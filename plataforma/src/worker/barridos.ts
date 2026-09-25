import type pg from 'pg';
import {
  completarCorrida, diferirCorridaPorCupo, fallarCorrida, reclamarCorridas, soltarCorridaPorApagado,
  type Corriente, type CorridaReclamada,
} from '../reconciliacion/corridas.ts';
import { claveCorrienteCuenta } from '../reconciliacion/tipos.ts';

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

/**
 * E1 T5 (spec §2.3): 429 sintético del gateway sombra (header `x-fusion-cupo: sombra-agotado`), distinto
 * de un 429 real de ML/Woo. No consume intento (§2.4): se maneja aparte de `fallarCorrida`.
 */
export class ErrorCupoSombraAgotado extends Error {
  override name = 'ErrorCupoSombraAgotado';
  readonly retryAfter: number;
  constructor(message: string, retryAfter: number) { super(message); this.retryAfter = retryAfter; }
}

export interface WorkerBarridos {
  unaVuelta(cantidad?: number): Promise<number>;
  detener(): Promise<void>;
}

/**
 * Los procesadores se indexan por `cuenta|topic|cursor_kind`: el worker sólo reclama corridas de las
 * cuentas y corrientes que registró, así que nunca recibe una corrida que no sabe procesar.
 */
export function crearWorkerBarridos(opciones: {
  db: pg.Pool;
  workerId: string;
  procesadores: Readonly<Record<string, ProcesadorBarrido>>;
}): WorkerBarridos {
  const activas = new Map<string, CorridaReclamada>();
  let aceptando = true;
  const corrientes: Corriente[] = Object.keys(opciones.procesadores).map((clave) => {
    const [channelAccountId, topic, cursorKind, sobra] = clave.split('|');
    if (!channelAccountId || !topic || !cursorKind || sobra !== undefined) throw new Error(`clave de corriente inválida: ${clave}`);
    return { channelAccountId, topic, cursorKind };
  });

  return {
    async unaVuelta(cantidad = 5) {
      if (!aceptando || corrientes.length === 0) return 0;
      const corridas = await reclamarCorridas(opciones.db, opciones.workerId, corrientes, cantidad);
      for (const corrida of corridas) {
        activas.set(corrida.id, corrida);
        try {
          const procesador = opciones.procesadores[claveCorrienteCuenta(corrida.channelAccountId, corrida.topic, corrida.cursorKind)]!;
          const resultado = await procesador(corrida);
          await completarCorrida(opciones.db, corrida, resultado.cursorAfter, resultado.antesDeCerrar);
        } catch (error) {
          if (error instanceof ErrorCupoSombraAgotado) {
            // No consume intento (spec E1 T5 §2.4): distinto de un HTTP_429 real, se difiere aparte.
            await diferirCorridaPorCupo(opciones.db, corrida, error.retryAfter);
            continue;
          }
          const retryAfter = error instanceof ErrorBarridoReintentable ? error.retryAfter : undefined;
          // Nombre + mensaje (p. ej. "ErrorBarridoReintentable: HTTP_429 /items/bulk"): sólo el nombre no alcanzaba
          // para saber por qué falló la vuelta diaria de ml.items. El mensaje ya viene con la ruta saneada.
          const codigo = error instanceof Error ? `${error.name}: ${error.message}` : 'ErrorDesconocido';
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
