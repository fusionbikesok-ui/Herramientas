// Fix: ítems del vendedor que NO están en ml_publicaciones_cache (el escaneo solo trae active/paused: cerrados, en revisión, etc.) hacían un
// GET /items/{id}?attributes=status por corrida de wc_a_ml (~3.000 GET/día en prod). Su status se recuerda en ml_estado_item_fuera_cache (TTL 24 h).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { syncWcToMl } from '../routes/sync.js';
import { registrarWebhookMl } from '../lib/workerIntegrationJobs.js';
import { encolarItemMl } from '../lib/trabajosRecurso.js';

vi.mock('../lib/mlClient.js', async () => {
  const actual = await vi.importActual('../lib/mlClient.js');
  return { ...actual, mlFetch: vi.fn(), estadoCooldownMl: () => ({ activo: false }) };
});
vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';

const TEST_DB = `./test/tmp-estado-fuera-cache.${process.pid}.sqlite`;
const CFG = { ml: { clientId: '123456', clientSecret: 'cs', userId: '99999' }, woo: { url: 'https://x.test', ck: 'a', cs: 'b' } };
const limpiarDb = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };
let db;
let n = 0;
let statusDeMl;

/** Publicación con deseado 5 y ML en 3. `status` null = sin fila en ml_publicaciones_cache (ítem fuera del escaneo). */
function seed({ item, status }) {
  const t = new Date().toISOString();
  const sku = `SKU-${item}`;
  db.prepare("INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, 'confirmar', ?)").run(`${item}|`, sku, `Prod ${item}`, t);
  if (status) db.prepare("INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, status, seller_sku, available_quantity, actualizado_en) VALUES (?, ?, '', ?, ?, 3, ?)").run(`${item}|`, item, status, sku, t);
  db.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en) VALUES (?, ?, ?, ?, NULL, 5, 300, 300, ?)').run(1000 + (n++), `Prod ${item}`, sku, 'simple', t);
  db.prepare('INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, 3, ?)').run(`${item}|`, sku, t);
}
const getsDeStatus = () => mlFetch.mock.calls.filter((c) => c[2] === 'get' && /attributes=status/.test(c[3])).length;
const fila = (item) => db.prepare('SELECT * FROM ml_estado_item_fuera_cache WHERE item_id = ?').get(item);

beforeEach(() => {
  limpiarDb(); db = openDb(TEST_DB); n = 0; mlFetch.mockReset(); statusDeMl = { status: 200, data: { status: 'closed' } };
  mlFetch.mockImplementation(async (_d, _c, method, path) => {
    if (method === 'get' && /attributes=status/.test(path)) return { ...statusDeMl, headers: {} };
    return { status: 200, data: {}, headers: {} };
  });
});
afterEach(() => { db.close(); limpiarDb(); });

describe('ml_estado_item_fuera_cache', () => {
  it('migración: crea la tabla', () => {
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ml_estado_item_fuera_cache'").get()).toBeTruthy();
  });

  it('el primer barrido consulta el status y lo recuerda; el segundo no vuelve a llamar', async () => {
    seed({ item: 'MLA1', status: null });
    await syncWcToMl(db, CFG);
    expect(getsDeStatus()).toBe(1);
    expect(fila('MLA1')).toMatchObject({ item_id: 'MLA1', status: 'closed' });
    await syncWcToMl(db, CFG);
    expect(getsDeStatus()).toBe(1);
  });

  it('vencido el TTL de 24 h se vuelve a consultar y se actualiza', async () => {
    seed({ item: 'MLA2', status: null });
    await syncWcToMl(db, CFG);
    db.prepare('UPDATE ml_estado_item_fuera_cache SET actualizado_en = ? WHERE item_id = ?').run(new Date(Date.now() - 25 * 3600 * 1000).toISOString(), 'MLA2');
    statusDeMl = { status: 200, data: { status: 'under_review' } };
    await syncWcToMl(db, CFG);
    expect(getsDeStatus()).toBe(2);
    expect(fila('MLA2').status).toBe('under_review');
  });

  it('dentro de las 24 h NO se vuelve a consultar', async () => {
    seed({ item: 'MLA3', status: null });
    db.prepare("INSERT INTO ml_estado_item_fuera_cache (item_id, status, actualizado_en) VALUES ('MLA3', 'closed', ?)").run(new Date(Date.now() - 23 * 3600 * 1000).toISOString());
    await syncWcToMl(db, CFG);
    expect(getsDeStatus()).toBe(0);
  });

  it('ml_publicaciones_cache manda: si el ítem está ahí, la tabla nueva se ignora', async () => {
    seed({ item: 'MLA4', status: 'active' });
    db.prepare("INSERT INTO ml_estado_item_fuera_cache (item_id, status, actualizado_en) VALUES ('MLA4', 'closed', ?)").run(new Date().toISOString());
    await syncWcToMl(db, CFG);
    // activa según la caché → el barrido intenta escribirla; si la tabla mandara ('closed') no habría ninguna escritura
    expect(mlFetch.mock.calls.some((c) => c[2] === 'put')).toBe(true);
  });

  it('un status que no se pudo consultar (error) NO se recuerda', async () => {
    seed({ item: 'MLA5', status: null });
    statusDeMl = { status: 500, data: {} };
    await syncWcToMl(db, CFG);
    expect(fila('MLA5')).toBeUndefined();
    await syncWcToMl(db, CFG);
    expect(getsDeStatus()).toBe(2);
  });

  it('un aviso de items de ML invalida la fila del ítem (el cambio de estado se ve enseguida)', () => {
    db.prepare("INSERT INTO ml_estado_item_fuera_cache (item_id, status, actualizado_en) VALUES ('MLA6', 'closed', ?), ('MLA7', 'closed', ?)").run(new Date().toISOString(), new Date().toISOString());
    registrarWebhookMl(db, { _id: 'n-1', topic: 'items', resource: '/items/MLA6', user_id: 99999, application_id: 1, attempts: 1 });
    expect(fila('MLA6')).toBeUndefined();
    expect(fila('MLA7')).toBeTruthy();
  });

  it('cualquier encolado de item.project invalida la fila', () => {
    db.prepare("INSERT INTO ml_estado_item_fuera_cache (item_id, status, actualizado_en) VALUES ('MLA8', 'closed', ?)").run(new Date().toISOString());
    encolarItemMl(db, 'MLA8');
    expect(fila('MLA8')).toBeUndefined();
  });
});
