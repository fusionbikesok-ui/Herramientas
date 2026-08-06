/**
 * Caché persistente de comisión (sale_fee) y costo de envío gratis en `ml_precios_cache`
 * (paso 2 del plan ahorro-llamadas-ml). Tests directos de lib/mlPrecios.js, sin pasar por
 * reactivarAutomatico, para aislar el comportamiento de la caché en sí.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));

import { mlFetch } from '../lib/mlClient.js';
import { saleFeeMl, costoEnvioMl, invalidarCachePreciosMl } from '../lib/mlPrecios.js';

const TEST_DB = './test/tmp-ml-precios-cache.sqlite';
const CFG = { userId: '999' };

let db;
beforeEach(() => {
  fs.rmSync(TEST_DB, { force: true });
  db = openDb(TEST_DB);
  mlFetch.mockReset();
});
afterEach(() => { db.close(); fs.rmSync(TEST_DB, { force: true }); });

describe('saleFeeMl — caché persistente', () => {
  it('hit fresco: no llama a ML y devuelve el valor cacheado', async () => {
    db.prepare(`INSERT INTO ml_precios_cache (clave, valor, actualizado_en) VALUES (?, ?, ?)`)
      .run('fee:100000:MLA1234:gold_special', 12345, new Date().toISOString());

    const fee = await saleFeeMl(db, CFG, 100000, 'MLA1234', 'gold_special');
    expect(fee).toBe(12345);
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('miss por vencimiento (>7 días): consulta ML y reescribe la fila', async () => {
    const hace8dias = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO ml_precios_cache (clave, valor, actualizado_en) VALUES (?, ?, ?)`)
      .run('fee:100000:MLA1234:gold_special', 111, hace8dias);
    mlFetch.mockResolvedValue({ status: 200, data: { sale_fee_amount: 999 } });

    const fee = await saleFeeMl(db, CFG, 100000, 'MLA1234', 'gold_special');
    expect(fee).toBe(999);
    expect(mlFetch).toHaveBeenCalledTimes(1);
    const fila = db.prepare("SELECT valor FROM ml_precios_cache WHERE clave='fee:100000:MLA1234:gold_special'").get();
    expect(fila.valor).toBe(999);
  });

  it('un error de ML no escribe fila envenenada (deja la tabla sin esa clave)', async () => {
    mlFetch.mockResolvedValue({ status: 500, data: null });

    const fee = await saleFeeMl(db, CFG, 100000, 'MLA1234', 'gold_special');
    expect(fee).toBeNull();
    const fila = db.prepare("SELECT * FROM ml_precios_cache WHERE clave='fee:100000:MLA1234:gold_special'").get();
    expect(fila).toBeUndefined();
  });

  it('opts.saltarCachePersistente ignora una fila fresca y consulta en vivo', async () => {
    db.prepare(`INSERT INTO ml_precios_cache (clave, valor, actualizado_en) VALUES (?, ?, ?)`)
      .run('fee:100000:MLA1234:gold_special', 111, new Date().toISOString());
    mlFetch.mockResolvedValue({ status: 200, data: { sale_fee_amount: 222 } });

    const fee = await saleFeeMl(db, CFG, 100000, 'MLA1234', 'gold_special', null, { saltarCachePersistente: true });
    expect(fee).toBe(222);
    expect(mlFetch).toHaveBeenCalledTimes(1);
  });
});

describe('costoEnvioMl — caché persistente por item_id + precio', () => {
  it('dos precios distintos del mismo item NO comparten costo de envío cacheado', async () => {
    mlFetch.mockImplementation(async () => ({ status: 200, data: { coverage: { all_country: { list_cost: 555 } } } }));
    await costoEnvioMl(db, CFG, 'MLA1', 100000, true);
    mlFetch.mockImplementation(async () => ({ status: 200, data: { coverage: { all_country: { list_cost: 777 } } } }));
    const costo2 = await costoEnvioMl(db, CFG, 'MLA1', 200000, true);

    expect(costo2).toBe(777);
    const filas = db.prepare("SELECT clave, valor FROM ml_precios_cache WHERE clave LIKE 'envio:MLA1:%'").all();
    expect(filas.length).toBe(2);
    expect(filas.find(f => f.clave === 'envio:MLA1:100000').valor).toBe(555);
    expect(filas.find(f => f.clave === 'envio:MLA1:200000').valor).toBe(777);
  });

  it('sin envío gratis: devuelve 0 sin llamar a ML', async () => {
    const costo = await costoEnvioMl(db, CFG, 'MLA1', 100000, false);
    expect(costo).toBe(0);
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('ML responde 200 sin list_cost: no persiste un 0 no confirmado (pero devuelve 0 para esta corrida)', async () => {
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    const costo = await costoEnvioMl(db, CFG, 'MLA1', 100000, true);
    expect(costo).toBe(0);
    const fila = db.prepare("SELECT * FROM ml_precios_cache WHERE clave='envio:MLA1:100000'").get();
    expect(fila).toBeUndefined();
  });

  it('un error de ML no escribe fila envenenada', async () => {
    mlFetch.mockResolvedValue({ status: 500, data: null });
    const costo = await costoEnvioMl(db, CFG, 'MLA1', 100000, true);
    expect(costo).toBe(0);
    const fila = db.prepare("SELECT * FROM ml_precios_cache WHERE clave='envio:MLA1:100000'").get();
    expect(fila).toBeUndefined();
  });
});

describe('invalidarCachePreciosMl', () => {
  it('sin prefijo borra toda la tabla', async () => {
    db.prepare(`INSERT INTO ml_precios_cache (clave, valor, actualizado_en) VALUES ('fee:1:a:b', 1, ?)`).run(new Date().toISOString());
    db.prepare(`INSERT INTO ml_precios_cache (clave, valor, actualizado_en) VALUES ('envio:X:1', 1, ?)`).run(new Date().toISOString());
    invalidarCachePreciosMl(db);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_precios_cache').get().n).toBe(0);
  });

  it('con prefijo borra solo esas filas', async () => {
    db.prepare(`INSERT INTO ml_precios_cache (clave, valor, actualizado_en) VALUES ('fee:1:a:b', 1, ?)`).run(new Date().toISOString());
    db.prepare(`INSERT INTO ml_precios_cache (clave, valor, actualizado_en) VALUES ('envio:X:1', 1, ?)`).run(new Date().toISOString());
    invalidarCachePreciosMl(db, 'fee:');
    const restantes = db.prepare('SELECT clave FROM ml_precios_cache').all().map(f => f.clave);
    expect(restantes).toEqual(['envio:X:1']);
  });
});
