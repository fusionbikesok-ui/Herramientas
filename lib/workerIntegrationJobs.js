import { reclamarJobs, completarJob, fallarJobAtomico, validarLease } from './integrationJobs.js';
import { ingerirPregunta, ingerirReclamo, ingerirMensaje } from '../routes/notificacionesMl.js';
import { wooFetch } from '../routes/woo.js';
const now = () => new Date().toISOString();

function identidad(e) {
  const topic = String(e.topic), action = String(e.action || (Array.isArray(e.actions) ? e.actions.join(',') : '') || 'receive');
  const notificationId = String(e._id || e.id || e.notification_id || e.notificationId || e.sent || e.date || '');
  const rawResource = e.resource || e.claim_id || e.envelope?.claim_id || 'unknown';
  const resource = e.resource ? String(e.resource) : `/post-purchase/v1/claims/${String(rawResource)}`;
  const version = String(e.version || e.api_version || 'v1'), user = String(e.user_id);
  const occurredAt = e.sent || e.date || e.occurred_at || null;
  return { topic, action, resource, version, user, notificationId, occurredAt };
}

/** Persiste evento y primer job en la misma transacción. */
export function registrarWebhookMl(db, envelope, options = {}) {
  const receivedAt = now(), { topic, action, resource, version, user, notificationId, occurredAt: suppliedOccurredAt } = identidad(envelope);
  const occurredAt = (() => { try { return suppliedOccurredAt ? new Date(suppliedOccurredAt).toISOString() : receivedAt; } catch { return receivedAt; } })();
  // Determinar si es un reclamo: topic 'claims' (legacy) o 'post_purchase' con resource de claims.
  // post_purchase solo se proyecta cuando la acción y el resource son explícitamente de claims.
  const isClaim = topic === 'claims' || (topic === 'post_purchase'
    && (envelope.action === 'claims' || (Array.isArray(envelope.actions) && envelope.actions.includes('claims')))
    && /\/claims\/[A-Za-z0-9_-]+(?:[/?#]|$)/.test(String(envelope.resource || '')));

  // Normalizar resource_id para claims: siempre a /post-purchase/v1/claims/{id}
  // Extrae el ID del resource (sea /claims/{id} del topic legado o /post-purchase/v1/claims/{id} del nuevo)
  let normalizedResource = resource;
  if (isClaim) {
    const claimId = String(resource || '').match(/\/claims\/([A-Za-z0-9_-]+)(?:[\/?#]|$)/)?.[1];
    if (claimId) {
      normalizedResource = `/post-purchase/v1/claims/${claimId}`;
    }
  }

  const fingerprint = `${topic}:${action}:${version}:${normalizedResource}:${user}:${notificationId || 'no-id'}`;
  const eventId = `ml-webhook-${Buffer.from(fingerprint).toString('base64url')}`;
  const correlationId = `ml-${topic}-${version}-${normalizedResource}-${eventId}`;
  const dedupeKey = `ml:webhook:${fingerprint}`;
  const jobType = topic === 'questions' ? 'question.project' : topic === 'messages' ? 'message.project' : isClaim ? 'claim.project' : 'webhook.audit';
  return db.transaction(() => {
    const inserted = db.prepare(`INSERT OR IGNORE INTO integration_events
      (event_id,event_type,channel,source,external_event_id,resource_id,payload_version,occurred_at,received_at,correlation_id,dedupe_key,metadata_json,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, 'webhook.received', 'ml', 'mercadolibre', fingerprint, normalizedResource, version, occurredAt, receivedAt, correlationId, dedupeKey,
      JSON.stringify({ topic, action, resource: normalizedResource, version, notification_id: notificationId || null, user_id: user, text: envelope.text || null, title: envelope.title || null }), 'pending');
    if (!inserted.changes) {
      // Es duplicado.
      db.prepare(`INSERT INTO integration_event_history (event_id,stage,to_status,resource_id,correlation_id,safe_message,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(eventId, 'webhook.dedupe', 'ignored_duplicate', normalizedResource, correlationId, 'webhook duplicado ignorado', receivedAt);
      return { eventId, duplicate: true, ignored: true };
    }
    db.prepare(`INSERT INTO integration_event_history (event_id,stage,to_status,resource_id,correlation_id,safe_message,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(eventId, 'webhook.persist', 'pending', normalizedResource, correlationId, 'webhook ML persistido antes del ACK', receivedAt);
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at) VALUES (?,?,?)`).run(eventId, jobType, receivedAt);
    return { eventId, duplicate: false, ignored: false };
  })();
}

function finalizar(db, job, workerId, message) {
  return db.transaction(() => {
    if (!completarJob(db, job.job_id, workerId, job.lease_token)) return false;
    const event = db.prepare('SELECT * FROM integration_events WHERE event_id=?').get(job.event_id);
    db.prepare("UPDATE integration_events SET status='completed' WHERE event_id=?").run(job.event_id);
    db.prepare(`INSERT INTO integration_event_history (event_id,stage,from_status,to_status,resource_id,correlation_id,attempts,safe_message,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(job.event_id, 'job.process', event.status, 'completed', event.resource_id, event.correlation_id, job.attempts, message, now());
    return true;
  })();
}

export async function procesarIntegrationJobs(db, { workerId = `integration-${process.pid}`, limit = 10, mlCfg = null, wooCfg = null } = {}) {
  const jobs = reclamarJobs(db, workerId, { limit, leaseSeconds: 60 }); let processed = 0;
  for (const job of jobs) {
    try {
      const event = db.prepare('SELECT * FROM integration_events WHERE event_id=?').get(job.event_id);
      if (!event) throw Object.assign(new Error('evento inexistente'), { retryable: false, code: 'event_missing' });
      const meta = JSON.parse(event.metadata_json || '{}');
      if (job.job_type === 'question.project' || job.job_type === 'claim.project') {
        if (!mlCfg) throw Object.assign(new Error('configuración ML requerida'), { retryable: true, code: 'ml_config_missing' });
        if (!validarLease(db, job.job_id, workerId, job.lease_token)) throw Object.assign(new Error('lease vencido'), { retryable: true, code: 'lease_expired' });
      }
      if (job.job_type === 'question.project') {
        const result = await ingerirPregunta(db, mlCfg, event.resource_id, event, { leaseGuard: () => validarLease(db, job.job_id, workerId, job.lease_token) });
        if (result !== true) throw Object.assign(new Error('MercadoLibre no confirmó la pregunta'), { retryable: true, code: 'ml_question_fetch_failed' });
      } else if (job.job_type === 'claim.project') {
        const result = await ingerirReclamo(db, mlCfg, event.resource_id, meta.resource || event.resource_id, event, { leaseGuard: () => validarLease(db, job.job_id, workerId, job.lease_token) });
        if (result !== true) throw Object.assign(new Error('MercadoLibre no confirmó el reclamo'), { retryable: true, code: 'ml_claim_fetch_failed' });
      } else if (job.job_type === 'message.project') {
        const result = await ingerirMensaje(db, mlCfg, event.resource_id, { eventId: event.event_id, leaseGuard: () => validarLease(db, job.job_id, workerId, job.lease_token) });
        if (result !== true) throw Object.assign(new Error('MercadoLibre no confirmó los mensajes'), { retryable: true, code: 'ml_message_fetch_failed' });
      } else if (job.job_type === 'webhook.audit') {
        // El estado y su historial se cierran exclusivamente en finalizar(),
        // para conservar la transición pending → completed.
      } else if (job.job_type === 'dispatch.woo') {
        if (!wooCfg?.url || !wooCfg?.ck || !wooCfg?.cs) throw Object.assign(new Error('configuración Woo requerida'), { retryable: true, code: 'woo_config_missing' });
        const orders = Array.isArray(meta.orders) ? meta.orders : [];
        for (const order of orders) {
          if (!order.wc_order_id) continue;
          await wooFetch(wooCfg, `/orders/${order.wc_order_id}`, 'put', { status: order.status || 'completed' });
        }
      } else throw Object.assign(new Error(`tipo de job no soportado: ${job.job_type}`), { retryable: false, code: 'job_type_unsupported' });
      const message = job.job_type === 'webhook.audit'
        ? 'webhook recibido en modo audit-only; sin proyección'
        : `${job.job_type} proyectado idempotentemente`;
      const currentMeta = JSON.parse(db.prepare('SELECT metadata_json FROM integration_events WHERE event_id=?').get(job.event_id)?.metadata_json || '{}');
      if (currentMeta.projection === 'ignored_stale') {
        if (completarJob(db, job.job_id, workerId, job.lease_token)) {
          db.prepare(`INSERT INTO integration_event_history
            (event_id,stage,from_status,to_status,resource_id,correlation_id,attempts,safe_message,created_at)
            SELECT event_id,'job.process','pending','ignored_stale',resource_id,correlation_id,?,?,? FROM integration_events WHERE event_id=?`)
            .run(job.attempts, 'evento stale ignorado; no se proyectó', now(), job.event_id);
          processed++;
        }
      } else if (finalizar(db, job, workerId, message)) processed++;
    } catch (err) {
      fallarJobAtomico(db, job, { workerId, leaseToken: job.lease_token, code: err.code || 'integration_job_failed', message: err.message || 'fallo controlado', retryable: err.retryable !== false });
    }
  }
  return { claimed: jobs.length, processed };
}
