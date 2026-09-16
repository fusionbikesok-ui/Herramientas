import type { BlockList } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { KeyringSobre } from '../seguridad/sobre.ts';
import { verificarInterna } from '../seguridad/interna.ts';
import { registrarEvento } from '../audit/auditoria.ts';

export type Canal = 'mercadolibre' | 'woocommerce';

/**
 * Configuración de la API interna de señales. La cuenta sale de `cuentas`, nunca del cliente: el emisor
 * dice de qué canal habla y el servidor decide qué `channel_account_id` le corresponde (diseño T3 §6).
 */
export interface OpcionesSenales {
  keyring: KeyringSobre;
  origenes: BlockList;
  cuentas: ReadonlyMap<Canal, string>;
}

export const RUTA_SENALES = '/internal/v1/reconciliation-signals';
export const LIMITE_CUERPO = 16 * 1024;
// Los nonces se conservan el doble de la ventana: uno con timestamp en el borde sigue cubierto.
const RETENCION_NONCE = '10 minutes';

const TOPICOS = ['ml.orders', 'ml.shipments', 'ml.questions', 'ml.messages', 'ml.claims', 'ml.items', 'woo.orders', 'woo.products'] as const;
const Envelope = z.strictObject({
  channel: z.enum(['mercadolibre', 'woocommerce']),
  topic: z.enum(TOPICOS),
  resource_id: z.string().min(1).max(512),
  fingerprint: z.string().min(1).max(512),
  notification_id: z.string().min(1).max(256).nullable().optional(),
  source: z.enum(['webhook_copy', 'ml_missed_feed']),
  /**
   * Importación de una pérdida (§11): el legado reenvía un recibo que descartó con la plataforma caída.
   * Además de la señal deja un evento de auditoría encadenada, una sola vez por recibo.
   */
  import: z.strictObject({
    discarded_at: z.iso.datetime({ offset: true }),
    reason: z.enum(['platform_unavailable', 'platform_timeout']),
  }).optional(),
});

function error(req: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ code, message, correlation_id: req.headers['x-correlation-id'] });
}

