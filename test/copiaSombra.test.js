import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import request from 'supertest';
import { crearEmisorSombra, destinoSenal, RUTA_SENALES } from '../lib/emisorSombra.js';
import { firmarInterno } from '../lib/internoHmac.js';
import { crearSelectorCanario } from '../lib/sombra.js';

vi.mock('../routes/preparacion.js', async () => {
  const actual = await vi.importActual('../routes/preparacion.js');
  return { ...actual, syncPedidoWebPuntual: vi.fn(() => Promise.resolve()), syncPedidoMlPuntual: vi.fn(() => Promise.resolve()) };
});
vi.mock('../routes/sync.js', async () => {
  const actual = await vi.importActual('../routes/sync.js');
  return { ...actual, syncMlToWc: vi.fn(() => Promise.resolve()), syncWcToMl: vi.fn(() => Promise.resolve()), syncOrdenMlPuntual: vi.fn(() => Promise.resolve()) };
});
const { buildApp } = await import('../server.js');

const DB = './test/tmp-copia-sombra.sqlite';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
afterEach(async () => {
  await app?._colaSombra?.detener();
  try { app?._db?.close(); } catch {}
  app = undefined;
  delete process.env.ML_USER_ID;
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
});

function nuevaApp(sombraEnviar = null) {
  process.env.MOBILE_JWT_SECRET = 'test-mobile-jwt-secret-123456789012345';
  process.env.ML_USER_ID = '123';
  app = buildApp({ dbPath: DB, sessionSecret: 's', wooCfg: {}, mlCfg: { userId: '123' }, geminiKey: 'k', ...(sombraEnviar ? { sombraEnviar } : {}) });
  return app;
}
const fila = () => app._db.prepare('SELECT shadow_status, shadow_reason, ack_at, completed_at FROM integration_events ORDER BY received_at DESC LIMIT 1').get();

describe('E1-RCP-01 copia de sombra enganchada a los webhooks', () => {
  it('con la copia apagada no hay ciclo de sombra ni intento', async () => {
    delete process.env.SOMBRA_COPIA_ENABLED;
    const a = nuevaApp();
    expect(a._colaSombra).toBeNull();
    const r = await request(a).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/1', user_id: 123 });
    expect(r.status).toBe(200);
    expect(fila().shadow_status).toBeNull();
  });

  it('copia después del ACK los tres webhooks y no copia un duplicado', async () => {
    const enviados = [];
    const a = nuevaApp(async (t) => { enviados.push(t.eventId); });
    const ml = { topic: 'orders_v2', resource: '/orders/555', user_id: 123, _id: 'notif-1' };
    expect((await request(a).post('/api/ml/notificacion').send(ml)).status).toBe(200);
    expect((await request(a).post('/api/ml/notificacion').send(ml)).status).toBe(200);
    expect((await request(a).post('/api/woo/webhook/order').set('x-wc-webhook-delivery-id', 'd1').send({ id: 77, status: 'processing' })).status).toBe(200);
    expect((await request(a).post('/api/woo/webhook/product').set({ 'x-wc-webhook-topic': 'product.updated', 'x-wc-webhook-delivery-id': 'd2' }).send({ id: 88 })).status).toBe(200);
    await esperar(50);
    expect(enviados).toHaveLength(3);
    const estados = a._db.prepare('SELECT shadow_status, ack_at FROM integration_events').all();
    expect(estados.every((e) => e.shadow_status === 'copied' && e.ack_at)).toBe(true);
  });

  it('un aviso fuera de E1 queda excluido sin intento', async () => {
    const enviar = vi.fn(async () => undefined);
    const a = nuevaApp(enviar);
    expect((await request(a).post('/api/ml/notificacion').send({ topic: 'orders_feedback', resource: '/orders/9/feedback', user_id: 123 })).status).toBe(200);
    await esperar(30);
    expect(enviar).not.toHaveBeenCalled();
    expect(fila()).toMatchObject({ shadow_status: 'excluded', shadow_reason: 'unsupported_topic' });
  });

  it('una plataforma colgada no demora el ACK: el intento se descarta por timeout', async () => {
    const a = nuevaApp(() => new Promise((r) => setTimeout(r, 3_000)));
    const inicio = Date.now();
    const r = await request(a).post('/api/ml/notificacion').send({ topic: 'questions', resource: '/questions/42', user_id: 123 });
    expect(r.status).toBe(200);
    expect(Date.now() - inicio).toBeLessThan(250);
    await esperar(400);
    expect(fila()).toMatchObject({ shadow_status: 'discarded', shadow_reason: 'platform_timeout' });
  });
});

