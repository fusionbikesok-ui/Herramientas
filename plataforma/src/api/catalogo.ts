/*
 * src/api/catalogo.ts — lectura del catálogo canónico (E2 T1, tarea 13). Requiere `catalog.read`.
 *
 *   GET /api/v2/catalog/models          modelos, paginados por cursor
 *   GET /api/v2/catalog/variants        variantes con su SKU (o pendiente) y sus publicaciones; ?pending=true filtra
 *   GET /api/v2/catalog/reconciliation  denominadores, cruces, casos abiertos, última copia y hash (§8 del diseño)
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { ProveedorSesion } from '../auth/sesion.ts';
import { conciliarCatalogo } from '../catalogo/conciliacion.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registrarCatalogo(
  app: FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>, pool: pg.Pool, sesion: ProveedorSesion, ahora: () => Date,
): void {
  /**
   * Sesión y capacidad. Devuelve true si ya respondió con el error. No devuelve el `reply`: es "thenable", y un
   * `await` sobre él lo resolvía como promesa y la respuesta se mandaba dos veces.
   */
  const bloqueado = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const actual = await sesion(req);
    const correlation_id = req.headers['x-correlation-id'];
    if (!actual) { void reply.code(401).send({ code: 'unauthenticated', message: 'Se requiere iniciar sesión.', correlation_id }); return true; }
    if (!actual.capabilities.includes('catalog.read')) { void reply.code(403).send({ code: 'forbidden', message: 'No tenés permiso para ver el catálogo.', correlation_id }); return true; }
    return false;
  };
  /** limit 1..100 (50 por omisión) y cursor = el último id de la página anterior. */
  const pagina = (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { limit?: unknown; cursor?: unknown };
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    const cursor = q.cursor === undefined ? null : String(q.cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== null && !UUID.test(cursor))) {
      void reply.code(422).send({ code: 'invalid_parameter', message: 'Los parámetros no son válidos.', correlation_id: req.headers['x-correlation-id'], details: { parameter: 'limit o cursor' } });
      return null;
    }
    return { limit, cursor };
  };

  app.get('/api/v2/catalog/models', async (req, reply) => {
    if (await bloqueado(req, reply)) return reply;
    const p = pagina(req, reply); if (!p) return reply;
    const r = await pool.query<{ id: string; origen: string; clave_origen: string; titulo: string; archivado: boolean; variantes: number }>(
      `SELECT m.id, m.origen, m.clave_origen, m.titulo, m.archivado_en IS NOT NULL AS archivado,
              (SELECT count(*)::int FROM catalog.sellable_variants v WHERE v.model_id = m.id AND v.archivado_en IS NULL) AS variantes
         FROM catalog.product_models m WHERE ($1::uuid IS NULL OR m.id > $1::uuid) ORDER BY m.id LIMIT $2`, [p.cursor, p.limit + 1]);
    const items = r.rows.slice(0, p.limit);
    return { items, next_cursor: r.rows.length > p.limit ? items.at(-1)!.id : null };
  });

  app.get('/api/v2/catalog/variants', async (req, reply) => {
    if (await bloqueado(req, reply)) return reply;
    const p = pagina(req, reply); if (!p) return reply;
    const pendientes = (req.query as { pending?: unknown }).pending === 'true';
    const r = await pool.query<{ id: string; model_id: string; sku: string | null; archivado: boolean; representaciones: unknown }>(
      `SELECT v.id, v.model_id, v.sku, v.archivado_en IS NOT NULL AS archivado,
              COALESCE((SELECT json_agg(json_build_object('canal', r.canal, 'recurso', r.recurso, 'variacion', r.variacion_normalizada,
                               'sku_observado', r.sku_observado, 'estado', r.estado_remoto) ORDER BY r.canal, r.recurso)
                          FROM catalog.external_representations r WHERE r.variant_id = v.id), '[]') AS representaciones
         FROM catalog.sellable_variants v
        WHERE ($1::uuid IS NULL OR v.id > $1::uuid) AND (NOT $3 OR (v.sku IS NULL AND v.archivado_en IS NULL))
        ORDER BY v.id LIMIT $2`, [p.cursor, p.limit + 1, pendientes]);
    const items = r.rows.slice(0, p.limit);
    return { items, next_cursor: r.rows.length > p.limit ? items.at(-1)!.id : null };
  });

  app.get('/api/v2/catalog/reconciliation', async (req, reply) => {
    if (await bloqueado(req, reply)) return reply;
    return conciliarCatalogo(pool, ahora());
  });
}
