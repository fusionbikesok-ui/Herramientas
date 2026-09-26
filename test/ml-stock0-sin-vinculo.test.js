import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { openDb } from '../db/index.js';
import { seleccionar, poner0, escribirCsv, rollback } from '../scripts/ml-stock0-sin-vinculo.mjs';

const TEST_DB = './test/ml-stock0.sqlite';
describe('ml-stock0-sin-vinculo', () => {
  let db, f;
  const pub = (clave, item, vid, o = {}) => db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,status,sub_status,seller_sku,available_quantity,actualizado_en) VALUES (?,?,?,?,?,?,?,?)`)
    .run(clave, item, vid, 'paused', o.sub ?? 'out_of_stock', o.sku ?? '', o.q ?? 5, 'now');
  beforeEach(() => { db = openDb(TEST_DB); f = vi.fn(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('selecciona solo sin sku, sin decisión, sin ml_stock_estado y con cantidad>0', () => {
    pub('A|', 'A', ''); pub('B|', 'B', '', { sku: 'X' }); pub('C|', 'C', '', { q: 0 });
    pub('D|', 'D', ''); db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES ('D|','S','asignar','n')").run();
    pub('E|', 'E', ''); db.prepare("INSERT INTO ml_stock_estado (clave,sku,cantidad_ml,actualizado_en) VALUES ('E|','S',1,'n')").run();
    expect(seleccionar(db).map((x) => x.clave)).toEqual(['A|']);
  });

  it('dry-run no hace PUT; apply escribe 0 por variación sin array variations; paused_by_seller aparte', async () => {
    pub('A|1', 'A', '1'); pub('B|', 'B', ''); pub('P|', 'P', '', { sub: 'paused_by_seller' });
    f.mockImplementation(async (_d, _c, m) => (m === 'get' ? { status: 200, data: { available_quantity: 4 } } : { status: 200, data: {} }));
    const seco = await poner0(db, {}, { fetcher: f });
    expect(f.mock.calls.some((c) => c[2] === 'put')).toBe(false);
    expect(seco.pausadasVendedor).toHaveLength(1);
    await poner0(db, {}, { apply: true, fetcher: f });
    const puts = f.mock.calls.filter((c) => c[2] === 'put');
    expect(puts.map((c) => c[3])).toEqual(['/items/A/variations/1', '/items/B']);
    expect(puts.every((c) => JSON.stringify(c[4]) === '{"available_quantity":0}')).toBe(true);
  });

  it('omite lectura != 200 o ya en 0, y frena ante 429', async () => {
    pub('A|', 'A', ''); pub('B|', 'B', ''); pub('C|', 'C', ''); pub('D|', 'D', '');
    const resp = { A: { status: 404 }, B: { status: 200, data: { available_quantity: 0 } }, C: { status: 429 }, D: { status: 200, data: { available_quantity: 3 } } };
    f.mockImplementation(async (_d, _c, m, p) => resp[p.split('/')[2].split('?')[0]]);
    const r = await poner0(db, {}, { apply: true, fetcher: f });
    expect(r.filas.map((x) => x.resultado)).toEqual(['omitido_lectura_404', 'omitido_ya_0', 'no_intentado_429', 'no_intentado_429']);
    expect(f.mock.calls.some((c) => c[2] === 'put')).toBe(false);
  });

  it('CSV y rollback restauran solo lo que sigue en 0', async () => {
    pub('A|', 'A', ''); pub('B|', 'B', '');
    f.mockImplementation(async (_d, _c, m) => (m === 'get' ? { status: 200, data: { available_quantity: 7 } } : { status: 200, data: {} }));
    const r = await poner0(db, {}, { apply: true, fetcher: f });
    const csv = escribirCsv(r.filas, fs.mkdtempSync(path.join(os.tmpdir(), 's0-')));
    expect(fs.readFileSync(csv, 'utf8')).toContain('A|,A,,7,ok');
    const g = vi.fn(async (_d, _c, m, p) => (m === 'get' ? { status: 200, data: { available_quantity: p.includes('/A') ? 0 : 2 } } : { status: 200, data: {} }));
    const rb = await rollback(db, {}, csv, { fetcher: g });
    expect(rb.filas.map((x) => x.resultado)).toEqual(['restaurado', 'omitido_stock_actual_2']);
    expect(g.mock.calls.find((c) => c[2] === 'put')[4]).toEqual({ available_quantity: 7 });
  });
});
