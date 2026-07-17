import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { mapeoRouter } from '../routes/mapeo.js';

const TEST_DB = './test/tmp-mapeo-route.sqlite';

function buildTestApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/mapeo', mapeoRouter(db));
  return app;
}

describe('mapeoRouter', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('POST /guardar adapts {nombreDoc, variacion, idFusion} into the mapeo_fusion table', async () => {
    const db = openDb(TEST_DB);
    const app = buildTestApp(db);
    const res = await request(app)
      .post('/api/mapeo/guardar')
      .send({ relaciones: [{ nombreDoc: 'Casco Bell', variacion: 'Talle L', idFusion: 55 }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const getRes = await request(app).get('/api/mapeo/conocido');
    const mapa = getRes.body.data;
    const claves = Object.keys(mapa);
    expect(claves.length).toBe(1);
    expect(mapa[claves[0]]).toEqual({ idWoo: 55, variacion: 'Talle L' });
    db.close();
  });

  it('POST /pendientes adapts {skuProvisional, nombreDoc, variacion} into pendientes_mapeo', async () => {
    const db = openDb(TEST_DB);
    const app = buildTestApp(db);
    const res = await request(app)
      .post('/api/mapeo/pendientes')
      .send({ registros: [{ skuProvisional: 'FB-001', nombreDoc: 'Guante Venzo', variacion: 'M' }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = db.prepare('SELECT * FROM pendientes_mapeo').get();
    expect(row.nombre_original).toBe('Guante Venzo');
    expect(row.resuelto).toBe(0);
    db.close();
  });
});
