import express from 'express';
import { mlFetch } from '../lib/mlClient.js';

// Notificaciones ML (webhooks): preguntas, mensajes y reclamos sin resolver.
// Ver docs/superpowers/plans (sesión 2026-08-26) — la app de ML tiene TODOS los topics
// seleccionados en el panel; POST /api/ml/notificacion (server.js) filtra por topic y solo
// procesa los que ya tienen función acá (`questions`, `messages`, `claims`, `post_purchase`). Sumar un topic nuevo
// es: función acá + un `if (topic===...)` en server.js, sin volver a tocar el panel de ML.
//
// Alcance decidido con el usuario: solo LISTAR con "hace cuánto" y link directo a
// Mercado Libre para responder ahí — no se responde desde esta herramienta.

const now = () => new Date().toISOString();

export function extraerClaimId(resource) {
  return String(resource || '').match(/\/claims\/([A-Za-z0-9_-]+)(?:[\/?#]|$)/)?.[1] || null;
}

function guardarReclamoMinimo(db, id, recurso) {
  const falladoEn = now();
  const existente = db.prepare('SELECT intentos FROM ml_reclamos WHERE id = ?').get(id);
  const minutos = Math.min(1440, 10 * (2 ** Math.min(existente?.intentos || 0, 7)));
  const proximo = new Date(Date.now() + minutos * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO ml_reclamos (id, recurso, estado, actualizado_en, consultado_en_ml, ultimo_error_en, intentos, proximo_intento_en)
    VALUES (@id, @recurso, 'sin_consultar', @actualizado_en, 0, @actualizado_en, 1, @proximo_intento_en)
    ON CONFLICT(id) DO UPDATE SET
      recurso=COALESCE(ml_reclamos.recurso, excluded.recurso),
      estado=CASE WHEN ml_reclamos.consultado_en_ml=1 THEN ml_reclamos.estado ELSE excluded.estado END,
      actualizado_en=excluded.actualizado_en,
      ultimo_error_en=excluded.ultimo_error_en,
      intentos=ml_reclamos.intentos + 1,
      proximo_intento_en=excluded.proximo_intento_en
  `).run({ id, recurso: recurso || null, actualizado_en: falladoEn, proximo_intento_en: proximo });
}

function ensureTables(db) {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ml_preguntas (
      id                INTEGER PRIMARY KEY,
      item_id           TEXT,
      texto             TEXT,
      estado            TEXT NOT NULL,
      fecha_creacion    TEXT,
      respondida_en     TEXT,
      actualizado_en    TEXT NOT NULL
    )`).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ml_preguntas_estado ON ml_preguntas(estado)').run();

    db.prepare(`CREATE TABLE IF NOT EXISTS ml_mensajes (
      id                TEXT PRIMARY KEY,
      pack_id           TEXT,
      order_id          TEXT,
      texto             TEXT,
      de_quien          TEXT,
      fecha_creacion    TEXT,
      respondido_en     TEXT,
      actualizado_en    TEXT NOT NULL
    )`).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ml_mensajes_respondido ON ml_mensajes(respondido_en)').run();

    db.prepare(`CREATE TABLE IF NOT EXISTS ml_reclamos (
      id TEXT PRIMARY KEY, recurso TEXT, estado TEXT NOT NULL, titulo TEXT,
      detalle TEXT, fecha_creacion TEXT, cerrado_en TEXT, actualizado_en TEXT NOT NULL,
      type TEXT, reason_id TEXT, resource_id TEXT, consultado_en_ml INTEGER NOT NULL DEFAULT 1,
      ultimo_error_en TEXT, intentos INTEGER NOT NULL DEFAULT 0, proximo_intento_en TEXT
    )`).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ml_reclamos_pendientes ON ml_reclamos(cerrado_en, fecha_creacion)').run();
  } catch (_) { /* ya existen */ }
}

// ── Ingesta desde el webhook (llamadas por server.js al recibir la notificación) ──

// GET /questions/{id} — trae la pregunta y la guarda/actualiza local.
// Fail-open a propósito: si ML no responde, la notificación no se reintenta ni bloquea nada
// más del webhook — la próxima notificación de esa pregunta (respondida, o si el primer
// intento simplemente falló) la va a corregir.
// Limitación conocida (hallazgo del revisor): no se serializa por id. Si dos notificaciones
// del mismo recurso llegan cerca en el tiempo (ML no garantiza orden), los dos GET a ML
// pueden resolver fuera de orden y el más viejo pisar el estado más fresco. Solo importa si
// no vuelve a llegar OTRA notificación que corrija — como esto es un aviso, no una fuente de
// verdad transaccional, el impacto es acotado; si algún día se necesita exactitud fuerte acá,
// serializar por id (ej. una cola/lock simple) antes de confiar ciegamente.
export async function ingerirPregunta(db, mlCfg, resource) {
  ensureTables(db);
  const m = String(resource || '').match(/\/questions\/(\d+)/);
  if (!m) return;
  const resp = await mlFetch(db, mlCfg, 'get', `/questions/${m[1]}`);
  if (resp.status !== 200 || !resp.data) return;
  const q = resp.data;
  db.prepare(`
    INSERT INTO ml_preguntas (id, item_id, texto, estado, fecha_creacion, respondida_en, actualizado_en)
    VALUES (@id, @item_id, @texto, @estado, @fecha_creacion, @respondida_en, @actualizado_en)
    ON CONFLICT(id) DO UPDATE SET
      item_id=excluded.item_id, texto=excluded.texto, estado=excluded.estado,
      respondida_en=excluded.respondida_en, actualizado_en=excluded.actualizado_en
  `).run({
    id: q.id, item_id: q.item_id || null, texto: q.text || '',
    estado: q.status || 'UNKNOWN', fecha_creacion: q.date_created || null,
    respondida_en: q.status === 'ANSWERED' ? (q.answer?.date_created || now()) : null,
    actualizado_en: now(),
  });
}

// GET <resource> de la notificación de messages — implementación mínima: guarda lo que
// venga, sin asumir de más el shape hasta ver notificaciones reales en producción (el
// contrato exacto de `resource` para `messages` varía según sea venta simple o pack).
export async function ingerirMensaje(db, mlCfg, resource) {
  ensureTables(db);
  if (!resource) return;
  const resp = await mlFetch(db, mlCfg, 'get', resource);
  if (resp.status !== 200 || !resp.data) return;
  const msgs = Array.isArray(resp.data) ? resp.data : (resp.data.messages || [resp.data]);
  for (const msg of msgs) {
    if (!msg?.id) continue;
    db.prepare(`
      INSERT INTO ml_mensajes (id, pack_id, order_id, texto, de_quien, fecha_creacion, respondido_en, actualizado_en)
      VALUES (@id, @pack_id, @order_id, @texto, @de_quien, @fecha_creacion, @respondido_en, @actualizado_en)
      ON CONFLICT(id) DO UPDATE SET
        texto=excluded.texto, de_quien=excluded.de_quien,
        respondido_en=excluded.respondido_en, actualizado_en=excluded.actualizado_en
    `).run({
      id: String(msg.id), pack_id: msg.pack_id ? String(msg.pack_id) : null,
      order_id: msg.order_id ? String(msg.order_id) : null,
      texto: msg.text?.plain || msg.text || '',
      de_quien: msg.from?.user_id ? String(msg.from.user_id) : null,
      fecha_creacion: msg.message_date?.created || msg.date_created || null,
      respondido_en: msg.status === 'read' ? (msg.message_date?.available || null) : null,
      actualizado_en: now(),
    });
  }
}

// GET /post-purchase/v1/claims/{id} (endpoint vigente). Soporta topics legacy y post_purchase.
// Fail-open: un fallo de ML no debe impedir el 200 del webhook.
// Idempotencia: el upsert evita duplicados; el estado del GET autoritativo de ML gana,
// incluso si ML reabre realmente un reclamo cerrado.
export async function ingerirReclamo(db, mlCfg, resource, originalResource = resource) {
  ensureTables(db);

  // Extraer claim_id: soporta /claims/{id}, /v1/claims/{id}, /post-purchase/v1/claims/{id}.
  // El patrón captura cualquier camino que termine con un id numérico/alfanumérico.
  const claimId = extraerClaimId(resource);
  if (!claimId) {
    console.warn('[notif-ml] claim resource sin claim_id');
    return;
  }

  // Consultar el endpoint vigente: /post-purchase/v1/claims/{id}.
  // Fail-open si no existe o la consulta falla.
  let resp;
  try {
    resp = await mlFetch(db, mlCfg, 'get', `/post-purchase/v1/claims/${claimId}`);
  } catch (err) {
    // Fail-open: el ACK ya fue respondido; registrar solo diagnóstico seguro.
    console.warn(`[notif-ml] claim ${claimId}: error consultando ML: ${err?.message || 'error_controlado'}`);
    guardarReclamoMinimo(db, claimId, originalResource);
    return;
  }

  if (resp.status !== 200) {
    console.warn(`[notif-ml] claim ${claimId}: ML respondió status ${resp.status}`);
    guardarReclamoMinimo(db, claimId, originalResource);
    return;
  }
  if (!resp.data?.id) {
    console.warn(`[notif-ml] claim ${claimId}: respuesta de ML sin id`);
    guardarReclamoMinimo(db, claimId, originalResource);
    return;
  }

  const c = resp.data;
  const canonicalId = String(c.id);
  if (canonicalId !== claimId) {
    console.warn(`[notif-ml] claim ${claimId}: ML devolvió id canónico ${canonicalId}`);
    db.prepare('DELETE FROM ml_reclamos WHERE id = ? AND consultado_en_ml = 0').run(claimId);
  }

  // Estados reales: 'opened' y 'closed'. Cualquier otro se conserva tal cual.
  const estado = String(c.status || 'unknown').toLowerCase();

  // Un reclamo está cerrado si el estado es explícitamente 'closed'.
  // No usamos 'stage' como fallback ni mapeamos otros valores a cerrado.
  const ahora_cerrado = estado.toLowerCase() === 'closed';

  // Persistir: incluir type, reason_id, resource_id si vienen en el payload.
  db.prepare(`
    INSERT INTO ml_reclamos (
    id, recurso, estado, titulo, detalle, fecha_creacion, cerrado_en, actualizado_en,
      type, reason_id, resource_id, consultado_en_ml
    )
    VALUES (
      @id, @recurso, @estado, @titulo, @detalle, @fecha_creacion, @cerrado_en, @actualizado_en,
      @type, @reason_id, @resource_id, @consultado_en_ml
    )
    ON CONFLICT(id) DO UPDATE SET
      recurso=COALESCE(ml_reclamos.recurso, excluded.recurso),
      estado=excluded.estado,
      titulo=COALESCE(excluded.titulo, ml_reclamos.titulo),
      detalle=COALESCE(excluded.detalle, ml_reclamos.detalle),
      cerrado_en=CASE
        WHEN excluded.cerrado_en IS NULL THEN NULL
        WHEN ml_reclamos.cerrado_en IS NOT NULL THEN ml_reclamos.cerrado_en
        ELSE excluded.cerrado_en
      END,
      actualizado_en=excluded.actualizado_en,
      type=COALESCE(excluded.type, ml_reclamos.type),
      reason_id=COALESCE(excluded.reason_id, ml_reclamos.reason_id),
      resource_id=COALESCE(excluded.resource_id, ml_reclamos.resource_id),
      fecha_creacion=COALESCE(ml_reclamos.fecha_creacion, excluded.fecha_creacion),
      consultado_en_ml=excluded.consultado_en_ml,
      ultimo_error_en=NULL,
      intentos=0,
      proximo_intento_en=NULL
  `).run({
    id: canonicalId,
    recurso: originalResource, // Conservar el recurso original del webhook.
    estado,
    titulo: c.title || c.reason || null,
    detalle: c.description || c.message || null,
    fecha_creacion: c.date_created || c.created_at || null,
    cerrado_en: ahora_cerrado ? (c.date_closed || now()) : null,
    actualizado_en: now(),
    type: c.type || null,
    reason_id: c.reason_id || null,
    resource_id: c.resource_id || null,
    consultado_en_ml: 1,
  });
}

export async function reintentarReclamosSinConsultar(db, mlCfg, limite = 10) {
  ensureTables(db);
  const filas = db.prepare("SELECT id, recurso FROM ml_reclamos WHERE ultimo_error_en IS NOT NULL AND (proximo_intento_en IS NULL OR proximo_intento_en <= ?) ORDER BY proximo_intento_en ASC LIMIT ?").all(now(), limite);
  for (const fila of filas) await ingerirReclamo(db, mlCfg, fila.recurso || `/claims/${fila.id}`);
  return filas.length;
}

// ── Router: lectura para la pantalla / aviso del Home ──

export function notificacionesMlRouter(db) {
  const router = express.Router();
  ensureTables(db);

  router.get('/pendientes', (req, res) => {
    const preguntas = db.prepare(
      "SELECT * FROM ml_preguntas WHERE estado='UNANSWERED' ORDER BY fecha_creacion ASC"
    ).all();
    const mensajes = db.prepare(
      "SELECT * FROM ml_mensajes WHERE respondido_en IS NULL ORDER BY fecha_creacion ASC"
    ).all();
    const reclamos = db.prepare(
      "SELECT * FROM ml_reclamos WHERE cerrado_en IS NULL AND consultado_en_ml = 1 ORDER BY fecha_creacion ASC"
    ).all();
    const reclamosSinConfirmar = db.prepare(
      "SELECT * FROM ml_reclamos WHERE consultado_en_ml = 0 ORDER BY actualizado_en ASC"
    ).all();
    res.json({
      ok: true,
      preguntas,
      mensajes,
      reclamos,
      reclamos_sin_confirmar: reclamosSinConfirmar,
      total: preguntas.length + mensajes.length + reclamos.length,
    });
  });

  // Conteo liviano — pensado para el aviso del Home (mismo patrón que otros contadores
  // livianos del proyecto, ej. push-skus-pendientes/count).
  router.get('/count', (req, res) => {
    const preguntas = db.prepare("SELECT COUNT(*) n FROM ml_preguntas WHERE estado='UNANSWERED'").get().n;
    const mensajes = db.prepare('SELECT COUNT(*) n FROM ml_mensajes WHERE respondido_en IS NULL').get().n;
    const reclamos = db.prepare("SELECT COUNT(*) n FROM ml_reclamos WHERE cerrado_en IS NULL AND consultado_en_ml = 1").get().n;
    const reclamosSinConfirmar = db.prepare("SELECT COUNT(*) n FROM ml_reclamos WHERE consultado_en_ml = 0").get().n;
    res.json({ ok: true, preguntas, mensajes, reclamos, reclamos_sin_confirmar: reclamosSinConfirmar, total: preguntas + mensajes + reclamos });
  });

  return router;
}
