import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';

// Cobertura adicional de la entrega 1 del Matcher unificado (tester): garantías #2, #3 y #4
// del despacho — admin-only en el backend (no solo escondido en pantalla), autoría en
// deshacer, y concurrencia optimista en reasignar. No duplica lo que ya cubren
// test/cobertura-hallazgos-revisor.test.js, test/cobertura-cola.test.js y
// test/vinculos-route.test.js — completa los huecos señalados en el despacho.

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn(),
  estadoCooldownMl: vi.fn(() => ({ activo: false, hasta: null })),
}));

import { mlFetch } from '../lib/mlClient.js';
import { coberturaRouter } from '../routes/cobertura.js';

const TEST_DB = './test/tmp-matcher-e1-cobertura-tester.sqlite';
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' } };

function appComo(db, user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/api/cobertura', coberturaRouter(db, CFG));
  return app;
}

function seedProducto(db, { id_woo, sku, nombre, marca = 'Metha', stock = 5, precio = 1000 }) {
  db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, marca, precio, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id_woo, nombre, sku, 'simple', stock, marca, precio, new Date().toISOString());
}

function seedMlSinSku(db, { clave, item_id, titulo, sellerSku = null }) {
  db.prepare(`
    INSERT INTO ml_publicaciones_cache (clave, item_id, titulo, status, seller_sku, actualizado_en)
    VALUES (?,?,?, 'active', ?, ?)
  `).run(clave, item_id, titulo, sellerSku, new Date().toISOString());
}

describe('Matcher unificado, entrega 1 — pausar/desvincular admin-only en el backend', () => {
  let db;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = openDb(TEST_DB);
    mlFetch.mockReset();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('POST /solo-ml/:clave/pausar sin ser admin responde 403 y no llama a ML', async () => {
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'Pub sin SKU' });
    const app = appComo(db, { id: 2, username: 'joaco', is_admin: 0 });

    const res = await request(app).post('/api/cobertura/solo-ml/MLA1|/pausar').send({});
    expect(res.status).toBe(403);
    expect(mlFetch).not.toHaveBeenCalled();
    // El status local no se tocó.
    expect(db.prepare("SELECT status FROM ml_publicaciones_cache WHERE clave='MLA1|'").get().status).toBe('active');
  });

  it('POST /solo-ml/:clave/pausar CON admin sí procede (control: la guarda es real, no siempre 403)', async () => {
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'Pub sin SKU' });
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    const app = appComo(db, { id: 1, username: 'admin', is_admin: 1 });

    const res = await request(app).post('/api/cobertura/solo-ml/MLA1|/pausar').send({});
    expect(res.status).toBe(200);
  });

  it('POST /multi-publicacion/:clave/desvincular sin ser admin responde 403 y no borra la decisión', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en)
      VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)`).run(new Date().toISOString());
    const app = appComo(db, { id: 2, username: 'joaco', is_admin: 0 });

    const res = await request(app).post('/api/cobertura/multi-publicacion/MLA1|/desvincular');
    expect(res.status).toBe(403);
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave='MLA1|'").get().n).toBe(1);
  });

  it('POST /multi-publicacion/:clave/desvincular CON admin sí procede (control)', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en)
      VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)`).run(new Date().toISOString());
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    const app = appComo(db, { id: 1, username: 'admin', is_admin: 1 });

    const res = await request(app).post('/api/cobertura/multi-publicacion/MLA1|/desvincular');
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave='MLA1|'").get().n).toBe(0);
  });
});