describe('canario de la copia (C10)', () => {
  it('filtra por canal y el porcentaje es determinístico por recurso', () => {
    const woo = crearSelectorCanario({ SOMBRA_CANALES: 'woo' });
    expect(woo.incluye('ml', 'ml.orders|1')).toBe(false);
    expect(woo.incluye('woo', 'woo.orders|1')).toBe(true);
    const diez = crearSelectorCanario({ SOMBRA_CANALES: 'woo', SOMBRA_PORCENTAJE: '10' });
    const recursos = Array.from({ length: 2000 }, (_, i) => `woo.products|${i}`);
    const dentro = recursos.filter((r) => diez.incluye('woo', r));
    // Aproximadamente 10 % y siempre la misma decisión para el mismo recurso.
    expect(dentro.length).toBeGreaterThan(140); expect(dentro.length).toBeLessThan(260);
    expect(recursos.filter((r) => diez.incluye('woo', r))).toEqual(dentro);
    // Ampliar el porcentaje nunca saca a un recurso que ya estaba adentro.
    const cincuenta = crearSelectorCanario({ SOMBRA_CANALES: 'woo', SOMBRA_PORCENTAJE: '50' });
    expect(dentro.every((r) => cincuenta.incluye('woo', r))).toBe(true);
    expect(crearSelectorCanario({ SOMBRA_PORCENTAJE: 'basura' }).incluye('woo', 'x')).toBe(false);
    expect(crearSelectorCanario({}).incluye('ml', 'x')).toBe(true);
  });

  it('un aviso de un canal no habilitado queda excluded/canary_excluded sin intento', async () => {
    process.env.SOMBRA_CANALES = 'woo';
    try {
      const enviar = vi.fn(async () => undefined);
      const a = nuevaApp(enviar);
      expect((await request(a).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/77', user_id: 123 })).status).toBe(200);
      expect((await request(a).post('/api/woo/webhook/order').set('x-wc-webhook-delivery-id', 'd9').send({ id: 99, status: 'processing' })).status).toBe(200);
      await esperar(50);
      expect(enviar).toHaveBeenCalledTimes(1);
      const filas = a._db.prepare('SELECT channel, shadow_status, shadow_reason FROM integration_events ORDER BY channel').all();
      expect(filas).toEqual([
        { channel: 'ml', shadow_status: 'excluded', shadow_reason: 'canary_excluded' },
        { channel: 'woo', shadow_status: 'copied', shadow_reason: null },
      ]);
    } finally { delete process.env.SOMBRA_CANALES; }
  });
});

describe('emisor de señales', () => {
  it('traduce cada recibo al tópico E1 y al id remoto pelado, o lo excluye', () => {
    const ev = (channel, topic, resource_id, extra = {}) => ({ event_id: `e-${resource_id}`, channel, resource_id, metadata_json: JSON.stringify({ topic, ...extra }) });
    expect(destinoSenal(ev('ml', 'orders_v2', '/orders/5', { notification_id: 'n1' }))).toMatchObject({ channel: 'mercadolibre', topic: 'ml.orders', resource_id: '5', notification_id: 'n1', source: 'webhook_copy' });
    expect(destinoSenal(ev('ml', 'post_purchase', '/post-purchase/v1/claims/9'))).toMatchObject({ topic: 'ml.claims', resource_id: '9' });
    expect(destinoSenal(ev('ml', 'items', '/items/MLA123'))).toMatchObject({ topic: 'ml.items', resource_id: 'MLA123' });
    expect(destinoSenal(ev('ml', 'messages', 'abc123'))).toMatchObject({ topic: 'ml.messages', resource_id: 'abc123' });
    expect(destinoSenal(ev('woo', 'order.updated', '/orders/77', { delivery_id: 'd' }))).toMatchObject({ channel: 'woocommerce', topic: 'woo.orders', resource_id: '77', notification_id: 'd' });
    expect(destinoSenal(ev('woo', 'product.updated', '/products/88'))).toMatchObject({ topic: 'woo.products', resource_id: '88' });
    for (const malo of [ev('ml', 'invoices', '/invoices/1'), ev('ml', 'orders_v2', '/orders/../users/me'), ev('woo', 'x', '/customers/1'), null]) {
      expect(destinoSenal(malo)).toBeNull();
    }
    expect(destinoSenal(ev('ml', 'orders_v2', '/orders/5')).fingerprint).toMatch(/^ev:[0-9a-f]{64}$/);
  });

  it('firma el cuerpo exacto, resuelve con 202 y normaliza el resto sin reintentar', async () => {
    const clave = crypto.randomBytes(32);
    const db = { prepare: () => ({ get: () => ({ event_id: 'e1', channel: 'ml', resource_id: '/orders/5', metadata_json: '{"topic":"orders_v2"}' }) }) };
    let respuesta = 202; let llamadas = 0;
    const fetchFalso = async (url, init) => {
      llamadas++;
      expect(String(url)).toBe(`http://host.docker.internal:3201${RUTA_SENALES}`);
      const h = init.headers;
      expect(h['x-fusion-signature']).toBe(firmarInterno(clave, h['x-fusion-timestamp'], h['x-fusion-nonce'], 'POST', RUTA_SENALES, init.body));
      if (respuesta === 'red') throw new Error('ECONNREFUSED');
      return new Response(null, { status: respuesta });
    };
    const enviar = crearEmisorSombra({ db, url: 'http://host.docker.internal:3201', keyring: { activeKeyId: 'k', keys: { k: clave } }, fetch: fetchFalso });
    await expect(enviar({ eventId: 'e1' })).resolves.toBeUndefined();
    respuesta = 400; await expect(enviar({ eventId: 'e1' })).rejects.toThrow('invalid_resource');
    // 409: la plataforma dice que el canal/tópico no corresponde a una cuenta configurada
    // (`channel_topic_mismatch`) — es un problema nuestro de configuración, no del recurso.
    respuesta = 409; await expect(enviar({ eventId: 'e1' })).rejects.toThrow('cuenta_no_configurada');
    respuesta = 503; await expect(enviar({ eventId: 'e1' })).rejects.toThrow('platform_unavailable');
    respuesta = 'red'; await expect(enviar({ eventId: 'e1' })).rejects.toThrow('platform_unavailable');
    expect(llamadas).toBe(5);
  });
});
