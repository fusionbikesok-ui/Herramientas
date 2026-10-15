import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { activarGuardiaWoo, desactivarGuardiaWoo, postWoo } from './helpers/wooFirmado.js';

const puntualWeb = vi.fn(() => Promise.resolve());
const puntualMl = vi.fn(() => Promise.resolve());
const syncMl = vi.fn(() => Promise.resolve());
const puntualOrdenMl = vi.fn(() => Promise.resolve());
const kickTrabajos = vi.fn(() => Promise.resolve());
vi.mock('../routes/preparacion.js', async () => {
  const actual = await vi.importActual('../routes/preparacion.js');
  return { ...actual, syncPedidoWebPuntual: puntualWeb, syncPedidoMlPuntual: puntualMl };
});
vi.mock('../routes/sync.js', async () => {
  const actual = await vi.importActual('../routes/sync.js');
  return { ...actual, syncMlToWc: syncMl, syncOrdenMlPuntual: puntualOrdenMl, procesarTrabajosRecurso: kickTrabajos };
});

const { buildApp } = await import('../server.js');
const DB = './test/tmp-server-webhooks.sqlite';
let app;

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ML_USER_ID;
  delete process.env.MOBILE_JWT_SECRET;
  desactivarGuardiaWoo();
  try { app?._db?.close(); } catch {}
  app = undefined;
  try { fs.unlinkSync(DB); } catch {}
});

function nuevaApp() {
  process.env.MOBILE_JWT_SECRET = 'test-mobile-jwt-secret-123456789012345';
  activarGuardiaWoo();
  app = buildApp({ dbPath: DB, sessionSecret: 's', wooCfg: {}, mlCfg: { userId: '123' }, geminiKey: 'k' });
  return app;
}

