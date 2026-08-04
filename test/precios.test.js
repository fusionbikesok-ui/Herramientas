import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { veredictoNeto, netoMl, precioWebClave, precioSugerido, precioContado, totalContado } from '../lib/mlPrecios.js';
import { auditarPrecios, preciosRouter } from '../routes/precios.js';

vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return { default: { ...actual.default, post: vi.fn(), request: vi.fn() } };
});
import axios from 'axios';

const TEST_DB = './test/tmp-precios.sqlite';
const ML_CFG = { clientId: 'c', clientSecret: 's', userId: '999' };
const ahora = () => new Date().toISOString();

function seedToken(db) {
  const exp = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES (1,'tok','ref',?,?)`).run(exp, ahora());
}
// regularPrice por defecto = precio (sin oferta): el contado auditado se calcula sobre
// regular_price (LISTA), nunca sobre precio (vigente) — pasar regularPrice explícito
// para simular un producto en oferta (regular_price != precio).
function seedCatalogo(db, { idWoo, sku, precio, regularPrice = precio, stock = 5 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(idWoo, 'Prod ' + sku, sku, 'variation', 1, stock, precio, regularPrice, ahora());
}
function seedDecision(db, clave, sku) {
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?,?,?,?,?)`).run(clave, sku, 'WC ' + sku, 'confirmar', ahora());
}
function seedPub(db, { clave, itemId, varId = '', status = 'active' }) {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave, item_id, variation_id, titulo, status, es_variante, seller_sku, variations_texto, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(clave, itemId, varId, 'Pub ' + itemId, status, varId ? 1 : 0, '', '', ahora());
}

// Mock de axios.request que enruta por URL (listing_prices / shipping / multiget items).
function mockMl({ saleFee = 100, envio = 50, itemPrice = 1000, freeShipping = true } = {}) {
  axios.request.mockImplementation((cfg) => {
    const url = cfg.url || '';
    if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: saleFee }, headers: {} };
    if (url.includes('/shipping_options/free')) return { status: 200, data: { coverage: { all_country: { list_cost: envio } } }, headers: {} };
    if (url.includes('/items?ids=')) {
      const ids = decodeURIComponent(url.split('ids=')[1].split('&')[0]).split(',');
      return { status: 200, data: ids.map(id => ({ code: 200, body: {
        id, price: itemPrice, category_id: 'MLA1', listing_type_id: 'gold_special',
        shipping: { free_shipping: freeShipping }, variations: [],
      } })), headers: {} };
    }
    return { status: 404, data: {}, headers: {} };
  });
}

// totalContado (fix del tester, 2026-08-03): totalContado(precioLista, qty) tiene que dar el
// mismo resultado que precioContado(precioLista)*qty SOLO cuando ese producto no divide con
// resto en centavos; en el caso general (2/3 no exacto) tiene que dar el total EXACTO, sin el
// centavo de diferencia que arrastra multiplicar el unitario ya redondeado por la cantidad.
describe('mlPrecios — totalContado (evita el doble redondeo)', () => {
  it('null si no hay precio de lista (mismo criterio fail-open que precioContado)', () => {
    expect(totalContado(null, 3)).toBeNull();
  });

  it('qty=1: coincide con precioContado (redondear una vez o dos da lo mismo con una sola unidad)', () => {
    expect(totalContado(1000, 1)).toBe(precioContado(1000));
  });

  it('regular_price=1000, qty=3: total EXACTO 2000.00, no 2000.01 (doble redondeo del unitario 666.67×3)', () => {
    expect(precioContado(1000)).toBe(666.67); // unitario ya redondeado
    expect(666.67 * 3).toBeCloseTo(2000.01, 2); // lo que daría el doble redondeo
    expect(totalContado(1000, 3)).toBe(2000);
  });

  it('regular_price=100, qty=7: total EXACTO 466.67, no 466.69 (doble redondeo del unitario 66.67×7)', () => {
    expect(precioContado(100)).toBe(66.67);
    expect(totalContado(100, 7)).toBe(466.67);
  });
});

describe('mlPrecios — veredictoNeto', () => {
  it('bajo: neto >5% por debajo del web', () => {
    expect(veredictoNeto(850, 1000).estado).toBe('bajo');
  });
  it('ok: dentro de tolerancia', () => {
    expect(veredictoNeto(980, 1000).estado).toBe('ok');
    expect(veredictoNeto(1050, 1000).estado).toBe('ok'); // 5% arriba, dentro de tolOver
  });
  it('alto: neto muy por encima del web', () => {
    expect(veredictoNeto(1300, 1000).estado).toBe('alto');
  });
  it('sin_precio: falta web o neto', () => {
    expect(veredictoNeto(900, null).estado).toBe('sin_precio');
    expect(veredictoNeto(null, 1000).estado).toBe('sin_precio');
  });
});

