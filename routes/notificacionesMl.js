import express from 'express';
import { mlFetch } from '../lib/mlClient.js';

// Notificaciones ML (webhooks): preguntas, mensajes y reclamos sin resolver.
// Ver docs/superpowers/plans (sesión 2026-08-26) — la app de ML tiene TODOS los topics
// seleccionados en el panel; POST /api/ml/notificacion (server.js) filtra por topic y solo
// procesa los que ya tienen función acá (`questions`, `messages`, `claims`). Sumar un topic nuevo
// es: función acá + un `if (topic===...)` en server.js, sin volver a tocar el panel de ML.
//
// Alcance decidido con el usuario: solo LISTAR con "hace cuánto" y link directo a
// Mercado Libre para responder ahí — no se responde desde esta herramienta.

const now = () => new Date().toISOString();

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
      detalle TEXT, fecha_creacion TEXT, cerrado_en TEXT, actualizado_en TEXT NOT NULL
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

// GET /claims/{id}. Fail-open: un fallo de ML no debe impedir el 200 del webhook.
export async function ingerirReclamo(db, mlCfg, resource) {
  ensureTables(db);
  const m = String(resource || '').match(/^\/claims\/([^/]+)\/?$/);
  if (!m) return;
  let resp;
  try {
    resp = await mlFetch(db, mlCfg, 'get', `/claims/${m[1]}`);
  } catch (_) {
    return;
  }
  if (resp.status !== 200 || !resp.data?.id) return;
  const c = resp.data;
  const estado = String(c.status || c.stage || 'UNKNOWN');
  const cerrado = ['CLOSED', 'RESOLVED', 'CANCELED', 'CANCELLED'].includes(estado.toUpperCase());
  db.prepare(`
    INSERT INTO ml_reclamos (id, recurso, estado, titulo, detalle, fecha_creacion, cerrado_en, actualizado_en)
    VALUES (@id, @recurso, @estado, @titulo, @detalle, @fecha_creacion, @cerrado_en, @actualizado_en)
    ON CONFLICT(id) DO UPDATE SET recurso=excluded.recurso, estado=excluded.estado,
      titulo=excluded.titulo, detalle=excluded.detalle, cerrado_en=excluded.cerrado_en,
      actualizado_en=excluded.actualizado_en
  `).run({
    id: String(c.id), recurso: `/claims/${m[1]}`, estado,
    titulo: c.title || c.reason || 'Reclamo de MercadoLibre',
    detalle: c.description || c.message || '',
    fecha_creacion: c.date_created || c.created_at || null,
    cerrado_en: cerrado ? (c.date_closed || now()) : null,
    actualizado_en: now(),
  });
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
      'SELECT * FROM ml_reclamos WHERE cerrado_en IS NULL ORDER BY fecha_creacion ASC'
    ).all();
    res.json({
      ok: true,
      preguntas,
      mensajes,
      reclamos,
      total: preguntas.length + mensajes.length + reclamos.length,
    });
  });

  // Conteo liviano — pensado para el aviso del Home (mismo patrón que otros contadores
  // livianos del proyecto, ej. push-skus-pendientes/count).
  router.get('/count', (req, res) => {
    const preguntas = db.prepare("SELECT COUNT(*) n FROM ml_preguntas WHERE estado='UNANSWERED'").get().n;
    const mensajes = db.prepare('SELECT COUNT(*) n FROM ml_mensajes WHERE respondido_en IS NULL').get().n;
    const reclamos = db.prepare('SELECT COUNT(*) n FROM ml_reclamos WHERE cerrado_en IS NULL').get().n;
    res.json({ ok: true, preguntas, mensajes, reclamos, total: preguntas + mensajes + reclamos });
  });

  return router;
}
