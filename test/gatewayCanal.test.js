import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import request from 'supertest';
import { construirOperacion, crearGatewayCanal, crearPresupuestoShadow, ErrorOperacionInvalida, OPERACIONES } from '../lib/gatewayCanal.js';
import { crearOrigenesInternos, firmarInterno } from '../lib/internoHmac.js';

const { buildApp } = await import('../server.js');
const DB = './test/tmp-gateway-canal.sqlite';
const ctx = { mlUserId: '123456', mlAppId: '998877', mlSiteId: 'MLA' };

describe('E1-GW-01 catálogo cerrado del gateway', () => {
  it('arma rutas sólo desde plantillas y con el vendedor de la configuración', () => {
    expect(construirOperacion({ op: 'ml.shipment', params: { id: '4455' } }, ctx)).toEqual({ canal: 'ml', ruta: '/shipments/4455', headers: { 'x-format-new': 'true' } });
    expect(construirOperacion({ op: 'ml.messages.pack', params: { pack: '200' } }, ctx).ruta)
      .toBe('/messages/packs/200/sellers/123456?tag=post_sale&mark_as_read=false');
    expect(construirOperacion({ op: 'ml.items.multiget', params: { ids: ['MLA1', 'MLA2'] } }, ctx).ruta).toBe('/items/bulk?ids=MLA1,MLA2');
    expect(construirOperacion({ op: 'woo.presence.list', params: { resource: 'orders', page: 2, status: 'trash' } }, ctx).ruta)
      .toBe('/orders?per_page=100&page=2&orderby=id&order=asc&status=trash&_fields=id');
  });

  it('rechaza antes de red todo lo que intente controlar método, host, path, query o encabezados', () => {
    const invalidas = [
      null, [], 'GET /orders', {},
      { op: 'ml.orders.post', params: {} },
      { op: '__proto__', params: {} },
      { op: 'ml.shipment', params: { id: '1', method: 'POST' } },
      { op: 'ml.shipment', params: { id: '1' }, method: 'DELETE' },
      { op: 'ml.shipment', params: { id: '1' }, url: 'https://evil.example' },
      { op: 'ml.shipment', params: { id: '../../users/me' } },
      { op: 'ml.shipment', params: { id: '1?access_token=x' } },
      { op: 'ml.orders.search', params: { from: '2026-09-16T00:00:00Z', to: '2026-09-16T01:00:00Z', offset: 0, seller: '999' } },
      { op: 'ml.orders.search', params: { from: 'ayer', to: '2026-09-16T01:00:00Z', offset: 0 } },
      { op: 'ml.items.multiget', params: { ids: Array.from({ length: 21 }, (_, i) => `MLA${i}`) } },
      { op: 'ml.items.multiget', params: { ids: ['MLA1,MLA2'] } },
      { op: 'ml.items.scan', params: { scroll_id: 'a&limit=1000' } },
      { op: 'woo.orders.list', params: { after: '2026-09-16T00:00:00Z', before: '2026-09-16T01:00:00Z', page: 1, status: 'processing' } },
      { op: 'woo.presence.list', params: { resource: 'customers', page: 1, status: 'any' } },
      { op: 'woo.variations.list', params: { product: '1/../../orders', page: 1 } },
      { op: 'ml.messages.unread', params: { role: 'buyer' } },
    ];
    for (const p of invalidas) expect(() => construirOperacion(p, ctx), JSON.stringify(p)).toThrow(ErrorOperacionInvalida);
  });

  it('ninguna plantilla produce una ruta con host, esquema o salto de directorio', () => {
    const ejemplos = {
      'ml.orders.search': { from: '2026-09-16T00:00:00Z', to: '2026-09-16T06:00:00Z', offset: 50 },
      'ml.missed_feeds': { topic: 'orders_v2', offset: 0 },
      'ml.order': { id: '1' }, 'woo.order': { id: '1' }, 'woo.product': { id: '1' },
      'ml.shipment': { id: '1' }, 'ml.questions.search': { offset: 0 }, 'ml.question': { id: '1' },
      'ml.claims.search': { offset: 0 }, 'ml.claim': { id: '1' }, 'ml.messages.unread': {}, 'ml.messages.pack': { pack: '1' },
      'ml.items.scan': { scroll_id: 'abc' }, 'ml.items.multiget': { ids: ['MLA1'] },
      'woo.orders.list': { after: '2026-09-16T00:00:00Z', before: '2026-09-16T06:00:00Z', page: 1, status: 'any' },
      'woo.products.list': { after: '2026-09-16T00:00:00Z', before: '2026-09-16T06:00:00Z', page: 1 },
      'woo.variations.list': { product: '1', page: 1 }, 'woo.presence.list': { resource: 'products', page: 1, status: 'any' },
    };
    expect(Object.keys(ejemplos).sort()).toEqual(Object.keys(OPERACIONES).sort());
    for (const [op, params] of Object.entries(ejemplos)) {
      const { ruta } = construirOperacion({ op, params }, ctx);
      expect(ruta.startsWith('/'), op).toBe(true);
      expect(ruta, op).not.toMatch(/\/\/|\.\.|:\/\/|access_token|#/);
    }
  });

  it('E1-MFD-01 missed_feeds: app_id y site_id salen de la configuración y items exige sitio', () => {
    expect(construirOperacion({ op: 'ml.missed_feeds', params: { topic: 'orders_v2', offset: 50 } }, ctx).ruta)
      .toBe('/missed_feeds?app_id=998877&topic=orders_v2&offset=50&limit=50');
    expect(construirOperacion({ op: 'ml.missed_feeds', params: { topic: 'items', offset: 0 } }, ctx).ruta)
      .toBe('/missed_feeds?app_id=998877&topic=items&offset=0&limit=50&site_id=MLA');
    expect(() => construirOperacion({ op: 'ml.missed_feeds', params: { topic: 'items', offset: 0 } }, { ...ctx, mlSiteId: null })).toThrow(ErrorOperacionInvalida);
    expect(() => construirOperacion({ op: 'ml.missed_feeds', params: { topic: 'orders_v2', offset: 0, app_id: '1' } }, ctx)).toThrow(ErrorOperacionInvalida);
    expect(() => construirOperacion({ op: 'ml.missed_feeds', params: { topic: 'payments', offset: 0 } }, ctx)).toThrow(ErrorOperacionInvalida);
    expect(() => construirOperacion({ op: 'ml.missed_feeds', params: { topic: 'orders_v2', offset: 0 } }, { ...ctx, mlAppId: null })).toThrow(ErrorOperacionInvalida);
  });

  it('presupuesto shadow en cero: ML responde 429 sintético sin llamar a ML', async () => {
    const ejecutarMl = vi.fn();
    const gw = crearGatewayCanal({ mlUserId: '1', ejecutarMl, ejecutarWoo: vi.fn() });
    expect(await gw({ op: 'ml.shipment', params: { id: '9' } })).toEqual({ status: 429, headers: { 'retry-after': '60' }, body: null });
    expect(ejecutarMl).not.toHaveBeenCalled();
    let t = 0; const cupo = crearPresupuestoShadow(2, () => t);
    expect([cupo(), cupo(), cupo()]).toEqual([true, true, false]);
    t = 60_000; expect(cupo()).toBe(true);
  });

  it('sanea la respuesta: sólo encabezados de paginado/retry y sin cuerpos de error remotos', async () => {
    const gw = crearGatewayCanal({
      mlUserId: '1', presupuestoMl: () => true,
      ejecutarMl: async () => ({ status: 403, headers: { 'set-cookie': 'x', authorization: 'Bearer secreto' }, data: { message: 'token APP_USR-123 inválido' } }),
      ejecutarWoo: async () => { throw Object.assign(new Error('WooCommerce API error 429'), { status: 429, retryAfterMs: 30_000, cuerpo: 'ck_secreto' }); },
    });
    const ml = await gw({ op: 'ml.question', params: { id: '5' } });
    expect(ml).toEqual({ status: 403, headers: {}, body: null });
    const woo = await gw({ op: 'woo.variations.list', params: { product: '3', page: 1 } });
    expect(woo).toEqual({ status: 429, headers: { 'retry-after': '30' }, body: null });
    expect(JSON.stringify([ml, woo])).not.toMatch(/APP_USR|ck_secreto|Bearer/);
  });
});

describe('E1-GW-01 ruta HTTP interna del legado', () => {
  let app;
  const clave = crypto.randomBytes(32);
  afterEach(() => {
    try { app?._db?.close(); } catch {}
    app = undefined;
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  });

  const nuevaApp = (ejecutar) => {
    process.env.MOBILE_JWT_SECRET = 'test-mobile-jwt-secret-123456789012345';
    app = buildApp({ dbPath: DB, sessionSecret: 's', wooCfg: {}, mlCfg: { userId: '123' }, geminiKey: 'k',
      gatewayInterno: { claves: { k1: clave }, origenes: crearOrigenesInternos('127.0.0.1/32,::1/128'), ejecutar } });
    return app;
  };
  const firmado = (cuerpo, o = {}) => {
    const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
    const nonce = o.nonce ?? crypto.randomBytes(16).toString('base64url');
    return {
      'content-type': 'application/json', 'x-fusion-key-id': 'k1', 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
      'x-fusion-signature': firmarInterno(o.clave ?? clave, ts, nonce, 'POST', '/internal/v1/channel-read', Buffer.from(cuerpo)),
    };
  };

  it('sin configuración la ruta no existe', async () => {
    process.env.MOBILE_JWT_SECRET = 'test-mobile-jwt-secret-123456789012345';
    delete process.env.GATEWAY_KEYRING_FILE;
    app = buildApp({ dbPath: DB, sessionSecret: 's', wooCfg: {}, mlCfg: {}, geminiKey: 'k' });
    const r = await request(app).post('/internal/v1/channel-read').set('content-type', 'application/json').send('{}');
    expect(r.status).toBe(404);
  });

  it('operación válida firmada: 200 con la respuesta saneada', async () => {
    const ejecutar = vi.fn(async () => ({ status: 200, headers: {}, body: { id: 5 } }));
    const cuerpo = JSON.stringify({ op: 'ml.question', params: { id: '5' } });
    const r = await request(nuevaApp(ejecutar)).post('/internal/v1/channel-read').set(firmado(cuerpo)).send(cuerpo);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 200, headers: {}, body: { id: 5 } });
  });

  it('401 sin firma, firma ajena, vencida, replay y reinicio con el mismo nonce; nada llega al ejecutor', async () => {
    const ejecutar = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    const cuerpo = JSON.stringify({ op: 'ml.question', params: { id: '5' } });
    const a = nuevaApp(ejecutar);
    const casos = [
      {}, firmado(cuerpo, { clave: crypto.randomBytes(32) }), firmado(cuerpo, { ts: Math.floor(Date.now() / 1000) - 301 }),
      firmado(JSON.stringify({ op: 'ml.question', params: { id: '6' } })),
    ];
    for (const h of casos) {
      const r = await request(a).post('/internal/v1/channel-read').set({ 'content-type': 'application/json', ...h }).send(cuerpo);
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.body)).not.toContain(clave.toString('hex'));
    }
    expect(ejecutar).not.toHaveBeenCalled();
    const h = firmado(cuerpo);
    expect((await request(a).post('/internal/v1/channel-read').set(h).send(cuerpo)).status).toBe(200);
    expect((await request(a).post('/internal/v1/channel-read').set(h).send(cuerpo)).status).toBe(401);
    // El nonce vive en SQLite: un proceso nuevo sobre la misma base tampoco acepta el replay.
    a._db.close();
    const b = nuevaApp(ejecutar);
    expect((await request(b).post('/internal/v1/channel-read').set(h).send(cuerpo)).status).toBe(401);
    expect(ejecutar).toHaveBeenCalledTimes(1);
  });

  it('401 desde un origen fuera de la red interna aunque la firma sea válida', async () => {
    process.env.MOBILE_JWT_SECRET = 'test-mobile-jwt-secret-123456789012345';
    const ejecutar = vi.fn();
    app = buildApp({ dbPath: DB, sessionSecret: 's', wooCfg: {}, mlCfg: {}, geminiKey: 'k',
      gatewayInterno: { claves: { k1: clave }, origenes: crearOrigenesInternos('172.17.0.0/16'), ejecutar } });
    const cuerpo = JSON.stringify({ op: 'ml.question', params: { id: '5' } });
    // X-Forwarded-For no cuenta: el origen sale del socket.
    const r = await request(app).post('/internal/v1/channel-read').set({ ...firmado(cuerpo), 'x-forwarded-for': '172.17.0.2' }).send(cuerpo);
    expect(r.status).toBe(401);
    expect(ejecutar).not.toHaveBeenCalled();
  });

  it('400 operación inválida firmada, 413 cuerpo grande y 502 sin detalle si el canal falla', async () => {
    const real = crearGatewayCanal({ mlUserId: '123', presupuestoMl: () => true, ejecutarMl: async () => { throw new Error('connect ECONNREFUSED api.mercadolibre.com token=APP_USR'); }, ejecutarWoo: vi.fn() });
    const a = nuevaApp(real);
    const mala = JSON.stringify({ op: 'ml.shipment', params: { id: '1', path: '/users/me' } });
    expect((await request(a).post('/internal/v1/channel-read').set(firmado(mala)).send(mala)).status).toBe(400);
    const grande = JSON.stringify({ op: 'ml.question', params: { id: '1' }, relleno: 'x'.repeat(17 * 1024) });
    expect((await request(a).post('/internal/v1/channel-read').set(firmado(grande)).send(grande)).status).toBe(413);
    const ok = JSON.stringify({ op: 'ml.question', params: { id: '1' } });
    const r = await request(a).post('/internal/v1/channel-read').set(firmado(ok)).send(ok);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|APP_USR|mercadolibre/);
  });
});
