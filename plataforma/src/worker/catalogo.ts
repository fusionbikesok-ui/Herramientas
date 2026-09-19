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

/**
 * El ciclo del bootstrap: una página por vuelta, de la primera cuenta que no terminó. Si cede (señales de ML
 * esperando o un 429) espera un minuto antes de la próxima, para no insistir sobre un cupo que ya está usado.
 * Cuando todas terminan, lo avisa y se detiene: el bootstrap corre una vez por cuenta, para siempre.
 */
export function iniciarCicloBootstrap(
  lector: LectorBootstrap, cuentas: readonly CuentaBootstrap[], pausaMs: number, log: RegistroCiclo,
  esperaCedido = 60_000,
): CicloCatalogo {
  let apagando = false;
  let temporizador: NodeJS.Timeout | null = null;
  let enCurso: Promise<void> = Promise.resolve();
  const terminadas = new Set<string>();

  const vuelta = async (): Promise<number> => {
    const c = cuentas.find((x) => !terminadas.has(`${x.id}:${x.topic}`));
    if (!c) return -1;
    try {
      const r = await lector.unaPagina(c);
      if (r.estado === 'terminada') {
        terminadas.add(`${c.id}:${c.topic}`);
        log.info({ cuenta: c.id, topic: c.topic }, 'bootstrap del catálogo terminado para la cuenta');
        return pausaMs;
      }
      if (r.estado === 'avanzo') { log.info({ cuenta: c.id, topic: c.topic, ...r }, 'bootstrap del catálogo: página confirmada'); return pausaMs; }
      if (r.estado === 'ocupada') return pausaMs;
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
