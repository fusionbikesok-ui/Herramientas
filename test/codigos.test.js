import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import axios from 'axios';
import { openDb } from '../db/index.js';
import { codigosRouter } from '../routes/codigos.js';

vi.mock('axios');

const TEST_DB = './test/tmp-codigos.sqlite';
const CFG = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/codigos', codigosRouter(db, CFG));
  return app;
}

const now = () => new Date().toISOString();

/** Inserta una fila de catalogo_cache con defaults razonables (override via `extra`). */
function insertProducto(db, extra) {
  const base = {
    id_woo: 1, nombre: 'Producto', sku: 'FB-1', tipo: 'simple', id_padre: null,
    stock: 5, categorias_json: null, img: null, precio: null, atributos_json: null,
    marca: null, gtin: null, actualizado_en: now(),
  };
  const row = { ...base, ...extra };
  db.prepare(`
    INSERT INTO catalogo_cache
      (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, atributos_json, marca, gtin, actualizado_en)
    VALUES
      (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @atributos_json, @marca, @gtin, @actualizado_en)
  `).run(row);
  return row;
}

describe('GET /api/codigos/faltantes — alcance de la cola', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('incluye solo lo que cumple todas las reglas y excluye cada caso límite', async () => {
    const db = openDb(TEST_DB);

    // Incluido: stock>0, sin gtin, simple, con sku, vendible, no excluido.
    insertProducto(db, { id_woo: 1, nombre: 'Cubierta Continental', sku: 'FB-1', tipo: 'simple', stock: 5, marca: 'Continental', categorias_json: '["CUBIERTAS"]' });
    // Excluido: ya tiene gtin cargado.
    insertProducto(db, { id_woo: 2, nombre: 'Con GTIN', sku: 'FB-2', tipo: 'simple', stock: 5, gtin: '7791234567890', marca: 'Continental' });
    // Excluido (con conStock por defecto): sin stock.
    insertProducto(db, { id_woo: 3, nombre: 'Sin stock', sku: 'FB-3', tipo: 'simple', stock: 0, marca: 'Continental' });
    // Excluido: variable (padre), sin sku a propósito.
    insertProducto(db, { id_woo: 4, nombre: 'Padre variable', sku: '', tipo: 'variable', stock: 5 });
    // Excluido: sin sku (aunque no sea variable).
    insertProducto(db, { id_woo: 5, nombre: 'Sin sku', sku: '', tipo: 'simple', stock: 5 });
    // Excluido: no-vendible (SERVICES).
    insertProducto(db, { id_woo: 6, nombre: 'Armado de bici', sku: 'FB-6', tipo: 'simple', stock: 5, categorias_json: '["SERVICES"]' });
    // Excluido: no-vendible (QR PAGOS).
    insertProducto(db, { id_woo: 7, nombre: 'QR Pago', sku: 'FB-7', tipo: 'simple', stock: 5, categorias_json: '["QR PAGOS"]' });
    // Excluido: marcado "solo local" en cobertura_exclusiones.
    insertProducto(db, { id_woo: 8, nombre: 'Solo local', sku: 'FB-8', tipo: 'simple', stock: 5, marca: 'Giro' });
    db.prepare('INSERT INTO cobertura_exclusiones (id_woo, sku, nombre, motivo, creado_en) VALUES (?,?,?,?,?)')
      .run(8, 'FB-8', 'Solo local', 'solo_local', now());

    const app = buildApp(db);
    const res = await request(app).get('/api/codigos/faltantes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.map((p) => p.id_woo)).toEqual([1]);

    // Los desplegables solo listan lo que aparece entre los faltantes efectivos.
    expect(res.body.marcas).toEqual(['Continental']);
    expect(res.body.categorias).toEqual(['CUBIERTAS']);

    db.close();
  });

  it('conStock=false suma los faltantes con stock<=0', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', tipo: 'simple', stock: 5 });
    insertProducto(db, { id_woo: 3, sku: 'FB-3', tipo: 'simple', stock: 0 });

    const app = buildApp(db);
    const res = await request(app).get('/api/codigos/faltantes?conStock=false');
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.id_woo).sort()).toEqual([1, 3]);

    db.close();
  });
});