describe('handlers reales de webhooks en server.js', () => {
  const trabajosWoo = (app) => app._db.prepare("SELECT recurso, estado, generacion FROM trabajos_recurso WHERE tipo = 'order.woo' ORDER BY recurso").all();

  it('E-1b el pedido Woo deja un trabajo order.woo durable antes del ACK y acelera el worker (sin syncWcToMl ni sync directo)', async () => {
    const app = nuevaApp();
    const res = await postWoo(request, app, '/api/woo/webhook/order', { id: 901, status: 'processing' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(trabajosWoo(app)).toEqual([{ recurso: '901', estado: 'pendiente', generacion: 1 }]);
    expect(kickTrabajos).toHaveBeenCalledTimes(1);
    expect(puntualWeb).not.toHaveBeenCalled();
  });

  it.each(['order.created', 'order.updated', 'order.deleted', 'order.restored'])('E-1b %s dispara el MISMO trabajo (el topic solo dispara; la relectura decide)', async (topic) => {
    const app = nuevaApp();
    // order.deleted de Woo trae solo el id: sin estado ni líneas.
    const cuerpo = topic === 'order.deleted' ? { id: 905 } : { id: 905, status: 'processing' };
    const res = await postWoo(request, app, '/api/woo/webhook/order', cuerpo, { topic, deliveryId: `e-${topic}` });
    expect(res.status).toBe(200);
    expect(trabajosWoo(app)).toEqual([{ recurso: '905', estado: 'pendiente', generacion: 1 }]);
    expect(app._db.prepare("SELECT json_extract(metadata_json,'$.topic') t FROM integration_events").get().t).toBe(topic);
  });

  it('E-1b varios avisos del mismo pedido (incluido un deleted atrasado) son UN trabajo con generación creciente', async () => {
    const app = nuevaApp();
    await postWoo(request, app, '/api/woo/webhook/order', { id: 906, status: 'processing' }, { topic: 'order.restored', deliveryId: 'a' });
    await postWoo(request, app, '/api/woo/webhook/order', { id: 906 }, { topic: 'order.deleted', deliveryId: 'b' });
    expect(trabajosWoo(app)).toEqual([{ recurso: '906', estado: 'pendiente', generacion: 2 }]);
  });

  it('E-1b un topic de pedido desconocido es 400 y no deja trabajo', async () => {
    const app = nuevaApp();
    const res = await postWoo(request, app, '/api/woo/webhook/order', { id: 907 }, { topic: 'order.foo' });
    expect(res.status).toBe(400);
    expect(trabajosWoo(app)).toEqual([]);
  });

  it('E1-RCP-01 el pedido Woo deja recibo antes del ACK, sin job y deduplicado por entrega', async () => {
    const app = nuevaApp();
    const envio = (id) => postWoo(request, app, '/api/woo/webhook/order',
      { id, status: 'processing', date_modified_gmt: '2026-09-16T10:00:00' }, { topic: 'order.updated', deliveryId: `entrega-${id}` });

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
    const res = await postWoo(request, app, '/api/woo/webhook/order', { status: 'processing' });
    expect(res.status).toBe(400);
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
    // Un aviso que no se puede identificar no dispara trabajo de fondo.
    expect(app._db.prepare("SELECT COUNT(*) n FROM trabajos_recurso WHERE tipo = 'order.woo'").get().n).toBe(0);
  });

  it('E-1a Woo sin WOO_WEBHOOK_SECRET es 503 (fail-closed), sin recibo ni trabajo de fondo', async () => {
    const app = nuevaApp();
    delete process.env.WOO_WEBHOOK_SECRET;
    const res = await postWoo(request, app, '/api/woo/webhook/order', { id: 903, status: 'processing' });
    expect(res.status).toBe(503);
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
    expect(trabajosWoo(app)).toEqual([]);
  });

  it('E-1a Woo sin firma es 401 y con firma de otro secreto también', async () => {
    const app = nuevaApp();
    expect((await postWoo(request, app, '/api/woo/webhook/order', { id: 904 }, { firmar: false })).status).toBe(401);
    expect((await postWoo(request, app, '/api/woo/webhook/order', { id: 904 }, { secreto: 'otro' })).status).toBe(401);
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
  });

  it('E-1a el ping de Woo (form-urlencoded firmado) se contesta 200 sin recibo ni trabajo', async () => {
    const app = nuevaApp();
    const cuerpo = 'webhook_id=7';
    const firma = (await import('crypto')).createHmac('sha256', 'secreto-test-woo').update(cuerpo).digest('base64');
    const res = await request(app).post('/api/woo/webhook/order')
      .set('content-type', 'application/x-www-form-urlencoded').set('x-wc-webhook-signature', firma).send(cuerpo);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ping: true });
    expect(app._db.prepare('SELECT COUNT(*) n FROM integration_events').get().n).toBe(0);
    expect(trabajosWoo(app)).toEqual([]);
  });

  it('E-1a un webhook de producto con topic de pedido es 400', async () => {
    const app = nuevaApp();
    expect((await postWoo(request, app, '/api/woo/webhook/product', { id: 5 }, { topic: 'order.updated' })).status).toBe(400);
  });

  describe('E-1c product.* → trabajo durable catalog.woo_product_sync', () => {
    const trabajosProd = (app) => app._db.prepare("SELECT recurso, estado, generacion FROM trabajos_recurso WHERE tipo = 'catalog.woo_product_sync' ORDER BY recurso").all();

    it.each(['product.created', 'product.updated', 'product.deleted', 'product.restored'])('%s deja el MISMO trabajo durable antes del ACK y acelera el worker', async (topic) => {
      const app = nuevaApp();
      const res = await postWoo(request, app, '/api/woo/webhook/product', { id: 1732 }, { topic, deliveryId: `p-${topic}` });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, duplicate: false });
      expect(trabajosProd(app)).toEqual([{ recurso: '1732', estado: 'pendiente', generacion: 1 }]);
      expect(kickTrabajos).toHaveBeenCalledTimes(1);
    });

    it('una variación se agrupa en el trabajo de su padre (parent_id del aviso, o el que conoce el caché)', async () => {
      const app = nuevaApp();
      app._db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,actualizado_en) VALUES (7248,'H','FB-7248','variation',1732,1,'x')").run();
      await postWoo(request, app, '/api/woo/webhook/product', { id: 7247, parent_id: 1732 }, { topic: 'product.deleted', deliveryId: 'a' });
      await postWoo(request, app, '/api/woo/webhook/product', { id: 7248 }, { topic: 'product.deleted', deliveryId: 'b' }); // sin parent_id: lo resuelve el caché
      expect(trabajosProd(app)).toEqual([{ recurso: '1732', estado: 'pendiente', generacion: 2 }]);
    });

    it('la entrega repetida no sube la generación ni vuelve a acelerar; el recibo no hace efecto (no borra nada por el topic)', async () => {
      const app = nuevaApp();
      app._db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (1732,'P','FB-1','simple',3,'x')").run();
      await postWoo(request, app, '/api/woo/webhook/product', { id: 1732 }, { topic: 'product.deleted', deliveryId: 'same' });
      const dup = await postWoo(request, app, '/api/woo/webhook/product', { id: 1732 }, { topic: 'product.deleted', deliveryId: 'same' });
      expect(dup.body).toMatchObject({ duplicate: true });
      expect(trabajosProd(app)).toEqual([{ recurso: '1732', estado: 'pendiente', generacion: 1 }]);
      expect(kickTrabajos).toHaveBeenCalledTimes(1);
      // el topic `deleted` por sí solo NO toca el catálogo ni registra ninguna baja
      expect(app._db.prepare('SELECT COUNT(*) n FROM catalogo_cache').get().n).toBe(1);
      expect(app._db.prepare('SELECT COUNT(*) n FROM woo_bajas_confirmadas').get().n).toBe(0);
    });

    it('fail-closed: sin secreto 503, sin firma o firma ajena 401, topic de pedido 400, id inválido 400; ninguno deja trabajo', async () => {
      const app = nuevaApp();
      expect((await postWoo(request, app, '/api/woo/webhook/product', { id: 1 }, { firmar: false })).status).toBe(401);
      expect((await postWoo(request, app, '/api/woo/webhook/product', { id: 1 }, { secreto: 'otro' })).status).toBe(401);
      expect((await postWoo(request, app, '/api/woo/webhook/product', { id: 1 }, { topic: 'order.updated' })).status).toBe(400);
      expect((await postWoo(request, app, '/api/woo/webhook/product', { id: 'abc' }, { topic: 'product.updated' })).status).toBe(400);
      expect((await postWoo(request, app, '/api/woo/webhook/product', { id: 0 }, { topic: 'product.updated' })).status).toBe(400);
      expect((await postWoo(request, app, '/api/woo/webhook/product', { id: 1 }, { topic: 'product.exploded' })).status).toBe(400);
      delete process.env.WOO_WEBHOOK_SECRET;
      expect((await postWoo(request, app, '/api/woo/webhook/product', { id: 1 }, { topic: 'product.updated' })).status).toBe(503);
      expect(trabajosProd(app)).toEqual([]);
      expect(kickTrabajos).not.toHaveBeenCalled();
    });
  });

  const trabajos = (app) => app._db.prepare("SELECT recurso, estado, generacion FROM trabajos_recurso WHERE tipo = 'order.ml' ORDER BY recurso").all();

  it.each(['orders', 'orders_v2'])('ML %s deja un trabajo order.ml durable antes del ACK y acelera el worker', async topic => {
    process.env.ML_USER_ID = '123';
    const app = nuevaApp();
    const res = await request(app).post('/api/ml/notificacion').send({ topic, resource: '/orders/ORD-1', user_id: 123 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(trabajos(app)).toEqual([{ recurso: 'ORD-1', estado: 'pendiente', generacion: 1 }]);
    expect(kickTrabajos).toHaveBeenCalledTimes(1);
    // Ya no se dispara la sincronización directa (se perdía si el proceso moría tras el ACK) ni el barrido completo.
    expect(puntualMl).not.toHaveBeenCalled();
    expect(puntualOrdenMl).not.toHaveBeenCalled();
    expect(syncMl).not.toHaveBeenCalled();
  });

  it('ignora user_id ajeno sin disparar trabajo', async () => {
    process.env.ML_USER_ID = '123';
    const app = nuevaApp();
    const res = await request(app).post('/api/ml/notificacion')
      .send({ topic: 'orders', resource: '/orders/ORD-2', user_id: 999 });
    expect(res.status).toBe(200);
    expect(trabajos(app)).toEqual([]);
    expect(kickTrabajos).not.toHaveBeenCalled();
    expect(syncMl).not.toHaveBeenCalled();
  });

  it('responde y descarta recurso inválido', async () => {
    process.env.ML_USER_ID = '123';
    const app = nuevaApp();
    const res = await request(app).post('/api/ml/notificacion')
      .send({ topic: 'orders_v2', resource: '/shipments/9', user_id: 123 });
    expect(res.status).toBe(200);
    expect(trabajos(app)).toEqual([]);
  });

  describe('coalescencia durable de avisos ML del mismo pedido', () => {
    it('avisos repetidos del mismo pedido (orders y orders_v2) comparten UN trabajo y suben su generación; el ACK es 200 siempre', async () => {
      process.env.ML_USER_ID = '123';
      const app = nuevaApp();
      const notif = (topic) => request(app).post('/api/ml/notificacion').send({ topic, resource: '/orders/ORD-DUP', user_id: 123 });
      const rs = [await notif('orders_v2'), await notif('orders_v2'), await notif('orders')];
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
      // El segundo orders_v2 es el mismo recibo (duplicado) y no suma; el orders es otro recibo del mismo recurso.
      expect(trabajos(app)).toEqual([{ recurso: 'ORD-DUP', estado: 'pendiente', generacion: 2 }]);
    });

    it('pedidos ML distintos tienen trabajos distintos', async () => {
      process.env.ML_USER_ID = '123';
      const app = nuevaApp();
      await request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/ORD-A', user_id: 123 });
      await request(app).post('/api/ml/notificacion').send({ topic: 'orders_v2', resource: '/orders/ORD-B', user_id: 123 });
      expect(trabajos(app).map((t) => t.recurso)).toEqual(['ORD-A', 'ORD-B']);
    });
  });
});