describe('mlPrecios — precioSugerido', () => {
  it('sugiere el precio que iguala el neto al precio web, dado el % de comisión implícito', () => {
    // a precio_ml=1000 la comisión fue 130 (13%): sugerido = (precio_web + envío) / (1 - 0.13)
    const sugerido = precioSugerido(1000, 130, 50, 900);
    expect(sugerido).toBe(Math.ceil((900 + 50) / (1 - 0.13)));
  });
  it('null si falta algún dato necesario', () => {
    expect(precioSugerido(0, 130, 50, 900)).toBeNull();
    expect(precioSugerido(1000, null, 50, 900)).toBeNull();
    expect(precioSugerido(1000, 130, 50, 0)).toBeNull();
  });
});

describe('mlPrecios — netoMl + precioWebClave', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); vi.clearAllMocks(); seedToken(db); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('netoMl = precio − comisión − envío', async () => {
    mockMl({ saleFee: 100, envio: 50 });
    const r = await netoMl(db, ML_CFG, { itemId: 'MLA1', price: 1000, categoryId: 'MLA1', listingTypeId: 'gold_special', freeShipping: true });
    expect(r.sale_fee).toBe(100);
    expect(r.envio).toBe(50);
    expect(r.neto).toBe(850);
  });

  it('precioWebClave lee el precio de LISTA del SKU mapeado y devuelve el de CONTADO (2/3)', () => {
    seedCatalogo(db, { idWoo: 10, sku: 'FB-1', precio: 1234 });
    seedDecision(db, 'MLA1|v1', 'FB-1');
    expect(precioWebClave(db, 'MLA1|v1')).toBe(822.67);
    expect(precioWebClave(db, 'MLA9|v9')).toBe(null);
  });

  it('producto en oferta: usa regular_price (LISTA), no precio (vigente) — no acumula descuentos', () => {
    // regular_price 1000 (lista), precio 800 (vigente, en oferta). El contado de
    // referencia es 666.67 (2/3 de 1000), NO 533.33 (2/3 de 800, descuento sobre descuento).
    seedCatalogo(db, { idWoo: 11, sku: 'FB-OFERTA', precio: 800, regularPrice: 1000 });
    seedDecision(db, 'MLA2|v1', 'FB-OFERTA');
    expect(precioWebClave(db, 'MLA2|v1')).toBe(666.67);
  });

  it('regular_price NULL: fail-closed, precioWebClave devuelve null sin fallback a precio', () => {
    seedCatalogo(db, { idWoo: 12, sku: 'FB-SINLISTA', precio: 800, regularPrice: null });
    seedDecision(db, 'MLA3|v1', 'FB-SINLISTA');
    expect(precioWebClave(db, 'MLA3|v1')).toBe(null);
  });

  it('regular_price NULL con precio con valor real (caso peligroso del fallback): sigue dando null', () => {
    // Este es el caso que un `regular_price ?? precio` reintroducido dejaría pasar en
    // silencio: acá precio SÍ tiene un valor sustancioso (2500), y aun así el resultado
    // tiene que ser null porque regular_price es NULL. Si algún día devuelve 1666.67
    // (2/3 de 2500) en vez de null, es la señal de que el fallback volvió.
    seedCatalogo(db, { idWoo: 13, sku: 'FB-PELIGRO', precio: 2500, regularPrice: null });
    seedDecision(db, 'MLA4|v1', 'FB-PELIGRO');
    expect(precioWebClave(db, 'MLA4|v1')).toBe(null);
  });

  it('regular_price=0 (no NULL): precioWebClave devuelve 0, no null y no el fallback a precio', () => {
    // 0 != null, así que la condición `row.regular_price != null` es verdadera y
    // precioContado(0) = 0. El llamador (chequearNetoReactivar) trata 0 como "sin precio
    // web" vía `!(precioWeb > 0)`, así que el bloqueo fail-closed sigue funcionando, pero
    // a este nivel el valor correcto es 0, no null ni el contado de `precio`.
    seedCatalogo(db, { idWoo: 14, sku: 'FB-CERO', precio: 900, regularPrice: 0 });
    seedDecision(db, 'MLA5|v1', 'FB-CERO');
    expect(precioWebClave(db, 'MLA5|v1')).toBe(0);
  });

  it('oferta con números que redondean feo (regular_price=1, precio=0.5): sigue sobre la lista', () => {
    // 2/3 de 1 = 0.666...67 → 0.67. Si usara precio (vigente=0.5) daría 0.33.
    seedCatalogo(db, { idWoo: 15, sku: 'FB-CENT', precio: 0.5, regularPrice: 1 });
    seedDecision(db, 'MLA6|v1', 'FB-CENT');
    expect(precioWebClave(db, 'MLA6|v1')).toBe(0.67);
  });
});

