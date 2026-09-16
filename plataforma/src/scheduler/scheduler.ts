import type pg from 'pg';
import { liberarVencidos } from '../colas/colas.ts';
import { liberarCorridasVencidas, materializarCorridas } from '../reconciliacion/corridas.ts';
import { evaluarAlertasPlataforma, guardarResumenDiario, liberarSenalesVencidas, medirPlataforma, type Alerta } from '../observabilidad/sombra.ts';

export interface Scheduler {
  unaVuelta(): Promise<{
    pendientes: number; muertos: number; corridas: number; corridasRecuperadas: number; corridasFallidas: number;
    senalesRecuperadas: number; senalesMuertas: number;
  }>;
  /** Mide, evalúa alertas y guarda el resumen del día a lo sumo cada `cadaMs`. */
  observar(ahora?: Date): Promise<Alerta[] | null>;
}

export function crearScheduler(opciones: { db: pg.Pool; cadaMs?: number }): Scheduler {
  let ultimaObservacion = 0;
  return {
    async unaVuelta() {
      const inbox = await liberarVencidos(opciones.db, 'inbox');
      const outbox = await liberarVencidos(opciones.db, 'outbox');
      const vencidas = await liberarCorridasVencidas(opciones.db);
      const corridas = await materializarCorridas(opciones.db);
      const senales = await liberarSenalesVencidas(opciones.db);
      return {
        pendientes: inbox.pendientes + outbox.pendientes,
        muertos: inbox.muertos + outbox.muertos,
        corridas,
        corridasRecuperadas: vencidas.pendientes,
        corridasFallidas: vencidas.fallidas,
        senalesRecuperadas: senales.reintentables,
        senalesMuertas: senales.muertas,
      };
    },
    async observar(ahora = new Date()) {
      if (ahora.getTime() - ultimaObservacion < (opciones.cadaMs ?? 5 * 60_000)) return null;
      ultimaObservacion = ahora.getTime();
      await guardarResumenDiario(opciones.db, ahora);
      return evaluarAlertasPlataforma(await medirPlataforma(opciones.db, ahora));
    },
  };
}
