import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { reclamarJobs, completarJob, fallarJob } from '../lib/integrationJobs.js';

describe('integration jobs: lease, retry y DLQ', () => {
  it('reclama, completa y recupera leases vencidos', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES ('e','claim.received','ml','ml','2026-08-29T00:00:00Z','c','d')`).run();
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at)
      VALUES ('e','claim.project','2020-01-01T00:00:00Z')`).run();
    const [job] = reclamarJobs(db, 'w1');
    expect(job.status).toBe('processing');
    expect(completarJob(db, job.job_id)).toBe(true);
    expect(db.prepare('SELECT status FROM integration_jobs WHERE job_id=?').get(job.job_id).status).toBe('completed');
    db.close();
  });

  it('manda a DLQ al agotar intentos', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES ('e2','claim.received','ml','ml','2026-08-29T00:00:00Z','c2','d2')`).run();
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at,max_attempts)
      VALUES ('e2','claim.project','2020-01-01T00:00:00Z',1)`).run();
    const [job] = reclamarJobs(db, 'w1');
    expect(fallarJob(db, job.job_id, { retryable: true })).toBe(true);
    expect(db.prepare('SELECT status FROM integration_jobs WHERE job_id=?').get(job.job_id).status).toBe('dead_lettered');
    db.close();
  });
});
