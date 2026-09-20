/*
 * src/worker/catalogo.ts — el ciclo del proyector dentro del worker.
 *
 * Un ciclo propio, separado de la vuelta de barridos y señales: el proyector no llama al canal (lee lo que
 * el inbox ya tiene), así que no compite por el cupo del gateway y no tiene por qué esperar a los barridos.
 * Entre vuelta y vuelta, la pausa configurada. Una vuelta a la vez, y al apagar se espera la que está en curso
 * antes de cerrar el pool: cortar a mitad de una transacción la deshace, pero deja el lease tomado hasta que
 * venza.
 */
import type { CuentaBootstrap, ResultadoPagina } from '../catalogo/bootstrap.ts';
import type { Proyector } from '../catalogo/proyector.ts';

export interface RegistroCiclo {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface CicloCatalogo {
  detener(): Promise<void>;
}

export function iniciarCicloCatalogo(proyector: Proyector, pausaMs: number, log: RegistroCiclo): CicloCatalogo {
  let apagando = false;
  let temporizador: NodeJS.Timeout | null = null;
  let enCurso: Promise<void> = Promise.resolve();
  let avisoDetenido = false;

  const vuelta = async (): Promise<void> => {
    try {
      const r = await proyector.unaVuelta();
      if (r.reclamados > 0) log.info({ ...r, procesados: proyector.procesados }, 'vuelta del proyector del catálogo');
      if (r.detenido && !avisoDetenido) {
        // Una sola vez: detenido, el proyector no reclama más, y repetir el aviso en cada vuelta sólo ensucia.
        avisoDetenido = true;
        log.error({ motivo: r.detenido, procesados: proyector.procesados }, 'proyector del catálogo detenido');
      }
    } catch (error) {
      log.error({ err: (error as Error).message }, 'vuelta del proyector del catálogo falló');
    }
  };

  const programar = () => {
    if (apagando) return;
    temporizador = setTimeout(() => {
      enCurso = vuelta().finally(programar);
    }, pausaMs);
  };
  programar();

  return {
    async detener() {
      apagando = true;
      if (temporizador) clearTimeout(temporizador);
      await enCurso;
    },
  };
}

/** Lo que el ciclo del bootstrap necesita del bootstrap: leer una página de una cuenta. */
export interface LectorBootstrap {
  unaPagina(c: CuentaBootstrap): Promise<ResultadoPagina>;
}

/*
 * Tope del backoff por 429. Tres minutos, no los 900_000 ms del backoff de señales: ML manda
 * `Retry-After: 60` y suelta el cupo por ventanas que se abren solas, así que un tope alto hace perder la
 * ventana en vez de proteger a nadie. Medido el 2026-09-20: con el tope en 900_000, a la sexta cesión el
 * ciclo se dormía 16 min y podía perderse una ventana abierta a los 3.
 */
const TOPE_BACKOFF_429_MS = 180_000;

/**
 * El ciclo del bootstrap: una página por vuelta, de la primera cuenta que no terminó. Si cede (señales de ML
 * esperando o un 429) espera antes de la próxima, para no insistir sobre un cupo que ya está usado. Cuando
 * todas terminan, lo avisa y se detiene: el bootstrap corre una vez por cuenta, para siempre.
 *
 * `cedio_429` es el único caso con backoff exponencial (base `esperaCedido`, tope `TOPE_BACKOFF_429_MS`):
 * el canal no tiene cupo, e insistir a ritmo fijo alimenta su propio 429 sin ganar nada. El contador de
 * cesiones consecutivas es POR CUENTA — dos cuentas en cesión no
 * comparten el mismo contador, y una cuenta que avanza no afecta el backoff de otra. Si ML manda
 * `Retry-After`, ese valor es un piso: nunca se reintenta antes de lo que el canal pidió, aunque el backoff
 * calculado sea menor.
 *
 * `cedio_senales` y `reinicio_scan` NO tienen backoff, a propósito: el primero es prioridad frente a señales
 * reales, no falta de cupo, y crecerlo alargaría la espera sin motivo cuando las señales bajen; el segundo es
 * un scroll de ML vencido (`ErrorCanalTerminal`, no `Reintentable`) que ya reinicia el scan desde cero —
 * esperar más no lo mejora, y si el scroll vence seguido (típico cuando hay 429 de por medio) el backoff se
 * dispararía por una causa que no es congestión.
 */
export function iniciarCicloBootstrap(
  lector: LectorBootstrap, cuentas: readonly CuentaBootstrap[], pausaMs: number, log: RegistroCiclo,
  esperaCedido = 60_000,
): CicloCatalogo {
  let apagando = false;
  let temporizador: NodeJS.Timeout | null = null;
  let enCurso: Promise<void> = Promise.resolve();
  const terminadas = new Set<string>();
  const cesiones429 = new Map<string, number>();

  const vuelta = async (): Promise<number> => {
    const c = cuentas.find((x) => !terminadas.has(`${x.id}:${x.topic}`));
    if (!c) return -1;
    const clave = `${c.id}:${c.topic}`;
    try {
      const r = await lector.unaPagina(c);
      if (r.estado === 'terminada') {
        terminadas.add(clave);
        log.info({ cuenta: c.id, topic: c.topic }, 'bootstrap del catálogo terminado para la cuenta');
        return pausaMs;
      }
      if (r.estado === 'avanzo') {
        cesiones429.delete(clave);
        log.info({ cuenta: c.id, topic: c.topic, ...r }, 'bootstrap del catálogo: página confirmada');
        return pausaMs;
      }
      if (r.estado === 'ocupada') return pausaMs;
      if (r.estado === 'cedio_429') {
        const cesiones = (cesiones429.get(clave) ?? 0) + 1;
        cesiones429.set(clave, cesiones);
        const backoff = Math.min(TOPE_BACKOFF_429_MS, esperaCedido * 2 ** (cesiones - 1));
        const espera = r.retryAfterS !== undefined ? Math.max(backoff, r.retryAfterS * 1000) : backoff;
        // retryAfterS explícito (incluso `null` si ML no mandó el header): mide si el piso hace algo o es letra
        // muerta la próxima vez que haya 429 reales, sin tener que inferirlo de si la clave aparece o no.
        log.info(
          { cuenta: c.id, topic: c.topic, ...r, retryAfterS: r.retryAfterS ?? null, cesiones, esperaMs: espera },
          'bootstrap del catálogo en pausa',
        );
        return espera;
      }
      log.info({ cuenta: c.id, topic: c.topic, ...r }, 'bootstrap del catálogo en pausa');
      return esperaCedido;
    } catch (error) {
      log.error({ cuenta: c.id, topic: c.topic, err: (error as Error).message }, 'página del bootstrap falló');
      return esperaCedido;
    }
  };

  const programar = (ms: number) => {
    if (apagando) return;
    temporizador = setTimeout(() => {
      enCurso = vuelta().then((proxima) => {
        if (proxima < 0) { log.info({}, 'bootstrap del catálogo completo en todas las cuentas'); return; }
        programar(proxima);
      });
    }, ms);
  };
  programar(pausaMs);

  return {
    async detener() {
      apagando = true;
      if (temporizador) clearTimeout(temporizador);
      await enCurso;
    },
  };
}
