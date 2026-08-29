import { enviarNotificacion } from './notificacionesPush.js';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60 * 1000;
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
const now = () => new Date().toISOString();

function nextRetry(attempt) {
  return new Date(Date.now() + (BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] || BACKOFF_MS.at(-1))).toISOString();
}

/** Consume únicamente notification_deliveries; no comparte estado con el worker legacy. */
export async function procesarEntregasPush(db, { send = enviarNotificacion, limit = 50 } = {}) {
  const ts = now();
  const rows = db.prepare(`
    SELECT d.*, n.title, n.body, n.deep_link, dt.token
    FROM notification_deliveries d
    JOIN user_notifications n ON n.notification_id = d.notification_id
    JOIN device_tokens dt ON dt.id = d.device_id AND dt.revocado_en IS NULL
    WHERE d.provider = 'push' AND d.status = 'pending'
      AND (d.lease_until IS NULL OR d.lease_until <= ?)
      AND (d.last_attempt_at IS NULL OR d.last_attempt_at <= ?)
    ORDER BY d.delivery_id LIMIT ?`).all(ts, ts, limit);
  let processed = 0;
  for (const row of rows) {
    const claimed = db.prepare(`UPDATE notification_deliveries SET lease_until=?, last_attempt_at=?, attempts=attempts+1, updated_at=?
      WHERE delivery_id=? AND status='pending' AND (lease_until IS NULL OR lease_until <= ?)`)
      .run(new Date(Date.now() + LEASE_MS).toISOString(), ts, ts, row.delivery_id, ts);
    if (!claimed.changes) continue;
    const attempt = row.attempts + 1;
    let result;
    try { result = await send(row.token, { titulo: row.title, cuerpo: row.body, deepLink: row.deep_link }); }
    catch (err) { result = { ok: false, error: err.message }; }
    const failed = !result?.ok;
    const status = failed && attempt >= MAX_ATTEMPTS ? 'failed' : failed ? 'pending' : 'sent';
    const updated = now();
    db.prepare(`UPDATE notification_deliveries SET status=?, provider_message_id=?, last_error_code=?, lease_until=NULL, updated_at=?
      WHERE delivery_id=?`).run(status, result?.providerMessageId || null, failed ? 'push.send_failed' : null, updated, row.delivery_id);
    if (failed && attempt < MAX_ATTEMPTS) {
      db.prepare('UPDATE notification_deliveries SET last_attempt_at=? WHERE delivery_id=?').run(nextRetry(attempt), row.delivery_id);
    }
    db.prepare(`UPDATE user_notifications SET status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM notification_deliveries WHERE notification_id=? AND status IN ('pending'))
       AND EXISTS (SELECT 1 FROM notification_deliveries WHERE notification_id=? AND status='sent') THEN 'sent'
      WHEN NOT EXISTS (SELECT 1 FROM notification_deliveries WHERE notification_id=? AND status IN ('pending','sent')) THEN 'failed'
      ELSE status END WHERE notification_id=?`)
      .run(row.notification_id, row.notification_id, row.notification_id, row.notification_id);
    processed++;
  }
  return { processed };
}
