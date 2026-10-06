import crypto from 'node:crypto';
const now = () => new Date().toISOString();

export function reclamarJobs(db, workerId, { limit = 10, leaseSeconds = 60 } = {}) {
  const ts = now();
  const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  return db.transaction(() => {
    const filas = db.prepare(`SELECT job_id FROM integration_jobs
      WHERE (status IN ('pending','failed') AND available_at <= ?)
         OR (status = 'processing' AND lease_until <= ?)
      ORDER BY available_at ASC, job_id ASC LIMIT ?`).all(ts, ts, limit);
    const claim = db.prepare(`UPDATE integration_jobs SET status='processing', locked_at=?,
      locked_by=?, lease_until=?, attempts=attempts+1 WHERE job_id=?`);
    for (const fila of filas) claim.run(ts, workerId, lease, fila.job_id);
    return filas.map(fila => {
      const leaseToken = crypto.randomUUID();
      db.prepare('UPDATE integration_jobs SET lease_token=? WHERE job_id=? AND locked_by=?').run(leaseToken, fila.job_id, workerId);
      return { ...db.prepare('SELECT * FROM integration_jobs WHERE job_id = ?').get(fila.job_id), lease_token: leaseToken };
    });
  })();
}

export function completarJob(db, jobId, workerId, leaseToken) {
  if (!workerId || !leaseToken) return false;
  return db.prepare(`UPDATE integration_jobs SET status='completed', lease_until=NULL,
    locked_at=NULL, locked_by=NULL WHERE job_id=? AND status='processing'
    AND locked_by=? AND lease_token=? AND (lease_until IS NULL OR lease_until > ?)`).run(jobId, workerId, leaseToken, now()).changes === 1;
}

export function fallarJob(db, jobId, { workerId, leaseToken, code = 'job_failed', message = 'fallo controlado', retryable = true } = {}) {
  if (!workerId || !leaseToken) return false;
  const job = db.prepare('SELECT attempts, max_attempts FROM integration_jobs WHERE job_id=?').get(jobId);
  if (!job) return false;
  const status = retryable && job.attempts < job.max_attempts ? 'failed' : 'dead_lettered';
  const delay = Math.min(3600, 2 ** Math.max(0, job.attempts - 1));
  const available = new Date(Date.now() + delay * 1000).toISOString();
  return db.prepare(`UPDATE integration_jobs SET status=?, available_at=?, lease_until=NULL,
    locked_at=NULL, locked_by=NULL, last_error_code=?, last_error_message=?
    WHERE job_id=? AND status='processing' AND locked_by=? AND lease_token=? AND (lease_until IS NULL OR lease_until > ?)`)
    .run(status, available, code, message, jobId, workerId, leaseToken, now()).changes === 1;
}

export function validarLease(db, jobId, workerId, leaseToken) {
  return Boolean(db.prepare(`SELECT 1 FROM integration_jobs
    WHERE job_id=? AND status='processing' AND locked_by=? AND lease_token=?
    AND (lease_until IS NULL OR lease_until > ?)`).get(jobId, workerId, leaseToken, now()));
}

/** Reabre explícitamente un trabajo DLQ para una operación administrativa controlada. */
export function reprocesarJob(db, jobId) {
  const at = now();
  return db.transaction(() => {
    const job = db.prepare('SELECT * FROM integration_jobs WHERE job_id=? AND status=\'dead_lettered\'').get(jobId);
    if (!job) return false;
    const event = db.prepare('SELECT * FROM integration_events WHERE event_id=?').get(job.event_id);
    db.prepare(`UPDATE integration_jobs SET status='pending', available_at=?, locked_at=NULL,
      attempts=0, locked_by=NULL, lease_until=NULL, lease_token=NULL, last_error_code=NULL, last_error_message=NULL
      WHERE job_id=? AND status='dead_lettered'`).run(at, jobId);
    db.prepare("UPDATE integration_events SET status='pending' WHERE event_id=?").run(job.event_id);
    db.prepare(`INSERT INTO integration_event_history
      (event_id,stage,from_status,to_status,error_code,resource_id,correlation_id,retryable,attempts,safe_message,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(job.event_id, 'job.reprocess', event?.status || 'dead_lettered', 'pending',
      'job.reprocessed', event?.resource_id || null, event?.correlation_id || null, 1, job.attempts,
      'trabajo reabierto por operación administrativa', at);
    return true;
  })();
}

export function fallarJobAtomico(db, job, { workerId, leaseToken, code, message, retryable = true } = {}) {
  const at = now();
  return db.transaction(() => {
    const current = db.prepare('SELECT * FROM integration_jobs WHERE job_id=? AND status=\'processing\' AND locked_by=? AND lease_token=? AND (lease_until IS NULL OR lease_until > ?)').get(job.job_id, workerId, leaseToken, at);
    if (!current) return false;
    const status = retryable && current.attempts < current.max_attempts ? 'failed' : 'dead_lettered';
    const delay = Math.min(3600, 2 ** Math.max(0, current.attempts - 1));
    db.prepare(`UPDATE integration_jobs SET status=?, available_at=?, lease_until=NULL, locked_at=NULL,
      locked_by=NULL, last_error_code=?, last_error_message=? WHERE job_id=?`).run(
      status, new Date(Date.now() + delay * 1000).toISOString(), code, message, job.job_id);
    const event = db.prepare('SELECT * FROM integration_events WHERE event_id=?').get(current.event_id);
    db.prepare('UPDATE integration_events SET status=? WHERE event_id=?').run(status, current.event_id);
    db.prepare(`INSERT INTO integration_event_history
      (event_id,stage,from_status,to_status,error_code,resource_id,correlation_id,retryable,attempts,safe_message,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(current.event_id, 'job.process', event?.status || 'processing', status,
      code, event?.resource_id || null, event?.correlation_id || `job-${current.job_id}`, retryable ? 1 : 0,
      current.attempts, message, at);
    return true;
  })();
}
