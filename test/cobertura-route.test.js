import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { coberturaRouter } from '../routes/cobertura.js';

const TEST_DB = './test/tmp-cobertura-route.sqlite';

function buildTestApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/cobertura', coberturaRouter(db));
  return app;
}

describe('GET /api/cobertura — no_vendible en solo_wc', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('marca no_vendible=1 para SERVICES/QR PAGOS y 0 para el resto, sin filtrar filas', async () => {
    const db = openDb(TEST_DB);
    const now = new Date().toISOString();
    const ins = db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, categorias_json, actualizado_en) VALUES (?,?,?,?,?,?,?)'
    );
    ins.run(1, 'Cubierta 26', 'FB-1', 'simple', 5, '["CUBIERTAS"]', now);
    ins.run(2, 'Armado de bici', 'FB-2', 'simple', 5, '["SERVICES"]', now);
    ins.run(3, 'Sin categoría', 'FB-3', 'simple', 5, null, now);

    const res = await request(buildTestApp(db)).get('/api/cobertura');
    expect(res.status).toBe(200);
    const filas = res.body.solo_wc;
    expect(filas).toHaveLength(3);
    expect(filas.find(f => f.sku === 'FB-1').no_vendible).toBe(0);
    expect(filas.find(f => f.sku === 'FB-2').no_vendible).toBe(1);
    expect(filas.find(f => f.sku === 'FB-3').no_vendible).toBe(0);
    // Aditivo: no se filtra ninguna fila y no se expone categorias_json crudo.
    expect(filas[0].categorias_json).toBeUndefined();
    db.close();
  });

  it('solo_wc excluye SKUs con decisión activa (accion != omitir) — igual que el NOT EXISTS previo', async () => {
    const db = openDb(TEST_DB);
    const now = new Date().toISOString();
    const insC = db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (?,?,?,?,?,?)'
    );
    insC.run(1, 'Con match activo', 'FB-A', 'simple', 5, now);      // decisión activa → NO en solo_wc
    insC.run(2, 'Sin match', 'FB-B', 'simple', 5, now);             // sin decisión → en solo_wc
    insC.run(3, 'Match omitido', 'FB-C', 'simple', 5, now);         // decisión omitir → en solo_wc
    insC.run(4, 'Variable padre', 'FB-D', 'variable', 5, now);      // tipo variable → NUNCA en solo_wc
    insC.run(5, 'Sin sku', null, 'simple', 5, now);                 // sku null → en solo_wc

    const insD = db.prepare(
      'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?,?,?,?,?)'
    );
    insD.run('k1', 'FB-A', 'Con match activo', 'publicar', now);
    insD.run('k3', 'FB-C', 'Match omitido', 'omitir', now);

    const res = await request(buildTestApp(db)).get('/api/cobertura');
    expect(res.status).toBe(200);
    const skus = res.body.solo_wc.map((f) => f.sku);
    // FB-A queda fuera (decisión activa); FB-D fuera (variable). El resto entra.
    expect(new Set(skus)).toEqual(new Set(['FB-B', 'FB-C', null]));
    expect(skus).toHaveLength(3);
    db.close();
  });

  it('un SKU con más de una decisión (una omitir y otra activa) igual queda excluido de solo_wc', async () => {
    const db = openDb(TEST_DB);
    const now = new Date().toISOString();
    const insC = db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en) VALUES (?,?,?,?,?,?)'
    );
    insC.run(1, 'Con doble decisión', 'FB-E', 'simple', 5, now);
    insC.run(2, 'Sku vacío (string)', '', 'simple', 5, now);

    const insD = db.prepare(
      'INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?,?,?,?,?)'
    );
    insD.run('kE1', 'FB-E', 'Con doble decisión', 'omitir', now);
    insD.run('kE2', 'FB-E', 'Con doble decisión', 'publicar', now);

    const res = await request(buildTestApp(db)).get('/api/cobertura');
    expect(res.status).toBe(200);
    const skus = res.body.solo_wc.map((f) => f.sku);
    expect(skus).not.toContain('FB-E'); // tiene una decisión activa → fuera, aunque otra sea omitir
    expect(skus).toContain(''); // sku vacío se trata igual que null → entra
    db.close();
  });
});
