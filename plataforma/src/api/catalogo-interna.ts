/*
 * src/api/catalogo-interna.ts — por dónde el legado le manda a la plataforma las decisiones del matcher y los
 * casos de identidad: la copia en tandas y los eventos sueltos de la outbox (E2 T1, tarea 7).
 *
 * Misma autenticación que la API de señales: HMAC con el keyring interno, origen permitido y nonce de un solo
 * uso (una petición capturada no se puede reenviar). La cuenta de ML la decide el servidor, nunca el cliente.
 *
 *   POST /internal/v1/catalogo/copias                    abre una copia → 201 { copy_id }
 *   POST /internal/v1/catalogo/copias/:id/lotes          un lote numerado → 202
 *   POST /internal/v1/catalogo/copias/:id/confirmar      verifica y aplica → 200 | 409 copia_incompleta / hash_distinto
 *   POST /internal/v1/catalogo/eventos                   un cambio suelto → 200 { resultado }
 *   POST /internal/v1/catalogo/eventos-identidad         un caso de identidad del legado → 200 { resultado }
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  abrirCopia, aplicarEvento, aplicarEventoIdentidad, confirmarCopia, ErrorCopia, recibirLote, type TipoCopia,
} from '../catalogo/copias.ts';
import { enTransaccion } from '../db/pool.ts';
import { verificarInterna } from '../seguridad/interna.ts';
import type { OpcionesSenales } from './senales.ts';

export const PREFIJO_CATALOGO = '/internal/v1/catalogo';
/** Un lote de la copia: el matcher tiene del orden de 7.000 filas; en lotes de 500 entra holgado. */
export const LIMITE_CUERPO_CATALOGO = 1024 * 1024;
const RETENCION_NONCE = '10 minutes';

const texto = z.string().max(512);
const Fecha = z.iso.datetime({ offset: true });
const AbrirCopia = z.strictObject({
  tipo: z.enum(['matcher', 'identidad']),
  total_esperado: z.number().int().min(0),
  hash_esperado: z.string().regex(/^[0-9a-f]{64}$/),
  corte: Fecha,
});
const FilaDecision = z.strictObject({
  recurso: texto.min(1), variacion: texto, sku: z.string().regex(/^FB-[0-9]+$/).nullable(),
  accion: z.enum(['confirmar', 'asignar', 'omitir']), actor: z.enum(['persona', 'sistema']),
  motivo: texto.nullable(), confirmado_por: texto.nullable(), actualizado_en_legado: Fecha.nullable(),
});
const FilaIdentidad = z.strictObject({
  caso_legado: texto.min(1), recurso: texto.min(1), variacion: texto,
  prioridad: z.enum(['normal', 'urgente']), detalle: z.record(z.string(), z.unknown()),
});
const Lote = z.strictObject({ numero: z.number().int().min(1), filas: z.array(z.unknown()).max(2000) });
const Evento = z.strictObject({
  evento_id: texto.min(1), recurso: texto.min(1), variacion: texto,
  accion: z.enum(['confirmar', 'asignar', 'omitir', 'revocar']), sku: z.string().regex(/^FB-[0-9]+$/).nullable(),
  actor: z.enum(['persona', 'sistema']), motivo: texto.nullable(), confirmado_por: texto.nullable(), ocurrido_en: Fecha,
});

interface Respuesta { status: number; body: Record<string, unknown> }
const fallo = (status: number, code: string, message: string): Respuesta => ({ status, body: { code, message } });

const EventoIdentidad = z.strictObject({
  evento_id: texto.min(1), caso_legado: texto.min(1), recurso: texto.min(1), variacion: texto,
  prioridad: z.enum(['normal', 'urgente']), abierto: z.boolean(), detalle: z.record(z.string(), z.unknown()), ocurrido_en: Fecha,
});

function error(req: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ code, message, correlation_id: req.headers['x-correlation-id'] });
}

