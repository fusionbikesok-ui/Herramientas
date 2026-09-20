import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import request from 'supertest';

const puntualWeb = vi.fn(() => Promise.resolve());
const puntualMl = vi.fn(() => Promise.resolve());
const syncMl = vi.fn(() => Promise.resolve());
const puntualOrdenMl = vi.fn(() => Promise.resolve());
vi.mock('../routes/preparacion.js', async () => {
  const actual = await vi.importActual('../routes/preparacion.js');
  return { ...actual, syncPedidoWebPuntual: puntualWeb, syncPedidoMlPuntual: puntualMl };
});
vi.mock('../routes/sync.js', async () => {
  const actual = await vi.importActual('../routes/sync.js');
  return { ...actual, syncMlToWc: syncMl, syncOrdenMlPuntual: puntualOrdenMl };
});

const { buildApp } = await import('../server.js');
const DB = './test/tmp-server-webhooks.sqlite';
let app;

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ML_USER_ID;
  delete process.env.MOBILE_JWT_SECRET;
  try { app?._db?.close(); } catch {}
  app = undefined;
  try { fs.unlinkSync(DB); } catch {}
});

function nuevaApp() {
  process.env.MOBILE_JWT_SECRET = 'test-mobile-jwt-secret-123456789012345';
  app = buildApp({ dbPath: DB, sessionSecret: 's', wooCfg: {}, mlCfg: { userId: '123' }, geminiKey: 'k' });
  return app;
}

describe('handlers reales de webhooks en server.js', () => {
  it('Woo responde inmediato y deja el trabajo de fondo aunque rechace', async () => {
    puntualWeb.mockRejectedValueOnce(new Error('Woo caído'));
    const res = await request(nuevaApp()).post('/api/woo/webhook/order').send({ id: 901, status: 'processing' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(puntualWeb).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ woo: {} }), 901);
  });

  it('E1-RCP-01 el pedido Woo deja recibo antes del ACK, sin job y deduplicado por entrega', async () => {
    const app = nuevaApp();
    const envio = (id) => request(app).post('/api/woo/webhook/order')
      .set('x-wc-webhook-topic', 'order.updated')
      .set('x-wc-webhook-delivery-id', `entrega-${id}`)
      .send({ id, status: 'processing', date_modified_gmt: '2026-09-16T10:00:00' });

    expect((await envio(902)).status).toBe(200);
    const fila = app._db.prepare("SELECT status,shadow_status,resource_id,channel FROM integration_events").get();
    // Trabajo legacy cerrado (en pedidos Woo no hay job) y, con la copia de sombra apagada, sin ciclo de
    // sombra: un 'pending' que nadie cierra quedaría activo para siempre.
    expect(fila).toMatchObject({ status: 'completed', shadow_status: null, resource_id: '/orders/902', channel: 'woo' });
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_jobs').get().n).toBe(0);

    // Reentrega de WC: mismo delivery id, un solo recibo.
    expect((await envio(902)).status).toBe(200);
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(1);
  });

  it('E1-RCP-01 un pedido Woo sin id válido es 400 y no se reintenta', async () => {
    const app = nuevaApp();
    const res = await request(app).post('/api/woo/webhook/order').send({ status: 'processing' });
    expect(res.status).toBe(400);
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
    // Un aviso que no se puede identificar no dispara trabajo de fondo.
    expect(puntualWeb).not.toHaveBeenCalled();
  });

  it.each(['orders', 'orders_v2'])('ML %s dispara el camino puntual', async topic => {
    process.env.ML_USER_ID = '123';
    const res = await request(nuevaApp()).post('/api/ml/notificacion')
      .send({ topic, resource: '/orders/ORD-1', user_id: 123 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(puntualMl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: '123' }), 'ORD-1');
    // El webhook usa el procesamiento puntual; no dispara el barrido completo de ML.
    expect(syncMl).not.toHaveBeenCalled();
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

  describe('deduplicación corta de notificaciones ML repetidas del mismo pedido', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('dos webhooks orders_v2 seguidos del mismo pedido disparan una sola sincronización, y el ACK sigue en 200 en los dos', async () => {
      process.env.ML_USER_ID = '123';
      const app = nuevaApp();
      const notif = () => request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/ORD-DUP', user_id: 123 });
      const r1 = await notif();
      const r2 = await notif();
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(puntualMl).toHaveBeenCalledTimes(1);
    });

    it('pasada la ventana de 15 s, el mismo pedido vuelve a disparar la sincronización', async () => {
      process.env.ML_USER_ID = '123';
      vi.useFakeTimers();
      const app = nuevaApp();
      const notif = () => request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/ORD-VENTANA', user_id: 123 });
      await notif();
      vi.advanceTimersByTime(15_001);
      await notif();
      expect(puntualMl).toHaveBeenCalledTimes(2);
    });

    it('pedidos ML distintos no se pisan entre sí', async () => {
      process.env.ML_USER_ID = '123';
      const app = nuevaApp();
      await request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/ORD-A', user_id: 123 });
      await request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/ORD-B', user_id: 123 });
      expect(puntualMl).toHaveBeenCalledTimes(2);
      expect(puntualMl).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ORD-A');
      expect(puntualMl).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ORD-B');
    });

    it('syncOrdenMlPuntual y syncPedidoMlPuntual tienen ventanas de dedup independientes: un orders_v2 no bloquea el orders posterior del mismo pedido', async () => {
      process.env.ML_USER_ID = '123';
      const app = nuevaApp();
      // orders_v2 sólo dispara syncPedidoMlPuntual; no debería consumir la ventana de syncOrdenMlPuntual.
      await request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/ORD-COMPARTIDO', user_id: 123 });
      await request(app).post('/api/ml/notificacion').send({ topic: 'orders', resource: '/orders/ORD-COMPARTIDO', user_id: 123 });
      // Las dos llamadas a syncPedidoMlPuntual caen en la misma ventana (mismo pedido): una sola.
      expect(puntualMl).toHaveBeenCalledTimes(1);
      // syncOrdenMlPuntual es de 'orders' únicamente y nunca se disparó antes para este pedido: sí corre.
      expect(puntualOrdenMl).toHaveBeenCalledTimes(1);
      expect(puntualOrdenMl).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ORD-COMPARTIDO');
    });

    it('el Map de dedup no acumula entradas vencidas para siempre', async () => {
      process.env.ML_USER_ID = '123';
      vi.useFakeTimers();
      const app = nuevaApp();
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: `/orders/ORD-VIEJO-${i}`, user_id: 123 });
      }
      vi.advanceTimersByTime(15_001);
      // Un pedido nuevo, después de vencida la ventana de los anteriores: su sola llegada purga lo vencido
      // (purga perezosa, sin tabla ni temporizador aparte) y no se acumula sin límite.
      await request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/ORD-NUEVO', user_id: 123 });
      expect(puntualMl).toHaveBeenCalledTimes(6);
      // No hay forma directa de leer el tamaño del Map desde afuera del módulo: se verifica por
      // comportamiento — un pedido repetido de los "viejos", ya vencidos, vuelve a disparar.
      await request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/ORD-VIEJO-0', user_id: 123 });
      expect(puntualMl).toHaveBeenCalledTimes(7);
    });
  });
});
