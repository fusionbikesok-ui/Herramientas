import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos } from '../lib/identidadProductos.js';
import { identidadProductosRouter } from '../routes/identidadProductos.js';

const FILE = './test/tmp-identidad-permisos-admin.sqlite';
const ISO = '2026-10-09T12:00:00.000Z';

describe('router de Identidad: acciones de administración', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  const app = (admin) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = { username: admin ? 'jose' : 'ana', is_admin: admin, permisos: [{ herramienta: 'matcher', nivel: 'write' }] };
      next();
    });
    a.use('/api/identidad-productos', identidadProductosRouter(db));
    return a;
  };

  function caso(id) {
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en)
      VALUES (?,'Bicicleta Rodado 27 Talle M',?,'simple',2,?)`).run(id, `FB-${id}`, ISO);
    db.prepare(`INSERT INTO ml_publicaciones_cache
      (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
      VALUES (?,?,'', 'Bicicleta Rodado 29 Talle M','active',NULL,0,2,'[]',?)`).run(`MLA${id}|`, `MLA${id}`, ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    return {
      f: db.prepare('SELECT * FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`),
      p: db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(id),
    };
  }
  const cuerpo = ({ f, p }, extra) => ({ tipo: 'vincular', product_id: p.id, operation_id: `op-${f.id}-${Object.keys(extra).join('')}`,
    expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint, ...extra });

  it('un operador recibe 403 al confirmar igual', async () => {
    const c = caso(1401);
    const r = await request(app(false)).post(`/api/identidad-productos/casos/${c.f.id}/decisiones`)
      .send(cuerpo(c, { override_contradiccion: true, motivo: 'm' }));
    expect(r.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) n FROM identidad_decisiones').get().n).toBe(0);
  });

  it('un operador recibe 403 al saltear omitir con override_omitir', async () => {
    const c = caso(1402);
    const r = await request(app(false)).post(`/api/identidad-productos/casos/${c.f.id}/decisiones`)
      .send(cuerpo(c, { override_omitir: true }));
    expect(r.status).toBe(403);
  });

  it('el administrador sí puede confirmar igual', async () => {
    const c = caso(1403);
    const r = await request(app(true)).post(`/api/identidad-productos/casos/${c.f.id}/decisiones`)
      .send(cuerpo(c, { override_contradiccion: true, motivo: 'm' }));
    expect(r.status).toBe(201);
  });

  it('un operador recibe 403 al destrabar', async () => {
    const r = await request(app(false)).post('/api/identidad-productos/operaciones/1/destrabar').send({});
    expect(r.status).toBe(403);
  });

  it('el administrador recibe 404 al destrabar una operación inexistente', async () => {
    const r = await request(app(true)).post('/api/identidad-productos/operaciones/999/destrabar').send({ operation_id: 'x' });
    expect(r.status).toBe(404);
  });
});
