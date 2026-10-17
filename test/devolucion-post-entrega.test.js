import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { tratarCancelacionMl, cerrarDevolucionEnWoo, avisarDevolucionesSinLlegar } from '../lib/devolucionPostEntrega.js';
import { recibirDevolucion, clasificarDevolucion, marcarDanoDevolucion } from '../lib/stockExceptions.js';

const FILE = './test/tmp-devolucion-post-entrega.sqlite';
const ML = '2000018588847374';
const WC = 70010;
const CFG = { ml: { fake: true }, woo: { fake: true } };

describe('cancelación ML de una venta ya despachada (devolución post-entrega)', () => {
  let db, llamadas, envio, pedidoWoo, fallaNota, fallaCancelar, stockWoo, fallaStock;

  const deps = () => ({
    mlFetch: async (_db, _cfg, _m, path) => {
      llamadas.push(['ml', path]);
      if (path.startsWith('/shipments/')) return envio instanceof Error ? { status: 500, data: null } : { status: 200, data: { status: envio } };
      return { status: 200, data: { id: ML, shipping: { id: 555 } } };
    },
    wooFetch: async (_cfg, path, method, body) => {
      llamadas.push(['woo', path, method, body]);
      if (path.endsWith('/notes')) { if (fallaNota) throw new Error('403 notes'); return { data: { id: 1 } }; }
      return { data: pedidoWoo };
    },
    cancelar: async (_db, _woo, id) => {
      llamadas.push(['cancelar', id]);
      if (fallaCancelar) throw new Error('woo caído');
      db.prepare('UPDATE ordenes_ml_wc_pedidos SET cancelado_en = ? WHERE ml_order_id = ?').run('2026-10-17T00:00:00Z', id);
      return { estado: 'cancelado', skus: ['FB-65235'] };
    },
    getStock: async (_db, _woo, sku) => stockWoo[sku] ?? null,
    setStock: async (_woo, _db, sku, n) => { if (fallaStock) throw new Error('put stock'); stockWoo[sku] = n; llamadas.push(['setStock', sku, n]); },
  });
  const orden = (extra = {}) => ({ id: ML, status: 'cancelled', shipping: { id: 555 }, ...extra });
  const registro = () => db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(ML);
  const devoluciones = () => db.prepare("SELECT * FROM stock_incidents WHERE origen = 'devolucion_cliente' ORDER BY id").all();

  beforeEach(() => {
    db = openDb(FILE);
    llamadas = []; envio = 'delivered'; fallaNota = false; fallaCancelar = false; fallaStock = false; stockWoo = { 'FB-65235': 1, 'FB-2': 4 };
    pedidoWoo = { status: 'processing', line_items: [{ sku: 'FB-65235', quantity: 1 }] };
    db.prepare('INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, creado_en) VALUES (?, ?, ?)').run(ML, WC, '2026-09-20T00:00:00Z');
  });
  afterEach(() => { db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s); });

  it('cancelación ANTES del despacho: cancela el pedido Woo como siempre y no crea devolución', async () => {
    envio = 'ready_to_ship';
    const r = await tratarCancelacionMl(db, CFG, orden(), deps());
    expect(r).toMatchObject({ estado: 'cancelado', skus: ['FB-65235'] });
    expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(true);
    expect(devoluciones()).toHaveLength(0);
    expect(registro().devolucion_pendiente).toBeNull();
  });

  for (const estado of ['shipped', 'delivered', 'not_delivered']) {
    it(`envío ${estado}: NO cancela el pedido Woo, agrega nota privada y crea la devolución`, async () => {
      envio = estado;
      const r = await tratarCancelacionMl(db, CFG, orden(), deps());
      expect(r).toMatchObject({ estado: 'devolucion_post_entrega', skus: [] });
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
      const nota = llamadas.find((l) => l[1] === `/orders/${WC}/notes`);
      expect(nota[2]).toBe('post');
      expect(nota[3]).toMatchObject({ customer_note: false });
      expect(nota[3].note).toMatch(/entregad|depósito/i);
      const [d] = devoluciones();
      expect(d).toMatchObject({ sku: 'FB-65235', cantidad: 1, ml_order_id: ML, wc_order_id: WC, estado: 'abierto', tipo: 'otro' });
      expect(d.motivo).toMatch(/ML/);
      expect(registro().cancelado_en).toBeNull();
      expect(registro().devolucion_pendiente).toBeTruthy();
      expect(registro().devolucion_nota_en).toBeTruthy();
    });
  }

  it('idempotente: los dos caminos (barrido y puntual) no duplican devolución ni nota', async () => {
    await tratarCancelacionMl(db, CFG, orden(), deps());
    await tratarCancelacionMl(db, CFG, orden(), deps());
    await Promise.all([tratarCancelacionMl(db, CFG, orden(), deps()), tratarCancelacionMl(db, CFG, orden(), deps())]);
    expect(devoluciones()).toHaveLength(1);
    expect(llamadas.filter((l) => l[1] === `/orders/${WC}/notes`)).toHaveLength(1);
    expect(llamadas.filter((l) => l[0] === 'cancelar')).toHaveLength(0);
  });

  it('envío ilegible: fail-closed (lanza, no cancela, no registra nada)', async () => {
    envio = new Error('x');
    await expect(tratarCancelacionMl(db, CFG, orden(), deps())).rejects.toThrow(/shipments/);
    expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
    expect(devoluciones()).toHaveLength(0);
    expect(registro().devolucion_pendiente).toBeNull();
  });

  it('la orden del barrido sin campo shipping se relee de ML antes de decidir', async () => {
    await tratarCancelacionMl(db, CFG, { id: ML, status: 'cancelled' }, deps());
    expect(llamadas.some((l) => l[0] === 'ml' && l[1] === `/orders/${ML}`)).toBe(true);
    expect(devoluciones()).toHaveLength(1);
  });

  it('si la nota falla la devolución queda creada y la nota se reintenta en la pasada siguiente (una sola vez)', async () => {
    fallaNota = true;
    await tratarCancelacionMl(db, CFG, orden(), deps());
    expect(devoluciones()).toHaveLength(1);
    expect(registro().devolucion_nota_en).toBeNull();
    fallaNota = false;
    await tratarCancelacionMl(db, CFG, orden(), deps());
    expect(registro().devolucion_nota_en).toBeTruthy();
    expect(llamadas.filter((l) => l[1] === `/orders/${WC}/notes` && !fallaNota).length).toBe(2); // 1 fallida + 1 ok
  });

  it('orden de varias líneas: una devolución por SKU (cantidades sumadas por SKU)', async () => {
    pedidoWoo = { status: 'processing', line_items: [{ sku: 'FB-65235', quantity: 1 }, { sku: 'FB-2', quantity: 2 }, { sku: 'FB-2', quantity: 1 }] };
    await tratarCancelacionMl(db, CFG, orden(), deps());
    expect(devoluciones().map((d) => [d.sku, d.cantidad])).toEqual([['FB-65235', 1], ['FB-2', 3]]);
  });

  describe('depósito recibe y clasifica', () => {
    async function recibirYClasificar(clasificar) {
      await tratarCancelacionMl(db, CFG, orden(), deps());
      const d = devoluciones()[0];
      const r1 = recibirDevolucion(db, d.id, { operation_id: 'r1', expected_version: d.expected_version, recibido_por: 'ana' });
      expect(r1.ok).toBe(true);
      const v = db.prepare('SELECT expected_version FROM stock_incidents WHERE id=?').get(d.id).expected_version;
      const r2 = clasificar(d.id, v);
      expect(r2.ok).toBe(true);
      return d.id;
    }
    const disponible = (id, v) => clasificarDevolucion(db, id, { operation_id: 'c1', expected_version: v, clasificacion: 'disponible', clasificado_por: 'ana' });
    const danada = (id, v) => marcarDanoDevolucion(db, id, { operation_id: 'c1', expected_version: v, motivo: 'cuadro rajado', marcado_por: 'ana' });

    it('clasificar NO usa el outbox +1/-1 (evita contar doble) y encola el trabajo de cierre', async () => {
      await recibirYClasificar(disponible);
      expect(db.prepare('SELECT COUNT(*) n FROM stock_exception_woo_outbox').get().n).toBe(0);
      expect(db.prepare("SELECT estado FROM trabajos_recurso WHERE tipo='devolucion.cierre' AND recurso=?").get(ML)).toMatchObject({ estado: 'pendiente' });
      expect(devoluciones()[0].woo_cierre_estado).toBe('pendiente');
    });

    it('Disponible: el cierre cancela el pedido Woo (Woo repone) y no toca el stock a mano', async () => {
      const id = await recibirYClasificar(disponible);
      const r = await cerrarDevolucionEnWoo(db, CFG, ML, deps());
      expect(r).toMatchObject({ estado: 'hecho', skus: ['FB-65235'] });
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(true);
      expect(llamadas.some((l) => l[0] === 'setStock')).toBe(false);
      expect(db.prepare('SELECT estado, woo_cierre_estado FROM stock_incidents WHERE id=?').get(id)).toMatchObject({ estado: 'resuelto', woo_cierre_estado: 'hecho' });
    });

    it('Dañada: cancela el pedido y descuenta la misma cantidad para que no sea vendible', async () => {
      stockWoo['FB-65235'] = 1; // lo que dejó Woo tras reponer
      const id = await recibirYClasificar(danada);
      const r = await cerrarDevolucionEnWoo(db, CFG, ML, deps());
      expect(r.estado).toBe('hecho');
      expect(llamadas.findIndex((l) => l[0] === 'cancelar')).toBeLessThan(llamadas.findIndex((l) => l[0] === 'setStock'));
      expect(stockWoo['FB-65235']).toBe(0);
      expect(db.prepare('SELECT descuento_woo_en, woo_cierre_estado FROM stock_incidents WHERE id=?').get(id).woo_cierre_estado).toBe('hecho');
    });

    it('falla de Woo al cancelar: reencola, deja el error visible y NO da nada por hecho', async () => {
      const id = await recibirYClasificar(disponible);
      fallaCancelar = true;
      const r = await cerrarDevolucionEnWoo(db, CFG, ML, deps());
      expect(r).toMatchObject({ estado: 'reencolar' });
      const f = db.prepare('SELECT estado, woo_cierre_estado, woo_cierre_error FROM stock_incidents WHERE id=?').get(id);
      expect(f).toMatchObject({ estado: 'abierto', woo_cierre_estado: 'error' });
      expect(f.woo_cierre_error).toMatch(/woo caído/);
      fallaCancelar = false;
      expect((await cerrarDevolucionEnWoo(db, CFG, ML, deps())).estado).toBe('hecho');
    });

    it('Dañada con falla al descontar: reintento no cancela dos veces ni descuenta dos veces', async () => {
      await recibirYClasificar(danada);
      fallaStock = true;
      expect((await cerrarDevolucionEnWoo(db, CFG, ML, deps())).estado).toBe('reencolar');
      fallaStock = false;
      expect((await cerrarDevolucionEnWoo(db, CFG, ML, deps())).estado).toBe('hecho');
      expect((await cerrarDevolucionEnWoo(db, CFG, ML, deps())).estado).toBe('hecho');
      expect(stockWoo['FB-65235']).toBe(0);
      expect(llamadas.filter((l) => l[0] === 'setStock')).toHaveLength(1);
    });

    it('orden de varias líneas: no cierra hasta que todos los SKUs estén recibidos y clasificados', async () => {
      pedidoWoo = { status: 'processing', line_items: [{ sku: 'FB-65235', quantity: 1 }, { sku: 'FB-2', quantity: 1 }] };
      await tratarCancelacionMl(db, CFG, orden(), deps());
      const [a] = devoluciones();
      recibirDevolucion(db, a.id, { operation_id: 'r1', expected_version: a.expected_version, recibido_por: 'ana' });
      clasificarDevolucion(db, a.id, { operation_id: 'c1', expected_version: 2, clasificacion: 'disponible', clasificado_por: 'ana' });
      const r = await cerrarDevolucionEnWoo(db, CFG, ML, deps());
      expect(r).toMatchObject({ estado: 'hecho', espera: true });
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
    });
  });

  describe('la unidad no llega', () => {
    const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();
    it('a los 15 días sin recepción abre UN incidente operativo por devolución y no toca stock', async () => {
      await tratarCancelacionMl(db, CFG, orden(), deps());
      db.prepare("UPDATE stock_incidents SET creado_en = ? WHERE origen='devolucion_cliente'").run(dias(16));
      expect(avisarDevolucionesSinLlegar(db).avisadas).toBe(1);
      expect(avisarDevolucionesSinLlegar(db).avisadas).toBe(0);
      const inc = db.prepare("SELECT * FROM incidentes_operativos WHERE proceso = 'devoluciones_post_entrega'").all();
      expect(inc).toHaveLength(1);
      expect(inc[0].mensaje_humano).toMatch(/MercadoLibre|ML/);
      expect(llamadas.some((l) => l[0] === 'setStock' || l[0] === 'cancelar')).toBe(false);
    });
    it('antes de 15 días o ya recibida: no avisa', async () => {
      await tratarCancelacionMl(db, CFG, orden(), deps());
      db.prepare("UPDATE stock_incidents SET creado_en = ? WHERE origen='devolucion_cliente'").run(dias(10));
      expect(avisarDevolucionesSinLlegar(db).avisadas).toBe(0);
      db.prepare("UPDATE stock_incidents SET creado_en = ?, recibido_en = ? WHERE origen='devolucion_cliente'").run(dias(20), dias(2));
      expect(avisarDevolucionesSinLlegar(db).avisadas).toBe(0);
    });
  });
});
