import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { matcherRouter, computarCandidatosApi } from '../routes/matcher.js';
import { construirWC, construirMLdesdeApi, derivarEstadoApi } from '../lib/matcherResolver.js';

const TEST_DB = './test/tmp-matcher-cand.sqlite';
const ML_CFG = { clientId: 'c', clientSecret: 's', userId: '9' };

function now() { return new Date().toISOString(); }

function seedProducto(db, { id_woo, nombre, sku, tipo = 'simple' }) {
  db.prepare(
    `INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, img, atributos_json, actualizado_en)
     VALUES (?, ?, ?, ?, 1, '', NULL, ?)`
  ).run(id_woo, nombre, sku, tipo, now());
}

function seedCache(db, { clave, itemId, variationId = '', titulo, seller_sku = '', esVar = 0, color = '', talle = '', status = 'active' }) {
  db.prepare(
    `INSERT INTO ml_publicaciones_cache
       (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo, actualizado_en)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, '', '', 0, ?)`
  ).run(clave, itemId, variationId, titulo, status, esVar, color, talle, seller_sku, now());
}

function seedSyncLog(db, { clave, estado }) {
  db.prepare(
    `INSERT INTO sync_log (direccion, clave, estado, intentos, creado_en, actualizado_en)
     VALUES ('ml_wc', ?, ?, 0, ?, ?)`
  ).run(clave, estado, now(), now());
}

function seedDecision(db, { clave, sku, accion }) {
  db.prepare(
    `INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
     VALUES (?, ?, NULL, ?, ?)`
  ).run(clave, sku, accion, now());
}

describe('lib/matcherResolver · funciones puras', () => {
  it('construirMLdesdeApi separa verificar (seller_sku FB válido) de asignar', () => {
    const { wcItems } = construirWC([{ sku: 'FB-1', nombre: 'Casco Bell', tipo: 'simple' }]);
    const { sinSku, conSkuValido } = construirMLdesdeApi([
      { item_id: 'A', titulo: 'Casco Bell', seller_sku: 'FB-1' },   // existe en WC → verificar
      { item_id: 'B', titulo: 'Otra cosa', seller_sku: 'FB-999' },  // no existe → asignar
      { item_id: 'C', titulo: 'Sin sku', seller_sku: '' },          // sin sku → asignar
    ], wcItems);
    expect(conSkuValido.map((x) => x.ml_item_id)).toEqual(['A']);
    expect(sinSku.map((x) => x.ml_item_id).sort()).toEqual(['B', 'C']);
  });

  it('derivarEstadoApi marca modo verificar y calcula score_confianza', () => {
    const { wcItems, indice, wcPorSku } = construirWC([{ sku: 'FB-1', nombre: 'Casco Bell Negro', tipo: 'simple' }]);
    const items = [{ ml_item_id: 'A', ml_variation_id: '', ml_title: 'Casco Bell Negro', ml_es_variante: false, sku_actual: 'FB-1', _desde_api: true }];
    const cand = items.map(() => []);
    const out = derivarEstadoApi(items, cand, wcPorSku);
    expect(out[0].modo).toBe('verificar');
    expect(out[0].score_confianza).toBeGreaterThan(0.9);
    expect(out[0]._ct).toBeUndefined(); // se quita el campo interno
  });

  it('derivarEstadoApi sintetiza el candidato del sku_actual cuando no está entre los top-8', () => {
    // Un solo producto en WC (el actual) con un título totalmente distinto al de la
    // publicación → no entra en los candidatos calculados por score, pero igual debe
    // aparecer primero porque es el sku_actual (verificar).
    const { wcItems, indice, wcPorSku } = construirWC([
      { sku: 'FB-1', nombre: 'Zzz Producto Totalmente Distinto', tipo: 'simple' },
    ]);
    const items = [{
      ml_item_id: 'A', ml_variation_id: '', ml_title: 'Casco Bell Negro Rodado 29',
      ml_es_variante: false, ml_variations: '', sku_actual: 'FB-1', _desde_api: true,
    }];
    // candidatos calculados por score real (vacíos porque no comparte tokens con el título)
    const candArr = items.map(() => []);
    const out = derivarEstadoApi(items, candArr, wcPorSku);
    expect(out[0].modo).toBe('verificar');
    expect(out[0].candidatos).toHaveLength(1);
    expect(out[0].candidatos[0].wc_sku).toBe('FB-1');
    expect(out[0].wc_actual.nombre).toBe('Zzz Producto Totalmente Distinto');
  });
});

