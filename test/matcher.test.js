import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { clavesNecesitanAtencion } from '../lib/mlMapeo.js';
import { matcherRouter, refrescarPublicacionesMlAcotado, computarCandidatosApi, remarcarStockResueltos } from '../routes/matcher.js';
import { _resetEstadoPushParaTests } from '../lib/matcherPush.js';

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

function seedCache(db, { clave, itemId, variationId = '', titulo = 'Pub', status = 'active', sellerSku = '' }) {
  db.prepare(
    `INSERT INTO ml_publicaciones_cache
       (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, actualizado_en)
     VALUES (?, ?, ?, ?, ?, '', 0, '', '', ?, '', ?)`
  ).run(clave, itemId, variationId, titulo, status, sellerSku, now());
}

let _idWooSeq = 0;
function seedCatalogo(db, { sku, stock }) {
  db.prepare(
    `INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en)
     VALUES (?, ?, ?, 'simple', ?, ?)`
  ).run(++_idWooSeq, 'Prod ' + sku, sku, stock, now());
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

  it('respeta ?limit/?offset (tope defensivo) sin romper a los consumidores que no los mandan', async () => {
    for (let i = 1; i <= 5; i++) seedCache(db, { clave: `MLA${i}|`, itemId: `MLA${i}` });

    const sinLimite = await request(app).get('/api/matcher/publicaciones');
    expect(sinLimite.body.total).toBe(5); // default: sigue trayendo todo el dataset

    const conLimite = await request(app).get('/api/matcher/publicaciones?limit=2');
    expect(conLimite.body.data).toHaveLength(2);

    const conOffset = await request(app).get('/api/matcher/publicaciones?limit=2&offset=4');
    expect(conOffset.body.data).toHaveLength(1);
  });
});

