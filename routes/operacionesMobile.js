import express from 'express';

const visible = '(i.assigned_user_id IS NULL OR i.assigned_user_id = ?)';
const visibleItem = '(assigned_user_id IS NULL OR assigned_user_id = ?)';

export function operacionesMobileRouter(db, authMiddleware) {
  const router = express.Router();
  const auth = authMiddleware;

  router.get('/conversations/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    const conversation = db.prepare(`SELECT c.* FROM conversations c
      WHERE c.conversation_id = ? AND EXISTS
      (SELECT 1 FROM inbox_items i WHERE i.conversation_id = c.conversation_id AND ${visible})`)
      .get(id, req.user.id);
    if (!conversation) return res.status(404).json({ error: { code: 'conversation_no_encontrada', message: 'Conversación no encontrada' } });
    const messages = db.prepare(`SELECT message_id,event_id,direction,external_message_id,body,body_redacted,occurred_at,created_at
      FROM conversation_messages WHERE conversation_id = ? ORDER BY message_id ASC`).all(id);
    return res.json({ conversation, messages });
  });

  router.post('/conversations/:id/read', auth, (req, res) => {
    const id = Number(req.params.id);
    const result = db.prepare(`UPDATE inbox_items SET status = CASE WHEN status='unread' THEN 'read' ELSE status END,
      version = version + 1, updated_at = ? WHERE conversation_id = ? AND ${visibleItem}`)
      .run(new Date().toISOString(), id, req.user.id);
    if (!result.changes) return res.status(404).json({ error: { code: 'conversation_no_encontrada', message: 'Conversación no encontrada' } });
    return res.json({ ok: true, updated: result.changes });
  });

  router.get('/integration-notifications', auth, (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const rows = db.prepare(`SELECT notification_id,event_id,inbox_id,title,body,deep_link,status,created_at,read_at
      FROM user_notifications WHERE user_id = ? ORDER BY notification_id DESC LIMIT ?`).all(req.user.id, limit + 1);
    return res.json({ items: rows.slice(0, limit), next_cursor: rows.length > limit ? String(rows[limit - 1].notification_id) : null });
  });

  router.get('/operations/:correlationId', auth, (req, res) => {
    const correlationId = String(req.params.correlationId);
    const event = db.prepare(`SELECT e.* FROM integration_events e WHERE e.correlation_id = ? AND EXISTS
      (SELECT 1 FROM inbox_items i WHERE i.event_id=e.event_id AND ${visible}) ORDER BY e.received_at DESC LIMIT 1`)
      .get(correlationId, req.user.id);
    if (!event) return res.status(404).json({ error: { code: 'operacion_no_encontrada', message: 'Operación no encontrada' } });
    const history = db.prepare(`SELECT stage,from_status,to_status,error_code,resource_id,correlation_id,retryable,attempts,safe_message,created_at
      FROM integration_event_history WHERE event_id = ? ORDER BY history_id ASC`).all(event.event_id);
    return res.json({ correlation_id: correlationId, event, history });
  });

  return router;
}
