import express from 'express';
import { mlFetch } from '../lib/mlClient.js';
import { migrateClaimsBackbone } from '../migrations/029_claims_backbone_p1.mjs';

// Notificaciones ML (webhooks): preguntas, mensajes y reclamos sin resolver.
// Ver docs/superpowers/plans (sesión 2026-08-26) — la app de ML tiene TODOS los topics
// seleccionados en el panel; POST /api/ml/notificacion (server.js) filtra por topic y solo
// procesa los que ya tienen función acá (`questions`, `messages`, `claims`, `post_purchase`). Sumar un topic nuevo
// es: función acá + un `if (topic===...)` en server.js, sin volver a tocar el panel de ML.
//
// Alcance decidido con el usuario: solo LISTAR con "hace cuánto" y link directo a
// Mercado Libre para responder ahí — no se responde desde esta herramienta.

const now = () => new Date().toISOString();

function upsertInboxUnico(db, { eventId, resourceId, title, preview, at, occurredAt = at, payloadVersion = 'v1', leaseGuard = null }) {
  const hasKind = db.prepare('PRAGMA table_info(inbox_items)').all().some((column) => column.name === 'kind');
  const kind = String(resourceId).startsWith('claim:') ? 'reclamo'
    : String(resourceId).startsWith('question:') ? 'pregunta'
      : String(resourceId).startsWith('message:') ? 'mensaje' : 'otro';
  if (leaseGuard && !leaseGuard()) throw Object.assign(new Error('lease vencido'), { code: 'lease_expired', retryable: true });
  const existente = db.prepare("SELECT inbox_id, event_id, status, version, updated_at FROM inbox_items WHERE channel='ml' AND resource_id=? ORDER BY inbox_id LIMIT 1").get(String(resourceId));
  if (existente) {
    const anterior = db.prepare('SELECT occurred_at, payload_version FROM integration_events WHERE event_id=?').get(existente.event_id);
    const incomingVersion = Number.parseInt(String(payloadVersion).replace(/\D/g, ''), 10) || 1;
    const previousVersion = Number.parseInt(String(anterior?.payload_version || 'v1').replace(/\D/g, ''), 10) || 1;
    const newer = incomingVersion > previousVersion
      || (incomingVersion === previousVersion && String(occurredAt || '') > String(anterior?.occurred_at || ''));
    if (!newer) return existente.event_id;
    if (leaseGuard && !leaseGuard()) throw Object.assign(new Error('lease vencido'), { code: 'lease_expired', retryable: true });
    if (hasKind) {
      db.prepare(`UPDATE inbox_items SET event_id=?, title=?, preview=?, kind=?, version=version+1, updated_at=? WHERE inbox_id=?`)
        .run(eventId, title, preview || null, kind, at, existente.inbox_id);
    } else {
      db.prepare(`UPDATE inbox_items SET event_id=?, title=?, preview=?, version=version+1, updated_at=? WHERE inbox_id=?`)
        .run(eventId, title, preview || null, at, existente.inbox_id);
    }
    return existente.inbox_id;
  }
  if (leaseGuard && !leaseGuard()) throw Object.assign(new Error('lease vencido'), { code: 'lease_expired', retryable: true });
  if (hasKind) {
    return db.prepare(`INSERT OR IGNORE INTO inbox_items
      (event_id,channel,resource_id,title,preview,status,kind,version,created_at,updated_at)
      VALUES (?,?,?,?,?,'unread',?,1,?,?)`).run(eventId, 'ml', String(resourceId), title, preview || null,
        kind, at, at).lastInsertRowid;
  }
  return db.prepare(`INSERT OR IGNORE INTO inbox_items
    (event_id,channel,resource_id,title,preview,status,version,created_at,updated_at)
    VALUES (?,?,?,?,?,'unread',1,?,?)`).run(eventId, 'ml', String(resourceId), title, preview || null, at, at).lastInsertRowid;
}

