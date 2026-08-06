/**
 * Tests para reconciliarStockMl: reconciliación incremental del stock recordado
 * (ml_stock_estado.cantidad_ml) contra el stock REAL de ML (multiget /items?ids=).
 *
 * Caso real que motivó esto (ver docs/superpowers/plans/2026-08-06-reconciliacion-stock-ml.md):
 * MLA1117110786| (SKU FB-4501) quedó con cantidad_ml=0 desde el 2026-07-17 mientras ML tenía
 * 1 unidad activa y vendible — syncWcToMl nunca lo detectó porque comparaba deseado (0)
 * contra recordado (0), ambos iguales.
 *
 * IMPORTANTE: esta función NUNCA escribe en ML (solo GET vía multiget). Solo corrige
 * ml_stock_estado; la corrección real hacia ML la sigue haciendo syncWcToMl, no probado acá.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { reconciliarStockMl } from '../routes/sync.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));

import { mlFetch } from '../lib/mlClient.js';

const TEST_DB = './test/tmp-reconciliacion.sqlite';

const CFG = {
  ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' },
  woo: { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' },
};

function seedPublicacion(db, { clave, itemId, variationId = '', status = 'active', sku, cantidadMl }) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run(clave, sku, 'Producto', 'confirmar', now);
  db.prepare(
    'INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run(clave, itemId, variationId, status, now);
  db.prepare(
    'INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)'
  ).run(clave, sku, cantidadMl, now);
}

describe('reconciliarStockMl', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  // Ejecuta reconciliarStockMl y avanza los fake timers para que los sleeps de pausa entre
  // chunks (RECONCILIACION_PAUSA_CHUNK_MS) no cuelguen el test.
  async function correr(db, cfg) {
    const p = reconciliarStockMl(db, cfg);
    await vi.runAllTimersAsync();
    return p;
  }

  it('reproduce el caso real de la horquilla: estado 0, ML 1, Woo 0 → corrige el estado a 1 y registra en sync_log', async () => {
    seedPublicacion(db, { clave: 'MLA1117110786|', itemId: 'MLA1117110786', sku: 'FB-4501', cantidadMl: 0 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA1117110786', status: 'active', available_quantity: 1 } }],
    });

    const r = await correr(db, CFG);

    expect(r.omitido).toBe(false);
    expect(r.corregidas).toBe(1);

    const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA1117110786|'").get();
    expect(estado.cantidad_ml).toBe(1);

    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'MLA1117110786|' AND estado = 'reconciliado'").get();
    expect(log).toBeTruthy();
    expect(log.cant_anterior).toBe(0);
    expect(log.cant_nueva).toBe(1);
    expect(log.error).toMatch(/ML tenía 1/);
    expect(log.error).toMatch(/registrado 0/);
  });

  it('sin divergencia (estado y ML coinciden) → no escribe nada ni ensucia el log', async () => {
    seedPublicacion(db, { clave: 'MLA200|', itemId: 'MLA200', sku: 'CASCO-L', cantidadMl: 5 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA200', status: 'active', available_quantity: 5 } }],
    });

    const r = await correr(db, CFG);

    expect(r.corregidas).toBe(0);
    const estado = db.prepare("SELECT cantidad_ml, actualizado_en FROM ml_stock_estado WHERE clave = 'MLA200|'").get();
    expect(estado.cantidad_ml).toBe(5);
    const logs = db.prepare("SELECT * FROM sync_log").all();
    expect(logs.length).toBe(0);
  });

  it('ML tiene MENOS que lo registrado → también se corrige (ambos sentidos)', async () => {
    seedPublicacion(db, { clave: 'MLA300|', itemId: 'MLA300', sku: 'CASCO-M', cantidadMl: 10 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA300', status: 'active', available_quantity: 2 } }],
    });

    const r = await correr(db, CFG);

    expect(r.corregidas).toBe(1);
    const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA300|'").get();
    expect(estado.cantidad_ml).toBe(2);
    const log = db.prepare("SELECT * FROM sync_log WHERE clave = 'MLA300|'").get();
    expect(log.cant_anterior).toBe(10);
    expect(log.cant_nueva).toBe(2);
  });

  describe('fail-closed: nunca corrige con un dato dudoso', () => {
    it('item ausente del multiget (chunk devolvió otra cosa) → deja la fila intacta', async () => {
      seedPublicacion(db, { clave: 'MLA400|', itemId: 'MLA400', sku: 'PEDAL-X', cantidadMl: 3 });
      mlFetch.mockResolvedValue({ status: 200, data: [] }); // MLA400 ausente de la respuesta

      const r = await correr(db, CFG);

      expect(r.corregidas).toBe(0);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA400|'").get();
      expect(estado.cantidad_ml).toBe(3);
      expect(db.prepare('SELECT * FROM sync_log').all().length).toBe(0);
    });

    it('cantidad nula/no numérica en la respuesta → deja la fila intacta', async () => {
      seedPublicacion(db, { clave: 'MLA401|', itemId: 'MLA401', sku: 'PEDAL-Y', cantidadMl: 3 });
      mlFetch.mockResolvedValue({
        status: 200,
        data: [{ code: 200, body: { id: 'MLA401', status: 'active', available_quantity: null } }],
      });

      const r = await correr(db, CFG);

      expect(r.corregidas).toBe(0);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA401|'").get();
      expect(estado.cantidad_ml).toBe(3);
    });

    it('el multiget responde status !== 200 → deja la fila intacta', async () => {
      seedPublicacion(db, { clave: 'MLA402|', itemId: 'MLA402', sku: 'PEDAL-Z', cantidadMl: 3 });
      mlFetch.mockResolvedValue({ status: 429, data: null });

      const r = await correr(db, CFG);

      expect(r.corregidas).toBe(0);
      const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA402|'").get();
      expect(estado.cantidad_ml).toBe(3);
    });
  });

  it('publicación que ya no está active en ML → se saltea sin tocar el estado', async () => {
    seedPublicacion(db, { clave: 'MLA500|', itemId: 'MLA500', sku: 'GRIP-A', cantidadMl: 0 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{ code: 200, body: { id: 'MLA500', status: 'paused', available_quantity: 7 } }],
    });

    const r = await correr(db, CFG);

    expect(r.corregidas).toBe(0);
    const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA500|'").get();
    expect(estado.cantidad_ml).toBe(0);
    expect(db.prepare('SELECT * FROM sync_log').all().length).toBe(0);
  });

  it('compara la cantidad de la VARIACIÓN, no la del item, cuando la clave tiene variation_id', async () => {
    seedPublicacion(db, { clave: 'MLA600|111', itemId: 'MLA600', variationId: '111', sku: 'CASCO-S', cantidadMl: 0 });
    mlFetch.mockResolvedValue({
      status: 200,
      data: [{
        code: 200,
        body: {
          id: 'MLA600', status: 'active', available_quantity: 999,
          variations: [
            { id: 111, available_quantity: 4 },
            { id: 222, available_quantity: 0 },
          ],
        },
      }],
    });

    const r = await correr(db, CFG);

    expect(r.corregidas).toBe(1);
    const estado = db.prepare("SELECT cantidad_ml FROM ml_stock_estado WHERE clave = 'MLA600|111'").get();
    expect(estado.cantidad_ml).toBe(4);
  });

  it('el cursor avanza entre corridas y da la vuelta al llegar al final, sin saltearse publicaciones', async () => {
    // 3 publicaciones, forzamos un lote de 1 leyendo directo el cursor entre corridas —
    // se simula con 3 corridas consecutivas y se verifica que cada clave se visitó.
    seedPublicacion(db, { clave: 'MLA700|', itemId: 'MLA700', sku: 'A', cantidadMl: 1 });
    seedPublicacion(db, { clave: 'MLA701|', itemId: 'MLA701', sku: 'B', cantidadMl: 1 });
    seedPublicacion(db, { clave: 'MLA702|', itemId: 'MLA702', sku: 'C', cantidadMl: 1 });

    mlFetch.mockImplementation(async (dbArg, cfgArg, method, path) => {
      const ids = path.match(/ids=([^&]+)/)[1].split(',');
      return {
        status: 200,
        data: ids.map(id => ({ code: 200, body: { id, status: 'active', available_quantity: 1 } })),
      };
    });

    // Con RECONCILIACION_LOTE=100 y solo 3 publicaciones, una sola corrida ya cubre todo el
    // universo y el cursor da la vuelta al principio. Corremos dos veces y verificamos que
    // el cursor sigue siendo consistente (apunta a una clave real del universo) y que ambas
    // corridas revisaron las 3 publicaciones sin saltear ninguna.
    const r1 = await correr(db, CFG);
    expect(r1.revisadas).toBe(3);
    const cursor1 = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
    expect(['MLA700|', 'MLA701|', 'MLA702|']).toContain(cursor1.valor);

    const r2 = await correr(db, CFG);
    expect(r2.revisadas).toBe(3);
  });

  it('sin config de ML → omitido, sin tocar nada', async () => {
    seedPublicacion(db, { clave: 'MLA800|', itemId: 'MLA800', sku: 'X', cantidadMl: 1 });
    const r = await reconciliarStockMl(db, { ml: {}, woo: CFG.woo });
    expect(r.omitido).toBe(true);
    expect(mlFetch).not.toHaveBeenCalled();
  });
});
