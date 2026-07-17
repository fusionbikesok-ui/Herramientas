import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { setStockWc, getStockLiveWc } from '../lib/wooStock.js';

vi.mock('../routes/woo.js', () => ({
  wooFetch: vi.fn()
}));
import { wooFetch } from '../routes/woo.js';

const TEST_DB = './test/tmp-woostock.sqlite';
const WOO_CFG = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

function seedCatalogo(db) {
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  ins.run(100, 'Bicicleta Simple', 'BIKE-001', 'simple', null, 5, now);
  ins.run(200, 'Casco L', 'CASCO-L', 'variation', 150, 3, now);
}

describe('wooStock', () => {
  let db;

  beforeEach(() => {
    db = openDb(TEST_DB);
    seedCatalogo(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('setStockWc', () => {
    it('llama a wooFetch con path de producto simple', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: {} });
      await setStockWc(WOO_CFG, db, 'BIKE-001', 10);
      expect(wooFetch).toHaveBeenCalledWith(
        WOO_CFG, '/products/100', 'put',
        { stock_quantity: 10, manage_stock: true }
      );
    });

    it('llama a wooFetch con path de variación (id_padre/variations/id_woo)', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: {} });
      await setStockWc(WOO_CFG, db, 'CASCO-L', 2);
      expect(wooFetch).toHaveBeenCalledWith(
        WOO_CFG, '/products/150/variations/200', 'put',
        { stock_quantity: 2, manage_stock: true }
      );
    });

    it('actualiza catalogo_cache tras PUT exitoso', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: {} });
      await setStockWc(WOO_CFG, db, 'BIKE-001', 7);
      const row = db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo = 100').get();
      expect(row.stock).toBe(7);
    });

    it('aplica Math.max(0) para cantidad negativa', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: {} });
      await setStockWc(WOO_CFG, db, 'BIKE-001', -5);
      expect(wooFetch).toHaveBeenCalledWith(
        WOO_CFG, '/products/100', 'put',
        { stock_quantity: 0, manage_stock: true }
      );
    });

    it('redondea cantidades decimales', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: {} });
      await setStockWc(WOO_CFG, db, 'BIKE-001', 3.7);
      expect(wooFetch).toHaveBeenCalledWith(
        WOO_CFG, '/products/100', 'put',
        { stock_quantity: 4, manage_stock: true }
      );
    });

    it('lanza error si SKU no existe en catalogo_cache', async () => {
      await expect(setStockWc(WOO_CFG, db, 'NO-EXISTE', 5))
        .rejects.toThrow('no encontrado en catalogo_cache');
      expect(wooFetch).not.toHaveBeenCalled();
    });
  });

  describe('getStockLiveWc', () => {
    it('devuelve stock_quantity del producto simple', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: 8 } });
      const stock = await getStockLiveWc(WOO_CFG, db, 'BIKE-001');
      expect(stock).toBe(8);
      expect(wooFetch).toHaveBeenCalledWith(WOO_CFG, '/products/100');
    });

    it('usa el path de variación para productos variation', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: 3 } });
      const stock = await getStockLiveWc(WOO_CFG, db, 'CASCO-L');
      expect(stock).toBe(3);
      expect(wooFetch).toHaveBeenCalledWith(WOO_CFG, '/products/150/variations/200');
    });

    it('devuelve 0 cuando stock_quantity es null en la respuesta', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: null } });
      const stock = await getStockLiveWc(WOO_CFG, db, 'BIKE-001');
      expect(stock).toBe(0);
    });

    it('devuelve null si SKU no existe en catalogo_cache', async () => {
      const stock = await getStockLiveWc(WOO_CFG, db, 'NO-EXISTE');
      expect(stock).toBeNull();
      expect(wooFetch).not.toHaveBeenCalled();
    });
  });
});
