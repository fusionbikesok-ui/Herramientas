import type pg from 'pg';
import {
  completarCorrida, fallarCorrida, reclamarCorridas, soltarCorridaPorApagado,
  type CorridaReclamada,
} from '../reconciliacion/corridas.ts';

export interface ResultadoBarrido {
  cursorAfter: Record<string, unknown>;
  antesDeCerrar?: (tx: pg.PoolClient) => Promise<void>;
}
export type ProcesadorBarrido = (corrida: CorridaReclamada) => Promise<ResultadoBarrido>;

export class ErrorBarridoReintentable extends Error {
  override name = 'ErrorBarridoReintentable';
  readonly retryAfter: number | undefined;
  constructor(message: string, retryAfter?: number) { super(message); this.retryAfter = retryAfter; }
}

export interface WorkerBarridos {
  unaVuelta(cantidad?: number): Promise<number>;
  detener(): Promise<void>;
}

export function crearWorkerBarridos(opciones: {
  db: pg.Pool;
  workerId: string;
  procesadores: Readonly<Record<string, ProcesadorBarrido>>;
}): WorkerBarridos {
  const activas = new Map<string, CorridaReclamada>();
  let aceptando = true;
  const topics = Object.keys(opciones.procesadores);

  return {
    async unaVuelta(cantidad = 5) {
      if (!aceptando || topics.length === 0) return 0;
      const corridas = await reclamarCorridas(opciones.db, opciones.workerId, topics, cantidad);
      for (const corrida of corridas) {
        activas.set(corrida.id, corrida);
        try {
          const resultado = await opciones.procesadores[corrida.topic]!(corrida);
          await completarCorrida(opciones.db, corrida, resultado.cursorAfter, resultado.antesDeCerrar);
        } catch (error) {
          const retryAfter = error instanceof ErrorBarridoReintentable ? error.retryAfter : undefined;
          const codigo = error instanceof Error ? error.name : 'ErrorDesconocido';
          await fallarCorrida(opciones.db, corrida, codigo, retryAfter, Math.random,
            error instanceof ErrorBarridoReintentable);
        } finally {
          activas.delete(corrida.id);
        }
      }
      return corridas.length;
    },
    async detener() {
      aceptando = false;
      await Promise.allSettled([...activas.values()].map((c) => soltarCorridaPorApagado(opciones.db, c)));
      activas.clear();
    },
  };
}
