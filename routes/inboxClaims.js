import express from 'express';

const now = () => new Date().toISOString();

function publicItem(row) {
  return {
    id: String(row.inbox_id), event_id: row.event_id, channel: row.channel,
    resource_id: row.resource_id, title: row.title, preview: row.preview,
    kind: row.kind || 'otro', priority: row.priority || 'normal',
    status: row.status, version: row.version, created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function detailFor(row, db) {
  const kind = row.kind || 'otro';
  const externalId = row.question_id || row.pack_id || row.claim_id
    || String(row.resource_id || '').replace(/^(question|message|claim):/, '') || null;
  const itemId = row.item_id || row.title?.match(/·\s*([^·]+)$/)?.[1]?.trim() || null;
  const detail = {
    id: String(row.inbox_id), kind, external_id: externalId,
    external_status: row.external_status || 'UNKNOWN',
    last_synced_at: row.last_synced_at || row.updated_at,
    item: { item_id: itemId, name: itemId, photo_url: null },
    context: {}, messages: [], available_actions: ['mark_read'],
    assigned_user_id: row.assigned_user_id == null ? null : String(row.assigned_user_id),
    status: row.status,
  };
  if (kind === 'pregunta') {
    detail.context.question = row.preview || '';
    if (detail.external_status === 'UNANSWERED') detail.available_actions.unshift('reply');
  } else if (kind === 'mensaje') {
    detail.context.pack_id = row.pack_id || externalId;
    detail.context.order_id = row.order_id || null;
    if (tableExists(db, 'ml_mensajes')) {
      detail.messages = db.prepare(`SELECT id, texto, fecha_creacion FROM ml_mensajes WHERE pack_id = ? ORDER BY fecha_creacion ASC`).all(detail.context.pack_id)
        .map((message) => ({ id: String(message.id), text: message.texto || '', created_at: message.fecha_creacion || null }));
    }
  } else if (kind === 'reclamo') {
    detail.context.claim_id = row.claim_id || externalId;
  }
  return detail;
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
      ORDER BY i.updated_at DESC, i.inbox_id DESC LIMIT ?`).all(...params, limit + 1);
    const items = rows.slice(0, limit).map(publicItem);
    return res.json({ items, next_cursor: rows.length > limit ? String(rows[limit - 1].inbox_id) : null });
  });

  router.get('/:id/detail', auth, (req, res) => {
    const row = db.prepare(`SELECT * FROM inbox_items WHERE inbox_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = ?)`)
      .get(Number(req.params.id), req.user.id);
    if (!row) return res.status(404).json({ error: { code: 'inbox_no_encontrado', message: 'Ítem no encontrado' } });
    return res.json(detailFor(row, db));
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
          `/inbox/${id}`, ts, id, req.user.id);
      const notificationId = db.prepare('SELECT notification_id FROM user_notifications WHERE inbox_id = ? AND user_id = ?').get(id, req.user.id).notification_id;
      db.prepare(`INSERT OR IGNORE INTO notification_deliveries
        (notification_id, device_id, provider, status, created_at, updated_at)
        SELECT ?, id, 'push', 'pending', ?, ? FROM device_tokens
        WHERE user_id = ? AND revocado_en IS NULL`).run(notificationId, ts, ts, req.user.id);
      return { updated };
    })();
    if (result.missing) return res.status(404).json({ error: { code: 'inbox_no_encontrado', message: 'Ítem no encontrado' } });
    if (result.conflict) return res.status(409).json({ error: { code: 'inbox_asignado', message: 'El ítem ya está asignado' }, item: publicItem(result.conflict) });
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
  return router;
}
