import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { clavesNecesitanAtencion } from '../lib/mlMapeo.js';
import { matcherRouter, refrescarPublicacionesMlAcotado } from '../routes/matcher.js';

// Mock axios para evitar llamadas reales a ML
vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return { default: { ...actual.default, post: vi.fn(), request: vi.fn() } };
});
import axios from 'axios';

const TEST_DB = './test/tmp-matcher.sqlite';
const ML_CFG = { clientId: 'client123', clientSecret: 'secret456', userId: '99999' };

function now() { return new Date().toISOString(); }

function seedSyncLog(db, { clave, estado }) {
  db.prepare(
    `INSERT INTO sync_log (direccion, clave, estado, intentos, creado_en, actualizado_en)
     VALUES ('ml_wc', ?, ?, 0, ?, ?)`
  ).run(clave, estado, now(), now());
}

function seedDecision(db, { clave, sku, accion }) {
  db.prepare(
    'INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
  ).run(clave, sku, sku, accion, now());
}

function seedCache(db, { clave, itemId, variationId = '', titulo = 'Pub', status = 'active' }) {
  db.prepare(
    `INSERT INTO ml_publicaciones_cache
       (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, actualizado_en)
     VALUES (?, ?, ?, ?, ?, '', 0, '', '', '', '', ?)`
  ).run(clave, itemId, variationId, titulo, status, now());
}

function seedToken(db) {
  const expiresAt = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
  db.prepare(
    `INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
     VALUES (1, 'tok', 'ref', ?, ?)`
  ).run(expiresAt, now());
}

describe('clavesNecesitanAtencion', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve sin_mapeo y remapeo_requerido no resueltos, y excluye lo resuelto y otros estados', () => {
    // sin_mapeo pendiente (sin decisión) → SÍ
    seedSyncLog(db, { clave: 'MLA1|', estado: 'sin_mapeo' });
    // sin_mapeo ya resuelto (tiene decisión asignar) → NO
    seedSyncLog(db, { clave: 'MLA2|', estado: 'sin_mapeo' });
    seedDecision(db, { clave: 'MLA2|', sku: 'FB-2', accion: 'asignar' });
    // remapeo_requerido pendiente (sin decisión) → SÍ
    seedSyncLog(db, { clave: 'MLA3|55', estado: 'remapeo_requerido' });
    // remapeo_requerido ya resuelto (cualquier decisión) → NO
    seedSyncLog(db, { clave: 'MLA4|', estado: 'remapeo_requerido' });
    seedDecision(db, { clave: 'MLA4|', sku: 'FB-4', accion: 'confirmar' });
    // otros estados → NO
    seedSyncLog(db, { clave: 'MLA5|', estado: 'error' });
    seedSyncLog(db, { clave: 'MLA6|', estado: 'ok' });

    const claves = clavesNecesitanAtencion(db).sort();
    expect(claves).toEqual(['MLA1|', 'MLA3|55']);
  });
});

describe('GET /publicaciones?scope=atencion', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    app = express();
    app.use(express.json());
    app.use('/api/matcher', matcherRouter(db, ML_CFG));
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve solo las claves que necesitan atención', async () => {
    seedCache(db, { clave: 'MLA1|', itemId: 'MLA1' });
    seedCache(db, { clave: 'MLA3|55', itemId: 'MLA3', variationId: '55' });
    seedCache(db, { clave: 'MLA9|', itemId: 'MLA9' }); // no necesita atención
    seedSyncLog(db, { clave: 'MLA1|', estado: 'sin_mapeo' });
    seedSyncLog(db, { clave: 'MLA3|55', estado: 'remapeo_requerido' });

    const r = await request(app).get('/api/matcher/publicaciones?scope=atencion');
    expect(r.status).toBe(200);
    const claves = r.body.data.map(p => p.clave).sort();
    expect(claves).toEqual(['MLA1|', 'MLA3|55']);
  });

  it('sin scope devuelve todas las publicaciones del cache', async () => {
    seedCache(db, { clave: 'MLA1|', itemId: 'MLA1' });
    seedCache(db, { clave: 'MLA9|', itemId: 'MLA9' });
    const r = await request(app).get('/api/matcher/publicaciones');
    expect(r.body.total).toBe(2);
  });

  it('scope=atencion sin pendientes devuelve lista vacía sin error', async () => {
    seedCache(db, { clave: 'MLA9|', itemId: 'MLA9' });
    const r = await request(app).get('/api/matcher/publicaciones?scope=atencion');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.total).toBe(0);
  });
});

describe('refrescarPublicacionesMlAcotado', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); seedToken(db); vi.clearAllMocks(); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('hace upsert de los item_ids pedidos SIN borrar el resto del cache', async () => {
    // Cache previo con una publicación que NO está en el refresco acotado
    seedCache(db, { clave: 'MLA999|', itemId: 'MLA999', titulo: 'Vieja' });

    axios.request.mockResolvedValue({
      status: 200,
      headers: {},
      data: [{
        code: 200,
        body: {
          id: 'MLA100', title: 'Bici nueva', status: 'active', sub_status: [],
          attributes: [{ id: 'SELLER_SKU', value_name: 'FB-100' }], variations: [],
        },
      }],
    });

    const r = await refrescarPublicacionesMlAcotado(db, ML_CFG, ['MLA100']);
    expect(r.total).toBe(1);

    // La nueva se insertó
    const nueva = db.prepare('SELECT titulo, seller_sku FROM ml_publicaciones_cache WHERE clave = ?').get('MLA100|');
    expect(nueva).toMatchObject({ titulo: 'Bici nueva', seller_sku: 'FB-100' });

    // La vieja SIGUE presente (no se borró todo el cache)
    const vieja = db.prepare('SELECT titulo FROM ml_publicaciones_cache WHERE clave = ?').get('MLA999|');
    expect(vieja).toMatchObject({ titulo: 'Vieja' });
  });
});