describe('auditarPrecios + router', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB); vi.clearAllMocks(); seedToken(db);
    app = express(); app.use(express.json());
    app.use('/api/precios', preciosRouter(db, { ml: ML_CFG }));
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('audita una publicación activa y clasifica bajo/ok/sin_precio', async () => {
    // bajo: neto 850 vs contado 1000 (precio de lista 1500 × 2/3, >5% debajo)
    seedCatalogo(db, { idWoo: 1, sku: 'FB-B', precio: 1500 });
    seedDecision(db, 'MLB|v1', 'FB-B'); seedPub(db, { clave: 'MLB|v1', itemId: 'MLB', varId: 'v1' });
    // ok: neto 850 vs contado 870 (precio de lista 1305 × 2/3)
    seedCatalogo(db, { idWoo: 2, sku: 'FB-O', precio: 1305 });
    seedDecision(db, 'MLO|v1', 'FB-O'); seedPub(db, { clave: 'MLO|v1', itemId: 'MLO', varId: 'v1' });
    // sin_precio: sin precio web
    seedCatalogo(db, { idWoo: 3, sku: 'FB-S', precio: null });
    seedDecision(db, 'MLS|v1', 'FB-S'); seedPub(db, { clave: 'MLS|v1', itemId: 'MLS', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 }); // neto = 850 para todos

    await auditarPrecios(db, ML_CFG);

    const g = (clave) => db.prepare('SELECT estado, neto FROM ml_precio_auditoria WHERE clave=?').get(clave);
    expect(g('MLB|v1').estado).toBe('bajo');
    expect(g('MLB|v1').neto).toBe(850);
    expect(g('MLO|v1').estado).toBe('ok');
    expect(g('MLS|v1').estado).toBe('sin_precio');
  });

  it('auditarPrecios: producto en oferta usa regular_price (LISTA), no precio (vigente) — call site real', async () => {
    // regular_price 1500 (lista) → contado 1000; precio vigente 1000 (30% off). Si el query
    // de auditarPrecios usara `c.precio AS precio_lista` (el bug que se corrigió), el
    // contado de referencia caería a 666.67 y esta publicación pasaría a "ok" cuando en
    // realidad tiene que seguir "bajo" contra la lista real.
    seedCatalogo(db, { idWoo: 1, sku: 'FB-OFERTA-AUD', precio: 1000, regularPrice: 1500 });
    seedDecision(db, 'MLB|v1', 'FB-OFERTA-AUD'); seedPub(db, { clave: 'MLB|v1', itemId: 'MLB', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 }); // neto = 850

    await auditarPrecios(db, ML_CFG);

    const fila = db.prepare('SELECT estado, neto, precio_web FROM ml_precio_auditoria WHERE clave=?').get('MLB|v1');
    expect(fila.precio_web).toBe(1000); // 2/3 de 1500, no de 1000
    expect(fila.estado).toBe('bajo'); // 850 vs 1000 → >5% debajo
  });

  it('auditarPrecios: regular_price NULL con precio con valor (caso peligroso) sigue dando sin_precio', async () => {
    // precio (vigente) tiene un valor real (1500); si algún fallback reintrodujera
    // `regular_price ?? precio`, esta fila pasaría a "bajo"/"ok" en vez de "sin_precio".
    db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, regular_price, actualizado_en)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(1, 'Prod FB-PELIGRO-AUD', 'FB-PELIGRO-AUD', 'variation', 1, 5, 1500, null, ahora());
    seedDecision(db, 'MLP|v1', 'FB-PELIGRO-AUD'); seedPub(db, { clave: 'MLP|v1', itemId: 'MLP', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 });

    await auditarPrecios(db, ML_CFG);

    const fila = db.prepare('SELECT estado, precio_web FROM ml_precio_auditoria WHERE clave=?').get('MLP|v1');
    expect(fila.estado).toBe('sin_precio');
    expect(fila.precio_web).toBeNull();
  });

  it('GET /api/precios?estado=bajo filtra por estado', async () => {
    seedCatalogo(db, { idWoo: 1, sku: 'FB-B', precio: 1500 });
    seedDecision(db, 'MLB|v1', 'FB-B'); seedPub(db, { clave: 'MLB|v1', itemId: 'MLB', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 });
    await auditarPrecios(db, ML_CFG);

    const res = await request(app).get('/api/precios?estado=bajo');
    expect(res.status).toBe(200);
    expect(res.body.data.map(r => r.clave)).toEqual(['MLB|v1']);
    const vacio = await request(app).get('/api/precios?estado=alto');
    expect(vacio.body.data).toHaveLength(0);
  });

  it('GET /api/precios incluye precio_sugerido solo para filas "bajo"', async () => {
    seedCatalogo(db, { idWoo: 1, sku: 'FB-B', precio: 1500 });
    seedDecision(db, 'MLB|v1', 'FB-B'); seedPub(db, { clave: 'MLB|v1', itemId: 'MLB', varId: 'v1' });
    seedCatalogo(db, { idWoo: 2, sku: 'FB-O', precio: 1305 });
    seedDecision(db, 'MLO|v1', 'FB-O'); seedPub(db, { clave: 'MLO|v1', itemId: 'MLO', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 });
    await auditarPrecios(db, ML_CFG);

    const res = await request(app).get('/api/precios?estado=all');
    const bajo = res.body.data.find(r => r.clave === 'MLB|v1');
    const ok = res.body.data.find(r => r.clave === 'MLO|v1');
    expect(bajo.precio_sugerido).toBeGreaterThan(bajo.precio_ml);
    expect(ok.precio_sugerido).toBeNull();
  });

  it('GET /api/precios: total es el COUNT real (no el LIMIT) y avisa truncado', async () => {
    const ins = db.prepare(`
      INSERT INTO ml_precio_auditoria
        (clave, item_id, titulo, sku, precio_ml, sale_fee, envio, neto, precio_web, deficit_pct, estado, actualizado_en)
      VALUES (?, ?, 't', 'FB-X', 100, 10, 5, 85, 200, 50, 'bajo', datetime('now'))
    `);
    const tx = db.transaction((n) => { for (let i = 0; i < n; i++) ins.run(`MLX${i}|v1`, `MLX${i}`); });
    tx(1050); // por encima del LIMIT 1000 de la query

    const res = await request(app).get('/api/precios?estado=all');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1050);
    expect(res.body.truncado).toBe(true);
    expect(res.body.data).toHaveLength(1000);
  });

  it('GET /api/precios: sin truncar, total coincide con la cantidad de filas devueltas', async () => {
    seedCatalogo(db, { idWoo: 1, sku: 'FB-B', precio: 1500 });
    seedDecision(db, 'MLB|v1', 'FB-B'); seedPub(db, { clave: 'MLB|v1', itemId: 'MLB', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 });
    await auditarPrecios(db, ML_CFG);

    const res = await request(app).get('/api/precios?estado=all');
    expect(res.body.total).toBe(res.body.data.length);
    expect(res.body.truncado).toBe(false);
  });

  it('POST /api/precios/actualizar-precio corrige el precio en ML y refresca la fila', async () => {
    seedCatalogo(db, { idWoo: 1, sku: 'FB-B', precio: 1500 }); // lista 1500 → contado 1000
    seedDecision(db, 'MLB|v1', 'FB-B'); seedPub(db, { clave: 'MLB|v1', itemId: 'MLB', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 });
    await auditarPrecios(db, ML_CFG);
    expect(db.prepare("SELECT estado FROM ml_precio_auditoria WHERE clave='MLB|v1'").get().estado).toBe('bajo');

    // Tras la corrección, el item queda a precio 1200 (neto 1050 ≥ contado 1000 → ok)
    axios.request.mockImplementation((cfg) => {
      const url = cfg.url || '';
      const method = (cfg.method || '').toLowerCase();
      if (method === 'put' && /\/items\/MLB\/variations\/v1$/.test(url)) return { status: 200, data: {}, headers: {} };
      if (url.includes('/listing_prices')) return { status: 200, data: { sale_fee_amount: 100 }, headers: {} };
      if (url.includes('/shipping_options/free')) return { status: 200, data: { coverage: { all_country: { list_cost: 50 } } }, headers: {} };
      if (/\/items\/MLB\?/.test(url)) return { status: 200, data: { id: 'MLB', price: 1200, category_id: 'MLA1', listing_type_id: 'gold_special', shipping: { free_shipping: true }, status: 'active', variations: [] }, headers: {} };
      return { status: 404, data: {}, headers: {} };
    });

    const res = await request(app).post('/api/precios/actualizar-precio').send({ clave: 'MLB|v1', precio: 1200 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.estado).toBe('ok');
    expect(res.body.data.precio_ml).toBe(1200);
    expect(res.body.data.neto).toBe(1050);

    const fila = db.prepare("SELECT estado, precio_ml FROM ml_precio_auditoria WHERE clave='MLB|v1'").get();
    expect(fila.estado).toBe('ok');
    expect(fila.precio_ml).toBe(1200);
  });

  it('POST /api/precios/actualizar-precio devuelve error si ML rechaza el precio', async () => {
    seedCatalogo(db, { idWoo: 1, sku: 'FB-B', precio: 1000 });
    seedDecision(db, 'MLB|v1', 'FB-B'); seedPub(db, { clave: 'MLB|v1', itemId: 'MLB', varId: 'v1' });
    axios.request.mockResolvedValue({ status: 400, data: { message: 'precio inválido' }, headers: {} });

    const res = await request(app).post('/api/precios/actualizar-precio').send({ clave: 'MLB|v1', precio: 1200 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/inválido/);
  });

  it('POST /api/precios/actualizar-precio valida clave/precio', async () => {
    const res = await request(app).post('/api/precios/actualizar-precio').send({ clave: '', precio: 0 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('GET /api/precios propaga marca/categorias_json/stock desde catalogo_cache (join por SKU)', async () => {
    // Fila CON match en catalogo_cache: debe traer marca/categorias/stock.
    db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, marca, categorias_json, actualizado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(1, 'Prod FB-B', 'FB-B', 'variation', 1, 7, 1500, 'Maxxis', '["CUBIERTAS"]', ahora());
    seedDecision(db, 'MLB|v1', 'FB-B'); seedPub(db, { clave: 'MLB|v1', itemId: 'MLB', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 });
    await auditarPrecios(db, ML_CFG);

    const res = await request(app).get('/api/precios?estado=all');
    expect(res.status).toBe(200);
    const fila = res.body.data.find(r => r.clave === 'MLB|v1');
    expect(fila).toBeTruthy();
    expect(fila.marca).toBe('Maxxis');
    expect(fila.categorias_json).toBe('["CUBIERTAS"]');
    expect(fila.stock).toBe(7);
  });

  it('GET /api/precios devuelve null (no excepción) para un SKU sin match en catalogo_cache', async () => {
    // Publicación auditada con decisión, pero SIN fila en catalogo_cache → sin_precio.
    seedDecision(db, 'MLN|v1', 'FB-SINCAT'); seedPub(db, { clave: 'MLN|v1', itemId: 'MLN', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 });
    await auditarPrecios(db, ML_CFG);

    const res = await request(app).get('/api/precios?estado=all');
    expect(res.status).toBe(200);
    const fila = res.body.data.find(r => r.clave === 'MLN|v1');
    expect(fila).toBeTruthy();
    expect(fila.marca).toBeNull();
    expect(fila.categorias_json).toBeNull();
    expect(fila.stock).toBeNull();
  });

  it('GET /api/precios NO multiplica filas por SKU duplicado y elige la fila más reciente', async () => {
    // catalogo_cache.sku no es único (hay duplicados reales en prod). El join debe
    // resolver a UNA sola fila por SKU y, ante duplicados con valores distintos,
    // elegir de forma determinística la de mayor `actualizado_en` (no una arbitraria).
    const vieja = '2026-07-01T00:00:00.000Z';
    const nueva = '2026-07-20T00:00:00.000Z';
    db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, marca, categorias_json, actualizado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(1, 'Prod dup vieja', 'FB-DUP', 'variation', 1, 3, 1500, 'MarcaVieja', '["VIEJA"]', vieja);
    db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, marca, categorias_json, actualizado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(2, 'Prod dup nueva', 'FB-DUP', 'variation', 1, 9, 1500, 'MarcaNueva', '["NUEVA"]', nueva);
    seedDecision(db, 'MLD|v1', 'FB-DUP'); seedPub(db, { clave: 'MLD|v1', itemId: 'MLD', varId: 'v1' });
    mockMl({ saleFee: 100, envio: 50, itemPrice: 1000 });
    await auditarPrecios(db, ML_CFG);

    const res = await request(app).get('/api/precios?estado=all');
    expect(res.status).toBe(200);
    const filas = res.body.data.filter(r => r.clave === 'MLD|v1');
    expect(filas).toHaveLength(1);
    // Debe ganar la fila con actualizado_en más reciente.
    expect(filas[0].marca).toBe('MarcaNueva');
    expect(filas[0].categorias_json).toBe('["NUEVA"]');
    expect(filas[0].stock).toBe(9);
  });
});
