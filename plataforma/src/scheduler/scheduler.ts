import type pg from 'pg';
import { liberarVencidos } from '../colas/colas.ts';
import { liberarCorridasVencidas, materializarCorridas } from '../reconciliacion/corridas.ts';

export interface Scheduler {
  unaVuelta(): Promise<{ pendientes: number; muertos: number; corridas: number; corridasRecuperadas: number; corridasFallidas: number }>;
}

export function crearScheduler(opciones: { db: pg.Pool }): Scheduler {
  return {
    async unaVuelta() {
      const inbox = await liberarVencidos(opciones.db, 'inbox');
      const outbox = await liberarVencidos(opciones.db, 'outbox');
      const vencidas = await liberarCorridasVencidas(opciones.db);
      const corridas = await materializarCorridas(opciones.db);
      return {
        pendientes: inbox.pendientes + outbox.pendientes,
        muertos: inbox.muertos + outbox.muertos,
        corridas,
        corridasRecuperadas: vencidas.pendientes,
        corridasFallidas: vencidas.fallidas,
      };
    },
  };
}
