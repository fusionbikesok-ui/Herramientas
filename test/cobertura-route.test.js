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
});