export function registrarSenales(app: FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>, pool: pg.Pool, logger: Logger, opciones: OpcionesSenales, ahora: () => Date): void {
  void app.register(async (sub) => {
    // Cuerpo crudo: la firma se calcula sobre los bytes recibidos, antes de interpretar el JSON.
    sub.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: LIMITE_CUERPO }, (_req, cuerpo, listo) => listo(null, cuerpo));
    sub.setErrorHandler((err, req, reply) => {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 413) return error(req, reply, 413, 'payload_too_large', 'El cuerpo supera 16 KiB.');
      if (status !== undefined && status >= 400 && status < 500) return error(req, reply, 400, 'invalid_envelope', 'El envelope no es válido.');
      logger.error({ err: (err as Error).message, correlation_id: req.headers['x-correlation-id'] }, 'error en señales');
      return error(req, reply, 500, 'internal_error', 'Error interno.');
    });

    sub.post(RUTA_SENALES, { bodyLimit: LIMITE_CUERPO }, async (req, reply) => {
      const cuerpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const v = verificarInterna({
        keyring: opciones.keyring, origenes: opciones.origenes, direccion: req.socket.remoteAddress,
        headers: req.headers, metodo: 'POST', path: RUTA_SENALES, cuerpo, ahoraMs: ahora().getTime(),
      });
      if (!v.ok) {
        // Sólo el motivo: nunca encabezados, firma ni cuerpo.
        logger.warn({ motivo: v.motivo, correlation_id: req.headers['x-correlation-id'] }, 'señal rechazada por autenticación');
        return error(req, reply, 401, 'unauthorized', 'Autenticación interna inválida.');
      }

      let datos: z.infer<typeof Envelope>;
      try {
        const r = Envelope.safeParse(JSON.parse(cuerpo.toString('utf8')));
        if (!r.success) return error(req, reply, 400, 'invalid_envelope', 'El envelope no es válido.');
        datos = r.data;
      } catch { return error(req, reply, 400, 'invalid_envelope', 'El envelope no es válido.'); }

      const prefijo = datos.channel === 'mercadolibre' ? 'ml.' : 'woo.';
      const cuenta = opciones.cuentas.get(datos.channel);
      if (!cuenta || !datos.topic.startsWith(prefijo) || (datos.source === 'ml_missed_feed' && datos.channel !== 'mercadolibre')
        || (datos.import && datos.source !== 'webhook_copy')) {
        return error(req, reply, 409, 'channel_topic_mismatch', 'El canal o el tópico no corresponden a una cuenta configurada.');
      }

      let cliente: pg.PoolClient | undefined;
      try {
        cliente = await pool.connect();
        await cliente.query('BEGIN');
        await cliente.query(`DELETE FROM integrations.signal_nonces WHERE seen_at < now() - interval '${RETENCION_NONCE}'`);
        const nonce = await cliente.query('INSERT INTO integrations.signal_nonces(key_id, nonce) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [v.keyId, v.nonce]);
        if (nonce.rowCount === 0) {
          await cliente.query('ROLLBACK');
          logger.warn({ motivo: 'replay', correlation_id: req.headers['x-correlation-id'] }, 'señal rechazada por autenticación');
          return error(req, reply, 401, 'unauthorized', 'Autenticación interna inválida.');
        }
        // Sin destino: cubre la unicidad por aviso y el índice parcial de coalescencia. Un duplicado
        // o un recurso con señal activa es éxito para el emisor, sin segunda fila.
        const senal = await cliente.query(`INSERT INTO integrations.reconciliation_signals
            (channel_account_id, topic, resource_id, notification_id, fingerprint, source)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
        [cuenta, datos.topic, datos.resource_id, datos.notification_id ?? null, datos.fingerprint, datos.source]);
        if (datos.import) {
          // Idempotente por recibo: el fingerprint identifica el recibo del legado. Un reintento de la
          // importación (el legado no llegó a marcarla) no encadena un segundo evento.
          const ya = await cliente.query(
            "SELECT 1 FROM audit.audit_events WHERE aggregate_type='shadow_receipt' AND aggregate_id=$1 AND action='shadow.loss_imported' LIMIT 1",
            [datos.fingerprint]);
          if (!ya.rowCount) {
            const empresa = (await cliente.query<{ company_id: string }>('SELECT company_id FROM core.channel_accounts WHERE id=$1', [cuenta])).rows[0];
            if (!empresa) throw Object.assign(new Error('cuenta inexistente'), { code: '23503' });
            await registrarEvento(cliente, {
              companyId: empresa.company_id, actorType: 'system', actorId: 'legacy-shadow-import',
              action: 'shadow.loss_imported', aggregateType: 'shadow_receipt', aggregateId: datos.fingerprint,
              correlationId: String(req.headers['x-correlation-id']), reason: datos.import.reason,
              payload: {
                channel_account_id: cuenta, topic: datos.topic, resource_id: datos.resource_id,
                reason: datos.import.reason, discarded_at: datos.import.discarded_at,
              },
            });
          }
        }
        await cliente.query('COMMIT');
        return reply.code(202).send({ status: senal.rowCount ? 'accepted' : 'duplicate', correlation_id: req.headers['x-correlation-id'] });
      } catch (err) {
        if (cliente) await cliente.query('ROLLBACK').catch(() => undefined);
        // Cuenta configurada que no existe en la base: es un problema de canal/cuenta, no de disponibilidad.
        if ((err as { code?: string }).code === '23503') return error(req, reply, 409, 'channel_topic_mismatch', 'La cuenta configurada no existe.');
        logger.error({ err: (err as Error).message, correlation_id: req.headers['x-correlation-id'] }, 'PostgreSQL no disponible para señales');
        return error(req, reply, 503, 'platform_unavailable', 'PostgreSQL no disponible.');
      } finally {
        cliente?.release();
      }
    });
  });
}
