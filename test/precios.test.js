import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { veredictoNeto, netoMl, precioWebClave, precioSugerido } from '../lib/mlPrecios.js';
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
function seedCatalogo(db, { idWoo, sku, precio, stock = 5 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, precio, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)`).run(idWoo, 'Prod ' + sku, sku, 'variation', 1, stock, precio, ahora());
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
});
