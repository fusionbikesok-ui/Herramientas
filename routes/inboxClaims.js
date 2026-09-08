import express from 'express';
import { detalleDeCaso } from '../lib/inboxDetalle.js';
import { reconocer, reasignar, POLITICA, severidadDe } from '../lib/escalamientoAlertas.js';
import { deepLinkDeCaso } from '../lib/pushCasoPayload.js';

const now = () => new Date().toISOString();

function publicItem(row) {
  return {
    id: String(row.inbox_id), event_id: row.event_id, channel: row.channel,
    resource_id: row.resource_id, title: row.title, preview: row.preview,
    kind: row.kind || 'otro', priority: row.priority || 'normal',
    severidad: severidadDe(row.severidad || row.priority),
    status: row.status, version: row.version, created_at: row.created_at,
    updated_at: row.updated_at,
    acknowledged_at: row.acknowledged_at || null,
    acknowledged_by: row.acknowledged_by == null ? null : String(row.acknowledged_by),
    escalated_at: row.escalated_at || null,
    assigned_user_id: row.assigned_user_id == null ? null : String(row.assigned_user_id),
    area: row.area || null,
    objetivo_minutos: POLITICA[severidadDe(row.severidad || row.priority)].objetivo,
  };
}

export function inboxClaimsRouter(db, authMiddleware) {
  const router = express.Router();
  const auth = authMiddleware;

  router.get('/', auth, (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const cursor = req.query.cursor == null || req.query.cursor === '' ? null : Number(req.query.cursor);
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) {
      return res.status(422).json({ error: { code: 'cursor_invalido', message: 'cursor inválido' } });
    }
    const status = req.query.status;
    const channel = req.query.channel;
    const params = [];
    let where = '(i.assigned_user_id IS NULL OR i.assigned_user_id = ?)';
    params.push(req.user.id);
    if (cursor !== null) { where += ' AND i.inbox_id < ?'; params.push(cursor); }
    if (status) { where += ' AND i.status = ?'; params.push(status); }
    if (channel) { where += ' AND i.channel = ?'; params.push(channel); }
    const rows = db.prepare(`SELECT i.* FROM inbox_items i WHERE ${where}
      ORDER BY CASE COALESCE(i.severidad, i.priority)
                 WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ASC,
               i.created_at ASC, i.inbox_id DESC LIMIT ?`).all(...params, limit + 1);
    const items = rows.slice(0, limit).map(publicItem);
    return res.json({ items, next_cursor: rows.length > limit ? String(rows[limit - 1].inbox_id) : null });
  });

  // Detalle operativo. Va antes de '/:id' porque Express resuelve por orden de registro y
  // '/:id' capturaría 'detail' como si fuera un identificador.
  router.get('/:id/detail', auth, (req, res) => {
    const detalle = detalleDeCaso(db, req.params.id, req.user.id);
    // Mismo 404 para inexistente y para ajeno: distinguirlos revelaría que el caso existe.
    if (!detalle) return res.status(404).json({ error: { code: 'no_encontrado', message: 'caso no encontrado' } });
    return res.json(detalle);
  });

  router.get('/:id', auth, (req, res) => {
    const row = db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = ?)').get(Number(req.params.id), req.user.id);
    if (!row) return res.status(404).json({ error: { code: 'inbox_no_encontrado', message: 'Ítem no encontrado' } });
    return res.json(publicItem(row));
  });

  router.post('/:id/read', auth, (req, res) => {
    const result = db.prepare(`UPDATE inbox_items SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
      version = version + 1, updated_at = ? WHERE inbox_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = ?)`).run(now(), Number(req.params.id), req.user.id);
    if (!result.changes) return res.status(404).json({ error: { code: 'inbox_no_encontrado', message: 'Ítem no encontrado' } });
    return res.json(publicItem(db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ?').get(Number(req.params.id))));
  });

  router.post('/:id/claim', auth, (req, res) => {
    const id = Number(req.params.id);
    const ts = now();
    const result = db.transaction(() => {
      const row = db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ?').get(id);
      if (!row) return { missing: true };
      if (row.assigned_user_id && row.assigned_user_id !== req.user.id) return { conflict: row };
      db.prepare(`UPDATE inbox_items SET assigned_user_id = ?, status = CASE WHEN status='unread' THEN 'read' ELSE status END,
        version = version + 1, updated_at = ? WHERE inbox_id = ?`).run(req.user.id, ts, id);
      const updated = db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ?').get(id);
      db.prepare(`INSERT INTO user_notifications (event_id,inbox_id,user_id,title,body,deep_link,status,created_at)
        SELECT ?,?,?,?,?,?,'pending',? WHERE NOT EXISTS
        (SELECT 1 FROM user_notifications WHERE inbox_id = ? AND user_id = ?)`)
        .run(updated.event_id, id, req.user.id, updated.title, updated.preview,
          deepLinkDeCaso(updated.kind, id), ts, id, req.user.id);
      const notificationId = db.prepare('SELECT notification_id FROM user_notifications WHERE inbox_id = ? AND user_id = ?').get(id, req.user.id).notification_id;
      db.prepare(`INSERT OR IGNORE INTO notification_deliveries
        (notification_id, device_id, provider, status, created_at, updated_at)
        SELECT ?, id, 'push', 'pending', ?, ? FROM device_tokens
        WHERE user_id = ? AND revocado_en IS NULL`).run(notificationId, ts, ts, req.user.id);
      return { updated };
    })();
    if (result.missing) return res.status(404).json({ error: { code: 'inbox_no_encontrado', message: 'Ítem no encontrado' } });
    // No se devuelve el ítem: `title` y `preview` son texto del cliente, y quien recibe este
    // 409 justamente NO tiene acceso al caso. Con el ítem adjunto alcanzaba con probar ids
    // para leer el asunto y el extracto de casos ajenos.
    if (result.conflict) return res.status(409).json({ error: { code: 'inbox_asignado', message: 'El ítem ya está asignado' } });
    return res.json(publicItem(result.updated));
  });

  router.post('/:id/resolve', auth, (req, res) => {
    const expected = Number(req.body?.version);
    if (!Number.isInteger(expected) || expected < 1) {
      return res.status(422).json({ error: { code: 'version_requerida', message: 'version entero requerido' } });
    }
    const result = db.prepare(`UPDATE inbox_items SET status = 'resolved', version = version + 1,
      updated_at = ? WHERE inbox_id = ? AND version = ? AND status != 'archived'
        AND (assigned_user_id IS NULL OR assigned_user_id = ?)`).run(now(), Number(req.params.id), expected, req.user.id);
    if (!result.changes) {
      const row = db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = ?)').get(Number(req.params.id), req.user.id);
      if (!row) return res.status(404).json({ error: { code: 'inbox_no_encontrado', message: 'Ítem no encontrado' } });
      return res.status(409).json({ error: { code: 'version_conflicto', message: 'El ítem cambió; recargá antes de resolver' }, item: publicItem(row) });
    }
    return res.json(publicItem(db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ?').get(Number(req.params.id))));
  });

  // Reconocer NO resuelve. Frena la repetición y deja constancia de quién lo está mirando;
  // el caso sigue abierto y sigue contando como trabajo pendiente (§14).
  router.post('/:id/acknowledge', auth, (req, res) => {
    const resultado = reconocer(db, { inboxId: Number(req.params.id), userId: req.user.id });
    if (resultado.missing) return res.status(404).json({ error: { code: 'inbox_no_encontrado', message: 'Ítem no encontrado' } });
    // Reconocer dos veces devuelve 200 con el reconocimiento original: es idempotente y el
    // segundo intento no debe parecer un error ni pisar quién llegó primero.
    return res.json({ ...publicItem(resultado.item), ya_reconocido: resultado.yaReconocido });
  });

  router.post('/:id/assign', auth, (req, res) => {
    const destino = req.body?.to_user_id;
    if (destino !== null && !Number.isSafeInteger(Number(destino))) {
      return res.status(422).json({ error: { code: 'destino_invalido', message: 'to_user_id debe ser un entero o null' } });
    }
    const esperado = req.body?.expected_version;
    if (esperado !== undefined && !Number.isInteger(esperado)) {
      return res.status(422).json({ error: { code: 'version_invalida', message: 'expected_version debe ser entero' } });
    }
    const resultado = reasignar(db, {
      inboxId: Number(req.params.id),
      aUsuario: destino === null ? null : Number(destino),
      actor: req.user.id,
      motivo: typeof req.body?.motivo === 'string' ? req.body.motivo.slice(0, 300) : null,
      esperado: esperado === undefined ? null : esperado,
    });
    if (resultado.missing) return res.status(404).json({ error: { code: 'inbox_no_encontrado', message: 'Ítem no encontrado' } });
    if (resultado.conflict) {
      return res.status(409).json({ error: { code: 'version_conflicto', message: 'El ítem cambió; recargá antes de reasignar' }, item: publicItem(resultado.conflict) });
    }
    return res.json(publicItem(resultado.item));
  });

  return router;
}