function proyectarClaimEnBackbone(db, { claimId, estado, titulo, detalle, ocurridoEn, backboneEvent = null }, txDb = null) {
  const target = txDb || db;
  const recibidoEn = now();
  const dedupeKey = `ml:claim:${claimId}:${estado}`;
  const eventId = `ml-claim-${claimId}-${estado}`;
  const correlationId = `ml-claim-${claimId}`;
  const guardar = () => {
    if (backboneEvent) {
      upsertInboxUnico(target, { eventId: backboneEvent.event_id, resourceId: `claim:${claimId}`,
        title: titulo || `Reclamo ${claimId}`, preview: detalle, at: backboneEvent.occurred_at || ocurridoEn || recibidoEn,
        occurredAt: backboneEvent.occurred_at || ocurridoEn || recibidoEn, payloadVersion: backboneEvent.payload_version || 'v1' });
      return;
    }
    target.prepare(`INSERT OR IGNORE INTO integration_events
      (event_id,event_type,channel,source,external_event_id,resource_id,payload_version,
       occurred_at,received_at,correlation_id,dedupe_key,metadata_json,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      eventId, 'claim.received', 'ml', 'mercadolibre', claimId, claimId, 'v1',
      ocurridoEn || recibidoEn, recibidoEn, correlationId, dedupeKey,
      JSON.stringify({ estado, titulo: titulo || null }), 'pending'
    );
    const evento = backboneEvent
      ? target.prepare('SELECT event_id FROM integration_events WHERE event_id = ?').get(backboneEvent.event_id)
      : target.prepare('SELECT event_id FROM integration_events WHERE dedupe_key = ?').get(dedupeKey);
    if (!evento) return;
    target.prepare(`INSERT OR IGNORE INTO integration_jobs
      (event_id,job_type,available_at) VALUES (?,?,?)`).run(evento.event_id, 'claim.project', recibidoEn);
    target.prepare(`INSERT OR IGNORE INTO integration_event_history
      (event_id,stage,to_status,resource_id,correlation_id,safe_message,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(evento.event_id, 'event.persist', 'pending', claimId,
      correlationId, 'claim durable recibido', recibidoEn);
    upsertInboxUnico(target, { eventId: evento.event_id, resourceId: `claim:${claimId}`,
      title: titulo || `Reclamo ${claimId}`, preview: detalle, at: ocurridoEn || recibidoEn, occurredAt: ocurridoEn || recibidoEn, payloadVersion: 'v1' });
  };
  (txDb ? guardar : db.transaction(guardar))();
}

function proyectarPreguntaEnBackbone(db, { preguntaId, estado, texto, itemId, ocurridoEn, backboneEvent = null }, txDb = null) {
  const target = txDb || db;
  const recibidoEn = now();
  const dedupeKey = `ml:question:${preguntaId}:${estado}`;
  const eventId = `ml-question-${preguntaId}-${estado}`;
  const correlationId = `ml-question-${preguntaId}`;
  const guardar = () => {
    if (backboneEvent) {
      upsertInboxUnico(target, { eventId: backboneEvent.event_id, resourceId: `question:${preguntaId}`,
        title: `Pregunta ML${itemId ? ` · ${itemId}` : ''}`, preview: texto, at: backboneEvent.occurred_at || ocurridoEn || recibidoEn,
        occurredAt: backboneEvent.occurred_at || ocurridoEn || recibidoEn, payloadVersion: backboneEvent.payload_version || 'v1' });
      return;
    }
    target.prepare(`INSERT OR IGNORE INTO integration_events
      (event_id,event_type,channel,source,external_event_id,resource_id,payload_version,
       occurred_at,received_at,correlation_id,dedupe_key,metadata_json,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      eventId, 'question.received', 'ml', 'mercadolibre', String(preguntaId), String(preguntaId), 'v1',
      ocurridoEn || recibidoEn, recibidoEn, correlationId, dedupeKey,
      JSON.stringify({ estado, item_id: itemId || null }), 'pending'
    );
    const evento = backboneEvent
      ? target.prepare('SELECT event_id FROM integration_events WHERE event_id = ?').get(backboneEvent.event_id)
      : target.prepare('SELECT event_id FROM integration_events WHERE dedupe_key = ?').get(dedupeKey);
    if (!evento) return;
    target.prepare(`INSERT OR IGNORE INTO integration_jobs
      (event_id,job_type,available_at) VALUES (?,?,?)`).run(evento.event_id, 'question.project', recibidoEn);
    target.prepare(`INSERT OR IGNORE INTO integration_event_history
      (event_id,stage,to_status,resource_id,correlation_id,safe_message,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(evento.event_id, 'event.persist', 'pending', String(preguntaId),
      correlationId, 'pregunta durable recibida', recibidoEn);
    upsertInboxUnico(target, { eventId: evento.event_id, resourceId: `question:${preguntaId}`,
      title: `Pregunta ML${itemId ? ` · ${itemId}` : ''}`, preview: texto, at: ocurridoEn || recibidoEn, occurredAt: ocurridoEn || recibidoEn, payloadVersion: 'v1' });
  };
  (txDb ? guardar : db.transaction(guardar))();
}

export function extraerClaimId(resource) {
  return String(resource || '').match(/\/claims\/([A-Za-z0-9_-]+)(?:[/?#]|$)/)?.[1] || null;
}

function guardarReclamoMinimo(db, id, recurso, backboneEvent = null, leaseGuard = null) {
  const falladoEn = now();
  const existente = db.prepare('SELECT intentos FROM ml_reclamos WHERE id = ?').get(id);
  const minutos = Math.min(1440, 10 * (2 ** Math.min(existente?.intentos || 0, 7)));
  const proximo = new Date(Date.now() + minutos * 60 * 1000).toISOString();
  db.transaction(() => {
  if (leaseGuard && !leaseGuard()) throw Object.assign(new Error('lease vencido'), { code: 'lease_expired', retryable: true });
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
  // El webhook ya creó el único evento/job durable. Solo enriquecemos su metadata;
  // nunca creamos un evento derivado cuando la consulta a ML falla.
  if (backboneEvent) {
    db.prepare(`UPDATE integration_events SET metadata_json=?, status='pending' WHERE event_id=?`)
      .run(JSON.stringify({ ...(JSON.parse(backboneEvent.metadata_json || '{}')), claim_id: String(id), claim_status: 'sin_consultar', last_error: 'ml_fetch_failed' }), backboneEvent.event_id);
  }
  })();
}

// Exportada para que los tests creen el mismo esquema que usa producción en lugar de una
// copia escrita a mano, que puede divergir sin que nadie lo note.
export function ensureTables(db) {
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
  // Algunas integraciones invocan este router con una DB desnuda (tests y workers aislados);
  // asegurar también el backbone mantiene el contrato sin depender del bootstrap del servidor.
  migrateClaimsBackbone(db);
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
/**
 * Red de reconciliación de preguntas: trae de ML las SIN RESPONDER y persiste las que falten.
 *
 * Las preguntas se poblaban únicamente por webhook, y ML no garantiza entrega ni orden. Un
 * aviso perdido era una consulta de cliente que no aparecía nunca y de la que nadie se
 * enteraba. Medido el 2026-09-06 contra la API: de 10 preguntas sin responder, **6 no estaban
 * en la base** — algunas de marzo, abril y mayo.
 *
 * Se pide sólo `status=UNANSWERED` a propósito: es el subconjunto que exige acción humana, y
 * mantiene el costo en UNA llamada por corrida (el histórico son 1111 preguntas y traerlo no
 * aportaría nada). Endpoint verificado en vivo:
 * `GET /questions/search?seller_id=&api_version=4&status=UNANSWERED`.
 *
 * Idempotente: el mismo upsert que usa el camino del webhook, con la misma guarda de no pisar
 * una respondida con una no respondida.
 */
export async function reconciliarPreguntasMl(db, mlCfg, { limite = 50 } = {}) {
  ensureTables(db);
  if (!mlCfg?.userId) return { omitido: true, motivo: 'sin userId' };
  const resp = await mlFetch(db, mlCfg, 'get',
    `/questions/search?seller_id=${mlCfg.userId}&api_version=4&status=UNANSWERED&limit=${limite}`);
  if (resp.status !== 200 || !Array.isArray(resp.data?.questions)) {
    return { omitido: true, motivo: `http_${resp.status}` };
  }
  const ts = now();
  let recuperadas = 0, vistas = 0, descartadas = 0;
  const upsert = db.prepare(`
    INSERT INTO ml_preguntas (id, item_id, texto, estado, fecha_creacion, respondida_en, actualizado_en)
    VALUES (@id, @item_id, @texto, @estado, @fecha_creacion, NULL, @actualizado_en)
    ON CONFLICT(id) DO UPDATE SET
      item_id=excluded.item_id, texto=excluded.texto, estado=excluded.estado,
      actualizado_en=excluded.actualizado_en
    WHERE excluded.actualizado_en >= ml_preguntas.actualizado_en
      AND NOT (ml_preguntas.estado = 'ANSWERED' AND excluded.estado <> 'ANSWERED')
  `);
  db.transaction(() => {
    for (const q of resp.data.questions) {
      if (!q?.id) continue;
      // `deleted_from_listing` = la pregunta se eliminó de la publicación (documentación
      // oficial de ML). No es trabajo pendiente y no se puede responder: traerla sería ruido
      // inaccionable en una bandeja. Medido el 2026-09-06: 2 de las 6 que faltaban estaban en
      // este estado, incluida una que a primera vista parecía un aviso perdido legítimo.
      if (q.deleted_from_listing === true) {
        // Si además ya estaba guardada como pendiente, se cierra: el comprador la borró y no
        // hay nada que responder, pero seguía contando como trabajo. Sin esto quedaba en la
        // bandeja para siempre —una de las 9 que figuraban sin responder era exactamente eso—.
        db.prepare("UPDATE ml_preguntas SET respondida_en=?, estado='DELETED', actualizado_en=? WHERE id=? AND COALESCE(respondida_en,'')=''")
          .run(ts, ts, q.id);
        descartadas += 1; continue;
      }
      // `hold` = la pregunta está retenida por ML y todavía no corresponde actuar sobre ella.
      if (q.hold === true) { descartadas += 1; continue; }
      vistas += 1;
      const existia = db.prepare('SELECT 1 FROM ml_preguntas WHERE id=?').get(q.id);
      upsert.run({ id: q.id, item_id: q.item_id || null, texto: q.text || '',
        estado: q.status || 'UNANSWERED', fecha_creacion: q.date_created || null, actualizado_en: ts });
      if (!existia) recuperadas += 1;
    }
  })();
  // Y CERRAR las que ya no están sin responder. Sin esto la red sólo agrega: una pregunta que
  // se contesta después queda como pendiente para siempre y le fabrica trabajo falso al
  // operario. Lo detectó el usuario el 2026-09-06 — cuatro de las que le mostramos ya estaban
  // respondidas en ML.
  //
  // ML sólo devuelve las UNANSWERED, así que su lista es la autoridad de "sigue sin responder".
  // Guarda importante: si el total supera lo que trajo esta página, NO se cierra nada — una
  // pregunta ausente podría estar en la página siguiente y no respondida, y cerrarla sería
  // afirmar algo que no sabemos.
  const totalMl = resp.data.total ?? null;
  const completa = totalMl == null || totalMl <= resp.data.questions.length;
  let cerradas = 0;
  if (completa) {
    const vivas = new Set(resp.data.questions.map((q) => String(q.id)));
    const nuestras = db.prepare("SELECT id FROM ml_preguntas WHERE estado='UNANSWERED'").all();
    const cerrar = db.prepare("UPDATE ml_preguntas SET estado='ANSWERED', respondida_en=?, actualizado_en=? WHERE id=?");
    db.transaction(() => {
      for (const r of nuestras) {
        if (vivas.has(String(r.id))) continue;
        cerrar.run(ts, ts, r.id);
        cerradas += 1;
      }
    })();
  }

  // Sólo se avisa cuando hubo algo que hacer: si el webhook está cubriendo, esto es mudo.
  if (recuperadas || cerradas) {
    console.log(`[reconciliar-preguntas] +${recuperadas} recuperada(s), -${cerradas} ya respondida(s), de ${vistas} accionables (${descartadas} descartada(s))`);
  }
  return { omitido: false, vistas, recuperadas, cerradas, descartadas, total_ml: totalMl };
}

export async function ingerirPregunta(db, mlCfg, resource, backboneEvent = null, options = {}) {
  ensureTables(db);
  const m = String(resource || '').match(/\/questions\/(\d+)/);
  if (!m) return false;
  const resp = await mlFetch(db, mlCfg, 'get', `/questions/${m[1]}`);
  if (resp.status !== 200 || !resp.data) return false;
  const q = resp.data;
  const estado = q.status || 'UNKNOWN';
  const actualizadoEn = now();
  db.transaction(() => {
    if (options.leaseGuard && !options.leaseGuard()) throw Object.assign(new Error('lease vencido'), { code: 'lease_expired', retryable: true });
    db.prepare(`
      INSERT INTO ml_preguntas (id, item_id, texto, estado, fecha_creacion, respondida_en, actualizado_en)
      VALUES (@id, @item_id, @texto, @estado, @fecha_creacion, @respondida_en, @actualizado_en)
      ON CONFLICT(id) DO UPDATE SET
        item_id=excluded.item_id, texto=excluded.texto, estado=excluded.estado,
        respondida_en=excluded.respondida_en, actualizado_en=excluded.actualizado_en
      WHERE excluded.actualizado_en >= ml_preguntas.actualizado_en
        AND NOT (ml_preguntas.estado = 'ANSWERED' AND excluded.estado <> 'ANSWERED')
    `).run({
      id: q.id, item_id: q.item_id || null, texto: q.text || '', estado,
      fecha_creacion: q.date_created || null,
      respondida_en: estado === 'ANSWERED' ? (q.answer?.date_created || actualizadoEn) : null,
      actualizado_en: actualizadoEn,
    });
    proyectarPreguntaEnBackbone(db, {
      preguntaId: q.id, estado, texto: q.text || '', itemId: q.item_id, ocurridoEn: q.date_created, backboneEvent,
    }, db);
  })();
  return true;
}

// GET <resource> de la notificación de messages — implementación mínima: guarda lo que
// venga, sin asumir de más el shape hasta ver notificaciones reales en producción (el
// contrato exacto de `resource` para `messages` varía según sea venta simple o pack).
/**
 * Trae los mensajes post-venta pendientes y los proyecta.
 *
 * El camino del webhook nunca funcionó y no puede funcionar: para el topic `messages` ML manda
 * como `resource` el id del mensaje pelado, y ese id **no se puede resolver con credenciales de
 * vendedor**. Verificado contra la API el 2026-09-06: `/marketplace/messages/{id}` devuelve 403
 * `Invalid caller.id` —ese recurso es para apps de mensajería de marketplace— y `/messages/{id}`
 * devuelve 404. Los 39 jobs muertos ni siquiera llegaban ahí: concatenaban el id a la base y
 * pedían el host inexistente `api.mercadolibre.com01a0725…`.
 *
 * La vía del vendedor es la que documenta ML: `/messages/unread` lista las conversaciones con
 * pendientes y cada una se lee por pack. Al no depender del aviso, además repara los mensajes
 * que se hayan perdido mientras esto estuvo roto.
 *
 * `mark_as_read=false` es obligatorio: sin ese parámetro, LEER marca los mensajes como leídos en
 * MercadoLibre. Una reconciliación que corre sola no puede decidir por una persona que ya vio un
 * mensaje.
 */
export async function reconciliarMensajesMl(db, mlCfg, { limite = 20 } = {}) {
  ensureTables(db);
  if (!mlCfg?.userId) return { omitido: true, motivo: 'sin userId' };
  const resp = await mlFetch(db, mlCfg, 'get', '/messages/unread?role=seller&tag=post_sale');
  if (resp.status !== 200 || !Array.isArray(resp.data?.results)) {
    return { omitido: true, motivo: `http_${resp.status}` };
  }
  // `resource` viene como `/packs/{pack}/sellers/{seller}`: se usa tal cual en vez de rearmarlo,
  // que es exactamente el error que dejó 39 jobs muertos.
  const pendientes = resp.data.results.slice(0, limite);
  let packs = 0;
  let mensajes = 0;
  for (const r of pendientes) {
    const recurso = String(r?.resource || '').trim();
    if (!/^\/packs\/[^/]+\/sellers\/[^/]+$/.test(recurso)) continue;
    const detalle = await mlFetch(db, mlCfg, 'get', `/messages${recurso}?tag=post_sale&mark_as_read=false`);
    if (detalle.status !== 200 || !Array.isArray(detalle.data?.messages)) continue;
    packs += 1;
    // El detalle no repite el pack en cada mensaje, así que se pasa desde el recurso: sin él
    // la bandeja no puede vincular la conversación con su pedido.
    const pack = recurso.split('/')[2];
    mensajes += proyectarMensajes(db, detalle.data.messages, { packId: pack });
  }
  return { ok: true, pendientes: resp.data.total ?? pendientes.length, packs, mensajes };
}

export async function ingerirMensaje(db, mlCfg, resource, options = {}) {
  ensureTables(db);
  if (!resource) return false;
  const resp = await mlFetch(db, mlCfg, 'get', resource);
  if (resp.status !== 200 || !resp.data) return false;
  if (options.leaseGuard && !options.leaseGuard()) return false;
  const msgs = Array.isArray(resp.data) ? resp.data : (resp.data.messages || [resp.data]);
  proyectarMensajes(db, msgs, options);
  return true;
}

/**
 * Upsert de mensajes, compartido por el camino del webhook y el de la reconciliación.
 *
 * La guarda `excluded.actualizado_en >= ml_mensajes.actualizado_en` evita que una lectura vieja
 * pise una más nueva cuando las dos vías tocan el mismo mensaje.
 */
/** Pedido ML al que pertenece un pack, para que la conversación quede unida a su venta. */
function packDeOrden(db, packId) {
  if (!packId) return null;
  try {
    return db.prepare("SELECT ml_order_id FROM pedidos_cache WHERE pack_id=? LIMIT 1").get(String(packId))?.ml_order_id || null;
  } catch { return null; }
}

function proyectarMensajes(db, msgs, options = {}) {
  let n = 0;
  db.transaction(() => {
  if (options.leaseGuard && !options.leaseGuard()) throw Object.assign(new Error('lease vencido'), { code: 'lease_expired', retryable: true });
  for (const msg of msgs) {
    if (!msg?.id) continue;
    n += 1;
    db.prepare(`
      INSERT INTO ml_mensajes (id, pack_id, order_id, texto, de_quien, fecha_creacion, respondido_en, actualizado_en)
      VALUES (@id, @pack_id, @order_id, @texto, @de_quien, @fecha_creacion, @respondido_en, @actualizado_en)
      ON CONFLICT(id) DO UPDATE SET
        texto=excluded.texto, de_quien=excluded.de_quien,
        respondido_en=excluded.respondido_en, actualizado_en=excluded.actualizado_en
      WHERE excluded.actualizado_en >= ml_mensajes.actualizado_en
    `).run({
      id: String(msg.id), pack_id: msg.pack_id ? String(msg.pack_id) : (options.packId || null),
      order_id: msg.order_id ? String(msg.order_id) : (packDeOrden(db, msg.pack_id || options.packId) || null),
      texto: msg.text?.plain || msg.text || '',
      de_quien: msg.from?.user_id ? String(msg.from.user_id) : null,
      fecha_creacion: msg.message_date?.created || msg.date_created || null,
      respondido_en: msg.status === 'read' ? (msg.message_date?.available || null) : null,
      actualizado_en: now(),
    });
    if (options.leaseGuard && !options.leaseGuard()) throw Object.assign(new Error('lease vencido'), { code: 'lease_expired', retryable: true });
    if (options.eventId) upsertInboxUnico(db, { eventId: options.eventId,
      resourceId: `message:${msg.pack_id || msg.order_id || msg.id}`, title: 'Mensaje ML',
      preview: msg.text?.plain || msg.text || '', at: now(), occurredAt: msg.message_date?.created || msg.date_created || now(), leaseGuard: options.leaseGuard });
  }
  })();
  return n;
}

// GET /post-purchase/v1/claims/{id} (endpoint vigente). Soporta topics legacy y post_purchase.
// Fail-open: un fallo de ML no debe impedir el 200 del webhook.
// Idempotencia: el upsert evita duplicados; el estado del GET autoritativo de ML gana,
// incluso si ML reabre realmente un reclamo cerrado.
export async function ingerirReclamo(db, mlCfg, resource, originalResource = resource, backboneEvent = null, options = {}) {
  ensureTables(db);

  // Extraer claim_id: soporta /claims/{id}, /v1/claims/{id}, /post-purchase/v1/claims/{id}.
  // El patrón captura cualquier camino que termine con un id numérico/alfanumérico.
  const claimId = extraerClaimId(resource);
  if (!claimId) {
    console.warn('[notif-ml] claim resource sin claim_id');
    return false;
  }

  // Consultar el endpoint vigente: /post-purchase/v1/claims/{id}.
  // Fail-open si no existe o la consulta falla.
  let resp;
  try {
    resp = await mlFetch(db, mlCfg, 'get', `/post-purchase/v1/claims/${claimId}`);
  } catch (err) {
    // Fail-open: el ACK ya fue respondido; registrar solo diagnóstico seguro.
    console.warn(`[notif-ml] claim ${claimId}: error consultando ML: ${err?.message || 'error_controlado'}`);
    guardarReclamoMinimo(db, claimId, originalResource, backboneEvent, options.leaseGuard);
    return false;
  }

  if (resp.status !== 200) {
    console.warn(`[notif-ml] claim ${claimId}: ML respondió status ${resp.status}`);
    guardarReclamoMinimo(db, claimId, originalResource, backboneEvent, options.leaseGuard);
    return false;
  }
  if (!resp.data?.id) {
    console.warn(`[notif-ml] claim ${claimId}: respuesta de ML sin id`);
    guardarReclamoMinimo(db, claimId, originalResource, backboneEvent, options.leaseGuard);
    return false;
  }

  const c = resp.data;
  const canonicalId = String(c.id);
  if (canonicalId !== claimId) {
    console.warn(`[notif-ml] claim ${claimId}: ML devolvió id canónico ${canonicalId}`);
  }

  // Estados reales: 'opened' y 'closed'. Cualquier otro se conserva tal cual.
  const estado = String(c.status || 'unknown').toLowerCase();

  // Un reclamo está cerrado si el estado es explícitamente 'closed'.
  // No usamos 'stage' como fallback ni mapeamos otros valores a cerrado.
  const ahora_cerrado = estado.toLowerCase() === 'closed';
  const proveedorEn = c.updated_at || c.date_created || c.created_at || null;
  const previo = db.prepare('SELECT estado, cerrado_en FROM ml_reclamos WHERE id=?').get(canonicalId);
  if (previo?.estado === 'closed' && !ahora_cerrado
      && (!proveedorEn || !previo.cerrado_en || String(proveedorEn) <= String(previo.cerrado_en))) {
    if (backboneEvent) {
      if (options.leaseGuard && !options.leaseGuard()) throw Object.assign(new Error('lease vencido'), { code: 'lease_expired', retryable: true });
      db.prepare("UPDATE integration_events SET metadata_json=json_set(metadata_json,'$.projection','ignored_stale') WHERE event_id=?").run(backboneEvent.event_id);
    }
    return true;
  }

  // Persistir: incluir type, reason_id, resource_id si vienen en el payload.
  db.transaction(() => {
  if (options.leaseGuard && !options.leaseGuard()) throw Object.assign(new Error('lease vencido'), { code: 'lease_expired', retryable: true });
  // La fila provisional se elimina dentro de la misma transacción y después de
  // validar el lease. Si vence durante el GET/canonicalización, el rollback conserva
  // la fila original para que otro intento pueda procesarla.
  if (canonicalId !== claimId) {
    db.prepare('DELETE FROM ml_reclamos WHERE id = ? AND consultado_en_ml = 0').run(claimId);
  }
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
    WHERE excluded.actualizado_en >= ml_reclamos.actualizado_en
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
  proyectarClaimEnBackbone(db, {
    claimId: canonicalId, backboneEvent,
    estado,
    titulo: c.title || c.reason,
    detalle: c.description || c.message,
    ocurridoEn: c.date_created || c.created_at,
  }, db);
  })();
  return true;
}

export async function reintentarReclamosSinConsultar(db, mlCfg, limite = 10) {
  ensureTables(db);
  const filas = db.prepare("SELECT id, recurso FROM ml_reclamos WHERE ultimo_error_en IS NOT NULL AND (proximo_intento_en IS NULL OR proximo_intento_en <= ?) ORDER BY proximo_intento_en ASC LIMIT ?").all(now(), limite);
  for (const fila of filas) {
    // Buscar evento por recurso normalizado: siempre guardamos /post-purchase/v1/claims/{id}.
    const claimResourceNormalized = `/post-purchase/v1/claims/${fila.id}`;
    const evento = db.prepare(`
      SELECT * FROM integration_events
      WHERE resource_id = ?
      ORDER BY received_at DESC LIMIT 1
    `).get(claimResourceNormalized);
    await ingerirReclamo(db, mlCfg, fila.recurso || `/claims/${fila.id}`, fila.recurso || `/claims/${fila.id}`, evento || null);
  }
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

  /**
   * Jobs de integración que agotaron sus reintentos y quedaron muertos.
   *
   * Hasta ahora NADA los mostraba ni los reclamaba: un job en `dead_lettered` se quedaba ahí
   * para siempre y nadie se enteraba. Es la brecha 6 del documento de arquitectura («formalizar
   * outbox, dead-letter y métricas de eventos perdidos») y la primera evidencia concreta de que
   * hacía falta fueron 39 mensajes y 3 preguntas muertos que sólo aparecieron porque alguien
   * fue a mirar la base a mano.
   *
   * Se agrupa por tipo y motivo en vez de listar todo: lo que importa operativamente es «qué
   * clase de cosa está fallando y desde cuándo», no el detalle de cada fila.
   */
  /**
   * Devuelve a la cola los jobs que agotaron sus reintentos.
   *
   * Un `dead_lettered` no se recupera solo: el worker no lo mira más. Cuando la causa se
   * arregla —los 39 de `message.project` pedían un host inexistente, los 3 de
   * `question.project` fueron un fallo transitorio del 30/08 que hoy responde 200— el trabajo
   * sigue perdido hasta que alguien los reencola.
   *
   * `limite` acota la tanda a propósito: cada job reencolado es al menos una llamada a ML, y
   * soltar decenas de golpe contra una API que ya nos bloqueó una vez es exactamente lo que no
   * hay que hacer. `attempts` vuelve a 0 y se sueltan los locks, o el worker lo saltearía por
   * lease ajeno.
   */
  router.post('/dead-letters/reintentar', (req, res) => {
    if (!req.user?.is_admin) return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Sólo Administración' });
    const hay = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integration_jobs'").get();
    if (!hay) return res.json({ ok: true, reencolados: 0 });
    const tipo = String(req.body?.job_type || '').trim();
    const limite = Math.max(1, Math.min(50, Number(req.body?.limite) || 10));
    const ids = db.prepare(`SELECT job_id FROM integration_jobs
      WHERE status='dead_lettered' ${tipo ? 'AND job_type=?' : ''}
      ORDER BY job_id LIMIT ?`).all(...(tipo ? [tipo, limite] : [limite])).map((r) => r.job_id);
    if (ids.length === 0) return res.json({ ok: true, reencolados: 0 });
    const ts = now();
    db.transaction(() => {
      db.prepare(`UPDATE integration_jobs
        SET status='pending', attempts=0, available_at=?, locked_at=NULL, locked_by=NULL,
            lease_until=NULL, lease_token=NULL, last_error_code=NULL, last_error_message=NULL
        WHERE job_id IN (${ids.map(() => '?').join(',')})`).run(ts, ...ids);
    })();
    return res.json({ ok: true, reencolados: ids.length, job_type: tipo || null });
  });

  router.get('/dead-letters', (req, res) => {
    const hay = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integration_jobs'").get();
    if (!hay) return res.json({ ok: true, total: 0, grupos: [] });
    const grupos = db.prepare(`
      SELECT j.job_type, COUNT(*) AS n,
             MIN(e.received_at) AS primero, MAX(e.received_at) AS ultimo,
             (SELECT h.safe_message FROM integration_event_history h
               WHERE h.event_id = j.event_id AND h.to_status='dead_lettered'
               ORDER BY h.created_at DESC LIMIT 1) AS motivo
        FROM integration_jobs j
        JOIN integration_events e ON e.event_id = j.event_id
       WHERE j.status='dead_lettered'
       GROUP BY j.job_type
       ORDER BY n DESC
    `).all();
    res.json({ ok: true, total: grupos.reduce((a, g) => a + g.n, 0), grupos });
  });

  // Conteo liviano — pensado para el aviso del Home (mismo patrón que otros contadores
  // livianos del proyecto, ej. push-skus-pendientes/count).
  router.get('/count', (req, res) => {
    const preguntas = db.prepare("SELECT COUNT(*) n FROM ml_preguntas WHERE estado='UNANSWERED'").get().n;
    // Cuántas de esas son de publicaciones que hoy NO se pueden vender (pausadas o sin stock).
    // Decisión del usuario (2026-09-06): se traen todas —una consulta sin responder lo es
    // igual, y dice qué quiere gente que no tenemos— pero se separan, para que no compitan
    // con las que sí se resuelven vendiendo. Medido ese día: de 6 preguntas que el webhook
    // nunca trajo, 5 eran de publicaciones pausadas sin stock.
    // `LEFT JOIN` + `IS NOT NULL`: una publicación que ni siquiera está en el cache no se
    // cuenta como "sin stock" — no sabemos nada de ella, y afirmarlo sería inventar.
    // Si el cache de publicaciones no está (contextos mínimos, sin el esquema completo) se
    // devuelve `null` = "no sé", nunca 0. Cero afirmaría que ninguna está sin stock, y eso
    // sería inventarlo. Se chequea la tabla en vez de envolver en try/catch, que además
    // taparía errores de verdad.
    const hayCache = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ml_publicaciones_cache'").get();
    const preguntasSinStock = !hayCache ? null : db.prepare(`
      SELECT COUNT(*) n FROM ml_preguntas q
      WHERE q.estado='UNANSWERED' AND EXISTS (
        SELECT 1 FROM ml_publicaciones_cache p
        WHERE p.item_id = q.item_id
          AND (p.status <> 'active' OR COALESCE(p.available_quantity,0) = 0))
    `).get().n;
    // Jobs muertos: hasta ahora nada los mostraba. Se cuentan acá para que el aviso del home
    // pueda decirlo sin pedir el detalle.
    const hayJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integration_jobs'").get();
    const dead = !hayJobs ? 0 : db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE status='dead_lettered'").get().n;
    const mensajes = db.prepare('SELECT COUNT(*) n FROM ml_mensajes WHERE respondido_en IS NULL').get().n;
    const reclamos = db.prepare("SELECT COUNT(*) n FROM ml_reclamos WHERE cerrado_en IS NULL AND consultado_en_ml = 1").get().n;
    const reclamosSinConfirmar = db.prepare("SELECT COUNT(*) n FROM ml_reclamos WHERE consultado_en_ml = 0").get().n;
    res.json({ ok: true, preguntas, preguntas_sin_stock: preguntasSinStock, dead_letters: dead, mensajes, reclamos, reclamos_sin_confirmar: reclamosSinConfirmar, total: preguntas + mensajes + reclamos });
  });

  return router;
}
