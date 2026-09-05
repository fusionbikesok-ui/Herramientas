import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../db/index.js';
vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { registrarWebhookMl, procesarIntegrationJobs, registrarCambiosObservados } from '../lib/workerIntegrationJobs.js';
import { reclamarJobs, completarJob, reprocesarJob } from '../lib/integrationJobs.js';

describe('worker durable de integration_jobs', () => {
  it('persiste el envelope antes de procesarlo y deduplica el mismo recibo', () => {
    const db = openDb(':memory:');
    const envelope = { topic: 'orders', resource: '/orders/42', user_id: '123', sent: '2026-08-30T18:00:00-03:00' };
    const first = registrarWebhookMl(db, envelope);
    const second = registrarWebhookMl(db, envelope);
    expect(first).toEqual({ eventId: second.eventId, duplicate: false, ignored: false });
    expect(second.duplicate).toBe(true);
    expect(db.prepare('SELECT status, resource_id FROM integration_events WHERE event_id=?').get(first.eventId))
      .toMatchObject({ status: 'pending', resource_id: '/orders/42' });
    expect(db.prepare('SELECT occurred_at FROM integration_events WHERE event_id=?').get(first.eventId).occurred_at).toBe('2026-08-30T21:00:00.000Z');
    expect(db.prepare('SELECT COUNT(*) n FROM integration_event_history WHERE event_id=?').get(first.eventId).n).toBe(2);
    expect(db.prepare("SELECT to_status FROM integration_event_history WHERE event_id=? ORDER BY history_id DESC LIMIT 1").get(first.eventId).to_status).toBe('ignored_duplicate');
    db.close();
  });

  it('reclama y completa un job actual sin duplicar la proyección', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,resource_id,received_at,correlation_id,dedupe_key,metadata_json)
      VALUES ('evt-q','question.received','ml','mercadolibre','77',CURRENT_TIMESTAMP,'corr-q','dedupe-q',?)`)
      .run(JSON.stringify({ item_id: 'ITEM-1' }));
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at)
      VALUES ('evt-q','webhook.audit','2000-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO inbox_items
      (event_id,channel,resource_id,title,created_at,updated_at)
      VALUES ('evt-q','ml','77','Pregunta',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
    const result = await procesarIntegrationJobs(db, { workerId: 'test-worker' });
    expect(result).toEqual({ claimed: 1, processed: 1 });
    expect(db.prepare("SELECT status FROM integration_jobs WHERE event_id='evt-q'").get().status).toBe('completed');
    expect(db.prepare("SELECT status FROM integration_events WHERE event_id='evt-q'").get().status).toBe('completed');
    expect(db.prepare("SELECT COUNT(*) n FROM inbox_items WHERE event_id='evt-q'").get().n).toBe(1);
    db.close();
  });

  it('manda un tipo no soportado a DLQ sin reintento', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events
      (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key)
      VALUES ('evt-x','x','ml','test',CURRENT_TIMESTAMP,'corr-x','dedupe-x')`).run();
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at,max_attempts)
      VALUES ('evt-x','unknown','2000-01-01T00:00:00Z',8)`).run();
    await procesarIntegrationJobs(db, { workerId: 'test-worker' });
    expect(db.prepare("SELECT status,last_error_code FROM integration_jobs WHERE event_id='evt-x'").get())
      .toEqual({ status: 'dead_lettered', last_error_code: 'job_type_unsupported' });
    db.close();
  });

  it('no permite completar con otro worker y permite reprocesar una DLQ', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key) VALUES ('evt-l','x','ml','test',CURRENT_TIMESTAMP,'corr-l','dedupe-l')`).run();
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at,max_attempts,status) VALUES ('evt-l','unknown','2000-01-01T00:00:00Z',1,'dead_lettered')`).run();
    const jobId = db.prepare("SELECT job_id FROM integration_jobs WHERE event_id='evt-l'").get().job_id;
    expect(reprocesarJob(db, jobId)).toBe(true);
    expect(db.prepare("SELECT status FROM integration_events WHERE event_id='evt-l'").get().status).toBe('pending');
    expect(db.prepare("SELECT stage,to_status FROM integration_event_history WHERE event_id='evt-l' ORDER BY history_id DESC LIMIT 1").get())
      .toMatchObject({ stage: 'job.reprocess', to_status: 'pending' });
    const [claimed] = reclamarJobs(db, 'worker-a');
    expect(completarJob(db, claimed.job_id, 'worker-b', claimed.lease_token)).toBe(false);
    expect(completarJob(db, claimed.job_id, 'worker-a', claimed.lease_token)).toBe(true);
    db.close();
  });

  it('no colisiona dos acciones legacy del mismo recurso', () => {
    const db = openDb(':memory:');
    const a = registrarWebhookMl(db, { topic: 'post_purchase', action: 'claims', claim_id: '42', user_id: 'u' });
    const b = registrarWebhookMl(db, { topic: 'post_purchase', action: 'messages', claim_id: '42', user_id: 'u' });
    expect(a.eventId).not.toBe(b.eventId);
    expect(db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(2);
    db.close();
  });

  it('usa un token distinto por reclamación y rechaza el token vencido', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO integration_events (event_id,event_type,channel,source,received_at,correlation_id,dedupe_key) VALUES ('evt-t','x','ml','test',CURRENT_TIMESTAMP,'corr-t','dedupe-t')`).run();
    db.prepare(`INSERT INTO integration_jobs (event_id,job_type,available_at) VALUES ('evt-t','webhook.audit','2000-01-01T00:00:00Z')`).run();
    const [first] = reclamarJobs(db, 'worker');
    db.prepare("UPDATE integration_jobs SET lease_until='2000-01-01T00:00:00Z' WHERE job_id=?").run(first.job_id);
    const [second] = reclamarJobs(db, 'worker');
    expect(second.lease_token).not.toBe(first.lease_token);
    expect(completarJob(db, first.job_id, 'worker', first.lease_token)).toBe(false);
    expect(completarJob(db, second.job_id, 'worker', second.lease_token)).toBe(true);
    db.close();
  });

  it('mantiene un solo evento/job cuando falla la consulta autoritativa de un claim', async () => {
    const db = openDb(':memory:');
    mlFetch.mockResolvedValueOnce({ status: 503, data: null });
    const recibo = registrarWebhookMl(db, { topic: 'claims', resource: '/post-purchase/v1/claims/c-fail', _id: 'n-fail', user_id: 'u' });
    await procesarIntegrationJobs(db, { workerId: 'claim-failure', mlCfg: {} });
    expect(db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM integration_jobs').get().n).toBe(1);
    expect(db.prepare('SELECT status FROM integration_events WHERE event_id=?').get(recibo.eventId).status).toBe('failed');
    db.close();
  });

  it('no proyecta después de que el lease vence durante la consulta', async () => {
    const db = openDb(':memory:');
    const recibo = registrarWebhookMl(db, { topic: 'questions', resource: '/questions/909', _id: 'n-909', user_id: 'u' });
    mlFetch.mockImplementationOnce(async () => {
      db.prepare("UPDATE integration_jobs SET lease_until='2000-01-01T00:00:00Z' WHERE event_id=?").run(recibo.eventId);
      return { status: 200, data: { id: 909, text: 'no escribir', status: 'UNANSWERED' } };
    });
    await procesarIntegrationJobs(db, { workerId: 'lease-race', mlCfg: {} });
    expect(db.prepare("SELECT COUNT(*) n FROM ml_preguntas WHERE id=909").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM inbox_items WHERE event_id=?").get(recibo.eventId).n).toBe(0);
    db.close();
  });

  it('procesa messages de forma durable y deduplica por _id', async () => {
    mlFetch.mockResolvedValueOnce({ status: 200, data: [{ id: 'msg-1', text: 'hola' }] });
    const db = openDb(':memory:');
    const first = registrarWebhookMl(db, { topic: 'messages', resource: '/messages/msg-1', _id: 'ml-notif-1', user_id: 'u' });
    const second = registrarWebhookMl(db, { topic: 'messages', resource: '/messages/msg-1', _id: 'ml-notif-1', sent: 'different', user_id: 'u' });
    expect(second.duplicate).toBe(true);
    expect(db.prepare("SELECT job_type FROM integration_jobs WHERE event_id=?").get(first.eventId).job_type).toBe('message.project');
    await procesarIntegrationJobs(db, { workerId: 'messages', mlCfg: {} });
    expect(db.prepare("SELECT COUNT(*) n FROM ml_mensajes WHERE id='msg-1'").get().n).toBe(1);
    db.close();
  });

  it('trata como audit-only un post_purchase sin action=claims', () => {
    const db = openDb(':memory:');
    // Caso crítico: envelope con post_purchase, resource de claim, pero action distinta o ausente.
    // Antes del fix, esto caería en 'webhook.audit' y se perdería el reclamo silenciosamente.
    const recibo = registrarWebhookMl(db, {
      topic: 'post_purchase',
      action: 'created',  // action distinta a 'claims'
      resource: '/post-purchase/v1/claims/claim-123',
      user_id: 'u',
    });
    expect(recibo.ignored).toBe(false);
    const job = db.prepare('SELECT job_type FROM integration_jobs WHERE event_id=?').get(recibo.eventId);
    expect(job.job_type).toBe('webhook.audit');
    db.close();
  });
});

