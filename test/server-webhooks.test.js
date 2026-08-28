import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import request from 'supertest';

const puntualWeb = vi.fn(() => Promise.resolve());
const puntualMl = vi.fn(() => Promise.resolve());
const syncMl = vi.fn(() => Promise.resolve());
vi.mock('../routes/preparacion.js', async () => {
  const actual = await vi.importActual('../routes/preparacion.js');
  return { ...actual, syncPedidoWebPuntual: puntualWeb, syncPedidoMlPuntual: puntualMl };
});
vi.mock('../routes/sync.js', async () => {
  const actual = await vi.importActual('../routes/sync.js');
  return { ...actual, syncMlToWc: syncMl };
});

const { buildApp } = await import('../server.js');
const DB = './test/tmp-server-webhooks.sqlite';
let app;

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ML_USER_ID;
  try { app?._db?.close(); } catch {}
  app = undefined;
  try { fs.unlinkSync(DB); } catch {}
});

function nuevaApp() {
  app = buildApp({ dbPath: DB, sessionSecret: 's', wooCfg: {}, mlCfg: { userId: '123' }, geminiKey: 'k' });
  return app;
}

describe('handlers reales de webhooks en server.js', () => {
  it('Woo responde inmediato y deja el trabajo de fondo aunque rechace', async () => {
    puntualWeb.mockRejectedValueOnce(new Error('Woo caído'));
    const res = await request(nuevaApp()).post('/api/woo/webhook/order').send({ id: 901, status: 'processing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(puntualWeb).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ woo: {} }), 901);
  });

  it.each(['orders', 'orders_v2'])('ML %s dispara el camino puntual', async topic => {
    process.env.ML_USER_ID = '123';
    const res = await request(nuevaApp()).post('/api/ml/notificacion')
      .send({ topic, resource: '/orders/ORD-1', user_id: 123 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(puntualMl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: '123' }), 'ORD-1');
    expect(topic === 'orders' ? syncMl : syncMl).toHaveBeenCalledTimes(topic === 'orders' ? 1 : 0);
  });

  it('ignora user_id ajeno sin disparar trabajo', async () => {
    process.env.ML_USER_ID = '123';
    const res = await request(nuevaApp()).post('/api/ml/notificacion')
      .send({ topic: 'orders', resource: '/orders/ORD-2', user_id: 999 });
    expect(res.status).toBe(200);
    expect(puntualMl).not.toHaveBeenCalled();
    expect(syncMl).not.toHaveBeenCalled();
  });

  it('responde y descarta recurso inválido', async () => {
    process.env.ML_USER_ID = '123';
    const res = await request(nuevaApp()).post('/api/ml/notificacion')
      .send({ topic: 'orders_v2', resource: '/shipments/9', user_id: 123 });
    expect(res.status).toBe(200);
    expect(puntualMl).not.toHaveBeenCalled();
  });
});
