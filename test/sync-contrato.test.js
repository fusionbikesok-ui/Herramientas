/**
 * Test de CARACTERIZACIÓN del payload exacto que syncMlToWc (_procesarOrden)
 * envía a WooCommerce, corrido ANTES de adoptar el modelo canónico de Orden de
 * venta (Fase 4 de lib/modelos/). Es la ruta que crea pedidos reales con plata
 * real — el refactor de routes/sync.js debe dejar este payload byte-idéntico.
 * Debe seguir en verde, sin modificarse, después del refactor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { syncMlToWc } from '../routes/sync.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));
vi.mock('../routes/woo.js', () => ({
  wooFetch: vi.fn(),
}));

import { mlFetch } from '../lib/mlClient.js';
import { wooFetch } from '../routes/woo.js';

const TEST_DB = './test/tmp-sync-contrato.sqlite';

const CFG = {
  ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
};

function seedMatcher(db) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run('MLA100|', 'BIKE-001', 'Bicicleta Simple', 'confirmar', now);
  // Guardado sin el sufijo .0 (mismo formato que usa el SKU Matcher).
  db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run('MLA200|987654321', 'CASCO-L', 'Casco Talla L', 'asignar', now);
}

function seedCatalogo(db) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(100, 'Bicicleta Simple', 'BIKE-001', 'simple', null, 5, now);
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(221, 'Casco Talla L', 'CASCO-L', 'variation', 220, 3, now);
}

describe('_procesarOrden — payload exacto de POST /orders', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedMatcher(db);
    seedCatalogo(db);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('item simple + variación con sufijo .0: line_items, billing, meta_data y persistencia', async () => {
    const orden = {
      id: 'ORD-CONTRATO-1',
      date_created: '2026-07-01T00:00:00Z',
      buyer: { first_name: 'Ana', last_name: 'Gomez', nickname: 'anag', email: 'ana@mail.com', phone: { number: '3511234567' } },
      order_items: [
        { item: { id: 'MLA100', variation_id: '' }, quantity: 2 },
        { item: { id: 'MLA200', variation_id: '987654321.0' }, quantity: 1 },
      ],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 5050 } };
      if (path === '/products/100') return { data: { price: '150.00' } };
      if (path === '/products/220/variations/221') return { data: { price: '30000.00' } };
      throw new Error(`ruta wooFetch no esperada en el test: ${path}`);
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall).toBeTruthy();
    const payload = orderCall[3];

    expect(payload.status).toBe('mercadolibre');
    expect(payload.set_paid).toBe(true);
    expect(payload.meta_data).toEqual([{ key: '_ml_order_id', value: 'ORD-CONTRATO-1' }]);
    expect(payload.billing).toEqual({
      first_name: 'Ana', last_name: 'Gomez', email: 'ana@mail.com', phone: '3511234567',
    });
    expect(payload.line_items).toEqual([
      { quantity: 2, subtotal: '300.00', total: '300.00', product_id: 100 },
      { quantity: 1, subtotal: '30000.00', total: '30000.00', product_id: 220, variation_id: 221 },
    ]);

    const vinculo = db.prepare('SELECT * FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get('ORD-CONTRATO-1');
    expect(vinculo.wc_order_id).toBe(5050);
    expect(JSON.parse(vinculo.comprador_json)).toEqual(orden.buyer);

    const proc = db.prepare('SELECT * FROM ordenes_ml_procesadas WHERE order_id = ?').get('ORD-CONTRATO-1');
    expect(proc.estado).toBe('ok');
    expect(JSON.parse(proc.items_json)).toEqual(orden.order_items);

    const log = db.prepare("SELECT * FROM sync_log WHERE direccion='ml_wc' AND clave='ORD-CONTRATO-1'").get();
    expect(log.estado).toBe('ok');
    expect(log.cant_nueva).toBe(5050);
  });

  it('buyer sin datos reales (solo nickname) → billing con defaults, sin email/phone', async () => {
    const orden = {
      id: 'ORD-CONTRATO-2', date_created: '2026-07-01T00:00:00Z',
      buyer: { nickname: 'compradorml' },
      order_items: [{ item: { id: 'MLA100', variation_id: '' }, quantity: 1 }],
    };
    mlFetch.mockResolvedValue({ status: 200, data: { results: [orden] } });
    wooFetch.mockImplementation(async (cfg, path, method = 'get') => {
      if (path === '/orders' && method === 'post') return { data: { id: 5051 } };
      return { data: { price: '150.00' } };
    });

    const p = syncMlToWc(db, CFG);
    await vi.runAllTimersAsync();
    await p;

    const orderCall = wooFetch.mock.calls.find(c => c[1] === '/orders' && c[2] === 'post');
    expect(orderCall[3].billing).toEqual({ first_name: 'compradorml', last_name: 'MercadoLibre' });
  });
});
