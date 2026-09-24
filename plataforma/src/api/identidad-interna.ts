/*
 * src/api/identidad-interna.ts — E3 corte 1 tarea 5: la API interna de la bandeja de identidad.
 *
 *   GET  /internal/v1/identidad/casos?tipo&estado&grupo&cursor&limit   cola priorizada (paginada por cursor)
 *   GET  /internal/v1/identidad/casos/:id                        detalle de un caso
 *   POST /internal/v1/identidad/casos/:id/decisiones             decidir (Idempotency-Key obligatoria)
 *   GET  /internal/v1/identidad/variantes?q=                     buscar "otra variante" (SKU exacto o título)
 *
 * Misma autenticación que catalogo-interna.ts (HMAC con el keyring interno, origen permitido, nonce de un
 * solo uso), con dos diferencias deliberadas:
 *  - en los GET se firma el `req.url` COMPLETO (con la query): en las rutas de sólo lectura la query ES el
 *    pedido, y firmando sólo el path un intermediario podría cambiar `tipo`/`cursor`/`q` sin invalidar la firma.
 *  - `decidirCaso` abre su propia transacción (con el candado de la cuenta), así que el nonce se consume en
 *    una transacción corta aparte: si la decisión falla, el legado reintenta con OTRO nonce y la MISMA
 *    Idempotency-Key, que es justamente para lo que existe esa clave.
 *
 * El puntaje del motor NO sale por acá (spec de la bandeja §2: no se muestra como confianza hasta calibrar).
 * La marca por atributo (`explicacion.atributos`) la calcula el motor y se devuelve tal cual; los atributos
 * que el motor no compara (`otros_atributos`) se marcan acá por igualdad normalizada, sin pretender más.
 */
import { modeloMlSql } from '../identidad/modelo-ml.ts';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import { otrosAtributos, type Atributos } from '../identidad/comparar.ts';
import { decidirCaso, type ResultadoDecision } from '../identidad/decidir.ts';
import { verificarInterna } from '../seguridad/interna.ts';
import type { OpcionesSenales } from './senales.ts';

export const PREFIJO_IDENTIDAD = '/internal/v1/identidad';
const RETENCION_NONCE = '10 minutes';
const LIMITE_CUERPO = 64 * 1024;
const LIMITE_POR_DEFECTO = 50;
const LIMITE_MAXIMO = 200;

const Decision = z.strictObject({
  expected_version: z.number().int().min(1),
  eleccion: z.enum(['vincular', 'omitir', 'mantener_omision', 'sin_candidato']),
  variant_id: z.uuid().optional(),
  motivo: z.string().max(2000).optional(),
  revierte: z.uuid().optional(),
  actor: z.strictObject({ usuario: z.string().min(1).max(200), es_admin: z.boolean() }),
  // Marca el "confirmar" del punto A (spec E3, decisión de José vía opt-16 2026-09-24): un click sobre un
  // caso cuyo variant_id ya apunta a una variante única y viva, sin pasar por el buscador de candidatos.
  // No cambia la validación de decidirCaso (sigue siendo un 'vincular' normal); sólo antepone el prefijo al
  // motivo para que quede diferenciado en la auditoría, sin necesitar una columna nueva.
  confirmar: z.boolean().optional(),
});
/** Prefijo del motivo para una decisión de confirmación rápida (punto A). Exportado para que el test lo
 *  pueda referenciar sin repetir el string a mano. */
export const PREFIJO_MOTIVO_CONFIRMAR = 'confirmar: ';
const ConsultaCola = z.strictObject({
  tipo: z.string().max(64).optional(), estado: z.string().max(32).optional(), grupo: z.coerce.number().int().min(0).max(6).optional(),
  cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(LIMITE_MAXIMO).default(LIMITE_POR_DEFECTO),
});
const ConsultaVariantes = z.strictObject({ q: z.string().trim().min(1).max(200) });

const STATUS_DECISION: Record<Exclude<ResultadoDecision, { ok: true }>['code'], number> = {
  version_conflict: 409, caso_cerrado: 409, revierte_no_vigente: 409,
  idempotency_mismatch: 422, variante_invalida: 422, caso_sin_publicacion: 422,
  solo_admin: 403, bandeja_apagada: 503, caso_inexistente: 404,
};

