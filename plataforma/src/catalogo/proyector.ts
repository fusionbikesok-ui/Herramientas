/*
 * src/catalogo/proyector.ts — el primer consumidor del inbox de E1: `woo.products` y `ml.items` al catálogo.
 *
 * Una vuelta reclama un lote y procesa cada mensaje en UNA transacción: descifrar, proyectar, aplicar y
 * cerrar el mensaje (`completarEnTx`) viven o mueren juntos. Tres frenos, porque el backlog son miles de
 * mensajes y nadie lo consumió nunca:
 *   - lote chico y pausa entre vueltas (la pausa la pone quien llama);
 *   - canario: con un tope, se detiene exactamente ahí y deja un resumen para revisar (decisión de José);
 *   - umbral de error: si una vuelta falla más de lo tolerado, se detiene y lo registra en la auditoría.
 *
 * Qué pasa con cada mensaje:
 *   - payload vencido (sin sobre)  → señal `payload_expired` para releer el recurso, y se cierra;
 *   - rechazo de la proyección      → a la DLQ con su causa: "rechazada con causa", nunca descartada;
 *   - falla inesperada              → reintento con backoff; al agotar intentos, a la DLQ.
 */
import type pg from 'pg';
import { registrarEvento } from '../audit/auditoria.ts';
import { completarEnTx, fallar, reclamar, type Reclamo } from '../colas/colas.ts';
import { ErrorTransitorio } from '../colas/errores.ts';
import { enTransaccion, type Consultable } from '../db/pool.ts';
import { descifrarSobre, type KeyringSobre } from '../seguridad/sobre.ts';
import { aplicarProyeccion, type Canal } from './aplicar.ts';
import { esRechazo } from './intenciones.ts';
import { proyectarItemMl } from './ml.ts';
import { proyectarProductoWoo } from './woo.ts';

export const TOPICOS_CATALOGO = ['woo.products', 'ml.items'] as const;

/** Una proyección rechazada con causa. No es transitoria: reintentarla daría lo mismo. */
export class ErrorRechazoProyeccion extends Error { override name = 'ErrorRechazoProyeccion'; }

export interface OpcionesProyector {
  pool: pg.Pool;
  keyring: KeyringSobre;
  lote: number;
  /** 0 = sin límite. */
  canario: number;
  umbralErrorPorciento: number;
}

export interface ResultadoVuelta {
  reclamados: number;
  aplicados: number;
  vencidos: number;
  rechazados: number;
  errores: number;
  /** Motivo por el que el proyector quedó detenido, o null si sigue. */
  detenido: string | null;
}

export interface Proyector {
  unaVuelta(): Promise<ResultadoVuelta>;
  /** Cuántos mensajes llevó hasta ahora; el canario se cuenta sobre esto. */
  readonly procesados: number;
  readonly detenido: string | null;
}

export function crearProyector(o: OpcionesProyector): Proyector {
  let procesados = 0;
  let detenido: string | null = null;

  async function procesar(tx: Consultable, r: Reclamo): Promise<'aplicado' | 'vencido'> {
    if (!r.sobre) {
      // El payload venció (90 días) o nunca se guardó: el recurso se relee por la vía de señales, que es
      // la que ya sabe pedirlo al canal con su cupo. ON CONFLICT DO NOTHING: si ya hay una señal activa
      // para ese recurso, esa relectura sirve igual.
      await tx.query(
        `INSERT INTO integrations.reconciliation_signals (channel_account_id, topic, resource_id, fingerprint, source)
         VALUES ($1, $2, $3, $4, 'payload_expired') ON CONFLICT DO NOTHING`,
        [r.channelAccountId, r.tipo, r.resourceId, `payload_expired:${r.id}`]);
      return 'vencido';
    }
    const claro = descifrarSobre(r.sobre,
      { account: r.channelAccountId, topic: r.tipo, resource: r.resourceId, remoteVersion: r.remoteVersion }, o.keyring);
    const payload: unknown = JSON.parse(claro.toString('utf8'));
    const canal: Canal = r.tipo === 'woo.products' ? 'woocommerce' : 'mercadolibre';
    const proyeccion = canal === 'woocommerce' ? proyectarProductoWoo(payload) : proyectarItemMl(payload);
    if (esRechazo(proyeccion)) throw new ErrorRechazoProyeccion(proyeccion.rechazo);
    await aplicarProyeccion({ tx, cuenta: r.channelAccountId, canal, versionRemota: r.remoteVersion }, proyeccion);
    return 'aplicado';
  }

  async function detener(motivo: string, resumen: Omit<ResultadoVuelta, 'detenido'>): Promise<void> {
    detenido = motivo;
    // La auditoría es por empresa; el proyector puede tocar varias. Se registra una vez por empresa con
    // cuentas de catálogo, así queda en el historial de cada una.
    const empresas = (await o.pool.query<{ company_id: string }>(
      'SELECT DISTINCT company_id FROM core.channel_accounts')).rows;
    for (const e of empresas) {
      await registrarEvento(o.pool, {
        companyId: e.company_id, actorType: 'system', actorId: 'plataforma.catalogo',
        action: 'catalogo.proyector_detenido', aggregateType: 'catalogo', aggregateId: 'proyector',
        correlationId: crypto.randomUUID(), reason: motivo, payload: { ...resumen, procesados },
      });
    }
  }

  return {
    get procesados() { return procesados; },
    get detenido() { return detenido; },
    async unaVuelta(): Promise<ResultadoVuelta> {
      const r: ResultadoVuelta = { reclamados: 0, aplicados: 0, vencidos: 0, rechazados: 0, errores: 0, detenido };
      if (detenido) return r;
      const restantes = o.canario > 0 ? o.canario - procesados : Infinity;
      if (restantes <= 0) {
        await detener(`canario de ${o.canario} completo: revisar antes de seguir`, r);
        return { ...r, detenido };
      }
      const reclamos = await reclamar(o.pool, 'inbox', [...TOPICOS_CATALOGO], Math.min(o.lote, restantes));
      r.reclamados = reclamos.length;
      for (const reclamo of reclamos) {
        try {
          const resultado = await enTransaccion(o.pool, async (tx) => {
            const x = await procesar(tx, reclamo);
            await completarEnTx(tx, reclamo);
            return x;
          });
          if (resultado === 'vencido') r.vencidos++; else r.aplicados++;
        } catch (error) {
          if (error instanceof ErrorRechazoProyeccion) {
            await fallar(o.pool, reclamo, error);
            r.rechazados++;
          } else {
            // Todo lo demás se reintenta: una falla de base, un bloqueo, un sobre que no descifra por una
            // rotación de claves a medias. Si es persistente, los intentos se agotan y va a la DLQ.
            await fallar(o.pool, reclamo, new ErrorTransitorio((error as Error).message));
            r.errores++;
          }
        }
        procesados++;
      }
      if (r.reclamados > 0 && (r.errores * 100) / r.reclamados > o.umbralErrorPorciento) {
        await detener(`${r.errores} de ${r.reclamados} mensajes fallaron en una vuelta (umbral ${o.umbralErrorPorciento} %)`, r);
      } else if (o.canario > 0 && procesados >= o.canario) {
        await detener(`canario de ${o.canario} completo: revisar antes de seguir`, r);
      }
      return { ...r, detenido };
    },
  };
}