export function registrarCatalogoInterno(
  app: FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>, pool: pg.Pool, logger: Logger,
  opciones: OpcionesSenales, ahora: () => Date,
): void {
  void app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: LIMITE_CUERPO_CATALOGO }, (_req, cuerpo, listo) => listo(null, cuerpo));
    sub.setErrorHandler((err, req, reply) => {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 413) return error(req, reply, 413, 'payload_too_large', 'El cuerpo supera 1 MiB.');
      if (status !== undefined && status >= 400 && status < 500) return error(req, reply, 400, 'invalid_body', 'El cuerpo no es válido.');
      logger.error({ err: (err as Error).message, correlation_id: req.headers['x-correlation-id'] }, 'error en el catálogo interno');
      return error(req, reply, 500, 'internal_error', 'Error interno.');
    });

    /**
     * Autentica, consume el nonce y ejecuta `trabajo` en la MISMA transacción: si el trabajo falla, el nonce
     * no queda gastado y el legado puede reintentar con la misma firma dentro de la ventana.
     *
     * `trabajo` DEVUELVE la respuesta y ésta se envía recién después del COMMIT. Enviarla desde adentro de la
     * transacción le decía "confirmada" al legado antes de que estuviera escrita: si el commit fallaba, el
     * legado daba por hecha una copia que no existía (lo encontró el test del recorrido completo).
     */
    async function autenticado(req: FastifyRequest, reply: FastifyReply,
      trabajo: (tx: pg.PoolClient, cuerpo: unknown, cuenta: string, empresa: string) => Promise<Respuesta>): Promise<FastifyReply> {
      const cuerpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const path = req.url.split('?')[0]!;
      const v = verificarInterna({
        keyring: opciones.keyring, origenes: opciones.origenes, direccion: req.socket.remoteAddress,
        headers: req.headers, metodo: 'POST', path, cuerpo, ahoraMs: ahora().getTime(),
      });
      if (!v.ok) {
        logger.warn({ motivo: v.motivo, path }, 'catálogo interno rechazado por autenticación');
        return error(req, reply, 401, 'unauthorized', 'Autenticación interna inválida.');
      }
      let datos: unknown;
      try { datos = JSON.parse(cuerpo.toString('utf8')); } catch { return error(req, reply, 400, 'invalid_body', 'El cuerpo no es JSON.'); }
      const cuenta = opciones.cuentas.get('mercadolibre');
      if (!cuenta) return error(req, reply, 409, 'cuenta_no_configurada', 'No hay cuenta de Mercado Libre configurada.');
      return enTransaccion(pool, async (tx) => {
        await tx.query(`DELETE FROM integrations.signal_nonces WHERE seen_at < now() - interval '${RETENCION_NONCE}'`);
        const nonce = await tx.query('INSERT INTO integrations.signal_nonces(key_id, nonce) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [v.keyId, v.nonce]);
        if (!nonce.rowCount) {
          logger.warn({ motivo: 'replay', path }, 'catálogo interno rechazado por autenticación');
          return fallo(401, 'unauthorized', 'Autenticación interna inválida.');
        }
        const empresa = (await tx.query<{ company_id: string }>('SELECT company_id FROM core.channel_accounts WHERE id = $1', [cuenta])).rows[0]!.company_id;
        return trabajo(tx as pg.PoolClient, datos, cuenta, empresa);
      }).then(
        (r) => reply.code(r.status).send(r.status >= 400 ? { ...r.body, correlation_id: req.headers['x-correlation-id'] } : r.body),
        (e: unknown) => {
          if (e instanceof ErrorCopia) return error(req, reply, e.codigo === 'copia_inexistente' ? 404 : 409, e.codigo, e.message);
          throw e;
        },
      );
    }

    sub.post(`${PREFIJO_CATALOGO}/copias`, (req, reply) => autenticado(req, reply, async (tx, cuerpo, _cuenta, empresa) => {
      const d = AbrirCopia.safeParse(cuerpo);
      if (!d.success) return fallo(400, 'invalid_body', 'La copia no es válida.');
      const id = await abrirCopia(tx, { empresa, tipo: d.data.tipo, totalEsperado: d.data.total_esperado, hashEsperado: d.data.hash_esperado, corte: d.data.corte });
      return { status: 201, body: { copy_id: id } };
    }));

    sub.post<{ Params: { id: string } }>(`${PREFIJO_CATALOGO}/copias/:id/lotes`, (req, reply) => autenticado(req, reply, async (tx, cuerpo) => {
      const d = Lote.safeParse(cuerpo);
      if (!d.success || !z.uuid().safeParse(req.params.id).success) return fallo(400, 'invalid_body', 'El lote no es válido.');
      const tipo = (await tx.query<{ tipo: TipoCopia }>('SELECT tipo FROM catalog.copias WHERE id = $1', [req.params.id])).rows[0]?.tipo;
      if (!tipo) throw new ErrorCopia('copia_inexistente', 'no existe la copia');
      // Cada fila se valida al llegar: una fila mal formada se rechaza con su lote, no en el confirmar.
      const esquema = tipo === 'matcher' ? FilaDecision : FilaIdentidad;
      if (!d.data.filas.every((f) => esquema.safeParse(f).success)) return fallo(400, 'invalid_body', 'Una fila del lote no es válida.');
      await recibirLote(tx, req.params.id, d.data.numero, d.data.filas);
      return { status: 202, body: { numero: d.data.numero } };
    }));

    sub.post<{ Params: { id: string } }>(`${PREFIJO_CATALOGO}/copias/:id/confirmar`, (req, reply) => autenticado(req, reply, async (tx, _cuerpo, cuenta) => {
      if (!z.uuid().safeParse(req.params.id).success) return fallo(400, 'invalid_body', 'Copia inválida.');
      const r = await confirmarCopia(tx, req.params.id, cuenta);
      logger.info({ copia: req.params.id, ...r }, 'copia del catálogo confirmada');
      return { status: 200, body: { ...r } };
    }));

    sub.post(`${PREFIJO_CATALOGO}/eventos`, (req, reply) => autenticado(req, reply, async (tx, cuerpo, cuenta, empresa) => {
      const d = Evento.safeParse(cuerpo);
      if (!d.success) return fallo(400, 'invalid_body', 'El evento no es válido.');
      const resultado = await aplicarEvento(tx, empresa, cuenta, d.data);
      return { status: 200, body: { resultado } };
    }));

    sub.post(`${PREFIJO_CATALOGO}/eventos-identidad`, (req, reply) => autenticado(req, reply, async (tx, cuerpo, cuenta, empresa) => {
      const d = EventoIdentidad.safeParse(cuerpo);
      if (!d.success) return fallo(400, 'invalid_body', 'El evento de identidad no es válido.');
      const resultado = await aplicarEventoIdentidad(tx, empresa, cuenta, d.data);
      return { status: 200, body: { resultado } };
    }));
  });
}
