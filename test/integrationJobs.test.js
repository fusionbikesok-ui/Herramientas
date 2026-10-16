import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDb } from '../db/index.js';
import { reclamarJobs, completarJob, fallarJob } from '../lib/integrationJobs.js';
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn(), refrescarProductoPuntual: vi.fn() }));
import { wooFetch, refrescarProductoPuntual } from '../routes/woo.js';
import { procesarIntegrationJobs } from '../lib/workerIntegrationJobs.js';

describe('integration jobs: lease, retry y DLQ', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reclama, completa y recupera leases vencidos', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES ('e','claim.received','ml','ml','2026-08-29T00:00:00Z','c','d')`).run();
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at)
      VALUES ('e','claim.project','2020-01-01T00:00:00Z')`).run();
    const [job] = reclamarJobs(db, 'w1');
    expect(job.status).toBe('processing');
    expect(completarJob(db, job.job_id, 'w1', job.lease_token)).toBe(true);
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
    expect(fallarJob(db, job.job_id, { workerId: 'w1', leaseToken: job.lease_token, retryable: true })).toBe(true);
    expect(db.prepare('SELECT status FROM integration_jobs WHERE job_id=?').get(job.job_id).status).toBe('dead_lettered');
    db.close();
  });

  it('crece el backoff (available_at) entre intentos sucesivos de un job reintentable', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES ('e3','claim.received','ml','ml','2026-08-29T00:00:00Z','c3','d3')`).run();
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at,max_attempts)
      VALUES ('e3','claim.project','2020-01-01T00:00:00Z',10)`).run();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T00:00:00.000Z'));

    // Intento 1: attempts pasa a 1 → delay = 2^0 = 1s.
    let [job] = reclamarJobs(db, 'w1');
    expect(fallarJob(db, job.job_id, { workerId: 'w1', leaseToken: job.lease_token, retryable: true })).toBe(true);
    const primerIntento = db.prepare('SELECT status, available_at FROM integration_jobs WHERE job_id=?').get(job.job_id);
    expect(primerIntento.status).toBe('failed');
    expect(primerIntento.available_at).toBe('2026-08-29T00:00:01.000Z');

    // Hacer disponible el job y reclamarlo de nuevo: attempts pasa a 2 → delay = 2^1 = 2s.
    db.prepare("UPDATE integration_jobs SET available_at='2020-01-01T00:00:00Z' WHERE job_id=?").run(job.job_id);
    [job] = reclamarJobs(db, 'w1');
    expect(fallarJob(db, job.job_id, { workerId: 'w1', leaseToken: job.lease_token, retryable: true })).toBe(true);
    const segundoIntento = db.prepare('SELECT status, available_at FROM integration_jobs WHERE job_id=?').get(job.job_id);
    expect(segundoIntento.status).toBe('failed');
    expect(segundoIntento.available_at).toBe('2026-08-29T00:00:02.000Z');

    // Tercer intento: attempts pasa a 3 → delay = 2^2 = 4s. El backoff sigue creciendo.
    db.prepare("UPDATE integration_jobs SET available_at='2020-01-01T00:00:00Z' WHERE job_id=?").run(job.job_id);
    [job] = reclamarJobs(db, 'w1');
    expect(fallarJob(db, job.job_id, { workerId: 'w1', leaseToken: job.lease_token, retryable: true })).toBe(true);
    const tercerIntento = db.prepare('SELECT status, available_at FROM integration_jobs WHERE job_id=?').get(job.job_id);
    expect(tercerIntento.available_at).toBe('2026-08-29T00:00:04.000Z');

    db.close();
  });

  it('agota max_attempts tras varias fallas reintentables y recién ahí manda a DLQ', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES ('e4','claim.received','ml','ml','2026-08-29T00:00:00Z','c4','d4')`).run();
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at,max_attempts)
      VALUES ('e4','claim.project','2020-01-01T00:00:00Z',3)`).run();

    for (let intento = 1; intento <= 2; intento++) {
      const [job] = reclamarJobs(db, 'w1');
      expect(fallarJob(db, job.job_id, { workerId: 'w1', leaseToken: job.lease_token, retryable: true })).toBe(true);
      const fila = db.prepare('SELECT status, attempts FROM integration_jobs WHERE job_id=?').get(job.job_id);
      expect(fila.status).toBe('failed');
      expect(fila.attempts).toBe(intento);
      db.prepare("UPDATE integration_jobs SET available_at='2020-01-01T00:00:00Z' WHERE job_id=?").run(job.job_id);
    }

    // Tercer y último intento permitido (max_attempts=3): debe pasar a dead_lettered.
    const [job] = reclamarJobs(db, 'w1');
    expect(job.attempts).toBe(3);
    expect(fallarJob(db, job.job_id, { workerId: 'w1', leaseToken: job.lease_token, retryable: true })).toBe(true);
    expect(db.prepare('SELECT status FROM integration_jobs WHERE job_id=?').get(job.job_id).status).toBe('dead_lettered');
    db.close();
  });

  it('recupera un job cuyo lease quedó abandonado (processing con lease_until vencido)', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES ('e5','claim.received','ml','ml','2026-08-29T00:00:00Z','c5','d5')`).run();
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at,max_attempts)
      VALUES ('e5','claim.project','2020-01-01T00:00:00Z',5)`).run();

    const [primero] = reclamarJobs(db, 'worker-caido');
    // Simular que el worker se cayó a mitad de proceso: el lease queda vencido sin completar ni fallar.
    db.prepare("UPDATE integration_jobs SET lease_until='2000-01-01T00:00:00Z' WHERE job_id=?").run(primero.job_id);
    expect(db.prepare('SELECT status FROM integration_jobs WHERE job_id=?').get(primero.job_id).status).toBe('processing');

    const [reclamado] = reclamarJobs(db, 'worker-nuevo');
    expect(reclamado.job_id).toBe(primero.job_id);
    expect(reclamado.status).toBe('processing');
    expect(reclamado.locked_by).toBe('worker-nuevo');
    expect(reclamado.attempts).toBe(2);
    expect(reclamado.lease_token).not.toBe(primero.lease_token);
    // El worker viejo, con su lease/token vencido, ya no puede completar el job.
    expect(completarJob(db, primero.job_id, 'worker-caido', primero.lease_token)).toBe(false);
    expect(completarJob(db, reclamado.job_id, 'worker-nuevo', reclamado.lease_token)).toBe(true);
    db.close();
  });

  it('dispatch.woo es obsoleto: un job viejo termina sin ningún PUT a Woo (web o ML) y deja constancia', async () => {
    const db = openDb(':memory:');
    wooFetch.mockResolvedValue({ status: 200, data: {} });
    for (const [id, canal] of [['dispatch-e', 'web'], ['dispatch-m', 'ml']]) {
      db.prepare(`INSERT INTO integration_events
        (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key,metadata_json)
        VALUES (?,'dispatch.confirmed',?,'fusionbikes',?,?,?,?)`)
        .run(id, canal, new Date().toISOString(), id, id, JSON.stringify({ canal, orders: [{ wc_order_id: 1, status: 'completed' }, { wc_order_id: 2, status: 'completed' }] }));
      db.prepare("INSERT INTO integration_jobs (event_id,job_type,available_at) VALUES (?,'dispatch.woo','2020-01-01T00:00:00Z')").run(id);
    }
    const result = await procesarIntegrationJobs(db, { wooCfg: { url: 'http://woo', ck: 'ck', cs: 'cs' } });
    expect(result.processed).toBe(2); expect(wooFetch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM integration_jobs WHERE job_type='dispatch.woo' AND status='completed'").get().n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM integration_event_history WHERE stage='dispatch_woo_obsoleto'").get().n).toBe(2);
    db.close();
  });

  it('dispatch.woo obsoleto termina igual sin configuración de Woo (no se reintenta ni va a dead-letter)', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key,metadata_json)
      VALUES ('dispatch-f','dispatch.confirmed','web','fusionbikes',?,'dispatch-f','dispatch-f','{}')`).run(new Date().toISOString());
    db.prepare("INSERT INTO integration_jobs (event_id,job_type,available_at,max_attempts) VALUES ('dispatch-f','dispatch.woo','2020-01-01T00:00:00Z',2)").run();
    await procesarIntegrationJobs(db, { wooCfg: null });
    expect(db.prepare("SELECT status FROM integration_jobs WHERE event_id='dispatch-f'").get().status).toBe('completed');
    db.close();
  });

  it('E-1c: el job de integración de un recibo VIEJO de catálogo no refresca ni da de baja: traspasa al trabajo por recurso', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key,metadata_json)
      VALUES ('woo-p','webhook.received','woo','woocommerce',?,'woo-p','woo-p',?)`)
      .run(new Date().toISOString(), JSON.stringify({ producto_id: 7247, parent_id: 1732, eliminado: true }));
    db.prepare("INSERT INTO integration_jobs (event_id,job_type,available_at) VALUES ('woo-p','catalog.woo_product_sync','2000-01-01T00:00:00Z')").run();
    const result = await procesarIntegrationJobs(db, { wooCfg: { url: 'https://woo', ck: 'ck', cs: 'cs' } });
    expect(result.processed).toBe(1);
    // ni el topic `deleted` (eliminado:true) ni nada borra: solo queda encolado el trabajo del padre, que releerá Woo
    expect(refrescarProductoPuntual).not.toHaveBeenCalled();
    expect(db.prepare("SELECT recurso, estado FROM trabajos_recurso WHERE tipo = 'catalog.woo_product_sync'").all()).toEqual([{ recurso: '1732', estado: 'pendiente' }]);
    expect(db.prepare("SELECT status FROM integration_jobs WHERE event_id='woo-p'").get().status).toBe('completed');
    db.close();
  });

  it('E-1c: un recibo NUEVO (ya encolado en el recibo) no vuelve a encolar desde el job de integración', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key,metadata_json)
      VALUES ('woo-q','webhook.received','woo','woocommerce',?,'woo-q','woo-q',?)`)
      .run(new Date().toISOString(), JSON.stringify({ producto_id: 1732, parent_id: null, trabajo_recurso: true }));
    db.prepare("INSERT INTO integration_jobs (event_id,job_type,available_at) VALUES ('woo-q','catalog.woo_product_sync','2000-01-01T00:00:00Z')").run();
    await procesarIntegrationJobs(db, { wooCfg: null });
    expect(db.prepare("SELECT COUNT(*) n FROM trabajos_recurso WHERE tipo = 'catalog.woo_product_sync'").get().n).toBe(0);
    expect(db.prepare("SELECT status FROM integration_jobs WHERE event_id='woo-q'").get().status).toBe('completed');
    db.close();
  });
});
