import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { buildApp } from '../server.js';
import { hashPassword, crearAccessToken } from '../lib/auth.js';

const TEST_DB = './test/tmp-server.sqlite';
const MOBILE_SECRET = 'mobile-secret-for-tests-at-least-32-chars';
let currentApp;

// La app usa sesión (cookie, /api/auth/login) — no HTTP Basic Auth. Sembrar un
// admin y devolver un agente supertest con la sesión ya iniciada (conserva cookies).
async function loginComoAdmin(app, { username = 'tester', password = 'test1234' } = {}) {
  const now = new Date().toISOString();
  app._db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
              VALUES (?, ?, 1, 1, ?, ?)`)
    .run(username, hashPassword(password), now, now);
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send({ username, password });
  if (login.status !== 200) throw new Error(`login de prueba falló: ${login.status} ${JSON.stringify(login.body)}`);
  return agent;
}

describe('server', () => {
  afterEach(() => {
    if (currentApp && currentApp._db) {
      try { currentApp._db.close(); } catch { /* already closed */ }
      currentApp = undefined;
    }
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    } catch { /* Windows may briefly retain the handle; safe to ignore in cleanup */ }
  });

  // En la suite global este caso compite con fixtures SQLite y llamadas mockeadas de los
  // módulos anteriores; aislado tarda ~1 s. El margen evita que la contención del runner
  // convierta un test de archivos estáticos en un falso fallo de disponibilidad.
  it('serves static pages without credentials (auth is on /api only)', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const stock = await request(app).get('/stock/');
    const etiquetas = await request(app).get('/etiquetas/');
    const inventario = await request(app).get('/inventario/');
    const login = await request(app).get('/login/');
    const matcher = await request(app).get('/matcher/');
    const vendorZxing = await request(app).get('/vendor/zxing.min.js');
    const scannerGate = await request(app).get('/lib/scannerGate.js');
    const scanner = await request(app).get('/lib/scanner.js');
    expect(stock.status).toBe(200);
    expect(etiquetas.status).toBe(200);
    expect(inventario.status).toBe(200);
    expect(login.status).toBe(200);
    expect(matcher.status).toBe(200);
    expect(vendorZxing.status).toBe(200);
    expect(scannerGate.status).toBe(200);
    expect(scanner.status).toBe(200);
  }, 30000);

  it('redirects the root (/) to /herramientas/home/', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const res = await request(app).get('/').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/herramientas/home/');
  });

  it('rejects API requests without sesión', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const res = await request(app).get('/api/woo/catalogo');
    expect(res.status).toBe(401);
  });

  it('mounts the woo, gemini, nuevos-productos, mapeo, csv, matcher and sync API routers', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const agent = await loginComoAdmin(app);

    const catalogo = await agent.get('/api/woo/catalogo');
    const categorias = await agent.get('/api/nuevos-productos/categorias');
    const mapeo = await agent.get('/api/mapeo/conocido');
    const decisiones = await agent.get('/api/matcher/decisiones');
    const syncEstado = await agent.get('/api/sync/estado');
    expect(catalogo.status).toBe(200);
    expect(categorias.status).toBe(200);
    expect(mapeo.status).toBe(200);
    expect(decisiones.status).toBe(200);
    expect(syncEstado.status).toBe(200);
    expect(syncEstado.body.ok).toBe(true);
  });

  it('GET /api/ml/token-estado: accesible por cualquier autenticado, fail-closed sin token', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const agent = await loginComoAdmin(app);

    const res = await agent.get('/api/ml/token-estado');
    expect(res.status).toBe(200);
    // Sin bootstrap OAuth previo: vencido y requiere re-autorización (fail-closed).
    expect(res.body).toMatchObject({
      ok: false,
      vencido: true,
      requiere_reautorizacion: true,
      reautorizar_url: '/api/sync/ml-auth-url',
    });
  });

  it('GET /api/ml/token-estado: token vigente reporta ok:true', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const now = new Date().toISOString();
    const vence = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
    app._db.prepare(`INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
      VALUES (1, 'tok', 'ref', ?, ?)`).run(vence, now);
    const agent = await loginComoAdmin(app);

    const res = await agent.get('/api/ml/token-estado');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vencido).toBe(false);
    expect(res.body.requiere_reautorizacion).toBe(false);
    expect(res.body.minutos_restantes).toBeGreaterThan(0);
  });

  it('rechaza construir la app sin MOBILE_JWT_SECRET válido', () => {
    expect(() => buildApp({ dbPath: TEST_DB, sessionSecret: 's', wooCfg: {}, geminiKey: 'k' }))
      .toThrow(/MOBILE_JWT_SECRET/);
  });

  it('rechaza con 401 una firma Woo inválida aunque tenga longitud incorrecta', async () => {
    const anterior = process.env.WOO_WEBHOOK_SECRET;
    process.env.WOO_WEBHOOK_SECRET = 'secret-de-prueba';
    try {
      const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
      currentApp = app;
      const res = await request(app).post('/api/woo/webhook/order')
        .set('x-wc-webhook-signature', 'invalid')
        .send({ id: 123 });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false, error: 'firma inválida' });
    } finally {
      if (anterior === undefined) delete process.env.WOO_WEBHOOK_SECRET;
      else process.env.WOO_WEBHOOK_SECRET = anterior;
    }
  });

  it('persiste antes del ACK un webhook firmado de producto Woo y deduplica su entrega', async () => {
    const anterior = process.env.WOO_WEBHOOK_SECRET;
    process.env.WOO_WEBHOOK_SECRET = 'secret-producto';
    try {
      const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
      currentApp = app;
      const payload = JSON.stringify({ id: 1732, type: 'variable', date_modified_gmt: '2026-09-05T01:00:00' });
      const firma = (await import('crypto')).createHmac('sha256', process.env.WOO_WEBHOOK_SECRET).update(payload).digest('base64');
      const enviar = () => request(app).post('/api/woo/webhook/product')
        .set('content-type', 'application/json')
        .set('x-wc-webhook-signature', firma)
        .set('x-wc-webhook-topic', 'product.updated')
        .set('x-wc-webhook-delivery-id', 'delivery-1732')
        .send(payload);
      const primero = await enviar();
      const segundo = await enviar();
      expect(primero.status).toBe(200);
      expect(primero.body).toMatchObject({ ok: true, duplicate: false });
      expect(segundo.body).toMatchObject({ ok: true, duplicate: true });
      expect(app._db.prepare("SELECT channel, source, status FROM integration_events WHERE event_id=?").get(primero.body.event_id))
        .toMatchObject({ channel: 'woo', source: 'woocommerce', status: 'pending' });
      expect(app._db.prepare("SELECT job_type FROM integration_jobs WHERE event_id=?").get(primero.body.event_id).job_type)
        .toBe('catalog.woo_product_sync');
    } finally {
      if (anterior === undefined) delete process.env.WOO_WEBHOOK_SECRET;
      else process.env.WOO_WEBHOOK_SECRET = anterior;
    }
  });

  it('API móvil real: login, Bearer JWT, permisos, refresh y revocación atómica del dispositivo', async () => {
    const app = buildApp({
      dbPath: TEST_DB,
      sessionSecret: 's',
      mobileJwtSecret: 'mobile-secret-for-tests-at-least-32-chars',
      wooCfg: {},
      geminiKey: 'k',
    });
    currentApp = app;
    const now = new Date().toISOString();
    app._db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, 0, 1, ?, ?)`).run('mobile', hashPassword('correcta123'), now, now);
    app._db.prepare(`INSERT INTO user_permisos (user_id, herramienta, nivel)
      SELECT id, 'notificaciones-ml', 'read' FROM users WHERE username = 'mobile'`).run();

    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'mobile', password: 'correcta123', platform: 'android', push_token: 'mobile-token',
    });
    expect(login.status).toBe(200);
    expect(login.body.access_token).toBeTruthy();
    expect(login.body.device_id).toBeTruthy();
    const auth = { Authorization: `Bearer ${login.body.access_token}` };

    const secondLogin = await request(app).post('/api/v1/auth/login').send({
      username: 'mobile', password: 'correcta123', device_id: login.body.device_id,
    });
    expect(secondLogin.status).toBe(200);

    expect((await request(app).get('/api/v1/me').set(auth)).status).toBe(200);
    expect((await request(app).get('/api/v1/notifications').set(auth)).status).toBe(200);
    expect((await request(app).get('/api/v1/inbox?cursor=not-a-cursor').set(auth)).status).toBe(422);
    expect((await request(app).get('/api/v1/integration-notifications?cursor=not-a-cursor').set(auth)).status).toBe(422);
    const mobileUserId = app._db.prepare("SELECT id FROM users WHERE username='mobile'").get().id;
    const ts = new Date().toISOString();
    app._db.prepare(`INSERT INTO user_notifications (user_id,title,body,created_at)
      VALUES (?, 'vieja', 'body', ?), (?, 'nueva', 'body', ?)`).run(mobileUserId, ts, mobileUserId, ts);
    const firstPage = await request(app).get('/api/v1/integration-notifications?limit=1').set(auth);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.next_cursor).toBeTruthy();
    const secondPage = await request(app).get(`/api/v1/integration-notifications?limit=1&cursor=${firstPage.body.next_cursor}`).set(auth);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect((await request(app).get('/api/v1/notifications/preferences').set(auth)).body)
      .toEqual({ incidentes_criticos: true });
    const preference = await request(app).patch('/api/v1/notifications/preferences').set(auth)
      .send({ incidentes_criticos: false });
    expect(preference.status).toBe(200);
    expect(preference.body).toEqual({ incidentes_criticos: false });
    expect((await request(app).get('/api/v1/devices')).status).toBe(401);

    const deleted = await request(app).delete(`/api/v1/devices/${login.body.device_id}`).set(auth);
    expect(deleted.status).toBe(200);
    const refresh = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: login.body.refresh_token });
    expect(refresh.status).toBe(401);
    const refresh2 = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: secondLogin.body.refresh_token });
    expect(refresh2.status).toBe(401);
    const revoked = app._db.prepare('SELECT revocado_en FROM mobile_refresh_tokens WHERE device_id = ?')
      .get(Number(login.body.device_id));
    expect(revoked.revocado_en).toBeTruthy();
  });

  it('declara y aplica 403 para notificaciones sin permiso, y 422 para read inválido', async () => {
    const app = buildApp({
      dbPath: TEST_DB,
      sessionSecret: 's',
      mobileJwtSecret: MOBILE_SECRET,
      wooCfg: {},
      geminiKey: 'k',
    });
    currentApp = app;
    const now = new Date().toISOString();
    app._db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, 0, 1, ?, ?)`).run('sin-permiso', hashPassword('correcta123'), now, now);
    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'sin-permiso', password: 'correcta123', platform: 'android', push_token: 'token-sin-permiso',
    });
    const auth = { Authorization: `Bearer ${login.body.access_token}` };
    expect((await request(app).get('/api/v1/notifications').set(auth)).status).toBe(403);
    expect((await request(app).post('/api/v1/notifications/abc/read').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/v1/notifications/preferences').set(auth)).status).toBe(403);

    app._db.prepare(`INSERT INTO user_permisos (user_id, herramienta, nivel)
      SELECT id, 'notificaciones-ml', 'read' FROM users WHERE username = 'sin-permiso'`).run();
    expect((await request(app).post('/api/v1/notifications/abc/read').set(auth)).status).toBe(422);
  });

  it('POST /api/admin/integration-jobs/:id/reprocess: reintenta un job DLQ (202)', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const agent = await loginComoAdmin(app);

    // Crear un evento y un job en DLQ.
    const now = new Date().toISOString();
    app._db.prepare(`INSERT INTO integration_events
      (event_id, event_type, channel, source, received_at, correlation_id, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('test-event-1', 'webhook.received', 'ml', 'mercadolibre', now, 'test-corr', 'test-dedupe');
    app._db.prepare(`INSERT INTO integration_jobs (event_id, job_type, available_at, status)
      VALUES (?, ?, ?, ?)`)
      .run('test-event-1', 'claim.project', now, 'dead_lettered');
    const jobId = app._db.prepare('SELECT job_id FROM integration_jobs WHERE event_id = ?').get('test-event-1').job_id;

    const res = await agent.post(`/api/admin/integration-jobs/${jobId}/reprocess`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, reprocessed: true });
    // Verificar que el job fue reabierto (status != 'dead_lettered').
    const updatedJob = app._db.prepare('SELECT status FROM integration_jobs WHERE job_id = ?').get(jobId);
    expect(updatedJob.status).not.toBe('dead_lettered');
  });

  it('POST /api/admin/integration-jobs/:id/reprocess: 404 si job no existe', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const agent = await loginComoAdmin(app);

    const res = await agent.post('/api/admin/integration-jobs/99999/reprocess');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'job DLQ no encontrado' });
  });

  it('POST /api/admin/integration-jobs/:id/reprocess: 403 si no es admin', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const now = new Date().toISOString();
    app._db.prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, 0, 1, ?, ?)`)
      .run('no-admin', hashPassword('test1234'), now, now);
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ username: 'no-admin', password: 'test1234' });
    expect(login.status).toBe(200);

    const res = await agent.post('/api/admin/integration-jobs/1/reprocess');
    expect(res.status).toBe(403);
  });

  it('POST /api/admin/integration-jobs/:id/reprocess: 401 sin sesión', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;

    const agent = request.agent(app);
    const res = await agent.post('/api/admin/integration-jobs/1/reprocess');
    expect(res.status).toBe(401);
  });

  it('agente de etiquetas: Bearer JWT válido y permiso permiten reclamar', async () => {
    const app = buildApp({ dbPath: TEST_DB, sessionSecret: 's', mobileJwtSecret: MOBILE_SECRET, wooCfg: {}, geminiKey: 'k' });
    currentApp = app;
    const now = new Date().toISOString();
    app._db.prepare(`INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?,?,?,?,?,?,?)`).run(77, 'agente-test', hashPassword('x'), 0, 1, now, now);
    app._db.prepare('INSERT INTO user_permisos (user_id, herramienta, nivel) VALUES (?,?,?)')
      .run(77, 'etiquetas', 'read');
    const device = app._db.prepare(`INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
      VALUES (?,?,?,?,?)`).run(77, 'device-agent-test', 'web', now, now);
    app._db.prepare(`INSERT INTO mobile_refresh_tokens (user_id, device_id, token_hash, expires_at, creado_en)
      VALUES (?,?,?,?,?)`).run(77, device.lastInsertRowid, 'agent-session-test', '2099-01-01T00:00:00.000Z', now);
    app._db.prepare(`INSERT INTO etiquetas_cola (sku, cantidad, estado, creado_en) VALUES (?,?,?,?)`)
      .run('AGENT-1', 1, 'pendiente', now);
    const token = crearAccessToken({ id: 77, username: 'agente-test' }, MOBILE_SECRET, undefined, 'agent-session-test');
    const res = await request(app).post('/api/etiquetas/cola/reclamar')
      .set('Authorization', `Bearer ${token}`).send({ agente_id: 'deposito-pc-test' });
    expect(res.status).toBe(200);
    expect(res.body.trabajo.sku).toBe('AGENT-1');
    app._db.prepare("DELETE FROM user_permisos WHERE user_id=? AND herramienta='etiquetas'").run(77);
    app._db.prepare(`INSERT INTO etiquetas_cola (sku, cantidad, estado, creado_en) VALUES (?,?,?,?)`)
      .run('AGENT-2', 1, 'pendiente', now);
    const denied = await request(app).post('/api/etiquetas/cola/reclamar')
      .set('Authorization', `Bearer ${token}`).send({ agente_id: 'deposito-pc-test' });
    expect(denied.status).toBe(403);
  });
});
