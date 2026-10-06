import crypto from 'node:crypto';
import express from 'express';

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_PREVIEW = 500;
const KINDS = new Set(['mensaje', 'pregunta', 'reclamo', 'pedido', 'otro']);

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function kindFromEventType(eventType) {
  const type = String(eventType || '').toLowerCase();
  if (/question|pregunta/.test(type)) return 'pregunta';
  if (/claim|complaint|reclamo/.test(type)) return 'reclamo';
  if (/order|pedido/.test(type)) return 'pedido';
  if (/message|mensaje/.test(type)) return 'mensaje';
  return 'otro';
}

function validPayload(body) {
  return body && typeof body === 'object'
    && typeof body.event_id === 'string' && body.event_id.length > 0 && body.event_id.length <= 190
    && typeof body.event_type === 'string' && body.event_type.length > 0
    && body.conversation && typeof body.conversation === 'object'
    && ['web', 'whatsapp'].includes(body.conversation.channel)
    && typeof body.conversation.token === 'string' && body.conversation.token.length > 0
    && body.message && typeof body.message === 'object'
    && typeof body.message.text === 'string';
}

export function chatEventsRouter(db, { env = process.env, now = () => Date.now() } = {}) {
  const router = express.Router();
  router.post('/v1/events', express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
    const apiKey = env.FUSION_CHAT_EVENTS_API_KEY?.trim();
    const secret = env.FUSION_CHAT_EVENTS_SECRET?.trim();
    if (!apiKey || !secret) return res.status(503).json({ ok: false, error: 'ingesta no configurada' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const timestampText = String(req.get('x-fusion-timestamp') || '');
    const timestamp = Number(timestampText);
    const suppliedKey = req.get('x-fusion-api-key') || '';
    const suppliedSignature = String(req.get('x-fusion-signature') || '').toLowerCase();
    if (!Number.isInteger(timestamp)
      || Math.abs(Math.floor(now() / 1000) - timestamp) > MAX_CLOCK_SKEW_SECONDS
      || !constantTimeEqual(suppliedKey, apiKey)) {
      return res.status(401).json({ ok: false, error: 'autenticación inválida' });
    }
    const expected = crypto.createHmac('sha256', secret).update(timestampText).update('.').update(raw).digest('hex');
    if (!constantTimeEqual(suppliedSignature, expected)) {
      return res.status(401).json({ ok: false, error: 'autenticación inválida' });
    }

    let event;
    try { event = JSON.parse(raw.toString('utf8')); }
    catch { return res.status(400).json({ ok: false, error: 'JSON inválido' }); }
    if (!validPayload(event)) return res.status(422).json({ ok: false, error: 'evento inválido' });

    const receivedAt = new Date(now()).toISOString();
    const occurredAt = Number.isNaN(Date.parse(event.occurred_at)) ? receivedAt : new Date(event.occurred_at).toISOString();
    const channel = event.conversation.channel;
    const resourceId = event.conversation.token;
    const kind = KINDS.has(event.kind) ? event.kind : kindFromEventType(event.event_type);
    const requested = event.handoff?.requested === true;
    const requestedPriority = String(event.handoff?.priority || '').toLowerCase();
    const priority = requested && requestedPriority === 'urgent' ? 'urgent' : requested ? 'high' : 'normal';
    const title = String(event.conversation.customer_name || '').trim() || (channel === 'whatsapp' ? 'WhatsApp' : 'Web');
    const preview = event.message.text.slice(0, MAX_PREVIEW);
    const correlationId = `chat-${resourceId}`;

    const result = db.transaction(() => {
      const inserted = db.prepare(`INSERT OR IGNORE INTO integration_events
        (event_id,event_type,channel,source,external_event_id,resource_id,payload_version,
         occurred_at,received_at,correlation_id,dedupe_key,metadata_json,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        event.event_id, event.event_type, channel, 'wordpress-live-chat', event.message.external_id || null,
        resourceId, '1.6.6', occurredAt, receivedAt, correlationId, `wordpress-chat:${event.event_id}`,
        JSON.stringify({ site_url: event.site_url || null, handoff: event.handoff || null }), 'completed');
      if (!inserted.changes) {
        const inbox = db.prepare('SELECT inbox_id FROM inbox_items WHERE event_id=?').get(event.event_id);
        return { duplicate: true, inboxId: inbox?.inbox_id || null };
      }
      const inbox = db.prepare(`INSERT INTO inbox_items
        (event_id,channel,resource_id,title,preview,status,kind,priority,version,created_at,updated_at)
        VALUES (?,?,?,?,?,'unread',?,?,1,?,?)`).run(
        event.event_id, channel, resourceId, title, preview, kind, priority, occurredAt, receivedAt);
      const inboxId = Number(inbox.lastInsertRowid);
      const users = db.prepare(`SELECT DISTINCT user_id FROM device_tokens
        WHERE revocado_en IS NULL AND user_id IS NOT NULL`).all();
      for (const { user_id: userId } of users) {
        const notification = db.prepare(`INSERT INTO user_notifications
          (event_id,inbox_id,user_id,title,body,deep_link,status,created_at)
          VALUES (?,?,?,?,?,?,'pending',?)`).run(event.event_id, inboxId, userId,
          requested ? `Atención humana · ${title}` : title, preview, `/inbox/${inboxId}`, receivedAt);
        db.prepare(`INSERT OR IGNORE INTO notification_deliveries
          (notification_id,device_id,provider,status,created_at,updated_at)
          SELECT ?,id,'push','pending',?,? FROM device_tokens
          WHERE user_id=? AND revocado_en IS NULL`).run(notification.lastInsertRowid, receivedAt, receivedAt, userId);
      }
      db.prepare(`INSERT INTO integration_event_history
        (event_id,stage,to_status,resource_id,correlation_id,safe_message,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(event.event_id, 'chat.project', 'completed', resourceId,
        correlationId, requested ? 'chat urgente proyectado y push encolado' : 'chat proyectado y push encolado', receivedAt);
      return { duplicate: false, inboxId };
    })();
    return res.status(200).json({ ok: true, duplicate: result.duplicate, event_id: event.event_id, inbox_id: result.inboxId });
  });
  return router;
}
