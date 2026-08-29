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
    return filas.map(fila => db.prepare('SELECT * FROM integration_jobs WHERE job_id = ?').get(fila.job_id));
  })();
}

export function completarJob(db, jobId) {
  return db.prepare(`UPDATE integration_jobs SET status='completed', lease_until=NULL,
    locked_at=NULL, locked_by=NULL WHERE job_id=? AND status='processing'`).run(jobId).changes === 1;
}

export function fallarJob(db, jobId, { code = 'job_failed', message = 'fallo controlado', retryable = true } = {}) {
  const job = db.prepare('SELECT attempts, max_attempts FROM integration_jobs WHERE job_id=?').get(jobId);
  if (!job) return false;
  const status = retryable && job.attempts < job.max_attempts ? 'failed' : 'dead_lettered';
  const delay = Math.min(3600, 2 ** Math.max(0, job.attempts - 1));
  const available = new Date(Date.now() + delay * 1000).toISOString();
  return db.prepare(`UPDATE integration_jobs SET status=?, available_at=?, lease_until=NULL,
    locked_at=NULL, locked_by=NULL, last_error_code=?, last_error_message=?
    WHERE job_id=? AND status='processing'`).run(status, available, code, message, jobId).changes === 1;
}
