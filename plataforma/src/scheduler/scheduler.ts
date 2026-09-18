import type pg from 'pg';
import { liberarVencidos } from '../colas/colas.ts';
import { liberarCorridasVencidas, materializarCorridas } from '../reconciliacion/corridas.ts';
import { evaluarAlertasPlataforma, guardarResumenDiario, liberarSenalesVencidas, medirPlataforma, type Alerta } from '../observabilidad/sombra.ts';
import { ZONA } from '../informes/dia.ts';
import { vueltaDeInformes, type CfgInformes, type ResultadoVuelta } from '../informes/vuelta.ts';

/** Los informes del día anterior salen a partir de las 07:00 ART (decisión de José del 2026-09-17). */
export const HORA_INFORMES_ART = 7;
const horaArt = (instante: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', hour12: false }).format(instante));

export interface Scheduler {
  unaVuelta(): Promise<{
    pendientes: number; muertos: number; corridas: number; corridasRecuperadas: number; corridasFallidas: number;
    senalesRecuperadas: number; senalesMuertas: number;
  }>;
  /** Mide, evalúa alertas y guarda el resumen del día a lo sumo cada `cadaMs`. */
  observar(ahora?: Date): Promise<Alerta[] | null>;
  /**
   * Emite los informes pendientes, a partir de las 07:00 ART y a lo sumo cada `informesCadaMs`. Devuelve
   * null si no le tocaba o si los informes no están configurados.
   */
  informes(ahora?: Date): Promise<ResultadoVuelta | null>;
}

export function crearScheduler(opciones: {
  db: pg.Pool; cadaMs?: number; informes?: CfgInformes; informesCadaMs?: number;
}): Scheduler {
  let ultimaObservacion = 0;
  let ultimosInformes = 0;
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
    async informes(ahora = new Date()) {
      if (!opciones.informes) return null;
      if (horaArt(ahora) < HORA_INFORMES_ART) return null;
      // Con todo al día, la vuelta no hace nada; el tope sólo evita martillar B2 o el SMTP si están caídos.
      if (ahora.getTime() - ultimosInformes < (opciones.informesCadaMs ?? 10 * 60_000)) return null;
      ultimosInformes = ahora.getTime();
      return vueltaDeInformes(opciones.db, opciones.informes, ahora);
    },
  };
}
