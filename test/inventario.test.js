import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { inventarioRouter, looksLikeEan } from '../routes/inventario.js';

const TEST_DB = './test/tmp-inventario.sqlite';
const CFG = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
const now = () => new Date().toISOString();

function buildApp(db, usuario = 'operario1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: usuario, is_admin: 0 }; next(); });
  app.use('/api/inventario', inventarioRouter(db, CFG));
  return app;
}

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

describe('looksLikeEan', () => {
  it('reconoce un EAN-13 válido (checksum GS1 correcto)', () => {
    // Dígito de control calculado a mano con el algoritmo de gtinCheckOk para
    // los primeros 12 dígitos "779123456789" (pesos 3/1 alternados desde la
    // derecha): suma ponderada = 132 → check = (10 - 132%10) % 10 = 8.
    // Por eso el código de test es 7791234567898 (no ...5 como en el brief original).
    expect(looksLikeEan('7791234567898')).toBe(true);
  });
  it('rechaza un código con checksum inválido', () => {
    expect(looksLikeEan('7791234567890')).toBe(false);
  });
  it('rechaza un SKU alfanumérico', () => {
    expect(looksLikeEan('FB-123')).toBe(false);
  });
  it('rechaza longitudes no válidas de EAN (ni 8/12/13/14 dígitos)', () => {
    expect(looksLikeEan('12345')).toBe(false);
  });
});

describe('GET /api/inventario/alcance-opciones', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve categorías y marcas distintas de catalogo_cache, sin duplicados', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', categorias_json: '["Cascos","Accesorios"]' });
    insertProducto(db, { id_woo: 3, sku: 'FB-3', marca: 'Continental', categorias_json: '["Cubiertas"]' });

    const res = await request(buildApp(db)).get('/api/inventario/alcance-opciones');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.marcas.sort()).toEqual(['Bell', 'Continental']);
    expect(res.body.categorias.sort()).toEqual(['Accesorios', 'Cascos', 'Cubiertas']);
  });
});

describe('GET /api/inventario/sesion-activa', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve null si el usuario no tiene sesión abierta', async () => {
    const db = openDb(TEST_DB);
    const res = await request(buildApp(db)).get('/api/inventario/sesion-activa');
    expect(res.status).toBe(200);
    expect(res.body.sesion).toBeNull();
  });

  it('devuelve la sesión abierta propia, no la de otro usuario', async () => {
    const db = openDb(TEST_DB);
    db.prepare(`CREATE TABLE IF NOT EXISTS inventario_sesiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL, categoria TEXT, marca TEXT,
      estado TEXT NOT NULL DEFAULT 'abierta', creado_en TEXT NOT NULL, confirmado_en TEXT)`).run();
    db.prepare("INSERT INTO inventario_sesiones (usuario, marca, estado, creado_en) VALUES ('otro_operario','Bell','abierta',?)").run(now());
    db.prepare("INSERT INTO inventario_sesiones (usuario, marca, estado, creado_en) VALUES ('operario1','Continental','abierta',?)").run(now());

    const res = await request(buildApp(db, 'operario1')).get('/api/inventario/sesion-activa');

    expect(res.status).toBe(200);
    expect(res.body.sesion).toBeTruthy();
    expect(res.body.sesion.marca).toBe('Continental');
  });
});
