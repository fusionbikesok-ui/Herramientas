/**
 * test/cobertura-legacy-410.test.js
 *
 * Verifica que Cobertura legacy responde 410 (Gone) con los campos requeridos
 * (ok: false, error, migracion) para cualquier mutación.
 *
 * También verifica que las rutas POST /api/matcher/push-sku y
 * POST /api/matcher/push-skus-pendientes responden 410.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { coberturaRouter } from '../routes/cobertura.js';
import { matcherRouter } from '../routes/matcher.js';

const TEST_DB = './test/tmp-cobertura-legacy-410.sqlite';
const CFG = { ml: { clientId: 'cid', clientSecret: 'cs', userId: '99999' } };

vi.mock('../lib/mlClient.js', () => ({
  mlFetch: vi.fn().mockResolvedValue({ status: 200, data: {} }),
  estadoCooldownMl: vi.fn(() => ({ activo: false, hasta: null })),
}));
vi.mock('../lib/mlRateLimiter.js', () => ({
  reservarCupo: vi.fn().mockResolvedValue(true),
}));

function buildCoberturaApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/cobertura', coberturaRouter(db, CFG));
  return app;
}

function buildMatcherApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/matcher', matcherRouter(db, CFG));
  return app;
}

describe('Cobertura legacy — todas las mutaciones responden 410 con migracion', () => {
  let db, appCobertura, appMatcher;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = openDb(TEST_DB);
    appCobertura = buildCoberturaApp(db);
    appMatcher = buildMatcherApp(db);

    // Seed datos mínimos para que las rutas no fallen por datos ausentes
    db.prepare(`
      INSERT INTO catalogo_cache (id_woo, sku, nombre, stock, actualizado_en)
      VALUES (1, 'FB-1', 'Test Producto', 10, ?)
    `).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO ml_publicaciones_cache (clave, item_id, seller_sku, status, available_quantity, actualizado_en)
      VALUES ('MLA123|', 'MLA123', 'FB-1', 'active', 5, ?)
    `).run(new Date().toISOString());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Exclusiones
  // ────────────────────────────────────────────────────────────────────────────────

  it('POST /exclusiones responde 410 con error y migracion', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/exclusiones')
      .send({ id_woo: 1, sku: 'FB-1', nombre: 'Test' });
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
  });

  it('DELETE /exclusiones/:id_woo responde 410', async () => {
    const res = await request(appCobertura)
      .delete('/api/cobertura/exclusiones/1');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('DELETE /exclusiones/:id_woo/revertir responde 410', async () => {
    const res = await request(appCobertura)
      .delete('/api/cobertura/exclusiones/1/revertir');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Productos (confirmar, descartar, publicar, saltear)
  // ────────────────────────────────────────────────────────────────────────────────

  it('POST /productos/:id_woo/confirmar responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/productos/1/confirmar')
      .send({ ml_clave: 'MLA123|' });
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /productos/:id_woo/descartar responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/productos/1/descartar');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /productos/:id_woo/publicar responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/productos/1/publicar');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /productos/:id_woo/saltear responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/productos/1/saltear');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Solo ML
  // ────────────────────────────────────────────────────────────────────────────────

  it('POST /solo-ml/:clave/vincular responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/solo-ml/MLA123|/vincular')
      .send({ id_woo: 1 });
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /solo-ml/:clave/marcar-correcta responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/solo-ml/MLA123|/marcar-correcta');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /solo-ml/:clave/pausar responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/solo-ml/MLA123|/pausar');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Multi-publicación
  // ────────────────────────────────────────────────────────────────────────────────

  it('POST /multi-publicacion/:clave/marcar-correcta responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/multi-publicacion/MLA123|/marcar-correcta');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /multi-publicacion/:clave/pausar responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/multi-publicacion/MLA123|/pausar');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /multi-publicacion/:clave/desvincular responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/multi-publicacion/MLA123|/desvincular');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Vínculos (deshacer, revisado, reasignar, desvincular)
  // ────────────────────────────────────────────────────────────────────────────────

  it('POST /vinculos/:clave/deshacer responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/vinculos/MLA123|/deshacer');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /vinculos/revisado responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/vinculos/revisado')
      .send({ clave: 'MLA123|', senal: 'test', valor: 'value' });
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /vinculos/reasignar responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/vinculos/reasignar')
      .send({ clave: 'MLA123|', sku: 'FB-2', expected_sku: null });
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /vinculos/:clave/desvincular responde 410', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/vinculos/MLA123|/desvincular');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Hay que publicar
  // ────────────────────────────────────────────────────────────────────────────────

  it('PATCH /hay-que-publicar/:id_woo responde 410', async () => {
    const res = await request(appCobertura)
      .patch('/api/cobertura/hay-que-publicar/1')
      .send({ tachado: true });
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('DELETE /hay-que-publicar/:id_woo responde 410', async () => {
    const res = await request(appCobertura)
      .delete('/api/cobertura/hay-que-publicar/1');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────────────────────────────
  it('POST /actualizar-ml conserva el alias seguro de refresco para Guardia', async () => {
    const res = await request(appCobertura)
      .post('/api/cobertura/actualizar-ml');
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.running).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Matcher legacy push routes
  // ────────────────────────────────────────────────────────────────────────────────

  it('POST /api/matcher/push-sku responde 410', async () => {
    const res = await request(appMatcher)
      .post('/api/matcher/push-sku')
      .send({ clave: 'MLA123|', sku: 'FB-1' });
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });

  it('POST /api/matcher/push-skus-pendientes responde 410', async () => {
    const res = await request(appMatcher)
      .post('/api/matcher/push-skus-pendientes');
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBeTruthy();
    expect(res.body.migracion).toBeTruthy();
  });
});
