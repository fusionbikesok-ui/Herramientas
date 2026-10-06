import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { recepcionesRouter } from '../routes/recepciones.js';

// GET /api/recepciones/catalogo?q=... — el combobox de recepción busca acá (no contra Woo en
// vivo). P1.3 exige: SKU exacto/prefijo, GTIN exacto/prefijo, nombre por tokens, excluir padres
// variables (tipo='variable', nunca se recibe/vende directo), límite 20, y catálogo completo con
// q vacío.

const cfg = { url: 'https://fusionbikes.com.ar', ck: 'ck', cs: 'cs' };
const DB = './test/tmp-recep-busqueda.sqlite';

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/recepciones', recepcionesRouter(db, cfg));
  return app;
}

function abrirApp() {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  const db = openDb(DB);
  const app = makeApp(db);
  return { db, app };
}

function insertarProducto(db, { id_woo, nombre, sku, tipo = 'simple', id_padre = null, stock = 5, gtin = null }) {
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,gtin,actualizado_en) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id_woo, nombre, sku, tipo, id_padre, stock, gtin, new Date().toISOString());
}

afterEach(() => {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
});

describe('GET /api/recepciones/catalogo — SKU', () => {
  it('SKU exacto: devuelve la fila con relevancia máxima', async () => {
    const { db, app } = abrirApp();
    insertarProducto(db, { id_woo: 1, nombre: 'Casco MTB', sku: 'CASCO-001' });
    insertarProducto(db, { id_woo: 2, nombre: 'Otro producto', sku: 'CASCO-001-XL' });

    const res = await request(app).get('/api/recepciones/catalogo?q=CASCO-001');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0].id_woo).toBe(1); // exacto antes que prefijo
    expect(res.body.data.map(r => r.id_woo)).toContain(2);
  });

  it('SKU por prefijo: encuentra sin coincidencia exacta', async () => {
    const { db, app } = abrirApp();
    insertarProducto(db, { id_woo: 1, nombre: 'Casco MTB', sku: 'CASCO-001-XL' });

    const res = await request(app).get('/api/recepciones/catalogo?q=CASCO-001');
    expect(res.body.data.map(r => r.id_woo)).toEqual([1]);
  });

  it('búsqueda insensible a mayúsculas/acentos (normalización)', async () => {
    const { db, app } = abrirApp();
    insertarProducto(db, { id_woo: 1, nombre: 'Cámara de Aire 26"', sku: 'CAM-26' });

    const res = await request(app).get('/api/recepciones/catalogo?q=camara');
    expect(res.body.data.map(r => r.id_woo)).toEqual([1]);
  });
});

describe('GET /api/recepciones/catalogo — GTIN', () => {
  it('GTIN exacto: encuentra el producto por su código de barras', async () => {
    const { db, app } = abrirApp();
    insertarProducto(db, { id_woo: 1, nombre: 'Casco MTB', sku: 'CASCO-001', gtin: '7791234567890' });
    insertarProducto(db, { id_woo: 2, nombre: 'Otro', sku: 'OTRO-1', gtin: '7799999999999' });

    const res = await request(app).get('/api/recepciones/catalogo?q=7791234567890');
    expect(res.body.data.map(r => r.id_woo)).toEqual([1]);
  });

  it('GTIN por prefijo: encuentra con solo una parte del código', async () => {
    const { db, app } = abrirApp();
    insertarProducto(db, { id_woo: 1, nombre: 'Casco MTB', sku: 'CASCO-001', gtin: '7791234567890' });

    const res = await request(app).get('/api/recepciones/catalogo?q=779123');
    expect(res.body.data.map(r => r.id_woo)).toEqual([1]);
  });

  it('un producto sin GTIN cargado no rompe la búsqueda por GTIN de otro', async () => {
    const { db, app } = abrirApp();
    insertarProducto(db, { id_woo: 1, nombre: 'Sin gtin', sku: 'SG-1', gtin: null });
    insertarProducto(db, { id_woo: 2, nombre: 'Con gtin', sku: 'CG-1', gtin: '1112223334445' });

    const res = await request(app).get('/api/recepciones/catalogo?q=1112223334445');
    expect(res.body.data.map(r => r.id_woo)).toEqual([2]);
  });
});

describe('GET /api/recepciones/catalogo — nombre por tokens', () => {
  it('encuentra un nombre con las palabras de la búsqueda en cualquier orden', async () => {
    const { db, app } = abrirApp();
    insertarProducto(db, { id_woo: 1, nombre: 'Casco MTB Negro Talle M', sku: 'CASCO-N-M' });
    insertarProducto(db, { id_woo: 2, nombre: 'Zapatilla Running Negra', sku: 'ZAP-N' });

    const res = await request(app).get('/api/recepciones/catalogo?q=negro casco');
    expect(res.body.data.map(r => r.id_woo)).toEqual([1]);
  });

  it('exige TODAS las palabras (AND, no OR)', async () => {
    const { db, app } = abrirApp();
    insertarProducto(db, { id_woo: 1, nombre: 'Casco MTB Rojo', sku: 'CASCO-R' });

    const res = await request(app).get('/api/recepciones/catalogo?q=casco azul');
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /api/recepciones/catalogo — excluye padres variables', () => {
  it('un producto tipo "variable" (padre de familia) nunca aparece, ni en listado general ni en búsqueda', async () => {
    const { db, app } = abrirApp();
    insertarProducto(db, { id_woo: 500, nombre: 'Casco Familia', sku: null, tipo: 'variable' });
    insertarProducto(db, { id_woo: 501, nombre: 'Casco Familia Talle M', sku: 'CASCO-FAM-M', tipo: 'variation', id_padre: 500 });

    const listado = await request(app).get('/api/recepciones/catalogo');
    expect(listado.body.data.map(r => r.id_woo)).toEqual([501]);

    const busqueda = await request(app).get('/api/recepciones/catalogo?q=casco familia');
    expect(busqueda.body.data.map(r => r.id_woo)).toEqual([501]);
  });
});

describe('GET /api/recepciones/catalogo — límite y catálogo vacío', () => {
  it('nunca devuelve más de 20 resultados aunque haya más coincidencias', async () => {
    const { db, app } = abrirApp();
    for (let i = 1; i <= 25; i++) {
      insertarProducto(db, { id_woo: i, nombre: `Casco modelo ${i}`, sku: `CASCO-${i}` });
    }

    const res = await request(app).get('/api/recepciones/catalogo?q=casco');
    expect(res.body.data).toHaveLength(20);
  });

  it('q vacío devuelve el catálogo completo (sin límite de 20)', async () => {
    const { db, app } = abrirApp();
    for (let i = 1; i <= 25; i++) {
      insertarProducto(db, { id_woo: i, nombre: `Producto ${i}`, sku: `SKU-${i}` });
    }

    const res = await request(app).get('/api/recepciones/catalogo');
    expect(res.body.data).toHaveLength(25);
  });

  it('catálogo vacío: responde ok con data vacía, no un error', async () => {
    const { app } = abrirApp();
    const res = await request(app).get('/api/recepciones/catalogo?q=cualquiercosa');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });
  });
});
