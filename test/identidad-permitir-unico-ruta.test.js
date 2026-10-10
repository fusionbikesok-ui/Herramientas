import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { bootstrapProductosFusion } from '../lib/identidadProductos.js';
import { identidadProductosRouter } from '../routes/identidadProductos.js';

// Ruta HTTP de "No le corresponde" sobre el único identificador (permitir_unico). La lógica a nivel lib
// está cubierta en test/identificadores-ml.test.js; acá se prueba el contrato HTTP.
const FILE = './test/tmp-identidad-permitir-unico-ruta.sqlite';
const ISO = '2026-09-06T12:00:00.000Z';
const RUTA = '/api/identidad-productos/identificadores/incorrecto';
const GTIN = '602883701731';
const VALOR = '00602883701731'; // forma canónica (14 dígitos) guardada en identificadores_producto

describe('ruta POST /identificadores/incorrecto: permitir_unico en el único identificador', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya estaba cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  const app = (user) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = user; next(); });
    a.use('/api/identidad-productos', identidadProductosRouter(db));
    return a;
  };
  const operador = { username: 'ana', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
  const lector = { username: 'leo', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'read' }] };

  function productoConUnGtin(idWoo) {
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,id_padre,stock,gtin,actualizado_en)
      VALUES (?,?,?,'simple',NULL,2,?,?)`).run(idWoo, `Producto ${idWoo}`, `FB-${idWoo}`, GTIN, ISO);
    bootstrapProductosFusion(db);
    return db.prepare('SELECT id FROM productos_fusion WHERE primary_woo_id=?').get(idWoo).id;
  }
  const gtins = (productoId) => db.prepare(`SELECT estado FROM identificadores_producto
    WHERE tipo='gtin' AND producto_id=? ORDER BY id`).all(productoId).map((f) => f.estado);
  const cuerpo = (productoId, extra = {}) => ({ producto_id: productoId, valor_normalizado: VALOR, motivo: 'no corresponde', ...extra });

  it('sin permitir_unico: 409 INVALID_STATE con requiere_confirmacion y no escribe', async () => {
    const id = productoConUnGtin(150);
    const r = await request(app(operador)).post(RUTA).send(cuerpo(id));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'INVALID_STATE', requiere_confirmacion: 'permitir_unico' });
    expect(gtins(id)).toEqual(['activo']);
  });

  it('permitir_unico:false explícito también se rechaza sin escribir', async () => {
    const id = productoConUnGtin(151);
    const r = await request(app(operador)).post(RUTA).send(cuerpo(id, { permitir_unico: false }));
    expect(r.status).toBe(409);
    expect(r.body.requiere_confirmacion).toBe('permitir_unico');
    expect(gtins(id)).toEqual(['activo']);
  });

  it('con permitir_unico:true: 200 y el identificador queda marcado como incorrecto', async () => {
    const id = productoConUnGtin(152);
    const r = await request(app(operador)).post(RUTA).send(cuerpo(id, { permitir_unico: true }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(gtins(id)).toEqual(['incorrecto']);
  });

  it('lector: 403 FORBIDDEN, con o sin permitir_unico, y no escribe', async () => {
    const id = productoConUnGtin(153);
    const sin = await request(app(lector)).post(RUTA).send(cuerpo(id));
    const con = await request(app(lector)).post(RUTA).send(cuerpo(id, { permitir_unico: true }));
    expect(sin.status).toBe(403);
    expect(con.status).toBe(403);
    expect(sin.body.code).toBe('FORBIDDEN');
    expect(gtins(id)).toEqual(['activo']);
  });
});
