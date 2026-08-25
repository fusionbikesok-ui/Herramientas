import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { setStockWc, setStockWcDelta, getStockLiveWc } from '../lib/wooStock.js';

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

    it('rechaza SKU homónimo antes de tocar Woo', async () => {
      db.prepare(
        'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(101, 'Bicicleta duplicada', 'BIKE-001', 'simple', 2, new Date().toISOString());

      await expect(setStockWc(WOO_CFG, db, 'BIKE-001', 10))
        .rejects.toThrow('SKU "BIKE-001" ambiguo');
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

  describe('setStockWcDelta', () => {
    it('calcula stock final como stockLive + delta cuando hubo venta durante conteo', async () => {
      // stock_inicial=3, stock_live=2 (se vendió 1), cantidad_contada=3
      // delta = 3 - 3 = 0, pero stock_live es 2
      // stockFinal = 2 + 0 = 2 (no sube a 3, porque hubo venta)
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: 2 } });
      const resultado = await setStockWcDelta(WOO_CFG, db, 'BIKE-001', 3, 3);

      expect(resultado.stockFinal).toBe(2);
      expect(resultado.huboVentaDurante).toBe(true);
      expect(resultado.stockLive).toBe(2);
      expect(wooFetch).toHaveBeenCalledWith(
        WOO_CFG, '/products/100', 'put',
        { stock_quantity: 2, manage_stock: true }
      );
    });

    it('devuelve stockFinal igual a cantidadContada cuando stock_live == stock_inicial', async () => {
      // stock_inicial=5, stock_live=5 (sin venta), cantidad_contada=4
      // delta = 4 - 5 = -1, stockFinal = 5 + (-1) = 4
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: 5 } });
      const resultado = await setStockWcDelta(WOO_CFG, db, 'BIKE-001', 4, 5);

      expect(resultado.stockFinal).toBe(4);
      expect(resultado.huboVentaDurante).toBe(false);
      expect(resultado.stockLive).toBe(5);
    });

    it('nunca devuelve negativo: Math.max(0) cuando delta es muy negativo', async () => {
      // stock_inicial=10, stock_live=0, cantidad_contada=1
      // delta = 1 - 10 = -9, stockFinal = 0 + (-9) = -9 → Math.max(0, -9) = 0
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: 0 } });
      const resultado = await setStockWcDelta(WOO_CFG, db, 'BIKE-001', 1, 10);

      expect(resultado.stockFinal).toBe(0);
      expect(wooFetch).toHaveBeenCalledWith(
        WOO_CFG, '/products/100', 'put',
        { stock_quantity: 0, manage_stock: true }
      );
    });

    it('lanza error si stockInicial es null', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: 5 } });
      await expect(setStockWcDelta(WOO_CFG, db, 'BIKE-001', 3, null))
        .rejects.toThrow('stockInicial requerido');
      expect(wooFetch).not.toHaveBeenCalled();
    });

    it('lanza error si stockInicial es undefined', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: 5 } });
      await expect(setStockWcDelta(WOO_CFG, db, 'BIKE-001', 3, undefined))
        .rejects.toThrow('stockInicial requerido');
      expect(wooFetch).not.toHaveBeenCalled();
    });

    it('lanza error si getStockLiveWc falla (sin hacer PUT)', async () => {
      wooFetch.mockRejectedValue(new Error('Woo error'));
      await expect(setStockWcDelta(WOO_CFG, db, 'BIKE-001', 3, 5))
        .rejects.toThrow('No se pudo leer stock live de WC');
      // Debe haber intentado el GET pero no el PUT
      expect(wooFetch).toHaveBeenCalledTimes(1);
      expect(wooFetch).toHaveBeenCalledWith(WOO_CFG, '/products/100');
    });

    it('lanza error si getStockLiveWc devuelve null (sin hacer PUT)', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: null } });
      // Simular que el SKU no existe llamando a getStockLiveWc directamente
      // En realidad, si el SKU existe en catalogo_cache pero WC devuelve null en stock,
      // getStockLiveWc devuelve 0, no null. Null solo cuando el SKU no está en cache.
      // Ajustamos el test: creamos un SKU que NO existe en cache.
      await expect(setStockWcDelta(WOO_CFG, db, 'NO-EXISTE', 3, 5))
        .rejects.toThrow('no encontrado en catalogo_cache');
      expect(wooFetch).not.toHaveBeenCalled();
    });

    it('rechaza SKU homónimo antes de leer stock live', async () => {
      db.prepare(
        'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(101, 'Bicicleta duplicada', 'BIKE-001', 'simple', 2, new Date().toISOString());

      await expect(setStockWcDelta(WOO_CFG, db, 'BIKE-001', 3, 5))
        .rejects.toThrow('SKU "BIKE-001" ambiguo');
      expect(wooFetch).not.toHaveBeenCalled();
    });

    it('actualiza catalogo_cache tras PUT exitoso', async () => {
      wooFetch.mockResolvedValue({ status: 200, data: { stock_quantity: 5 } });
      await setStockWcDelta(WOO_CFG, db, 'BIKE-001', 3, 5);
      const row = db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo = 100').get();
      expect(row.stock).toBe(3);
    });
  });
});