describe('computarCandidatosApi · cruce server-side', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('resuelve candidatos y modo por publicación contra el catálogo', () => {
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedProducto(db, { id_woo: 2, nombre: 'Cubierta Maxxis 29', sku: 'FB-2' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: 'FB-1' });
    seedCache(db, { clave: 'B|', itemId: 'B', titulo: 'Cubierta Maxxis 29', seller_sku: '' });

    const { items, total } = computarCandidatosApi(db, 'all');
    expect(total).toBe(2);
    const a = items.find((i) => i.ml_item_id === 'A');
    const b = items.find((i) => i.ml_item_id === 'B');
    expect(a.modo).toBe('verificar');
    expect(a.sku_actual).toBe('FB-1');
    expect(b.modo).toBe('asignar');
    // El primer candidato de B debe ser el producto que mejor matchea por título.
    expect(b.candidatos[0].wc_sku).toBe('FB-2');
  });

  it('scope=atencion solo procesa las claves que necesitan atención', () => {
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: '' });
    seedCache(db, { clave: 'B|', itemId: 'B', titulo: 'Otra', seller_sku: '' });
    seedSyncLog(db, { clave: 'A|', estado: 'sin_mapeo' }); // solo A necesita atención

    const { items, total } = computarCandidatosApi(db, 'atencion');
    expect(total).toBe(1);
    expect(items[0].ml_item_id).toBe('A');
  });

  it('scope=atencion sin pendientes devuelve vacío', () => {
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco', seller_sku: '' });
    expect(computarCandidatosApi(db, 'atencion')).toEqual({ items: [], total: 0 });
  });

  it('una publicación con decisión guardada (asignar/confirmar) sale del scope=atencion', () => {
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: '' });
    seedCache(db, { clave: 'B|', itemId: 'B', titulo: 'Otra', seller_sku: '' });
    seedSyncLog(db, { clave: 'A|', estado: 'sin_mapeo' });
    seedSyncLog(db, { clave: 'B|', estado: 'sin_mapeo' });

    // Con las dos sin decisión, ambas necesitan atención.
    expect(computarCandidatosApi(db, 'atencion').total).toBe(2);

    // Al guardar una decisión sobre A, sale de la lista de atención.
    seedDecision(db, { clave: 'A|', sku: 'FB-1', accion: 'asignar' });
    const { items, total } = computarCandidatosApi(db, 'atencion');
    expect(total).toBe(1);
    expect(items[0].ml_item_id).toBe('B');
  });
});

// Sigue el flujo async de /candidatos: un cache MISS ahora responde 202 (arranca el cruce en
// background con setImmediate) en vez de bloquear. Este helper espera a que el cómputo termine
// y devuelve la respuesta 200 final; marca en `recomputo` si hubo que recomputar (hubo un 202).
async function getCandidatos(app, qs = '') {
  let recomputo = false;
  for (let i = 0; i < 100; i++) {
    const r = await request(app).get('/api/matcher/candidatos' + qs);
    if (r.status === 202) {
      recomputo = true;
      await new Promise((res) => setImmediate(res)); // deja correr el cómputo en background
      continue;
    }
    r.recomputo = recomputo;
    return r;
  }
  throw new Error('el cómputo de candidatos no terminó a tiempo');
}

