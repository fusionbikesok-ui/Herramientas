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
function sembrarReactivable({ clave = 'MLA1|', itemId = 'MLA1', sku = 'FB-1', stockWc = 3, precioWc = 300000, titulo = null, sinPrecioWeb = false } = {}) {
  // sinPrecioWeb: sigue con stock > 0 (así hay reactivable de verdad y la corrida avanza
  // hasta chequearNetoReactivar) pero con precio NULL, para que precioWebClave devuelva
  // null y dispare el bloqueo "Sin precio web mapeado" en vez de vaciar getReactivablesRows.
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, actualizado_en)
    VALUES (?, ?, ?, 'simple', ?, ?, '2026-07-30T00:00:00Z')`)
    .run(Math.floor(Math.random() * 1e6), 'Producto ' + sku, sku, stockWc, sinPrecioWeb ? null : precioWc);
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?, ?, ?, 'asignar', '2026-07-30T00:00:00Z')`).run(clave, sku, 'Producto ' + sku);
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, sub_status, es_variante, actualizado_en)
    VALUES (?, ?, '', ?, 'paused', 'out_of_stock', 0, '2026-07-30T00:00:00Z')`).run(clave, itemId, titulo ?? ('Pub ' + sku));
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

  it('fail-closed: "no se pudo calcular la comisión" no registra frenada (deficitPct null pero clave no nula)', async () => {
    sembrarReactivable({ precioWc: 300000 });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      // El GET de comisión falla: chequearNetoReactivar devuelve bloqueo con clave no nula
      // pero deficitPct: null — no es un problema de precio, no debe registrarse.
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 500, data: null };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(r.frenadas).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('fail-closed: sin precio web mapeado no registra frenada (deficitPct null pero clave no nula)', async () => {
    sembrarReactivable({ sinPrecioWeb: true });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    const r = await reactivarAutomatico(db, CFG);
    // Blindaje: si getReactivablesRows volviera a devolver vacío (test vacuo), mlFetch nunca
    // se llamaría y este assert lo detectaría antes que los de abajo.
    expect(mlFetch).toHaveBeenCalled();
    expect(r.reactivadas).toBe(0);
    expect(r.frenadas).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('candado: si ya hay una corrida en curso, la segunda no llama a ML y devuelve omitido', async () => {
    sembrarReactivable();
    let resolveFetch;
    mlFetch.mockImplementation(() => new Promise(res => { resolveFetch = res; }));

    const p1 = reactivarAutomatico(db, CFG); // arranca, llega al await de ML y queda pendiente
    const r2 = await reactivarAutomatico(db, CFG); // corre mientras la primera sigue en curso

    expect(r2).toEqual({ omitido: true });

    resolveFetch({ status: 500, data: null }); // libera la primera corrida para no dejarla colgada
    await p1;
  });

  it('barrido de huérfanas: borra una frenada cuya publicación ya no está entre las reactivables', async () => {
    sembrarReactivable({ clave: 'MLA1|', itemId: 'MLA1', sku: 'FB-1', precioWc: 300000 });
    // Frenada huérfana: no corresponde a ninguna fila reactivable vigente (otra clave/sku).
    db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES ('MLA999|', 'FB-999', 'vieja', 1, 2, 0.5, '2026-07-29T00:00:00Z')`).run();
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/MLA1?')) {
        return { status: 200, data: { id: 'MLA1', status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    await reactivarAutomatico(db, CFG);
    expect(db.prepare("SELECT COUNT(*) n FROM ml_reactivacion_frenada WHERE clave='MLA999|'").get().n).toBe(0);
  });

  it('barrido de huérfanas: si no hay reactivables, limpia todas las frenadas existentes', async () => {
    db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES ('MLA999|', 'FB-999', 'vieja', 1, 2, 0.5, '2026-07-29T00:00:00Z')`).run();

    const r = await reactivarAutomatico(db, CFG);
    expect(r.reactivadas).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(0);
  });

  it('anti-starvation: una publicación sin frenada y de título tardío entra en el lote aunque haya más de LOTE_MAX frenadas crónicas con título temprano', async () => {
    const LOTE_MAX = 50;
    // 50 publicaciones "crónicamente frenadas" con títulos alfabéticamente tempranos.
    for (let i = 0; i < LOTE_MAX; i++) {
      const n = String(i).padStart(2, '0');
      const clave = `MLA_A${n}|`;
      const itemId = `MLA_A${n}`;
      sembrarReactivable({ clave, itemId, sku: `FB-A${n}`, precioWc: 300000, titulo: `A${n} - producto viejo` });
      db.prepare(`INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
        VALUES (?, ?, 'crónica', 1, 2, 0.5, '2026-07-29T00:00:00Z')`).run(clave, `FB-A${n}`);
    }
    // Una publicación nueva, sin frenada, con título alfabéticamente TARDÍO (quedaría en la
    // posición 51 si no se reordenara — nunca entraría al lote de LOTE_MAX=50).
    sembrarReactivable({ clave: 'MLA_ZZZ|', itemId: 'MLA_ZZZ', sku: 'FB-ZZZ', precioWc: 300000, titulo: 'ZZZ - producto nuevo con stock' });

    const itemsConsultados = new Set();
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/')) {
        const itemId = path.slice('/items/'.length).split('?')[0];
        itemsConsultados.add(itemId);
        return { status: 200, data: { id: itemId, status: 'paused', sub_status: ['out_of_stock'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } };
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });

    await reactivarAutomatico(db, CFG);

    expect(itemsConsultados.has('MLA_ZZZ')).toBe(true);
  });
});