describe('computarCandidatosApi — cruce de stock (ml_stock_wc / ml_sin_stock)', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  // El cruce de stock ya no vive en computarCandidatosApi (queda cacheado por firma y la
  // firma ignora el stock a propósito): se recalcula en cada request vía remarcarStockResueltos,
  // fuera del bloque cacheado. Estos tests unitarios ejercitan ese marcado sobre los resueltos.
  function byItem(res) {
    remarcarStockResueltos(db, res.items);
    return Object.fromEntries(res.items.map(i => [i.ml_item_id, i]));
  }

  it('marca ml_sin_stock según estado y stock de Woo; SKU desconocido queda visible', () => {
    // activa con stock > 0 → visible (sin stock false)
    seedCache(db, { clave: 'A|', itemId: 'A', status: 'active', sellerSku: 'FB-1' });
    seedCatalogo(db, { sku: 'FB-1', stock: 5 });
    // activa con stock 0 → sin stock true
    seedCache(db, { clave: 'B|', itemId: 'B', status: 'active', sellerSku: 'FB-2' });
    seedCatalogo(db, { sku: 'FB-2', stock: 0 });
    // pausada aunque tenga stock → sin stock true
    seedCache(db, { clave: 'C|', itemId: 'C', status: 'paused', sellerSku: 'FB-3' });
    seedCatalogo(db, { sku: 'FB-3', stock: 9 });
    // activa con SKU desconocido (no está en catalogo_cache) → stockWc null, visible
    seedCache(db, { clave: 'D|', itemId: 'D', status: 'active', sellerSku: 'FB-404' });
    // activa sin seller_sku → stockWc null, visible
    seedCache(db, { clave: 'E|', itemId: 'E', status: 'active', sellerSku: '' });

    const items = byItem(computarCandidatosApi(db, 'all'));
    expect(items.A.ml_stock_wc).toBe(5);
    expect(items.A.ml_sin_stock).toBe(false);
    expect(items.B.ml_stock_wc).toBe(0);
    expect(items.B.ml_sin_stock).toBe(true);
    expect(items.C.ml_stock_wc).toBe(9);
    expect(items.C.ml_sin_stock).toBe(true);
    expect(items.D.ml_stock_wc).toBe(null);
    expect(items.D.ml_sin_stock).toBe(false);
    expect(items.E.ml_stock_wc).toBe(null);
    expect(items.E.ml_sin_stock).toBe(false);
  });

  it('stock negativo → sin stock; status no active (closed) → sin stock; seller_sku con espacios matchea (trim)', () => {
    seedCache(db, { clave: 'N|', itemId: 'N', status: 'active', sellerSku: 'FB-11' });
    seedCatalogo(db, { sku: 'FB-11', stock: -3 });
    seedCache(db, { clave: 'X|', itemId: 'X', status: 'closed', sellerSku: 'FB-12' });
    seedCatalogo(db, { sku: 'FB-12', stock: 20 });
    seedCache(db, { clave: 'S|', itemId: 'S', status: 'active', sellerSku: '  FB-13  ' });
    seedCatalogo(db, { sku: 'FB-13', stock: 7 });

    const items = byItem(computarCandidatosApi(db, 'all'));
    expect(items.N.ml_stock_wc).toBe(-3);
    expect(items.N.ml_sin_stock).toBe(true);
    expect(items.X.ml_sin_stock).toBe(true);
    expect(items.S.ml_stock_wc).toBe(7);
    expect(items.S.ml_sin_stock).toBe(false);
  });

  it('SKU duplicado en catalogo_cache: se queda con el máximo stock (no oculta si alguna fila tiene stock)', () => {
    seedCache(db, { clave: 'DUP|', itemId: 'DUP', status: 'active', sellerSku: 'FB-14' });
    seedCatalogo(db, { sku: 'FB-14', stock: 0 });
    seedCatalogo(db, { sku: 'FB-14', stock: 5 });

    const items = byItem(computarCandidatosApi(db, 'all'));
    expect(items.DUP.ml_stock_wc).toBe(5);
    expect(items.DUP.ml_sin_stock).toBe(false);
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

describe('GET /matcher/push-skus-pendientes/list', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    app = express();
    app.use(express.json());
    app.use('/matcher', matcherRouter(db, ML_CFG));
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('devuelve las decisiones pendientes de escribir en ML con datos para mostrar una fila', async () => {
    seedCache(db, { clave: 'MLA1|', itemId: 'MLA1', titulo: 'Bici Roja', status: 'active', sellerSku: '' });
    seedDecision(db, { clave: 'MLA1|', sku: 'FB-100', accion: 'asignar' });

    const res = await request(app).get('/matcher/push-skus-pendientes/list');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ clave: 'MLA1|', sku: 'FB-100', titulo: 'Bici Roja', item_id: 'MLA1' });
  });

  it('no incluye decisiones ya escritas en ML (seller_sku ya coincide)', async () => {
    seedCache(db, { clave: 'MLA2|', itemId: 'MLA2', titulo: 'Bici Azul', status: 'active', sellerSku: 'FB-200' });
    seedDecision(db, { clave: 'MLA2|', sku: 'FB-200', accion: 'asignar' });

    const res = await request(app).get('/matcher/push-skus-pendientes/list');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('SÍ incluye decisiones de publicaciones pausadas (con status y sin fallo previo)', async () => {
    seedCache(db, { clave: 'MLA3|', itemId: 'MLA3', titulo: 'Bici Verde', status: 'paused', sellerSku: '' });
    seedDecision(db, { clave: 'MLA3|', sku: 'FB-300', accion: 'confirmar' });

    const res = await request(app).get('/matcher/push-skus-pendientes/list');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ clave: 'MLA3|', status: 'paused', intentos: null });
  });

  it('excluye decisiones con accion "descartar" y SKUs que no empiezan con FB- (no son de FusionBikes)', async () => {
    seedCache(db, { clave: 'MLA4|', itemId: 'MLA4', titulo: 'Descartada', status: 'active', sellerSku: '' });
    seedDecision(db, { clave: 'MLA4|', sku: 'FB-400', accion: 'descartar' });

    seedCache(db, { clave: 'MLA5|', itemId: 'MLA5', titulo: 'SKU externo', status: 'active', sellerSku: '' });
    seedDecision(db, { clave: 'MLA5|', sku: 'OTRO-500', accion: 'asignar' });

    const res = await request(app).get('/matcher/push-skus-pendientes/list');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('POST /matcher/push-skus-pendientes y estado (background)', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    seedToken(db);
    _resetEstadoPushParaTests();
    app = express();
    app.use(express.json());
    app.use('/matcher', matcherRouter(db, ML_CFG));
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('devuelve 202 y arranca en background; 409 si ya hay una corrida en curso', async () => {
    seedCache(db, { clave: 'MLA1|', itemId: 'MLA1', status: 'active', sellerSku: '' });
    seedDecision(db, { clave: 'MLA1|', sku: 'FB-100', accion: 'asignar' });
    axios.request.mockImplementation(() => new Promise(() => {})); // nunca resuelve

    const r1 = await request(app).post('/matcher/push-skus-pendientes');
    expect(r1.status).toBe(202);
    expect(r1.body).toMatchObject({ ok: true, running: true });

    const r2 = await request(app).post('/matcher/push-skus-pendientes');
    expect(r2.status).toBe(409);
  });

  it('GET /estado refleja el estado sondeable', async () => {
    const r = await request(app).get('/matcher/push-skus-pendientes/estado');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, running: false });
  });
});

describe('GET /matcher/push-skus-pendientes/count', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    app = express();
    app.use(express.json());
    app.use('/matcher', matcherRouter(db, ML_CFG));
  });
  afterEach(() => { db.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it('incluye pausadas y las separa de activas', async () => {
    seedCache(db, { clave: 'A1|', itemId: 'A1', status: 'active', sellerSku: '' });
    seedDecision(db, { clave: 'A1|', sku: 'FB-1', accion: 'asignar' });
    seedCache(db, { clave: 'P1|', itemId: 'P1', status: 'paused', sellerSku: '' });
    seedDecision(db, { clave: 'P1|', sku: 'FB-2', accion: 'asignar' });

    const r = await request(app).get('/matcher/push-skus-pendientes/count');
    expect(r.body).toMatchObject({ ok: true, pendientes: 2, activas: 1, pausadas: 1, en_espera: 0 });
  });
});