describe('proyección del topic `items` (§15 del plan: dejaba la decisión abierta)', () => {
  it('un aviso de items crea un job que proyecta, no uno audit-only', () => {
    const db = openDb(':memory:');
    const r = registrarWebhookMl(db, { topic: 'items', resource: '/items/MLA123', user_id: '9', sent: '2026-09-05T18:00:00Z' });
    expect(db.prepare('SELECT job_type FROM integration_jobs WHERE event_id=?').get(r.eventId).job_type).toBe('item.project');
    db.close();
  });

  it('un topic sin proyección definida sigue siendo audit-only', () => {
    const db = openDb(':memory:');
    const r = registrarWebhookMl(db, { topic: 'shipments', resource: '/shipments/1', user_id: '9', sent: '2026-09-05T18:00:00Z' });
    expect(db.prepare('SELECT job_type FROM integration_jobs WHERE event_id=?').get(r.eventId).job_type).toBe('webhook.audit');
    db.close();
  });

  it('un resource de items malformado NO crea un job de proyección', () => {
    const db = openDb(':memory:');
    const r = registrarWebhookMl(db, { topic: 'items', resource: '/items/', user_id: '9', sent: '2026-09-05T18:00:00Z' });
    expect(db.prepare('SELECT job_type FROM integration_jobs WHERE event_id=?').get(r.eventId).job_type).toBe('webhook.audit');
    db.close();
  });

  // La cuenta ya fue bloqueada una vez por exceso de llamadas: un aviso sobre un ítem que se
  // acaba de refrescar no puede gastar otra. ML manda ~2,6 avisos por ítem (medido).
  it('no llama a ML si el cache del ítem se refrescó recién', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,actualizado_en)
      VALUES ('MLA9|','MLA9','','Fresco','active',?)`).run(new Date().toISOString());
    const r = registrarWebhookMl(db, { topic: 'items', resource: '/items/MLA9', user_id: '9', sent: '2026-09-05T18:00:00Z' });
    mlFetch.mockClear();
    await procesarIntegrationJobs(db, { mlCfg: { clientId: 'c', clientSecret: 's', userId: '9' } });
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM integration_jobs WHERE event_id=?').get(r.eventId).status).toBe('completed');
    db.close();
  });
});

describe('captura de qué cambió en una publicación de ML', () => {
  function pub(db, clave, campos = {}) {
    const base = { seller_sku: 'FB-1', available_quantity: 3, status: 'active', sub_status: '', precio: 100, user_product_id: null, gtin: null, ...campos };
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,sub_status,seller_sku,available_quantity,precio,user_product_id,gtin,actualizado_en)
      VALUES (?,?,'','t',?,?,?,?,?,?,?,?)
      ON CONFLICT(clave) DO UPDATE SET status=excluded.status, sub_status=excluded.sub_status, seller_sku=excluded.seller_sku,
        available_quantity=excluded.available_quantity, precio=excluded.precio, user_product_id=excluded.user_product_id, gtin=excluded.gtin`)
      .run(clave, clave.split('|')[0], base.status, base.sub_status, base.seller_sku, base.available_quantity, base.precio, base.user_product_id, base.gtin, new Date().toISOString());
  }
  const snap = (db, item) => db.prepare(`SELECT clave,item_id,seller_sku,available_quantity,status,sub_status,precio,user_product_id,gtin
    FROM ml_publicaciones_cache WHERE item_id=?`).all(item);

  it('registra sólo los campos que cambiaron, con antes y después', () => {
    const db = openDb(':memory:');
    pub(db, 'MLA1|');
    const antes = snap(db, 'MLA1');
    pub(db, 'MLA1|', { precio: 150, available_quantity: 0 });
    expect(registrarCambiosObservados(db, 'MLA1', antes, 'webhook')).toBe(2);
    const filas = db.prepare('SELECT campo,antes,despues,origen FROM ml_cambios_observados ORDER BY campo').all();
    expect(filas).toEqual([
      { campo: 'available_quantity', antes: '3', despues: '0', origen: 'webhook' },
      { campo: 'precio', antes: '100', despues: '150', origen: 'webhook' },
    ]);
    db.close();
  });

  it('sin cambios no registra nada', () => {
    const db = openDb(':memory:');
    pub(db, 'MLA1|');
    expect(registrarCambiosObservados(db, 'MLA1', snap(db, 'MLA1'), 'webhook')).toBe(0);
    db.close();
  });

  it('una clave nueva no cuenta como cambio', () => {
    const db = openDb(':memory:');
    pub(db, 'MLA1|');
    const antes = snap(db, 'MLA1');
    pub(db, 'MLA1|b');
    expect(registrarCambiosObservados(db, 'MLA1', antes, 'webhook')).toBe(0);
    db.close();
  });

  // El caso que motivó todo esto: alguien edita el SELLER_SKU en ML por fuera de la
  // herramienta y hoy no quedaba rastro de que hubiera pasado.
  it('deja rastro de un SELLER_SKU editado fuera de la herramienta', () => {
    const db = openDb(':memory:');
    pub(db, 'MLA1|');
    const antes = snap(db, 'MLA1');
    pub(db, 'MLA1|', { seller_sku: 'FB-OTRO' });
    registrarCambiosObservados(db, 'MLA1', antes, 'webhook');
    expect(db.prepare("SELECT antes,despues FROM ml_cambios_observados WHERE campo='seller_sku'").get())
      .toEqual({ antes: 'FB-1', despues: 'FB-OTRO' });
    db.close();
  });
});
