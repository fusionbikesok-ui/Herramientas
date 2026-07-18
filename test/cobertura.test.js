import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { coberturaRouter } from '../routes/cobertura.js';
import { esFaltante, calcularFaltantes, esNoVendible, parseCategorias } from '../lib/cobertura.js';

const TEST_DB = './test/tmp-cobertura.sqlite';

function buildTestApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/cobertura', coberturaRouter(db));
  return app;
}

describe('lib/cobertura reglas de faltante', () => {
  const skusEnML = new Set(['EN-ML-1']);
  const excluidos = new Set([999]);

  it('marca faltante a un simple vendible con SKU no presente en ML', () => {
    const p = { id_woo: 1, sku: 'FB-1', tipo: 'simple', stock: 5, categorias_json: '["CUBIERTAS"]' };
    expect(esFaltante(p, skusEnML, excluidos)).toBe(true);
  });

  it('no es faltante si el stock es 0', () => {
    const p = { id_woo: 2, sku: 'FB-2', tipo: 'simple', stock: 0, categorias_json: null };
    expect(esFaltante(p, skusEnML, excluidos)).toBe(false);
  });

  it('no es faltante si el SKU ya está en ML', () => {
    const p = { id_woo: 3, sku: 'EN-ML-1', tipo: 'simple', stock: 5, categorias_json: null };
    expect(esFaltante(p, skusEnML, excluidos)).toBe(false);
  });

  it('no es faltante el padre variable (placeholder)', () => {
    const p = { id_woo: 4, sku: 'FB-4', tipo: 'variable', stock: 5, categorias_json: null };
    expect(esFaltante(p, skusEnML, excluidos)).toBe(false);
  });

  it('no es faltante sin SKU', () => {
    const p = { id_woo: 5, sku: '', tipo: 'simple', stock: 5, categorias_json: null };
    expect(esFaltante(p, skusEnML, excluidos)).toBe(false);
  });

  it('no es faltante si es servicio (SERVICES) o QR PAGOS', () => {
    const serv = { id_woo: 6, sku: 'FB-6', tipo: 'simple', stock: 5, categorias_json: '["SERVICES"]' };
    const qr = { id_woo: 7, sku: 'FB-7', tipo: 'simple', stock: 5, categorias_json: '["QR PAGOS"]' };
    expect(esFaltante(serv, skusEnML, excluidos)).toBe(false);
    expect(esFaltante(qr, skusEnML, excluidos)).toBe(false);
  });

  it('no es faltante si está en la lista de excluidos (solo local)', () => {
    const p = { id_woo: 999, sku: 'FB-999', tipo: 'simple', stock: 5, categorias_json: null };
    expect(esFaltante(p, skusEnML, excluidos)).toBe(false);
  });

  it('esNoVendible es case-insensitive y tolera espacios', () => {
    expect(esNoVendible({ categorias_json: '["services"]' })).toBe(true);
    expect(esNoVendible({ categorias_json: '["CUBIERTAS"]' })).toBe(false);
  });

  it('parseCategorias tolera array, string JSON y null', () => {
    expect(parseCategorias(['A'])).toEqual(['A']);
    expect(parseCategorias('["A","B"]')).toEqual(['A', 'B']);
    expect(parseCategorias(null)).toEqual([]);
    expect(parseCategorias('no-json')).toEqual([]);
  });

  it('calcularFaltantes filtra el catálogo completo', () => {
    const catalogo = [
      { id_woo: 1, sku: 'FB-1', tipo: 'simple', stock: 5, categorias_json: '["CUBIERTAS"]' }, // faltante
      { id_woo: 2, sku: 'EN-ML-1', tipo: 'simple', stock: 5, categorias_json: null },          // cubierto
      { id_woo: 6, sku: 'FB-6', tipo: 'simple', stock: 5, categorias_json: '["SERVICES"]' },   // servicio
    ];
    const faltantes = calcularFaltantes(catalogo, skusEnML, excluidos);
    expect(faltantes.map((p) => p.id_woo)).toEqual([1]);
  });
});

describe('coberturaRouter /exclusiones', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('POST crea, GET lista, DELETE borra; upsert no duplica', async () => {
    const db = openDb(TEST_DB);
    const app = buildTestApp(db);

    const post = await request(app)
      .post('/api/cobertura/exclusiones')
      .send({ id_woo: 42, sku: 'FB-42', nombre: 'Casco Local' });
    expect(post.status).toBe(200);
    expect(post.body.ok).toBe(true);

    let get = await request(app).get('/api/cobertura/exclusiones');
    expect(get.body.ok).toBe(true);
    expect(get.body.data.length).toBe(1);
    expect(get.body.data[0]).toMatchObject({ id_woo: 42, sku: 'FB-42', nombre: 'Casco Local', motivo: 'solo_local' });

    // Upsert: mismo id_woo no duplica
    await request(app)
      .post('/api/cobertura/exclusiones')
      .send({ id_woo: 42, sku: 'FB-42', nombre: 'Casco Local (edit)' });
    get = await request(app).get('/api/cobertura/exclusiones');
    expect(get.body.data.length).toBe(1);
    expect(get.body.data[0].nombre).toBe('Casco Local (edit)');

    const del = await request(app).delete('/api/cobertura/exclusiones/42');
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    get = await request(app).get('/api/cobertura/exclusiones');
    expect(get.body.data.length).toBe(0);
    db.close();
  });

  it('POST sin id_woo devuelve 400', async () => {
    const db = openDb(TEST_DB);
    const app = buildTestApp(db);
    const res = await request(app)
      .post('/api/cobertura/exclusiones')
      .send({ sku: 'FB-1', nombre: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    db.close();
  });
});
