/*
 * src/worker/catalogo.ts — el ciclo del proyector dentro del worker.
 *
 * Un ciclo propio, separado de la vuelta de barridos y señales: el proyector no llama al canal (lee lo que
 * el inbox ya tiene), así que no compite por el cupo del gateway y no tiene por qué esperar a los barridos.
 * Entre vuelta y vuelta, la pausa configurada. Una vuelta a la vez, y al apagar se espera la que está en curso
 * antes de cerrar el pool: cortar a mitad de una transacción la deshace, pero deja el lease tomado hasta que
 * venza.
 */
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
