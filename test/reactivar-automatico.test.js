/**
 * reactivarAutomatico: el cron que reactiva solo las publicaciones pausadas por
 * out_of_stock que recuperaron stock, con guarda de precio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  bootstrapToken: vi.fn(),
  getAccessToken: vi.fn(),
}));
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));

import { mlFetch } from '../lib/mlClient.js';
import { reactivarAutomatico } from '../routes/sync.js';

const TEST_DB = './test/tmp-reactivar-auto.sqlite';
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' }, woo: { url: 'x', ck: 'c', cs: 's' } };

let db;

/** Siembra una publicación pausada por out_of_stock, mapeada, con stock web disponible. */
function sembrarReactivable({ clave = 'MLA1|', itemId = 'MLA1', sku = 'FB-1', stockWc = 3, precioWc = 300000 } = {}) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, actualizado_en)
    VALUES (?, ?, ?, 'simple', ?, ?, '2026-07-30T00:00:00Z')`).run(Math.floor(Math.random() * 1e6), 'Producto ' + sku, sku, stockWc, precioWc);
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?, ?, ?, 'asignar', '2026-07-30T00:00:00Z')`).run(clave, sku, 'Producto ' + sku);
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, actualizado_en)
    VALUES (?, ?, '', ?, 'paused', 'out_of_stock', 0, '2026-07-30T00:00:00Z')`).run(clave, itemId, 'Pub ' + sku);
}

beforeEach(() => {
  fs.rmSync(TEST_DB, { force: true });
  db = openDb(TEST_DB);
  mlFetch.mockReset();
});
afterEach(() => { db.close(); fs.rmSync(TEST_DB, { force: true }); });

describe('reactivarAutomatico', () => {
  it('reactiva la publicación cuando el neto pasa el chequeo', async () => {
    sembrarReactivable({ precioWc: 300000 });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(1);
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA1|'").get().status).toBe('active');
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('NO reactiva y registra la frenada cuando el neto queda por debajo del precio de contado', async () => {
    sembrarReactivable({ precioWc: 900000 });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 200000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 30000 } };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(r.frenadas).toBe(1);
    const f = db.prepare('SELECT * FROM ml_reactivacion_frenada').get();
    expect(f.clave).toBe('MLA1|');
    expect(f.deficit_pct).toBeGreaterThan(0);
    // No se activó en ML.
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA1|'").get().status).toBe('paused');
  });

  it('fail-closed: si ML no responde, no reactiva NI registra frenada', async () => {
    sembrarReactivable();
    mlFetch.mockResolvedValue({ status: 500, data: null });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(r.frenadas).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('borra la frenada cuando en un ciclo posterior el precio pasa el chequeo', async () => {
    sembrarReactivable({ precioWc: 300000 });
    db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES ('MLA1|', 'FB-1', 'viejo', 1, 2, 0.5, '2026-07-29T00:00:00Z')`).run();
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    await reactivarAutomatico(db, CFG);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('no hace nada si no hay reactivables', async () => {
    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(mlFetch).not.toHaveBeenCalled();
  });
});
