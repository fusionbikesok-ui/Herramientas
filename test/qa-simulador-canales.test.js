import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { crearSimulador } from '../scripts/qa/simulador-canales.mjs';

const TEST_DB = './test/tmp-qa-simulador.sqlite';

describe('scripts/qa/simulador-canales', () => {
  let db;
  let server;
  let base;

  beforeAll(async () => {
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
    db = openDb(TEST_DB);
    const ahora = new Date().toISOString();
    const pub = db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave, item_id, variation_id, titulo, status, es_variante, color, talle, seller_sku, actualizado_en, precio, available_quantity, atributos_json, canales_json)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    pub.run('MLA1', 'MLA1', null, 'Cubierta 29', 0, null, null, 'FB-1', ahora, 1000, 4, JSON.stringify([{ id: 'SELLER_SKU', value_name: 'FB-1' }]), '["marketplace"]');
    pub.run('MLA2:11', 'MLA2', '11', 'Jersey', 1, 'Rojo', 'M', 'FB-2-M', ahora, 500, 2, '[]', '["marketplace"]');
    pub.run('MLA2:12', 'MLA2', '12', 'Jersey', 1, 'Rojo', 'L', 'FB-2-L', ahora, 500, 3, '[]', '["marketplace"]');
    const prod = db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en, precio, regular_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    prod.run(10, 'Jersey', 'FB-2', 'variable', 0, null, ahora, 500, 500);
    prod.run(11, 'Jersey M', 'FB-2-M', 'variation', 10, 2, ahora, 500, 500);
    prod.run(20, 'Cubierta 29', 'FB-1', 'simple', 0, 4, ahora, 1000, 1200);
    server = crearSimulador({ db });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(r => server.close(r));
    db.close();
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  });

  const get = async (ruta) => { const r = await fetch(base + ruta); return { status: r.status, headers: r.headers, body: await r.json() }; };

  it('multiget de ML arma items con variaciones, stock sumado y 404 por id desconocido', async () => {
    const r = await get('/items?ids=MLA1,MLA2,MLA999');
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ code: 200, body: { id: 'MLA1', available_quantity: 4, attributes: [{ id: 'SELLER_SKU', value_name: 'FB-1' }] } });
    expect(r.body[1].body.variations).toHaveLength(2);
    expect(r.body[1].body.available_quantity).toBe(5);
    expect(r.body[1].body.variations[0].attribute_combinations).toEqual(expect.arrayContaining([{ id: 'SIZE', name: 'Talle', value_name: 'M' }]));
    expect(r.body[2].code).toBe(404);
  });

  it('OAuth devuelve un token de QA y las escrituras ML no fallan ni tocan nada real', async () => {
    const token = await fetch(`${base}/oauth/token`, { method: 'POST' }).then(r => r.json());
    expect(token.access_token).toBe('APP_USR-QA');
    const put = await fetch(`${base}/items/MLA1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ available_quantity: 0 }) });
    expect(put.status).toBe(200);
    expect((await put.json()).available_quantity).toBe(0);
    expect((await get('/items/MLA1')).body.available_quantity).toBe(4);
  });

  it('Woo pagina productos padres con cabeceras y expone variaciones', async () => {
    const r = await get('/wp-json/wc/v3/products?per_page=1&page=1');
    expect(r.headers.get('x-wp-total')).toBe('2');
    expect(r.headers.get('x-wp-totalpages')).toBe('2');
    const vars = await get('/wp-json/wc/v3/products/10/variations');
    expect(vars.body).toEqual([expect.objectContaining({ id: 11, sku: 'FB-2-M', stock_quantity: 2 })]);
    expect((await get('/wp-json/wc/v3/products/20')).body).toMatchObject({ regular_price: '1200', stock_status: 'instock' });
  });

  it('inyecta fallas por ruta la cantidad de veces pedida y registra las llamadas', async () => {
    await fetch(`${base}/__qa/fallas`, { method: 'DELETE' });
    await fetch(`${base}/__qa/fallas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ruta: '^/items\\?ids=', status: 429, veces: 1, retryAfter: 30 }) });
    const r1 = await fetch(`${base}/items?ids=MLA1`);
    expect(r1.status).toBe(429);
    expect(r1.headers.get('retry-after')).toBe('30');
    expect((await fetch(`${base}/items?ids=MLA1`)).status).toBe(200);
    const llamadas = (await get('/__qa/llamadas')).body;
    expect(llamadas.map(l => l.status)).toEqual([429, 200]);
  });

  it('rechaza una regex de falla inválida y responde 404 claro a rutas no simuladas', async () => {
    const r = await fetch(`${base}/__qa/fallas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ruta: '([', status: 500 }) });
    expect(r.status).toBe(400);
    expect((await get('/ruta/inexistente')).body.message).toMatch(/no simulada/);
  });
});
