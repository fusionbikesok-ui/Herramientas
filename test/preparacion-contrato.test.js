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
