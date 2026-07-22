/**
 * Tests de CARACTERIZACIÓN del contrato de datos que expone routes/preparacion.js
 * al frontend (public/preparacion/index.html), corridos ANTES de adoptar el modelo
 * canónico de Orden de venta (Fase 3 de lib/modelos/). Fijan:
 *   - las 14 claves exactas de normalizarEnvio (planilla Andreani, contrato con
 *     public/preparacion/index.html:461-468)
 *   - la forma completa de un pendiente 'web' y uno 'ml' (GET /pendientes)
 * Deben seguir en verde, sin modificarse, después del refactor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { normalizarEnvio } from '../lib/preparacion.js';

vi.mock('../routes/woo.js', async () => {
  const actual = await vi.importActual('../routes/woo.js');
  return { ...actual, wooFetch: vi.fn() };
});
vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));

import { wooFetch } from '../routes/woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { preparacionRouter } from '../routes/preparacion.js';

const TEST_DB = './test/tmp-preparacion-contrato.sqlite';

const CFG = {
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
  ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
  andreaniStatus: 'lpaandreani',
};

function buildTestApp(db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'tester', is_admin: 1 }; next(); });
  app.use('/api/preparacion', preparacionRouter(db, CFG));
  return app;
}

describe('contrato normalizarEnvio (planilla Andreani)', () => {
  it('expone exactamente las 14 claves que consume public/preparacion/index.html', () => {
    const order = {
      id: 77, number: '77',
      shipping: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', address_2: '2B', city: 'Córdoba', state: 'Córdoba', postcode: '5000', phone: '0351 4567890' },
      billing: { email: 'ana@mail.com' },
      customer_note: 'tocar timbre',
      meta_data: [{ key: '_billing_dni', value: '30123456' }],
    };
    const envio = normalizarEnvio(order);
    expect(Object.keys(envio).sort()).toEqual([
      'apellido', 'calle', 'caracteristica', 'cp', 'dni_cuit', 'email', 'localidad',
      'nombre', 'notas', 'numeracion', 'pedido', 'piso_depto', 'provincia', 'telefono',
    ].sort());
  });
});

describe('contrato GET /pendientes', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();

    // Catálogo para resolver categoría del ítem web (id_woo = variation_id||product_id).
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, actualizado_en) VALUES (?,?,?,?,?,?,?,?)'
    ).run(501, 'Bici Rodado', 'BIKE-1', 'simple', null, 3, '["Bicicletas"]', new Date().toISOString());

    // Mapeo + catálogo para resolver SKU/categoría del ítem ML.
    db.prepare(
      'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?,?,?,?,?)'
    ).run('MLA900|', 'CASCO-9', 'Casco L', 'confirmar', new Date().toISOString());
    db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, actualizado_en) VALUES (?,?,?,?,?,?,?,?)'
    ).run(601, 'Casco L', 'CASCO-9', 'simple', null, 5, '["Cascos"]', new Date().toISOString());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('un pendiente web y uno ml tienen exactamente la forma que espera el frontend', async () => {
    const orderWeb = {
      id: 900, number: '900', status: 'lpaandreani', date_created: '2026-07-01T00:00:00Z',
      billing: { first_name: 'Juan', last_name: 'Perez' },
      meta_data: [],
      line_items: [{ id: 1, product_id: 501, variation_id: 0, sku: '', name: 'Bici Rodado', quantity: 2 }],
    };
    wooFetch.mockResolvedValueOnce({ data: [orderWeb] });

    const ordenMl = {
      id: 'ORD-ML-1', date_created: '2026-07-02T00:00:00Z',
      buyer: { nickname: 'comprador_ml' },
      shipping: { id: 'SHIP-1' },
      order_items: [{ item: { id: 'MLA900', variation_id: '', seller_sku: 'CASCO-9' }, quantity: 1 }],
    };
    mlFetch
      .mockResolvedValueOnce({ status: 200, data: { results: [ordenMl] } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'ready_to_ship', logistic_type: 'self_service', substatus: null } });

    const res = await request(buildTestApp(db)).get('/api/preparacion/pendientes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(2);

    const web = res.body.data.find(p => p.canal === 'web');
    expect(Object.keys(web).sort()).toEqual([
      'canal', 'comprador', 'espejo_ml', 'estado_preparacion', 'estado_wc', 'etiqueta_lista',
      'fecha', 'items', 'numero_pedido', 'preparacion_id', 'wc_order_id',
    ].sort());
    expect(web.wc_order_id).toBe(900);
    expect(web.espejo_ml).toBe(false);
    expect(web.comprador).toBe('Juan Perez');
    expect(Object.keys(web.items[0]).sort()).toEqual([
      'cantidad', 'categoria', 'line_item_id', 'nombre', 'product_id', 'sku', 'variation_id',
    ].sort());
    expect(web.items[0]).toMatchObject({ sku: 'BIKE-1', categoria: 'Bicicletas', cantidad: 2 });

    const ml = res.body.data.find(p => p.canal === 'ml');
    expect(Object.keys(ml).sort()).toEqual([
      'canal', 'comprador', 'estado_preparacion', 'fecha', 'items', 'logistic_type',
      'ml_order_id', 'numero_pedido', 'preparacion_id', 'substatus', 'wc_order_id',
    ].sort());
    expect(ml.ml_order_id).toBe('ORD-ML-1');
    expect(ml.comprador).toBe('comprador_ml');
    expect(ml.logistic_type).toBe('self_service');
    expect(Object.keys(ml.items[0]).sort()).toEqual([
      'cantidad', 'categoria', 'line_item_id', 'nombre', 'product_id', 'sku', 'variation_id',
    ].sort());
    expect(ml.items[0]).toMatchObject({ sku: 'CASCO-9', categoria: 'Cascos', cantidad: 1 });
  });
});

describe('GET /seguimientos', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('solo devuelve pedidos web con etiqueta_lista=1', async () => {
    const orderA = { id: 900, number: '900', shipping: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', city: 'Córdoba', state: 'Córdoba', postcode: '5000' }, billing: {}, meta_data: [] };
    const orderB = { id: 901, number: '901', shipping: { first_name: 'Beto', last_name: 'Diaz', address_1: 'San Martin 1', city: 'CABA', state: 'CABA', postcode: '1000' }, billing: {}, meta_data: [] };
    wooFetch
      .mockResolvedValueOnce({ data: [orderA, orderB] }) // status=lpaandreani
      .mockResolvedValueOnce({ data: [] }); // status=completed (colgados)

    const app = buildTestApp(db); // ensureTables corre acá; hace falta antes de sembrar preparaciones
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en) VALUES ('web','web:900',900,1,'en_preparacion',?)`).run(now);
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en) VALUES ('web','web:901',901,0,'en_preparacion',?)`).run(now);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].wc_order_id).toBe(900);
    expect(res.body.data[0].envio.pedido).toBe('900');
    expect(res.body.data[0].colgado).toBe(false);
  });

  it('también lista pedidos colgados en completed con tracking cargado (sin llegar a enviadoandreani)', async () => {
    const orderLpa = { id: 900, number: '900', shipping: { first_name: 'Ana', last_name: 'Gomez', address_1: 'Belgrano 123', city: 'Córdoba', state: 'Córdoba', postcode: '5000' }, billing: {}, meta_data: [] };
    // Colgado: quedó en 'completed' con tracking, sin registro local y sin llegar a enviadoandreani
    const orderColgado = { id: 902, number: '902', shipping: { first_name: 'Caro', last_name: 'Lopez', address_1: 'Rivadavia 50', city: 'Rosario', state: 'Santa Fe', postcode: '2000' }, billing: {}, meta_data: [{ id: 71, key: '_andreani_tracking', value: 'AND999' }] };
    // Otro completed sin tracking: no debe aparecer
    const orderSinTracking = { id: 903, number: '903', shipping: { first_name: 'Dario', last_name: 'Paz', address_1: 'Mitre 1', city: 'CABA', state: 'CABA', postcode: '1000' }, billing: {}, meta_data: [] };
    wooFetch
      .mockResolvedValueOnce({ data: [orderLpa] }) // status=lpaandreani
      .mockResolvedValueOnce({ data: [orderColgado, orderSinTracking] }); // status=completed

    const app = buildTestApp(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en) VALUES ('web','web:900',900,1,'en_preparacion',?)`).run(now);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    const ids = res.body.data.map(f => f.wc_order_id).sort();
    expect(ids).toEqual([900, 902]);
    const colgado = res.body.data.find(f => f.wc_order_id === 902);
    expect(colgado.colgado).toBe(true);
    expect(colgado.tracking).toBe('AND999');
    expect(colgado.envio.pedido).toBe('902');
  });

  it('excluye de colgados un completed con _andreani_tracking de solo espacios en blanco', async () => {
    // Meta presente pero vacío tras trim: se trata como si no tuviera tracking.
    const orderBlanco = { id: 904, number: '904', shipping: { first_name: 'Eve', last_name: 'Ruiz', address_1: 'Colon 9', city: 'CABA', state: 'CABA', postcode: '1000' }, billing: {}, meta_data: [{ id: 80, key: '_andreani_tracking', value: '   ' }] };
    wooFetch
      .mockResolvedValueOnce({ data: [] }) // status=lpaandreani
      .mockResolvedValueOnce({ data: [orderBlanco] }); // status=completed

    const app = buildTestApp(db);

    const res = await request(app).get('/api/preparacion/seguimientos');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('POST /seguimientos/:wcOrderId', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('preserva el id del meta existente y encadena completed → enviadoandreani', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: { id: 900, status: 'lpaandreani', meta_data: [{ id: 55, key: '_andreani_tracking', value: '' }] } }) // GET actual
      .mockResolvedValueOnce({ data: { id: 900, status: 'completed' } }) // PUT paso 1
      .mockResolvedValueOnce({ data: { id: 900, status: 'enviadoandreani' } }); // PUT paso 2

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/900').send({ tracking: 'AND123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(wooFetch).toHaveBeenCalledTimes(3);
    expect(wooFetch.mock.calls[1][2]).toBe('put');
    expect(wooFetch.mock.calls[1][3]).toEqual({
      status: 'completed',
      meta_data: [{ id: 55, key: '_andreani_tracking', value: 'AND123' }],
    });
    expect(wooFetch.mock.calls[2][2]).toBe('put');
    expect(wooFetch.mock.calls[2][3]).toEqual({ status: 'enviadoandreani' });

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:900'").get();
    expect(prep.estado).toBe('completada');
    expect(prep.etiqueta_lista).toBe(1);
  });

  it('crea el meta sin id cuando el pedido no tenía tracking previo', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: { id: 901, status: 'lpaandreani', meta_data: [] } })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: {} });

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/901').send({ tracking: 'XYZ' });
    expect(res.status).toBe(200);
    expect(wooFetch.mock.calls[1][3]).toEqual({
      status: 'completed',
      meta_data: [{ key: '_andreani_tracking', value: 'XYZ' }],
    });
  });

  it('reintento: pedido ya en completed con el mismo tracking → solo hace el PUT2 (no reenvía el mail)', async () => {
    wooFetch
      .mockResolvedValueOnce({ data: { id: 902, status: 'completed', meta_data: [{ id: 71, key: '_andreani_tracking', value: 'AND999' }] } }) // GET actual
      .mockResolvedValueOnce({ data: { id: 902, status: 'enviadoandreani' } }); // PUT paso 2 (único)

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/902').send({ tracking: 'AND999' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Solo GET + un único PUT: nunca se vuelve a mandar status:'completed'
    expect(wooFetch).toHaveBeenCalledTimes(2);
    const puts = wooFetch.mock.calls.filter(c => c[2] === 'put');
    expect(puts).toHaveLength(1);
    expect(puts[0][3]).toEqual({ status: 'enviadoandreani' });
    expect(puts.some(c => c[3]?.status === 'completed')).toBe(false);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:902'").get();
    expect(prep.estado).toBe('completada');
  });

  it('fail-closed: pedido en otro estado (ni lpaandreani ni completed-con-tracking) → 409 sin ningún PUT', async () => {
    wooFetch.mockResolvedValueOnce({ data: { id: 903, status: 'processing', meta_data: [] } }); // GET actual

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/903').send({ tracking: 'NOPE' });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);

    // Solo el GET; jamás se llama a wooFetch con método PUT
    expect(wooFetch).toHaveBeenCalledTimes(1);
    expect(wooFetch.mock.calls.some(c => c[2] === 'put')).toBe(false);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:903'").get();
    expect(prep).toBeUndefined();
  });

  it('fail-closed: completed con un tracking guardado DISTINTO al recibido → 409 sin ningún PUT', async () => {
    // El pedido ya está confirmado con AND999; llega uno distinto (AND111).
    // No se debe pisar: dispararía el PUT1 (status:completed) y reenviaría el mail.
    wooFetch.mockResolvedValueOnce({ data: { id: 905, status: 'completed', meta_data: [{ id: 90, key: '_andreani_tracking', value: 'AND999' }] } }); // GET actual

    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/905').send({ tracking: 'AND111' });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);

    // Solo el GET; jamás se escribe nada
    expect(wooFetch).toHaveBeenCalledTimes(1);
    expect(wooFetch.mock.calls.some(c => c[2] === 'put')).toBe(false);

    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave='web:905'").get();
    expect(prep).toBeUndefined();
  });

  it('wcOrderId=0 → 400 sin tocar Woo', async () => {
    const res = await request(buildTestApp(db)).post('/api/preparacion/seguimientos/0').send({ tracking: 'AND123' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(wooFetch).not.toHaveBeenCalled();
  });
});