describe('GET /api/matcher/candidatos', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    app = express(); app.use(express.json());
    app.use('/api/matcher', matcherRouter(db, ML_CFG));
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('cache MISS responde 202 sin bloquear; tras el cómputo en background un GET devuelve 200 con los datos', async () => {
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: 'FB-1' });

    // Primer GET en frío: NO computa in-line (evita el timeout de nginx), responde 202 al toque.
    const r0 = await request(app).get('/api/matcher/candidatos');
    expect(r0.status).toBe(202);
    expect(r0.body.ok).toBe(true);
    expect(r0.body.computing).toBe(true);
    expect(r0.body.scope).toBe('all');
    expect(r0.body.data).toBeUndefined(); // el 202 no trae datos todavía

    // Se deja correr el cómputo en background y un GET posterior ya trae los datos (200).
    const r1 = await getCandidatos(app);
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.total).toBe(1);
    expect(r1.body.data[0].modo).toBe('verificar');
    expect(r1.body.cache).toBe(true); // servido del cache que llenó el background
  });

  it('un GET repetido sale del cache sin volver a disparar un cómputo (no hay 202)', async () => {
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: 'FB-1' });

    const r1 = await getCandidatos(app);
    expect(r1.recomputo).toBe(true); // primer cómputo (hubo 202)

    const r2 = await request(app).get('/api/matcher/candidatos'); // ya está cacheado
    expect(r2.status).toBe(200);
    expect(r2.body.cache).toBe(true);
  });

  it('el cache se invalida cuando cambia el cache de publicaciones (nuevo 202)', async () => {
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: 'FB-1' });
    expect((await getCandidatos(app)).recomputo).toBe(true); // llena cache

    seedCache(db, { clave: 'B|', itemId: 'B', titulo: 'Cubierta', seller_sku: '' });
    const r = await getCandidatos(app);
    expect(r.recomputo).toBe(true); // firma cambió → volvió a computar (hubo 202)
    expect(r.body.total).toBe(2);
  });

  it('un cambio de stock en el catálogo NO invalida el cache; uno de sku/nombre SÍ', async () => {
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: 'FB-1' });
    await getCandidatos(app); // llena cache
    expect((await getCandidatos(app)).recomputo).toBe(false); // sale del cache

    // Auto-sync de stock: cambia stock + actualizado_en, pero NO campos del matching.
    db.prepare('UPDATE catalogo_cache SET stock = 99, actualizado_en = ? WHERE id_woo = 1').run(now());
    expect((await getCandidatos(app)).recomputo).toBe(false);

    // Cambio real de campo relevante al matching (nombre) → sí invalida (nuevo cómputo).
    db.prepare('UPDATE catalogo_cache SET nombre = ? WHERE id_woo = 1').run('Casco Bell Rojo');
    expect((await getCandidatos(app)).recomputo).toBe(true);
  });

  it('ml_sin_stock refleja el stock ACTUAL aun con cache hit (stock no invalida la firma)', async () => {
    // Publicación activa con SKU válido y stock 1 → con stock (visible en el filtro).
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: 'FB-1' });

    await getCandidatos(app); // llena cache
    const r1 = await getCandidatos(app);
    expect(r1.recomputo).toBe(false);
    expect(r1.body.data[0].ml_sin_stock).toBe(false);
    expect(r1.body.data[0].ml_stock_wc).toBe(1);

    // Auto-sync de Woo baja el stock a 0: cambia stock + actualizado_en, pero NO sku/nombre/
    // atributos ni el cache de publicaciones → la firma NO cambia (sigue siendo cache hit).
    db.prepare('UPDATE catalogo_cache SET stock = 0, actualizado_en = ? WHERE id_woo = 1').run(now());

    const r2 = await getCandidatos(app);
    expect(r2.recomputo).toBe(false); // sale del cache (el cruce caro no se recomputa)
    // ...pero el stock SÍ se recalculó fuera del bloque cacheado: ahora está sin stock.
    expect(r2.body.data[0].ml_stock_wc).toBe(0);
    expect(r2.body.data[0].ml_sin_stock).toBe(true);
  });

  it('ml_status/ml_sin_stock reflejan el status VIVO de ml_publicaciones_cache aun con cache hit (M2, ronda 2 revisor: el write-back de reconciliarStockMl no invalida la firma)', async () => {
    // Publicación pausada al momento del primer cómputo: entra al bucket cacheado con
    // ml_status='paused'.
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: 'FB-1', status: 'paused' });

    await getCandidatos(app); // llena cache
    const r1 = await getCandidatos(app);
    expect(r1.recomputo).toBe(false);
    expect(r1.body.data[0].ml_status).toBe('paused');
    expect(r1.body.data[0].ml_sin_stock).toBe(true); // no activa → sin stock

    // reconciliarStockMl reescribe status en ml_publicaciones_cache SIN tocar actualizado_en
    // (deliberado, ver firmaCandidatos) — la firma no cambia, sigue siendo cache hit.
    db.prepare("UPDATE ml_publicaciones_cache SET status = 'active' WHERE clave = 'A|'").run();

    const r2 = await getCandidatos(app);
    expect(r2.recomputo).toBe(false); // sale del cache (el cruce caro no se recomputa)
    // ...pero el status SÍ se releyó fuera del bloque cacheado: ya no queda 'paused' stale.
    expect(r2.body.data[0].ml_status).toBe('active');
    expect(r2.body.data[0].ml_sin_stock).toBe(false);
  });

  it('?peek=1: cache frío no computa ni dispara background (cache:false, data:[]); cache tibio devuelve normal', async () => {
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: 'FB-1' });

    // Cache frío: peek NO computa (ni siquiera en background), responde vacío al toque (200).
    const cold = await request(app).get('/api/matcher/candidatos?peek=1');
    expect(cold.status).toBe(200);
    expect(cold.body.cache).toBe(false);
    expect(cold.body.data).toEqual([]);
    expect(cold.body.total).toBe(0);

    // Un peek no debe haber dejado nada cacheado ni en curso: sigue frío.
    expect((await request(app).get('/api/matcher/candidatos?peek=1')).body.cache).toBe(false);

    // Cómputo real (sin peek) llena el cache vía el flujo async.
    await getCandidatos(app);

    // Cache tibio: peek devuelve el resultado normal.
    const warm = await request(app).get('/api/matcher/candidatos?peek=1');
    expect(warm.status).toBe(200);
    expect(warm.body.cache).toBe(true);
    expect(warm.body.total).toBe(1);
    expect(warm.body.data[0].modo).toBe('verificar');
  });

  it('?scope=atencion filtra por HTTP igual que computarCandidatosApi, con cache propio por scope', async () => {
    seedProducto(db, { id_woo: 1, nombre: 'Casco Bell Negro', sku: 'FB-1' });
    seedCache(db, { clave: 'A|', itemId: 'A', titulo: 'Casco Bell Negro', seller_sku: '' });
    seedCache(db, { clave: 'B|', itemId: 'B', titulo: 'Otra publicación', seller_sku: '' });
    seedSyncLog(db, { clave: 'A|', estado: 'sin_mapeo' }); // solo A necesita atención

    const atencion = await getCandidatos(app, '?scope=atencion');
    expect(atencion.status).toBe(200);
    expect(atencion.body.scope).toBe('atencion');
    expect(atencion.body.total).toBe(1);
    expect(atencion.body.data[0].ml_item_id).toBe('A');
    expect(atencion.recomputo).toBe(true); // primer cómputo de este scope

    // scope=all sigue trayendo ambas y no comparte cache con 'atencion'.
    const todas = await getCandidatos(app);
    expect(todas.body.scope).toBe('all');
    expect(todas.body.total).toBe(2);
    expect(todas.recomputo).toBe(true); // scope distinto, cache propio

    // Repetir 'atencion' ahora sí sale del cache de ese scope.
    const atencion2 = await getCandidatos(app, '?scope=atencion');
    expect(atencion2.recomputo).toBe(false);
  });
});
