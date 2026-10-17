import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { stockExceptionsRouter } from '../routes/stockExceptions.js';
import { tratarCancelacionMl, cerrarDevolucionEnWoo } from '../lib/devolucionPostEntrega.js';
import { recibirDevolucion, clasificarDevolucion } from '../lib/stockExceptions.js';

const FILE = './test/tmp-devolucion-no-llego.sqlite';
const ML = '2000018588847374';
const WC = 70010;
const CFG = { ml: {}, woo: {} };

describe('devolución de cliente que nunca llegó («No llegó», solo admin)', () => {
  let db, llamadas, pedidoWoo;
  const deps = () => ({
    mlFetch: async (_d, _c, _m, path) => (path.startsWith('/shipments/') ? { status: 200, data: { status: 'delivered' } } : { status: 200, data: { id: ML, shipping: { id: 1 } } }),
    wooFetch: async (_c, path, method, body) => { llamadas.push(['woo', path, method, body]); return { data: pedidoWoo }; },
    cancelar: async () => { llamadas.push(['cancelar']); return { estado: 'cancelado', skus: ['FB-1'] }; },
  });
  const app = (user) => {
    const a = express(); a.use(express.json());
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use('/api/stock-exceptions', stockExceptionsRouter(db));
    return a;
  };
  const admin = { username: 'jose', is_admin: true, permisos: [] };
  const deposito = { username: 'ana', permisos: [{ herramienta: 'stock-exceptions', nivel: 'write' }] };
  const supervisor = { username: 'sup', rol: 'supervisor', permisos: [{ herramienta: 'stock-exceptions', nivel: 'write' }] };
  const filas = () => db.prepare("SELECT * FROM stock_incidents WHERE origen='devolucion_cliente' ORDER BY id").all();
  const registro = () => db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(ML);
  const body = (f, extra = {}) => ({ expected_version: f.expected_version, operation_id: 'op-' + Math.random(), motivo: 'pasaron 30 días y ML cerró el reclamo', ...extra });
  const crear = async (lineas) => {
    pedidoWoo = { status: 'processing', line_items: lineas };
    await tratarCancelacionMl(db, CFG, { id: ML, status: 'cancelled', shipping: { id: 1 } }, deps());
  };

  beforeEach(() => {
    db = openDb(FILE); llamadas = [];
    db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, creado_en) VALUES (?, ?, ?)').run(ML, WC, '2026-09-20T00:00:00Z');
  });
  afterEach(() => { db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s); });

  it('no admin → 403 (depósito con permiso de escritura y supervisor incluidos); no cambia nada', async () => {
    await crear([{ sku: 'FB-1', quantity: 1 }]);
    const [f] = filas();
    for (const u of [deposito, supervisor]) {
      const r = await request(app(u)).post(`/api/stock-exceptions/devoluciones/${f.id}/no-llego`).send(body(f));
      expect(r.status).toBe(403);
    }
    expect(filas()[0].estado).toBe('abierto');
  });

  it('admin: motivo obligatorio (422) y, con motivo, cierra la fila sin cancelar el pedido ni tocar stock, con el actor auditado', async () => {
    await crear([{ sku: 'FB-1', quantity: 1 }]);
    const [f] = filas();
    const sin = await request(app(admin)).post(`/api/stock-exceptions/devoluciones/${f.id}/no-llego`).send(body(f, { motivo: '   ' }));
    expect(sin.status).toBe(422);
    const r = await request(app(admin)).post(`/api/stock-exceptions/devoluciones/${f.id}/no-llego`).send(body(f));
    expect(r.status).toBe(201);
    expect(r.body.orden_cerrada).toBe(true);
    expect(filas()[0]).toMatchObject({ estado: 'resuelto', resuelto_por: 'jose', woo_cierre_estado: 'hecho' });
    expect(filas()[0].resolucion).toMatch(/^No llegó: pasaron 30 días/);
    expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
    expect(db.prepare("SELECT actor, motivo FROM stock_exception_events WHERE evento='devolucion_no_llego'").get())
      .toMatchObject({ actor: 'jose', motivo: expect.stringMatching(/ML cerró/) });
    expect(db.prepare('SELECT COUNT(*) n FROM stock_exception_woo_outbox').get().n).toBe(0);
  });

  it('última fila de la orden: la orden queda cerrada y ni el barrido ni el trabajo de cierre la reprocesan', async () => {
    await crear([{ sku: 'FB-1', quantity: 1 }]);
    const [f] = filas();
    await request(app(admin)).post(`/api/stock-exceptions/devoluciones/${f.id}/no-llego`).send(body(f));
    expect(registro().devolucion_cerrada_en).toBeTruthy();
    expect(registro().cancelado_en).toBeNull();
    const r = await tratarCancelacionMl(db, CFG, { id: ML, status: 'cancelled', shipping: { id: 1 } }, deps());
    expect(r).toMatchObject({ estado: 'devolucion_post_entrega', skus: [] });
    expect((await cerrarDevolucionEnWoo(db, CFG, ML, deps())).estado).toBe('hecho');
    expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
  });

  it('orden mixta: la hermana disponible NO cancela el pedido porque la otra no llegó; abre incidente y deja nota', async () => {
    await crear([{ sku: 'FB-1', quantity: 1 }, { sku: 'FB-2', quantity: 1 }]);
    const [a, b] = filas();
    recibirDevolucion(db, a.id, { operation_id: 'ra', expected_version: 1, recibido_por: 'ana' });
    clasificarDevolucion(db, a.id, { operation_id: 'ca', expected_version: 2, clasificacion: 'disponible', clasificado_por: 'ana' });
    const r = await request(app(admin)).post(`/api/stock-exceptions/devoluciones/${b.id}/no-llego`).send(body(b));
    expect(r.body.orden_cerrada).toBe(false);
    expect(registro().devolucion_cerrada_en).toBeNull();
    expect(db.prepare("SELECT estado FROM trabajos_recurso WHERE tipo='devolucion.cierre' AND recurso=?").get(ML)).toBeTruthy();
    const c = await cerrarDevolucionEnWoo(db, CFG, ML, deps());
    expect(c).toMatchObject({ estado: 'hecho', skus: [] });
    expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
    expect(llamadas.filter((l) => l[1] === `/orders/${WC}/notes`).pop()[3].note).toMatch(/MIXTA/);
    expect(db.prepare("SELECT 1 FROM incidentes_operativos WHERE tipo_error LIKE 'clasificacion_mixta_%' AND estado='activo'").get()).toBeTruthy();
  });

  it('no aplica a una unidad ya recibida (se clasifica) ni repetido por operation_id', async () => {
    await crear([{ sku: 'FB-1', quantity: 1 }]);
    const [f] = filas();
    recibirDevolucion(db, f.id, { operation_id: 'r1', expected_version: 1, recibido_por: 'ana' });
    const recibida = await request(app(admin)).post(`/api/stock-exceptions/devoluciones/${f.id}/no-llego`).send(body(db.prepare('SELECT * FROM stock_incidents WHERE id=?').get(f.id)));
    expect(recibida.status).toBe(400);
    expect(filas()[0].estado).toBe('abierto');
  });

  it('cierra el aviso de «no llegó en 15 días» y es idempotente por operation_id', async () => {
    await crear([{ sku: 'FB-1', quantity: 1 }]);
    const [f] = filas();
    db.prepare("UPDATE stock_incidents SET creado_en = ? WHERE id = ?").run(new Date(Date.now() - 20 * 86400000).toISOString(), f.id);
    const { avisarDevolucionesSinLlegar } = await import('../lib/devolucionPostEntrega.js');
    expect(avisarDevolucionesSinLlegar(db).avisadas).toBe(1);
    const b = body(f);
    expect((await request(app(admin)).post(`/api/stock-exceptions/devoluciones/${f.id}/no-llego`).send(b)).status).toBe(201);
    expect((await request(app(admin)).post(`/api/stock-exceptions/devoluciones/${f.id}/no-llego`).send(b)).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM incidentes_operativos WHERE tipo_error = ? AND estado='activo'").get(`sin_llegar_${f.id}`).n).toBe(0);
  });
});
