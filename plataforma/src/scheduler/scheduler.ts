import type pg from 'pg';
import { liberarVencidos } from '../colas/colas.ts';

export interface Scheduler {
  unaVuelta(): Promise<{ pendientes: number; muertos: number }>;
}

export function crearScheduler(opciones: { db: pg.Pool }): Scheduler {
  return {
    async unaVuelta() {
      const inbox = await liberarVencidos(opciones.db, 'inbox');
      const outbox = await liberarVencidos(opciones.db, 'outbox');
      return { pendientes: inbox.pendientes + outbox.pendientes, muertos: inbox.muertos + outbox.muertos };
    },
  };
}
