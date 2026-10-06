import type pg from 'pg';
import { enTransaccion } from '../db/pool.ts';
import { ErrorCanalTerminal, ErrorDestinoProhibido } from '../reconciliacion/cliente-http.ts';
import { ErrorPaginaInvalida, persistirRecurso, validarRecurso } from '../reconciliacion/motor.ts';
import type { Relector } from '../reconciliacion/relectura.ts';
import { cerrarSenal, diferirSenalPorCupo, fallarSenal, reclamarSenales, type ObjetivoSenal, type SenalReclamada } from '../reconciliacion/senales-cola.ts';
import type { KeyringSobre } from '../seguridad/sobre.ts';
import { ErrorBarridoReintentable, ErrorCupoSombraAgotado } from './barridos.ts';

class ErrorLeasePerdido extends Error { override name = 'ErrorLeasePerdido'; }

/** Clave de relector: una cuenta sólo relee con los relectores de su propio canal. */
export const claveRelector = (channelAccountId: string, topic: string): string => `${channelAccountId}|${topic}`;

export interface WorkerSenales {
  unaVuelta(cantidad?: number): Promise<number>;
  detener(): void;
}

/**
 * Procesa señales (E1 T3 §9). El resultado del GET se persiste con el mismo motor que el barrido, en la
 * misma transacción que cierra la señal y sólo si el lease sigue siendo de este worker: si se perdió,
 * se revierte todo y otra instancia la vuelve a tomar.
 */
export function crearWorkerSenales(opciones: {
  db: pg.Pool;
  workerId: string;
  keyring: KeyringSobre;
  relectores: Readonly<Record<string, Relector>>;
}): WorkerSenales {
  let aceptando = true;
  const objetivos: ObjetivoSenal[] = Object.keys(opciones.relectores).map((clave) => {
    const [channelAccountId, topic, sobra] = clave.split('|');
    if (!channelAccountId || !topic || sobra !== undefined) throw new Error(`clave de relector inválida: ${clave}`);
    return { channelAccountId, topic };
  });

  async function procesar(s: SenalReclamada): Promise<void> {
    const relector = opciones.relectores[claveRelector(s.channelAccountId, s.topic)]!;
    if (!relector.id.test(s.resourceId)) {
      await cerrarSenal(opciones.db, s, 'excluded', 'invalid_resource');
      return;
    }
    let resultado;
    try {
      resultado = await relector.releer(s.resourceId);
    } catch (error) {
      if (error instanceof ErrorCupoSombraAgotado) {
        // No consume intento (spec E1 T5 §2.4): distinto de un HTTP_429 real, se difiere aparte.
        await diferirSenalPorCupo(opciones.db, s, error.retryAfter);
      } else if (error instanceof ErrorBarridoReintentable) {
        await fallarSenal(opciones.db, s, `retryable:${error.message.split(' ')[0]}`, error.retryAfter !== undefined ? { retryAfterS: error.retryAfter } : {});
      } else if (error instanceof ErrorCanalTerminal || error instanceof ErrorDestinoProhibido) {
        // Terminal de verdad: el canal dijo que no (404, 403) o el destino está prohibido. Reintentar no
        // cambia el resultado.
        await fallarSenal(opciones.db, s, `terminal:${error.name}`, { terminal: true });
      } else if (error instanceof ErrorPaginaInvalida) {
        /*
         * "No entendí la respuesta" NO es terminal, aunque antes estaba agrupado con los de arriba. Puede
         * ser un campo nuevo de ML, un dato transitorio, o un defecto nuestro: el 2026-09-19 fueron 35
         * órdenes muertas porque `ordenMl` no toleraba una orden sin `date_last_updated`, y el registro de
         * órdenes de la copia quedó clavado una semana sin que nada lo dijera.
         *
         * Reintentando, el arreglo de un defecto nuestro recupera las señales solo; y si el dato es
         * realmente inservible, muere igual al agotar los intentos, pero con la causa escrita y contada
         * en la alerta `senal_dead_letter`.
         */
        await fallarSenal(opciones.db, s, `retryable:${error.name}`);
      } else {
        await fallarSenal(opciones.db, s, `error:${(error as Error)?.name ?? 'desconocido'}`);
      }
      return;
    }

    if (resultado.tipo === 'barrido') {
      // Coalescido por cuenta: adelantar el barrido ya programado; la corrida activa única hace el resto.
      await enTransaccion(opciones.db, async (tx) => {
        await tx.query(
          `UPDATE integrations.reconciliation_cursors SET next_run_at=LEAST(next_run_at, now())
            WHERE channel_account_id=$1 AND topic=$2 AND cursor_kind='state_sweep' AND enabled`,
          [s.channelAccountId, s.topic],
        );
        if (!await cerrarSenal(tx, s, 'succeeded', 'sweep_triggered')) throw new ErrorLeasePerdido();
      }).catch((e) => { if (!(e instanceof ErrorLeasePerdido)) throw e; });
      return;
    }
    if (resultado.tipo === 'sin_baja') {
      await cerrarSenal(opciones.db, s, 'succeeded', `${resultado.motivo}:sin_baja`);
      return;
    }
    try {
      for (const recurso of resultado.recursos) validarRecurso(recurso, relector.versionKind);
    } catch (error) {
      // Mismo criterio que arriba: un recurso que no se entiende reintenta, no muere al primer intento.
      // Éste es el camino por el que murieron las 35 órdenes: la relectura traía 200 y la validación
      // posterior las rechazaba.
      await fallarSenal(opciones.db, s, `retryable:${(error as Error).name}`);
      return;
    }
    await enTransaccion(opciones.db, async (tx) => {
      const contexto = { channelAccountId: s.channelAccountId, topic: s.topic, correlationId: s.correlationId, runId: null, source: 'signal_reread' as const };
      let encolados = 0; let atrasados = 0;
      for (const recurso of resultado.recursos) {
        const r = await persistirRecurso(tx, contexto, relector.versionKind, recurso, opciones.keyring);
        if (r === 'enqueued') encolados++; else if (r === 'stale') atrasados++;
      }
      const detalle = encolados ? 'enqueued' : atrasados ? 'stale' : 'duplicate';
      if (!await cerrarSenal(tx, s, 'succeeded', detalle)) throw new ErrorLeasePerdido();
    }).catch((e) => { if (!(e instanceof ErrorLeasePerdido)) throw e; });
  }

  return {
    async unaVuelta(cantidad = 10) {
      if (!aceptando || !objetivos.length) return 0;
      const senales = await reclamarSenales(opciones.db, opciones.workerId, objetivos, cantidad);
      for (const s of senales) {
        try { await procesar(s); }
        catch (error) { await fallarSenal(opciones.db, s, `error:${(error as Error)?.name ?? 'desconocido'}`).catch(() => undefined); }
      }
      return senales.length;
    },
    // Una señal en vuelo no se suelta a mano: su lease vence y otra vuelta la retoma (un GET repetido es inocuo).
    detener() { aceptando = false; },
  };
}