const linkMl = (recurso: string) => 'https://articulo.mercadolibre.com.ar/' + recurso.replace(/^(ML[A-Z])/, '$1-');

/** La publicación de ML que gobierna un caso: MISMA resolución que decidirCaso (por representation_id, o la
 *  ÚNICA representación viva de ML de la variante). Sin publicación única el caso no se puede decidir
 *  (caso_sin_publicacion), así que la cola no lo ofrece. */
const PUBLICACION = `LEFT JOIN LATERAL (
  SELECT x.* FROM (
    SELECT r0.*, count(*) OVER () AS n FROM catalog.external_representations r0
     WHERE r0.id = c.representation_id
        OR (c.representation_id IS NULL AND c.variant_id IS NOT NULL AND r0.variant_id = c.variant_id
            AND r0.canal = 'mercadolibre' AND r0.archivado_en IS NULL)) x
   -- Las mismas condiciones que decidirCaso valida sobre la representación resuelta (en las DOS ramas): si no
   -- las cumple, el POST daría caso_sin_publicacion, así que el caso cae en no_decidibles y no en la cola.
   WHERE x.n = 1 AND x.canal = 'mercadolibre' AND x.tipo = 'vendible' AND x.archivado_en IS NULL
     AND x.company_id = c.company_id) r ON true`;

interface Cursor { g: number; a: string; id: string }
const codificar = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodificar(s: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    return Number.isInteger(c.g) && typeof c.a === 'string' && !Number.isNaN(Date.parse(c.a)) && z.uuid().safeParse(c.id).success ? c : null;
  } catch { return null; }
}

function error(req: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string, extra: object = {}) {
  return reply.code(status).send({ code, message, ...extra, correlation_id: req.headers['x-correlation-id'] });
}

interface Fila { [k: string]: unknown }
async function atributosDe(pool: pg.Pool, sql: string, id: string): Promise<Atributos> {
  const r = await pool.query<{ nombre: string; valor: string }>(sql, [id]);
  const m: Atributos = new Map();
  for (const f of r.rows) m.set(f.nombre, m.has(f.nombre) ? `${m.get(f.nombre)} / ${f.valor}` : f.valor);
  return m;
}

