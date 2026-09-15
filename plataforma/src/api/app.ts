import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import type pg from 'pg';
import type { Logger } from 'pino';
import { correlacionDe } from '../comun/correlacion.ts';
import { sinSesion, type ProveedorSesion } from '../auth/sesion.ts';

type Estado = 'ok' | 'degraded' | 'down';
interface Componente { status: Estado; checked_at: string; detail?: string }
interface EstadoArchivo { medido?: string; ok?: boolean; mas_viejo_s?: number }

export interface OpcionesApi {
  pool: pg.Pool;
  logger: Logger;
  estadoPgDir: string;
  heartbeatMaxS?: number;
  sesion?: ProveedorSesion;
  ahora?: () => Date;
}

const TOPICOS = new Set(['ml.orders', 'ml.shipments', 'ml.questions', 'ml.messages', 'ml.claims', 'ml.items', 'woo.orders', 'woo.products']);
const ESTADOS = new Set(['retryable', 'uncertain', 'dead_lettered', 'parked']);

function componente(status: Estado, detail?: string, ahora = new Date()): Componente {
  return detail === undefined ? { status, checked_at: ahora.toISOString() } : { status, checked_at: ahora.toISOString(), detail };
}

async function leerArchivoWal(dir: string): Promise<EstadoArchivo | null> {
  try { return JSON.parse(await readFile(join(dir, 'estado-pg-archivo.json'), 'utf8')) as EstadoArchivo; }
  catch { return null; }
}

/** La comprobación de salud no puede consumir el timeout general de 5 s. */
async function comprobarBase(pool: pg.Pool): Promise<void> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SET LOCAL statement_timeout = '2000ms'");
    await cliente.query('SELECT 1');
    await cliente.query('COMMIT');
  } catch (error) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    cliente.release();
  }
}

function cursorDecode(valor: unknown): { openedAt: string; sourceType: string; sourceId: string } | null {
  if (typeof valor !== 'string' || !valor || valor.length > 512) return valor === undefined ? null : null;
  try {
    const x = JSON.parse(Buffer.from(valor, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof x.openedAt === 'string' && typeof x.sourceType === 'string' && typeof x.sourceId === 'string'
      ? { openedAt: x.openedAt, sourceType: x.sourceType, sourceId: x.sourceId } : null;
  } catch { return null; }
}

export function crearApi(opciones: OpcionesApi) {
  const app = Fastify({ loggerInstance: opciones.logger });
  const sesion = opciones.sesion ?? sinSesion;
  const ahora = opciones.ahora ?? (() => new Date());
  app.addHook('onRequest', async (req, reply) => {
    const id = correlacionDe(req.headers['x-correlation-id']);
    req.headers['x-correlation-id'] = id;
    reply.header('X-Correlation-Id', id);
  });
  app.setErrorHandler((error, req, reply) => {
    opciones.logger.error({ err: (error as Error).message, correlation_id: req.headers['x-correlation-id'] }, 'error de API');
    void reply.code(500).send({ code: 'internal_error', message: 'Error interno.', correlation_id: req.headers['x-correlation-id'] });
  });

  app.get('/api/v2/health', async (_req, reply) => {
    const fecha = ahora();
    let database: Componente;
    try { await comprobarBase(opciones.pool); database = componente('ok', undefined, fecha); }
    catch { database = componente('down', 'No responde PostgreSQL.', fecha); }
    const vivos = await opciones.pool.query<{ servicio: string; visto_en: string }>("SELECT servicio, visto_en::text FROM core.service_heartbeats WHERE servicio IN ('worker','scheduler') AND visto_en >= now() - make_interval(secs => $1)", [opciones.heartbeatMaxS ?? 120]).catch(() => ({ rows: [] }));
    const presentes = new Set(vivos.rows.map((r) => r.servicio));
    const worker = presentes.has('worker') ? componente('ok', undefined, fecha) : componente('down', 'Sin latido reciente.', fecha);
    const scheduler = presentes.has('scheduler') ? componente('ok', undefined, fecha) : componente('down', 'Sin latido reciente.', fecha);
    const archivo = await leerArchivoWal(opciones.estadoPgDir);
    let wal: Componente;
    const medido = archivo?.medido ? Date.parse(archivo.medido) : NaN;
    const edad = Number.isFinite(medido) ? (fecha.getTime() - medido) / 1000 : Infinity;
    const atraso = Number(archivo?.mas_viejo_s ?? Infinity);
    if (!archivo?.ok || edad > 900 || atraso > 300) wal = componente('down', 'Estado de WAL ausente, vencido o crítico.', fecha);
    else if (atraso > 180) wal = componente('degraded', 'Archivado de WAL demorado.', fecha);
    else wal = componente('ok', undefined, fecha);
    const componentes = { database, worker, scheduler, wal_archive: wal };
    const estados = Object.values(componentes).map((c) => c.status);
    const status: Estado = estados.includes('down') ? 'down' : estados.includes('degraded') ? 'degraded' : 'ok';
    return reply.code(status === 'ok' ? 200 : 503).send({ status, components: componentes });
  });

  app.get('/api/v2/incidents', async (req, reply) => {
    const actual = await sesion(req);
    const correlation_id = req.headers['x-correlation-id'];
    if (!actual) return reply.code(401).send({ code: 'unauthenticated', message: 'Se requiere iniciar sesión.', correlation_id });
    if (!actual.capabilities.includes('operations.read')) return reply.code(403).send({ code: 'forbidden', message: 'No tenés permiso para ver incidentes.', correlation_id });
    const q = req.query as { cursor?: unknown; limit?: unknown; topic?: unknown; status?: unknown };
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    const cursor = cursorDecode(q.cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (q.cursor !== undefined && cursor === null) || (q.topic !== undefined && (typeof q.topic !== 'string' || !TOPICOS.has(q.topic))) || (q.status !== undefined && (typeof q.status !== 'string' || !ESTADOS.has(q.status)))) {
      return reply.code(422).send({ code: 'invalid_parameter', message: 'Los parámetros no son válidos.', correlation_id, details: { parameter: 'cursor, limit, topic o status' } });
    }
    const params: unknown[] = [];
    const filtros: string[] = [];
    if (typeof q.topic === 'string') { params.push(q.topic); filtros.push(`topic = $${params.length}`); }
    if (typeof q.status === 'string') { params.push(q.status); filtros.push(`status = $${params.length}`); }
    if (cursor) { params.push(cursor.openedAt, cursor.sourceType, cursor.sourceId); filtros.push(`(opened_at, source_type, source_id) > ($${params.length - 2}::timestamptz, $${params.length - 1}, $${params.length}::bigint)`); }
    params.push(limit + 1);
    const r = await opciones.pool.query<{ source_type: string; source_id: string; topic: string; status: string; reason_code: string | null; opened_at: Date; attempts: number; correlation_id: string }>(`SELECT source_type, source_id, topic, status, reason_code, opened_at, attempts, correlation_id FROM integrations.incidents ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''} ORDER BY opened_at, source_type, source_id LIMIT $${params.length}`, params);
    const filas = r.rows.slice(0, limit);
    const ultimo = filas.at(-1);
    const next_cursor = r.rows.length > limit && ultimo ? Buffer.from(JSON.stringify({ openedAt: ultimo.opened_at.toISOString(), sourceType: ultimo.source_type, sourceId: ultimo.source_id })).toString('base64url') : null;
    return { items: filas.map((f) => ({ ...f, source_id: f.source_id, opened_at: f.opened_at.toISOString() })), next_cursor };
  });
  return app;
}