describe('POST /api/codigos/asignar', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    vi.resetAllMocks();
  });

  it('producto simple: PATCH a /products/{id} y persiste gtin + siembra ean_sku', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 100, sku: 'FB-100', tipo: 'simple', stock: 5 });
    axios.request.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

    const app = buildApp(db);
    const res = await request(app).post('/api/codigos/asignar').send({ id_woo: 100, gtin: '7791234500001' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://fusionbikes.com.ar/wp-json/wc/v3/products/100',
      method: 'patch',
      data: { global_unique_id: '7791234500001' },
    }));

    const fila = db.prepare('SELECT gtin FROM catalogo_cache WHERE id_woo = ?').get(100);
    expect(fila.gtin).toBe('7791234500001');
    const eanSku = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('7791234500001');
    expect(eanSku.sku).toBe('FB-100');

    db.close();
  });

  it('variación: PATCH a /products/{id_padre}/variations/{id}', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 201, sku: 'FB-201', tipo: 'variation', id_padre: 200, stock: 3 });
    axios.request.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });

    const app = buildApp(db);
    const res = await request(app).post('/api/codigos/asignar').send({ id_woo: 201, gtin: '7791234500002' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://fusionbikes.com.ar/wp-json/wc/v3/products/200/variations/201',
      method: 'patch',
      data: { global_unique_id: '7791234500002' },
    }));

    const fila = db.prepare('SELECT gtin FROM catalogo_cache WHERE id_woo = ?').get(201);
    expect(fila.gtin).toBe('7791234500002');
    const eanSku = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('7791234500002');
    expect(eanSku.sku).toBe('FB-201');

    db.close();
  });

  it('fail-closed: Woo rechaza (ej. GTIN duplicado) → no toca cache ni ean_sku, propaga el mensaje real', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 100, sku: 'FB-100', tipo: 'simple', stock: 5 });
    axios.request.mockResolvedValueOnce({
      status: 400,
      data: { code: 'duplicate_global_unique_id', message: 'El código universal ya está en uso por otro producto.' },
      headers: {},
    });

    const app = buildApp(db);
    const res = await request(app).post('/api/codigos/asignar').send({ id_woo: 100, gtin: '7791234500001' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('El código universal ya está en uso por otro producto.');

    const fila = db.prepare('SELECT gtin FROM catalogo_cache WHERE id_woo = ?').get(100);
    expect(fila.gtin).toBeNull();
    const eanSku = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('7791234500001');
    expect(eanSku).toBeUndefined();

    db.close();
  });

  it('fail-closed: error de red (axios throwea) → no toca cache ni ean_sku', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 100, sku: 'FB-100', tipo: 'simple', stock: 5 });
    axios.request.mockRejectedValueOnce(new Error('ECONNRESET'));

    const app = buildApp(db);
    const res = await request(app).post('/api/codigos/asignar').send({ id_woo: 100, gtin: '7791234500001' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.ok).toBe(false);

    const fila = db.prepare('SELECT gtin FROM catalogo_cache WHERE id_woo = ?').get(100);
    expect(fila.gtin).toBeNull();
    const eanSku = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('7791234500001');
    expect(eanSku).toBeUndefined();

    db.close();
  });

  it('sobrescritura: reasignar a un gtin nuevo borra la fila ean_sku del gtin viejo (no queda huérfana)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 100, sku: 'FB-100', tipo: 'simple', stock: 5 });
    const app = buildApp(db);

    axios.request.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
    await request(app).post('/api/codigos/asignar').send({ id_woo: 100, gtin: 'GTIN-VIEJO' });
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('GTIN-VIEJO').sku).toBe('FB-100');

    axios.request.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
    const res = await request(app).post('/api/codigos/asignar').send({ id_woo: 100, gtin: 'GTIN-NUEVO' });
    expect(res.body.ok).toBe(true);

    const fila = db.prepare('SELECT gtin FROM catalogo_cache WHERE id_woo = ?').get(100);
    expect(fila.gtin).toBe('GTIN-NUEVO');
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('GTIN-VIEJO')).toBeUndefined();
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('GTIN-NUEVO').sku).toBe('FB-100');

    db.close();
  });
});