export function registrarIdentidadInterna(
  app: FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>, pool: pg.Pool, logger: Logger,
  opciones: OpcionesSenales, ahora: () => Date, bandeja: boolean,
): void {
  void app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: LIMITE_CUERPO }, (_req, cuerpo, listo) => listo(null, cuerpo));
    sub.setErrorHandler((err, req, reply) => {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 413) return error(req, reply, 413, 'payload_too_large', 'El cuerpo es demasiado grande.');
      if (status !== undefined && status >= 400 && status < 500) return error(req, reply, 400, 'invalid_body', 'El cuerpo no es válido.');
      logger.error({ err: (err as Error).message, correlation_id: req.headers['x-correlation-id'] }, 'error en la identidad interna');
      return error(req, reply, 500, 'internal_error', 'Error interno.');
    });

    /** Verifica firma + origen y gasta el nonce. Devuelve la cuenta/empresa, o null si ya respondió el error. */
    async function autenticar(req: FastifyRequest, reply: FastifyReply, metodo: 'GET' | 'POST'): Promise<{ cuenta: string; empresa: string } | null> {
      const cuerpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const path = metodo === 'GET' ? req.url : req.url.split('?')[0]!;
      const v = verificarInterna({
        keyring: opciones.keyring, origenes: opciones.origenes, direccion: req.socket.remoteAddress,
        headers: req.headers, metodo, path, cuerpo, ahoraMs: ahora().getTime(),
      });
      if (!v.ok) {
        logger.warn({ motivo: v.motivo, path: req.url.split('?')[0] }, 'identidad interna rechazada por autenticación');
        error(req, reply, 401, 'unauthorized', 'Autenticación interna inválida.'); return null;
      }
      const cuenta = opciones.cuentas.get('mercadolibre');
      if (!cuenta) { error(req, reply, 409, 'cuenta_no_configurada', 'No hay cuenta de Mercado Libre configurada.'); return null; }
      // F: una cuenta configurada que no existe en core.channel_accounts es 409, no un 500 por `rows[0]!`.
      const empresaCuenta = (await pool.query<{ company_id: string }>('SELECT company_id FROM core.channel_accounts WHERE id = $1', [cuenta])).rows[0]?.company_id;
      if (!empresaCuenta) { error(req, reply, 409, 'cuenta_no_configurada', 'La cuenta de Mercado Libre no existe.'); return null; }
      const empresa = await pool.connect().then(async (c) => {
        try {
          await c.query('BEGIN');
          await c.query(`DELETE FROM integrations.signal_nonces WHERE seen_at < now() - interval '${RETENCION_NONCE}'`);
          const nonce = await c.query('INSERT INTO integrations.signal_nonces(key_id, nonce) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [v.keyId, v.nonce]);
          await c.query('COMMIT');
          if (!nonce.rowCount) return null;
          return empresaCuenta;
        } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
      });
      if (!empresa) {
        logger.warn({ motivo: 'replay', path: req.url.split('?')[0] }, 'identidad interna rechazada por autenticación');
        error(req, reply, 401, 'unauthorized', 'Autenticación interna inválida.'); return null;
      }
      return { cuenta, empresa };
    }

    // ───────────────────────── cola priorizada ─────────────────────────
    sub.get(`${PREFIJO_IDENTIDAD}/casos`, async (req, reply) => {
      const auth = await autenticar(req, reply, 'GET'); if (!auth) return reply;
      const q = ConsultaCola.safeParse(req.query);
      if (!q.success) return error(req, reply, 422, 'invalid_query', 'La consulta no es válida.');
      const cur = q.data.cursor ? decodificar(q.data.cursor) : null;
      if (q.data.cursor && !cur) return error(req, reply, 422, 'invalid_cursor', 'El cursor no es válido.');
      // Grupo de prioridad (menor = antes): conflicto → D5 → con auto_sku en sombra → activa con stock → resto
      // con título → confirmable (variant_id ya vinculado a una variante viva: un click, sin candidatos) →
      // sin título (al fondo, hasta que el punto B les dé una fuente). Decisión de José vía opt-16
      // 2026-09-24: los decidibles primero, "confirmar" después de esos, "sin título" al final de todos.
      const r = await pool.query<Fila & { g: number; abierto_iso: string }>(
        `WITH cola AS (
           SELECT c.id, c.tipo, c.estado, c.prioridad, c.version, c.abierto_en, c.detalle, c.variant_id,
                  r.recurso, r.variacion_normalizada, r.sku_observado, r.estado_remoto, r.stock_canal, r.precio, r.moneda,
                  m.titulo, cv.sku AS confirmar_sku,
                  CASE WHEN c.estado = 'conflict' THEN 0
                       WHEN (c.detalle->>'d5')::boolean IS TRUE THEN 1
                       WHEN EXISTS (SELECT 1 FROM catalog.identity_decisions d
                                     WHERE d.channel_account_id = r.channel_account_id AND d.recurso = r.recurso
                                       AND d.variacion_normalizada = r.variacion_normalizada
                                       AND d.origen = 'auto_sku' AND d.efecto = 'sombra' AND d.superada_en IS NULL) THEN 2
                       WHEN r.estado_remoto = 'active' AND COALESCE(r.stock_canal, 0) > 0 THEN 3
                       WHEN m.titulo IS NULL THEN 6
                       WHEN cv.sku IS NOT NULL THEN 5
                       ELSE 4 END AS g
             FROM catalog.identity_cases c
             ${PUBLICACION}
             LEFT JOIN catalog.product_models m ON m.id = ${modeloMlSql('r')}
             LEFT JOIN catalog.sellable_variants cv ON cv.id = c.variant_id AND cv.archivado_en IS NULL
            WHERE c.company_id = $1 AND c.cerrado_en IS NULL AND r.id IS NOT NULL
              AND ($2::text IS NULL OR c.tipo = $2) AND ($3::text IS NULL OR c.estado = $3))
         SELECT *, to_char(abierto_en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS abierto_iso FROM cola
          WHERE ($8::int IS NULL OR g = $8::int)
            AND ($4::int IS NULL OR (g, abierto_en, id) > ($4::int, $5::timestamptz, $6::uuid))
          ORDER BY g, abierto_en, id LIMIT $7`,
        [auth.empresa, q.data.tipo ?? null, q.data.estado ?? null, cur?.g ?? null, cur?.a ?? null, cur?.id ?? null, q.data.limit + 1, q.data.grupo ?? null]);
      // Contadores para los chips de la cabecera (spec §6): mismos filtros de empresa y abiertos, SIN cursor ni
      // tipo/estado, para que los números sean los de toda la bandeja. `no_decidibles` (A): abiertos sin publicación
      // única — no salen en la cola, pero se cuentan para que no se pierdan de vista.
      const cnt = (await pool.query<{ g: number | null; n: number }>(
        `SELECT CASE WHEN r.id IS NULL THEN NULL
                     WHEN c.estado = 'conflict' THEN 0
                     WHEN (c.detalle->>'d5')::boolean IS TRUE THEN 1
                     WHEN EXISTS (SELECT 1 FROM catalog.identity_decisions d
                                   WHERE d.channel_account_id = r.channel_account_id AND d.recurso = r.recurso
                                     AND d.variacion_normalizada = r.variacion_normalizada
                                     AND d.origen = 'auto_sku' AND d.efecto = 'sombra' AND d.superada_en IS NULL) THEN 2
                     WHEN r.estado_remoto = 'active' AND COALESCE(r.stock_canal, 0) > 0 THEN 3
                     WHEN m.titulo IS NULL THEN 6
                     WHEN cv.sku IS NOT NULL THEN 5
                     ELSE 4 END AS g, count(*)::int AS n
           FROM catalog.identity_cases c ${PUBLICACION}
           LEFT JOIN catalog.product_models m ON m.id = ${modeloMlSql('r')}
           LEFT JOIN catalog.sellable_variants cv ON cv.id = c.variant_id AND cv.archivado_en IS NULL
          WHERE c.company_id = $1 AND c.cerrado_en IS NULL GROUP BY 1`, [auth.empresa])).rows;
      const en = (g: number | null) => cnt.find((f) => f.g === g)?.n ?? 0;
      const contadores = { conflictos: en(0), d5: en(1), sku_exacto: en(2), activas_con_stock: en(3), resto: en(4), confirmable: en(5), sin_titulo: en(6), no_decidibles: en(null) };
      const hay = r.rows.length > q.data.limit;
      const filas = r.rows.slice(0, q.data.limit);
      const ultimo = filas.at(-1);
      return {
        casos: filas.map((f) => ({
          id: f.id, tipo: f.tipo, estado: f.estado, prioridad: f.prioridad, version: f.version, grupo: f.g, abierto_en: f.abierto_iso,
          d5: f.detalle && (f.detalle as { d5?: boolean }).d5 === true,
          publicacion: { recurso: f.recurso, variacion: f.variacion_normalizada, titulo: f.titulo ?? null, sku_observado: f.sku_observado ?? null,
            estado: f.estado_remoto ?? null, stock: f.stock_canal ?? null, precio: f.precio ?? null, moneda: f.moneda ?? null, link_ml: linkMl(String(f.recurso)) },
          // Grupo 5 (punto A): la pantalla puede ofrecer "Confirmar" sin llamar a /casos/:id — ya tiene el
          // variant_id y el SKU acá mismo, sin candidatos que buscar.
          confirmar: f.g === 5 ? { variant_id: f.variant_id, sku: f.confirmar_sku ?? null } : null,
        })),
        // Precargable: el legado pide el "siguiente" con este cursor mientras el operador decide el actual.
        contadores,
        siguiente: hay && ultimo ? codificar({ g: ultimo.g, a: ultimo.abierto_iso, id: String(ultimo.id) }) : null,
      };
    });

    // ───────────────────────── detalle ─────────────────────────
    sub.get<{ Params: { id: string } }>(`${PREFIJO_IDENTIDAD}/casos/:id`, async (req, reply) => {
      const auth = await autenticar(req, reply, 'GET'); if (!auth) return reply;
      if (!z.uuid().safeParse(req.params.id).success) return error(req, reply, 404, 'caso_inexistente', 'No existe el caso.');
      const c = (await pool.query<Fila>(
        `SELECT c.id, c.tipo, c.estado, c.prioridad, c.version, c.detalle, c.abierto_en, c.cerrado_en, c.motivo_cierre,
                r.id AS rep_id, r.channel_account_id, r.recurso, r.variacion_normalizada, r.sku_observado, r.estado_remoto,
                r.stock_canal, r.precio, r.moneda, r.model_id, m.titulo
           FROM catalog.identity_cases c
           ${PUBLICACION}
           LEFT JOIN catalog.product_models m ON m.id = ${modeloMlSql('r')}
          WHERE c.id = $1 AND c.company_id = $2`, [req.params.id, auth.empresa])).rows[0];
      if (!c) return error(req, reply, 404, 'caso_inexistente', 'No existe el caso.');

      const atributosMl = c.rep_id
        ? await atributosDe(pool, 'SELECT nombre_normalizado AS nombre, valor FROM catalog.model_attributes WHERE representation_id = $1 AND vigente_hasta IS NULL', String(c.rep_id))
        : new Map<string, string>();

      // El último top-3 (la corrida más reciente), SIN puntaje.
      const cands = (await pool.query<Fila>(
        `SELECT k.rank, k.explicacion, v.id AS variant_id, v.sku, v.model_id, m.titulo,
                (SELECT url FROM catalog.model_images i WHERE i.model_id = v.model_id AND i.vigente_hasta IS NULL
                  ORDER BY i.orden NULLS LAST, i.id LIMIT 1) AS foto,
                w.precio, w.moneda, w.stock_canal AS stock
           FROM catalog.identity_candidates k
           JOIN catalog.sellable_variants v ON v.id = k.variant_id
           JOIN catalog.product_models m ON m.id = v.model_id
           LEFT JOIN LATERAL (SELECT precio, moneda, stock_canal FROM catalog.external_representations
                               WHERE variant_id = v.id AND canal = 'woocommerce' AND archivado_en IS NULL
                               ORDER BY observado_en DESC LIMIT 1) w ON true
          WHERE k.case_id = $1
            AND k.run_id = (SELECT run_id FROM catalog.identity_candidates WHERE case_id = $1 ORDER BY creado_en DESC, id DESC LIMIT 1)
          ORDER BY k.rank`, [c.id])).rows;
      const candidatos = [];
      for (const k of cands) {
        const atrCand = await atributosDe(pool, 'SELECT nombre_normalizado AS nombre, valor FROM catalog.model_attributes WHERE model_id = $1 AND vigente_hasta IS NULL', String(k.model_id));
        const atributos = (k.explicacion as { atributos?: unknown[] } | null)?.atributos ?? [];
        candidatos.push({
          rank: k.rank, variant_id: k.variant_id, sku: k.sku ?? null, titulo: k.titulo, foto: k.foto ?? null,
          precio: k.precio ?? null, moneda: k.moneda ?? null, stock: k.stock ?? null,
          explicacion: { atributos, otros_atributos: otrosAtributos(atributosMl, atrCand) },
        });
      }

      const historial = c.recurso === null || c.recurso === undefined ? [] : (await pool.query<Fila>(
        `SELECT d.id, d.origen, d.efecto, d.eleccion, d.actor, d.motivo, d.creado_en, d.superada_en, d.supersede_a, v.sku
           FROM catalog.identity_decisions d LEFT JOIN catalog.sellable_variants v ON v.id = d.variant_id
          WHERE d.channel_account_id = $1 AND d.recurso = $2 AND d.variacion_normalizada = $3
          ORDER BY d.creado_en DESC, d.id DESC LIMIT 50`, [c.channel_account_id, c.recurso, c.variacion_normalizada])).rows;
      const sombra = historial.find((d) => d.origen === 'auto_sku' && d.efecto === 'sombra' && d.superada_en === null);
      const evidencia = (await pool.query<Fila>(
        'SELECT fuente, observado_en, hash, campos FROM catalog.identity_evidence WHERE case_id = $1 ORDER BY observado_en DESC LIMIT 20', [c.id])).rows;

      return {
        id: c.id, tipo: c.tipo, estado: c.estado, prioridad: c.prioridad, version: c.version, abierto_en: c.abierto_en,
        cerrado_en: c.cerrado_en, motivo_cierre: c.motivo_cierre, detalle: c.detalle,
        publicacion: c.recurso ? {
          recurso: c.recurso, variacion: c.variacion_normalizada, titulo: c.titulo ?? null, sku_observado: c.sku_observado ?? null,
          estado: c.estado_remoto ?? null, stock: c.stock_canal ?? null, precio: c.precio ?? null, moneda: c.moneda ?? null,
          link_ml: linkMl(String(c.recurso)), atributos: Object.fromEntries(atributosMl),
        } : null,
        candidatos,
        auto_sku_en_sombra: sombra ? { decision_id: sombra.id, sku: sombra.sku ?? null, creado_en: sombra.creado_en } : null,
        historial: historial.map((d) => ({ id: d.id, origen: d.origen, efecto: d.efecto, eleccion: d.eleccion, sku: d.sku ?? null,
          actor: d.actor, motivo: d.motivo ?? null, creado_en: d.creado_en, superada_en: d.superada_en ?? null, supersede_a: d.supersede_a ?? null })),
        evidencia,
      };
    });

    // ───────────────────────── decidir ─────────────────────────
    sub.post<{ Params: { id: string } }>(`${PREFIJO_IDENTIDAD}/casos/:id/decisiones`, async (req, reply) => {
      const auth = await autenticar(req, reply, 'POST'); if (!auth) return reply;
      let datos: unknown;
      try { datos = JSON.parse((Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)).toString('utf8')); }
      catch { return error(req, reply, 400, 'invalid_body', 'El cuerpo no es JSON.'); }
      const d = Decision.safeParse(datos);
      if (!d.success || !z.uuid().safeParse(req.params.id).success) return error(req, reply, 422, 'invalid_body', 'La decisión no es válida.');
      const clave = req.headers['idempotency-key'];
      if (typeof clave !== 'string' || clave.length < 8 || clave.length > 200) {
        return error(req, reply, 422, 'idempotency_key_requerida', 'Falta la cabecera Idempotency-Key.');
      }
      const motivo = d.data.confirmar
        ? PREFIJO_MOTIVO_CONFIRMAR + (d.data.motivo ?? 'sku ya vinculado')
        : d.data.motivo;
      const r = await decidirCaso(pool, {
        caseId: req.params.id, expectedVersion: d.data.expected_version, eleccion: d.data.eleccion,
        ...(d.data.variant_id ? { variantId: d.data.variant_id } : {}), actor: d.data.actor.usuario, esAdmin: d.data.actor.es_admin,
        ...(motivo ? { motivo } : {}), idempotencyKey: clave, ...(d.data.revierte ? { revierte: d.data.revierte } : {}),
      }, { bandeja });
      if (r.ok) return reply.code(200).send({ decision_id: r.decisionId, version: r.version, vinculo: r.vinculo });
      return error(req, reply, STATUS_DECISION[r.code], r.code, `No se pudo decidir: ${r.code}.`, r.details ? { details: r.details } : {});
    });

    // ───────────────────────── buscar otra variante ─────────────────────────
    sub.get(`${PREFIJO_IDENTIDAD}/variantes`, async (req, reply) => {
      const auth = await autenticar(req, reply, 'GET'); if (!auth) return reply;
      const q = ConsultaVariantes.safeParse(req.query);
      if (!q.success) return error(req, reply, 422, 'invalid_query', 'Falta el texto a buscar.');
      const patron = '%' + q.data.q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      const r = await pool.query<Fila>(
        `SELECT v.id AS variant_id, v.sku, m.titulo,
                (SELECT url FROM catalog.model_images i WHERE i.model_id = v.model_id AND i.vigente_hasta IS NULL
                  ORDER BY i.orden NULLS LAST, i.id LIMIT 1) AS foto,
                w.precio, w.moneda, w.stock_canal AS stock
           FROM catalog.sellable_variants v
           JOIN catalog.product_models m ON m.id = v.model_id
           LEFT JOIN LATERAL (SELECT precio, moneda, stock_canal FROM catalog.external_representations
                               WHERE variant_id = v.id AND canal = 'woocommerce' AND archivado_en IS NULL
                               ORDER BY observado_en DESC LIMIT 1) w ON true
          WHERE v.company_id = $1 AND v.archivado_en IS NULL AND (upper(trim(v.sku)) = upper(trim($2)) OR m.titulo ILIKE $3)
          ORDER BY (upper(trim(v.sku)) = upper(trim($2))) DESC, m.titulo, v.sku LIMIT 20`, [auth.empresa, q.data.q, patron]);
      return { variantes: r.rows.map((f) => ({ variant_id: f.variant_id, sku: f.sku ?? null, titulo: f.titulo, foto: f.foto ?? null,
        precio: f.precio ?? null, moneda: f.moneda ?? null, stock: f.stock ?? null })) };
    });
  });
}
