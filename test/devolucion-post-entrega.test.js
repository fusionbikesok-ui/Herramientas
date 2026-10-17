import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { tratarCancelacionMl, cerrarDevolucionEnWoo, avisarDevolucionesSinLlegar } from '../lib/devolucionPostEntrega.js';
import { recibirDevolucion, clasificarDevolucion, marcarDanoDevolucion, resolverIncidente, descartarIncidente } from '../lib/stockExceptions.js';

const FILE = './test/tmp-devolucion-post-entrega.sqlite';
const ML = '2000018588847374';
const WC = 70010;
// Forma real de GET /shipments/{id} (sin x-format-new) de un envío cancelado antes del despacho (verificada contra ML).
const HIST_CANCELADO = { date_handling: '2026-10-13T10:00:00Z', date_ready_to_ship: null, date_shipped: null, date_delivered: null, date_returned: null, date_not_delivered: null, date_cancelled: '2026-10-14T10:00:00Z' };
const CFG = { ml: { fake: true }, woo: { fake: true } };

describe('cancelación ML de una venta ya despachada (devolución post-entrega)', () => {
  let historial, sinEnvio, db, llamadas, envio, pedidoWoo, fallaNota, fallaCancelar;

  const deps = () => ({
    mlFetch: async (_db, _cfg, _m, path, _body, opts) => {
      llamadas.push(['ml', path, opts]);
      if (path.startsWith('/shipments/')) return envio instanceof Error ? { status: 500, data: null } : { status: 200, data: envio === undefined ? {} : { status: envio, ...(historial === undefined ? {} : { status_history: historial }) } };
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
      db.prepare('UPDATE ordenes_ml_wc_pedidos SET cancelado_en = ? WHERE ml_order_id = ?').run('2026-10-17T00:00:00Z', id);
      return { estado: 'cancelado', skus: ['FB-65235'] };
    },
  });
  const orden = (extra = {}) => ({ id: ML, status: 'cancelled', shipping: { id: 555 }, ...extra });
  const registro = () => db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(ML);
  const devoluciones = () => db.prepare("SELECT * FROM stock_incidents WHERE origen = 'devolucion_cliente' ORDER BY id").all();

  beforeEach(() => {
    db = openDb(FILE);
    historial = undefined; sinEnvio = false; llamadas = []; envio = 'delivered'; fallaNota = false; fallaCancelar = false;
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
  for (const st of ['pending', 'handling', 'ready_to_ship', 'to_be_agreed']) {
    it(`envío ${st} (antes del despacho, lista explícita): cancela como hoy`, async () => {
      envio = st;
      expect((await tratarCancelacionMl(db, CFG, orden(), deps())).estado).toBe('cancelado');
    });
  }
  describe('envío cancelled: manda el historial', () => {
    for (const h of [{ ...HIST_CANCELADO, date_shipped: '2026-09-20T10:00:00Z' }, { ...HIST_CANCELADO, date_delivered: '2026-09-22T10:00:00Z' }, { ...HIST_CANCELADO, date_returned: '2026-09-30T10:00:00Z' }]) {
      it(`con ${Object.keys(h)[0]} → post-entrega (no cancela el pedido)`, async () => {
        envio = 'cancelled'; historial = h;
        expect((await tratarCancelacionMl(db, CFG, orden(), deps())).estado).toBe('devolucion_post_entrega');
        expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
        expect(devoluciones()).toHaveLength(1);
      });
    }
    it('sin ninguna fecha de despacho/entrega → antes del despacho (cancela como hoy)', async () => {
      envio = 'cancelled'; historial = HIST_CANCELADO;
      expect((await tratarCancelacionMl(db, CFG, orden(), deps())).estado).toBe('cancelado');
    });
    it('sin status_history → fail-closed', async () => {
      envio = 'cancelled'; historial = undefined;
      await expect(tratarCancelacionMl(db, CFG, orden(), deps())).rejects.toThrow(/status_history/);
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
      expect(devoluciones()).toHaveLength(0);
    });
  });

  it('GET /shipments se hace SIN el header x-format-new (con él ML no trae status_history)', async () => {
    envio = 'cancelled'; historial = HIST_CANCELADO;
    await tratarCancelacionMl(db, CFG, orden(), deps());
    const ll = llamadas.find((l) => l[0] === 'ml' && l[1].startsWith('/shipments/'));
    expect(ll).toBeTruthy();
    expect(ll[2]?.headers?.['x-format-new']).toBeUndefined();
  });

  for (const [nombre, shipping] of [['null', null], ['{}', {}], ['sin id', { mode: 'custom' }]]) {
    it(`orden con shipping ${nombre} y relectura sin shipping.id: inconcluso (lanza, no cancela, no repone a ciegas)`, async () => {
      sinEnvio = true;
      await expect(tratarCancelacionMl(db, CFG, { id: ML, status: 'cancelled', shipping }, deps())).rejects.toThrow(/shipping\.id/);
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
      expect(llamadas.some((l) => l[0] === 'ml' && l[1] === `/orders/${ML}`)).toBe(true); // se releyó antes de rendirse
      expect(devoluciones()).toHaveLength(0);
    });
  }
  it('orden del listado con shipping {} pero la relectura trae el envío: decide por el envío', async () => {
    envio = 'delivered';
    const r = await tratarCancelacionMl(db, CFG, { id: ML, status: 'cancelled', shipping: {} }, deps());
    expect(r.estado).toBe('devolucion_post_entrega');
  });

  it('carrera exacta: el camino post-entrega espera el GET del pedido Woo y el de antes del despacho NO cancela mientras tanto', async () => {
    let soltar; const compuerta = new Promise((r) => { soltar = r; });
    const dA = deps(); // camino A: ve el envío despachado y se queda esperando el pedido Woo
    const wooA = dA.wooFetch;
    dA.mlFetch = async (...a) => (a[3].startsWith('/shipments/') ? { status: 200, data: { status: 'shipped' } } : { status: 200, data: { id: ML, shipping: { id: 555 } } });
    dA.wooFetch = async (cfg, path, ...r) => { if (path === `/orders/${WC}`) await compuerta; return wooA(cfg, path, ...r); };
    const dB = deps(); // camino B: vio el envío antes del despacho
    dB.mlFetch = async (...a) => (a[3].startsWith('/shipments/') ? { status: 200, data: { status: 'ready_to_ship' } } : { status: 200, data: { id: ML, shipping: { id: 555 } } });
    const pA = tratarCancelacionMl(db, CFG, orden(), dA);
    await new Promise((r) => setTimeout(r, 20));
    const pB = tratarCancelacionMl(db, CFG, orden(), dB);
    await new Promise((r) => setTimeout(r, 20));
    soltar();
    const [a, b] = await Promise.all([pA, pB]);
    expect(a.estado).toBe('devolucion_post_entrega');
    expect(b.estado).toBe('devolucion_post_entrega');
    expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
    expect(devoluciones()).toHaveLength(1);
  });

  it('la marca en_curso de la nota vence: un claim viejo (proceso caído) se recupera; uno reciente no', async () => {
    await tratarCancelacionMl(db, CFG, orden(), deps());
    const notas = () => llamadas.filter((l) => l[1] === `/orders/${WC}/notes`).length;
    db.prepare("UPDATE ordenes_ml_wc_pedidos SET devolucion_nota_en = ? WHERE ml_order_id = ?").run(`en_curso:${new Date(Date.now() - 60000).toISOString()}`, ML);
    await tratarCancelacionMl(db, CFG, orden(), deps());
    expect(notas()).toBe(1); // reciente: otro proceso la está posteando
    db.prepare("UPDATE ordenes_ml_wc_pedidos SET devolucion_nota_en = ? WHERE ml_order_id = ?").run(`en_curso:${new Date(Date.now() - 3600000).toISOString()}`, ML);
    await tratarCancelacionMl(db, CFG, orden(), deps());
    expect(notas()).toBe(2);
    expect(registro().devolucion_nota_en).not.toMatch(/^en_curso/);
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
      .toMatchObject({ ok: false, code: 'DEVOLUCION_DE_CLIENTE' });
    expect(descartarIncidente(db, d.id, { operation_id: 'x2', expected_version: d.expected_version, motivo: 'no', descartado_por: 'ana' }))
      .toMatchObject({ ok: false, code: 'DEVOLUCION_DE_CLIENTE' });
    recibirDevolucion(db, d.id, { operation_id: 'r1', expected_version: d.expected_version, recibido_por: 'ana' });
    for (const clasificacion of ['condicionado', 'no_disponible']) {
      expect(clasificarDevolucion(db, d.id, { operation_id: 'c-' + clasificacion, expected_version: 2, clasificacion, clasificado_por: 'ana' }))
        .toMatchObject({ ok: false, code: 'CLASIFICACION_NO_PERMITIDA' });
    }
    expect(devoluciones()[0].estado).toBe('abierto');
    // ya clasificada tampoco se cierra a mano: el cierre de la orden quedaría con un conjunto incompleto
    const v = db.prepare('SELECT expected_version v FROM stock_incidents WHERE id=?').get(d.id).v;
    expect(clasificarDevolucion(db, d.id, { operation_id: 'cd', expected_version: v, clasificacion: 'disponible', clasificado_por: 'ana' }).ok).toBe(true);
    const v2 = db.prepare('SELECT expected_version v FROM stock_incidents WHERE id=?').get(d.id).v;
    expect(resolverIncidente(db, d.id, { operation_id: 'x3', expected_version: v2, resolucion: 'ok', resuelto_por: 'ana' })).toMatchObject({ ok: false, code: 'DEVOLUCION_DE_CLIENTE' });
    expect(descartarIncidente(db, d.id, { operation_id: 'x4', expected_version: v2, motivo: 'no', descartado_por: 'ana' })).toMatchObject({ ok: false, code: 'DEVOLUCION_DE_CLIENTE' });
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
            expect(db.prepare('SELECT estado, woo_cierre_estado FROM stock_incidents WHERE id=?').get(id)).toMatchObject({ estado: 'resuelto', woo_cierre_estado: 'hecho' });
    });

    it('Dañada: NO cancela el pedido ni toca stock; solo nota privada y cierra la devolución', async () => {
      const id = await recibirYClasificar(danada);
      const r = await cerrarDevolucionEnWoo(db, CFG, ML, deps());
      expect(r).toMatchObject({ estado: 'hecho', skus: [] });
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
      expect(llamadas.some((l) => l[1]?.includes('/products') || l[2] === 'put')).toBe(false);
      const nota = llamadas.filter((l) => l[1] === `/orders/${WC}/notes`).pop();
      expect(nota[3]).toMatchObject({ customer_note: false });
      expect(nota[3].note).toMatch(/DAÑADA.*no reingresa al stock/);
      expect(db.prepare('SELECT estado, woo_cierre_estado FROM stock_incidents WHERE id=?').get(id)).toMatchObject({ estado: 'resuelto', woo_cierre_estado: 'hecho' });
      expect(registro().cancelado_en).toBeNull();
    });

    it('Dañada con la nota fallando: reencola sin cerrar; al reintentar cierra', async () => {
      const id = await recibirYClasificar(danada);
      fallaNota = true;
      expect((await cerrarDevolucionEnWoo(db, CFG, ML, deps())).estado).toBe('reencolar');
      expect(db.prepare('SELECT estado, woo_cierre_estado FROM stock_incidents WHERE id=?').get(id)).toMatchObject({ estado: 'abierto', woo_cierre_estado: 'error' });
      fallaNota = false;
      expect((await cerrarDevolucionEnWoo(db, CFG, ML, deps())).estado).toBe('hecho');
    });

    it('Mixta con el incidente fallando (fail-open de incidentes): no cierra las filas, reencola', async () => {
      pedidoWoo = { status: 'processing', line_items: [{ sku: 'FB-65235', quantity: 1 }, { sku: 'FB-2', quantity: 1 }] };
      await tratarCancelacionMl(db, CFG, orden(), deps());
      const [a, b] = devoluciones();
      for (const x of [a, b]) recibirDevolucion(db, x.id, { operation_id: 'r' + x.id, expected_version: 1, recibido_por: 'ana' });
      clasificarDevolucion(db, a.id, { operation_id: 'ca', expected_version: 2, clasificacion: 'disponible', clasificado_por: 'ana' });
      marcarDanoDevolucion(db, b.id, { operation_id: 'cb', expected_version: 2, motivo: 'rota', marcado_por: 'ana' });
      db.exec('ALTER TABLE incidentes_operativos_historial RENAME TO x_hist_roto');
      const r = await cerrarDevolucionEnWoo(db, CFG, ML, deps());
      expect(r.estado).toBe('reencolar');
      expect(llamadas.some((l) => l[1] === `/orders/${WC}/notes` && /MIXTA/.test(l[3]?.note))).toBe(false); // la nota va DESPUÉS del incidente: sin incidente no se postea (no se duplica en cada reintento)
      expect(devoluciones().every((x) => x.estado === 'abierto')).toBe(true);
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
    });

    it('Clasificación mixta (disponible + dañada): NO cancela, deja nota e incidente de revisión manual', async () => {
      pedidoWoo = { status: 'processing', line_items: [{ sku: 'FB-65235', quantity: 1 }, { sku: 'FB-2', quantity: 1 }] };
      await tratarCancelacionMl(db, CFG, orden(), deps());
      const [a, b] = devoluciones();
      for (const x of [a, b]) recibirDevolucion(db, x.id, { operation_id: 'r' + x.id, expected_version: 1, recibido_por: 'ana' });
      expect(clasificarDevolucion(db, a.id, { operation_id: 'ca', expected_version: 2, clasificacion: 'disponible', clasificado_por: 'ana' }).ok).toBe(true);
      expect(marcarDanoDevolucion(db, b.id, { operation_id: 'cb', expected_version: 2, motivo: 'rota', marcado_por: 'ana' }).ok).toBe(true);
      const r = await cerrarDevolucionEnWoo(db, CFG, ML, deps());
      expect(r).toMatchObject({ estado: 'hecho', skus: [] });
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
      expect(llamadas.filter((l) => l[1] === `/orders/${WC}/notes`).pop()[3].note).toMatch(/MIXTA/);
      expect(db.prepare("SELECT severidad FROM incidentes_operativos WHERE proceso='devoluciones_post_entrega' AND tipo_error LIKE 'clasificacion_mixta_%' AND estado='activo'").all()).toHaveLength(1);
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
      expect(llamadas.some((l) => l[0] === 'cancelar')).toBe(false);
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