describe('Matcher unificado, entrega 1 — deshacer exige ser el autor', () => {
  let db;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = openDb(TEST_DB);
    mlFetch.mockReset();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('un no-admin sobre un vínculo AJENO recibe 403 diciendo quién lo confirmó, y no lo toca', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, confirmado_por, actualizado_en)
      VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', 'ana', ?)`).run(new Date().toISOString());
    const app = appComo(db, { id: 2, username: 'joaco', is_admin: 0 });

    const res = await request(app).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('ana');
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave='MLA1|'").get().n).toBe(1);
  });

  it('el AUTOR (no-admin) sí puede deshacer su propio vínculo', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, confirmado_por, actualizado_en)
      VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', 'joaco', ?)`).run(new Date().toISOString());
    const app = appComo(db, { id: 2, username: 'joaco', is_admin: 0 });

    const res = await request(app).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave='MLA1|'").get().n).toBe(0);
  });

  it('un vínculo SIN confirmado_por (anterior a la migración 013) solo lo deshace un admin: un no-admin recibe 403', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    // confirmado_por NULL a propósito: simula una decisión de antes de la migración 013.
    db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, actualizado_en)
      VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', ?)`).run(new Date().toISOString());
    const app = appComo(db, { id: 2, username: 'joaco', is_admin: 0 });

    const res = await request(app).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('administrador');
    expect(db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave='MLA1|'").get().n).toBe(1);
  });

  it('un admin SÍ puede deshacer un vínculo ajeno (control: la guarda no bloquea de más)', async () => {
    seedProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'X' });
    seedMlSinSku(db, { clave: 'MLA1|', item_id: 'MLA1', titulo: 'X' });
    db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, origen, confirmado_por, actualizado_en)
      VALUES ('MLA1|', 'FB-1', 'X', 'confirmar', 'cobertura', 'ana', ?)`).run(new Date().toISOString());
    const app = appComo(db, { id: 1, username: 'admin', is_admin: 1 });

    const res = await request(app).post('/api/cobertura/vinculos/MLA1|/deshacer');
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave='MLA1|'").get().n).toBe(0);
  });
});

describe('Matcher unificado, entrega 1 — reasignar: concurrencia optimista y origen/accion correctos', () => {
  let db;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = openDb(TEST_DB);
    mlFetch.mockReset();
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  function sembrarVinculo(db, { clave = 'MLA1|10', itemId = 'MLA1', sku = 'FB-1' } = {}) {
    seedProducto(db, { id_woo: 1, sku, nombre: 'Producto ' + sku });
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave, item_id, variation_id, titulo, status, es_variante, seller_sku, actualizado_en)
      VALUES (?, ?, '10', 'Pub', 'active', 1, ?, ?)`).run(clave, itemId, sku, new Date().toISOString());
  }

  it('reasignar escribe origen="cobertura" y accion="confirmar" — sin eso el vínculo no se puede deshacer, no cuenta en el progreso y no aparece en el historial', async () => {
    sembrarVinculo(db, { clave: 'MLA1|10', sku: 'FB-1' });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Otro' });
    const app = appComo(db, { id: 1, username: 'ana', is_admin: 0 });

    const res = await request(app).post('/api/cobertura/vinculos/reasignar').send({ clave: 'MLA1|10', sku: 'FB-2', expected_sku: null });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT sku, origen, accion, confirmado_por FROM sku_matcher_decisiones WHERE clave='MLA1|10'").get();
    expect(row.sku).toBe('FB-2');
    expect(row.origen).toBe('cobertura');
    expect(row.accion).toBe('confirmar');
    expect(row.confirmado_por).toBe('ana');

    // Consecuencia directa: ahora SÍ se puede deshacer (deshacer filtra accion='confirmar' AND
    // origen='cobertura'). Si la mutación de origen/accion se rompiera, este deshacer daría 404.
    const resDeshacer = await request(app).post('/api/cobertura/vinculos/MLA1|10/deshacer');
    expect(resDeshacer.status).toBe(200);
  });

  it('reasignar: si otra persona ya vinculó esa clave a OTRO sku, revalida antes de escribir y responde 409 con quién y qué (no pisa en silencio)', async () => {
    sembrarVinculo(db, { clave: 'MLA1|10', sku: 'FB-1' });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Otro' });
    seedProducto(db, { id_woo: 3, sku: 'FB-3', nombre: 'Tercero' });

    const appAna = appComo(db, { id: 1, username: 'ana', is_admin: 0 });
    const appJoaco = appComo(db, { id: 2, username: 'joaco', is_admin: 0 });

    // Ana reasigna primero, a FB-2.
    const resAna = await request(appAna).post('/api/cobertura/vinculos/reasignar').send({ clave: 'MLA1|10', sku: 'FB-2', expected_sku: null });
    expect(resAna.status).toBe(200);

    // Joaco, sin saberlo, intenta reasignar la MISMA clave a otro SKU distinto (FB-3).
    const resJoaco = await request(appJoaco).post('/api/cobertura/vinculos/reasignar').send({ clave: 'MLA1|10', sku: 'FB-3', expected_sku: null });
    expect(resJoaco.status).toBe(409);
    expect(resJoaco.body.ya_resuelto).toBe(true);
    expect(resJoaco.body.resuelto_por).toBe('ana');
    expect(resJoaco.body.sku).toBe('FB-2');
    // No pisó la decisión de Ana.
    expect(db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave='MLA1|10'").get().sku).toBe('FB-2');
  });

  it('reasignar: si la reasignación previa fue de la MISMA persona, el 409 vuelve con propio:true (distinto mensaje, misma revalidación — no se pisa a ciegas ni siquiera a uno mismo)', async () => {
    sembrarVinculo(db, { clave: 'MLA1|10', sku: 'FB-1' });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Otro' });
    seedProducto(db, { id_woo: 3, sku: 'FB-3', nombre: 'Tercero' });
    const app = appComo(db, { id: 1, username: 'ana', is_admin: 0 });

    const res1 = await request(app).post('/api/cobertura/vinculos/reasignar').send({ clave: 'MLA1|10', sku: 'FB-2', expected_sku: null });
    expect(res1.status).toBe(200);
    // Ana, en otra pestaña, intenta reasignar de nuevo la misma clave: mismo autor, pero la
    // revalidación sigue aplicando — 409 con propio:true (distingue "fuiste vos" de "fue
    // otro", igual que confirmarDecisionCobertura), no un pisado silencioso.
    const res2 = await request(app).post('/api/cobertura/vinculos/reasignar').send({ clave: 'MLA1|10', sku: 'FB-3', expected_sku: null });
    expect(res2.status).toBe(409);
    expect(res2.body.propio).toBe(true);
    expect(res2.body.resuelto_por).toBe('ana');
    // No se pisó: sigue en FB-2.
    expect(db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave='MLA1|10'").get().sku).toBe('FB-2');
  });

  it('reasignar permite cambiar deliberadamente una decisión moderna si expected_sku coincide', async () => {
    sembrarVinculo(db, { clave: 'MLA1|10', sku: 'FB-1' });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Otro' });
    db.prepare(`INSERT INTO sku_matcher_decisiones
      (clave, sku, wc_nombre, accion, origen, confirmado_por, actualizado_en)
      VALUES ('MLA1|10','FB-1','Original','confirmar','cobertura','ana',?)`).run(new Date().toISOString());
    const app = appComo(db, { id: 1, username: 'ana', is_admin: 0 });

    const res = await request(app).post('/api/cobertura/vinculos/reasignar')
      .send({ clave: 'MLA1|10', sku: 'FB-2', expected_sku: 'FB-1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, clave: 'MLA1|10', sku_anterior: 'FB-1', sku: 'FB-2' });
    expect(db.prepare("SELECT sku, confirmado_por FROM sku_matcher_decisiones WHERE clave='MLA1|10'").get())
      .toEqual({ sku: 'FB-2', confirmado_por: 'ana' });
  });

  it('reasignar exige expected_sku para no convertir una lectura vieja en un pisado ciego', async () => {
    sembrarVinculo(db, { clave: 'MLA1|10', sku: 'FB-1' });
    seedProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Otro' });
    const app = appComo(db, { id: 1, username: 'ana', is_admin: 0 });

    const res = await request(app).post('/api/cobertura/vinculos/reasignar')
      .send({ clave: 'MLA1|10', sku: 'FB-2' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('expected_sku');
  });
});
