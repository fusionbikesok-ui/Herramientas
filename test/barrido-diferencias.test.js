// Fix E-3: el barrido wc_a_ml medía como "diferencia" TODA fila con cantidad_ml <> deseado, incluidas las publicaciones pausadas/cerradas
// que el propio barrido descarta sin escribir (en prod: 1176 diferencias, 0 activas). Solo cuentan las que el barrido puede corregir.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { syncWcToMl } from '../routes/sync.js';

vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }) };
});
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';

const TEST_DB = `./test/tmp-barrido-dif.${process.pid}.sqlite`;
const CFG = { ml: { clientId: '123456', clientSecret: 'cs', userId: '99999' }, woo: { url: 'https://x.test', ck: 'a', cs: 'b' } };
const limpiarDb = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };
let db;
let n = 0;

/** Una publicación con deseado 5 y ML en 3 (diferencia real si está activa). `status` null = sin fila de caché de publicaciones. */
function seed({ item, status, cantMl = 3, deseado = 5, edad = 0 }) {
  const t = new Date().toISOString();
  const viejo = new Date(Date.now() - edad * 1000).toISOString();
  const sku = `SKU-${item}`;
  const nombre = `Prod ${item}`;
  const id = 1000 + (n++);
  db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, 'confirmar', ?)").run(`${item}|`, sku, nombre, t);
  if (status) db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, seller_sku, available_quantity, actualizado_en) VALUES (?, ?, '', ?, ?, ?, ?)").run(`${item}|`, item, status, sku, cantMl, t);
  db.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en) VALUES (?, ?, ?, ?, NULL, ?, 300, 300, ?)').run(id, nombre, sku, 'simple', deseado, t);
  db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)').run(`${item}|`, sku, cantMl, viejo);
}
const corrida = () => db.prepare("SELECT * FROM barrido_corridas WHERE proceso = 'wc_a_ml' ORDER BY id DESC LIMIT 1").get();

beforeEach(() => {
  limpiarDb(); db = openDb(TEST_DB); n = 0; mlFetch.mockReset();
  mlFetch.mockImplementation(async (_d, _c, method, path) => {
    if (method === 'get' && /\/items\/MLA\w+\?attributes=status/.test(path)) return { status: 200, data: { status: 'paused' }, headers: {} };
    return { status: 200, data: {}, headers: {} };
  });
});
afterEach(() => { db.close(); limpiarDb(); });

describe('barrido wc_a_ml: qué cuenta como diferencia', () => {
  it('una publicación pausada/cerrada con diferencia NO cuenta (el barrido la descarta sin escribir)', async () => {
    seed({ item: 'MLA1', status: 'paused' });
    seed({ item: 'MLA2', status: 'closed' });
    await syncWcToMl(db, CFG);
    expect(corrida()).toMatchObject({ diferencias: 0, diferencias_sin_evento: 0 });
  });

  it('una publicación activa con diferencia SÍ cuenta', async () => {
    seed({ item: 'MLA3', status: 'active' });
    seed({ item: 'MLA4', status: 'paused' });
    await syncWcToMl(db, CFG);
    expect(corrida().diferencias).toBe(1);
  });

  it('sin fila de caché: se consulta el estado y, si está pausada, no cuenta', async () => {
    seed({ item: 'MLA5', status: null });
    await syncWcToMl(db, CFG);
    expect(corrida().diferencias).toBe(0);
  });

  it('si el estado no se puede consultar (error real) sí cuenta: no se sabe si es activa', async () => {
    seed({ item: 'MLA6', status: null });
    mlFetch.mockImplementation(async (_d, _c, method, path) => (/attributes=status/.test(path) ? { status: 500, data: {}, headers: {} } : { status: 200, data: {}, headers: {} }));
    await syncWcToMl(db, CFG);
    expect(corrida().diferencias).toBe(1);
  });
});

describe('barrido wc_a_ml: claves no recorridas (corte) cuentan siempre', () => {
  it('corte por 429: la pendiente que el caché da por pausada SÍ cuenta (nunca se recorrió)', async () => {
    seed({ item: 'MLA10', status: null, edad: 300 });      // la primera: sin caché, dispara el GET de status
    seed({ item: 'MLA11', status: 'paused', edad: 200 });  // pendiente según caché
    mlFetch.mockImplementation(async (_d, _c, method, path) => (/attributes=status/.test(path) ? { status: 429, data: {}, headers: {} } : { status: 200, data: {}, headers: {} }));
    await syncWcToMl(db, CFG);
    expect(corrida().diferencias).toBe(2);
  });

  it('corte por tope de llamadas: las pausadas (según caché) que el tope dejó sin recorrer SÍ cuentan', async () => {
    seed({ item: 'MLA20', status: null, edad: 300 });      // el GET de status gasta la única llamada permitida
    seed({ item: 'MLA21', status: 'paused', edad: 200 });
    seed({ item: 'MLA22', status: 'paused', edad: 100 });
    mlFetch.mockImplementation(async (_d, _c, method, path) => (/attributes=status/.test(path) ? { status: 200, data: { status: 'active' }, headers: {} } : { status: 200, data: {}, headers: {} }));
    await syncWcToMl(db, CFG, { maxLlamadas: 1 });
    expect(corrida().diferencias).toBe(3);
  });

  it('sin corte, las pausadas recorridas no cuentan aunque haya una activa', async () => {
    seed({ item: 'MLA30', status: 'paused', edad: 300 });
    seed({ item: 'MLA31', status: 'paused', edad: 200 });
    seed({ item: 'MLA32', status: 'active', edad: 100 });
    await syncWcToMl(db, CFG);
    expect(corrida().diferencias).toBe(1);
  });
});
