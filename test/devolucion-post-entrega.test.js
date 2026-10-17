import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { tratarCancelacionMl, cerrarDevolucionEnWoo, avisarDevolucionesSinLlegar } from '../lib/devolucionPostEntrega.js';
import { recibirDevolucion, clasificarDevolucion, marcarDanoDevolucion, resolverIncidente, descartarIncidente } from '../lib/stockExceptions.js';

const FILE = './test/tmp-devolucion-post-entrega.sqlite';
const ML = '2000018588847374';
const WC = 70010;
const CFG = { ml: { fake: true }, woo: { fake: true } };

describe('cancelación ML de una venta ya despachada (devolución post-entrega)', () => {
  let caeTrasPut, sinEnvio, db, llamadas, envio, pedidoWoo, fallaNota, fallaCancelar, stockWoo, fallaStock;

  const deps = () => ({
    mlFetch: async (_db, _cfg, _m, path) => {
      llamadas.push(['ml', path]);
      if (path.startsWith('/shipments/')) return envio instanceof Error ? { status: 500, data: null } : { status: 200, data: envio === undefined ? {} : { status: envio } };
      return { status: 200, data: { id: ML, shipping: sinEnvio ? {} : { id: 555 } } };
    },
    wooFetch: async (_cfg, path, method, body) => {
      llamadas.push(['woo', path, method, body]);
      if (path.endsWith('/notes')) { if (fallaNota) throw new Error('403 notes'); return { data: { id: 1 } }; }
      return { data: pedidoWoo };
    },
    cancelar: async (_db, _woo, id) => {
      llamadas.push(['cancelar', id]);
      if (fallaCancelar) throw new Error('woo caído');
      if (!registro().cancelado_en) stockWoo['FB-65235'] += 1; // Woo repone al cancelar (solo la primera vez)
      db.prepare('UPDATE ordenes_ml_wc_pedidos SET cancelado_en = ? WHERE ml_order_id = ?').run('2026-10-17T00:00:00Z', id);
      return { estado: 'cancelado', skus: ['FB-65235'] };
    },
    // Las firmas reales son getStockLiveWc(cfg, db, sku) y setStockWc(cfg, db, sku, n): el mock las valida.
    getStock: async (cfg, d, sku) => {
      if (cfg?.fake !== true || typeof d?.prepare !== 'function' || typeof sku !== 'string') throw new Error('firma inválida de getStock');
      return stockWoo[sku] ?? null;
    },
    setStock: async (cfg, d, sku, n) => {
      if (cfg?.fake !== true || typeof d?.prepare !== 'function' || typeof sku !== 'string' || !Number.isInteger(n)) throw new Error('firma inválida de setStock');
      if (fallaStock) throw new Error('put stock');
      stockWoo[sku] = n; llamadas.push(['setStock', sku, n]);
      if (caeTrasPut) { caeTrasPut = false; throw new Error('proceso caído tras el PUT'); }
    },
  });
  const orden = (extra = {}) => ({ id: ML, status: 'cancelled', shipping: { id: 555 }, ...extra });
  const registro = () => db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(ML);
  const devoluciones = () => db.prepare("SELECT * FROM stock_incidents WHERE origen = 'devolucion_cliente' ORDER BY id").all();

  beforeEach(() => {
    db = openDb(FILE);
    caeTrasPut = false; sinEnvio = false; llamadas = []; envio = 'delivered'; fallaNota = false; fallaCancelar = false; fallaStock = false; stockWoo = { 'FB-65235': 0, 'FB-2': 4 };
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

  for (const [nombre, valor] of [['sin status', undefined], ['status desconocido', 'teleportado']]) {
    it(`envío ${nombre}: fail-closed (lanza, no cancela, no registra)`, async () => {
      envio = valor;
      await expect(tratarCancelacionMl(db, CFG, orden(), deps())).rejects.toThrow(/status/);
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
      expect(devoluciones()).toHaveLength(0);
    });
  }
  for (const st of ['pending', 'handling', 'ready_to_ship', 'to_be_agreed', 'cancelled']) {
    it(`envío ${st} (antes del despacho, lista explícita): cancela como hoy`, async () => {
      envio = st;
      expect((await tratarCancelacionMl(db, CFG, orden(), deps())).estado).toBe('cancelado');
    });
  }
  it('orden sin shipping.id (venta sin envío): se trata como hoy', async () => {
    sinEnvio = true;
    expect((await tratarCancelacionMl(db, CFG, { id: ML, status: 'cancelled' }, deps())).estado).toBe('cancelado');
  });

  it('línea sin SKU o cantidad inválida: NO registra devolución parcial, no cancela, abre incidente y marca la orden', async () => {
    pedidoWoo = { status: 'processing', line_items: [{ sku: 'FB-65235', quantity: 1 }, { sku: '', quantity: 1 }] };
    const r = await tratarCancelacionMl(db, CFG, orden(), deps());
    expect(r).toMatchObject({ estado: 'devolucion_post_entrega', skus: [] });
    expect(devoluciones()).toHaveLength(0);
    expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
    expect(registro().devolucion_pendiente).toBeTruthy();
    expect(db.prepare("SELECT severidad FROM incidentes_operativos WHERE proceso='devoluciones_post_entrega' AND estado='activo'").all()).toHaveLength(1);
    await tratarCancelacionMl(db, CFG, orden(), deps()); // el barrido no la reprocesa
    expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
    expect(devoluciones()).toHaveLength(0);
  });

  it('carrera: el otro camino registra la devolución mientras se lee el envío → no cancela el pedido', async () => {
    envio = 'ready_to_ship';
    const d = deps();
    const mlLento = d.mlFetch;
    d.mlFetch = async (...a) => { // al leer el envío, el camino B (shipped) ya registró la devolución
      const r = await mlLento(...a);
      if (a[3].startsWith('/shipments/')) db.prepare('UPDATE ordenes_ml_wc_pedidos SET devolucion_pendiente = ? WHERE ml_order_id = ?').run('2026-10-17T00:00:00Z', ML);
      return r;
    };
    const r = await tratarCancelacionMl(db, CFG, orden(), d);
    expect(r).toMatchObject({ estado: 'devolucion_post_entrega', skus: [] });
    expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
  });

  it('una devolución de cliente sin clasificar no se resuelve ni se descarta a mano; condicionado/no_disponible se rechazan', async () => {
    await tratarCancelacionMl(db, CFG, orden(), deps());
    const d = devoluciones()[0];
    expect(resolverIncidente(db, d.id, { operation_id: 'x1', expected_version: d.expected_version, resolucion: 'ok', resuelto_por: 'ana' }))
      .toMatchObject({ ok: false, code: 'DEVOLUCION_SIN_CLASIFICAR' });
    expect(descartarIncidente(db, d.id, { operation_id: 'x2', expected_version: d.expected_version, motivo: 'no', descartado_por: 'ana' }))
      .toMatchObject({ ok: false, code: 'DEVOLUCION_SIN_CLASIFICAR' });
    recibirDevolucion(db, d.id, { operation_id: 'r1', expected_version: d.expected_version, recibido_por: 'ana' });
    for (const clasificacion of ['condicionado', 'no_disponible']) {
      expect(clasificarDevolucion(db, d.id, { operation_id: 'c-' + clasificacion, expected_version: 2, clasificacion, clasificado_por: 'ana' }))
        .toMatchObject({ ok: false, code: 'CLASIFICACION_NO_PERMITIDA' });
    }
    expect(devoluciones()[0].estado).toBe('abierto');
  });

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

    it('Dañada: caída entre el PUT de stock y la marca → el reintento deja el stock final = stock_antes (sin doble descuento)', async () => {
      await recibirYClasificar(danada);
      caeTrasPut = true; // el PUT se aplica y el proceso cae antes de la marca
      expect((await cerrarDevolucionEnWoo(db, CFG, ML, deps())).estado).toBe('reencolar');
      expect(db.prepare("SELECT stock_antes, descuento_woo_en FROM stock_incidents WHERE origen='devolucion_cliente'").get()).toMatchObject({ stock_antes: 0, descuento_woo_en: null });
      expect((await cerrarDevolucionEnWoo(db, CFG, ML, deps())).estado).toBe('hecho');
      expect(stockWoo['FB-65235']).toBe(0); // = stock_antes, no -1
      expect(llamadas.filter((l) => l[0] === 'setStock').every((l) => l[2] === 0)).toBe(true);
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
      expect(stockWoo['FB-65235']).toBe(0);
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
