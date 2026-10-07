import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { guardiaMlRouter } from '../routes/guardiaMl.js';

const FILE = './test/tmp-fase-c-guardia-retirada.sqlite';

describe('Fase C paso 6: Guardia retirada en activo', () => {
  let db; const env = process.env.IDENTIDAD_PROTECCION;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    db.close();
    if (env === undefined) delete process.env.IDENTIDAD_PROTECCION; else process.env.IDENTIDAD_PROTECCION = env;
    for (const f of [FILE, `${FILE}-wal`, `${FILE}-shm`]) fs.rmSync(f, { force: true });
  });
  const app = () => {
    const a = express(); a.use(express.json());
    a.use((req, _res, next) => { req.user = { username: 'admin', is_admin: true, permisos: [] }; next(); });
    a.use('/api/guardia-ml', guardiaMlRouter(db, {}));
    return a;
  };

  it('en activo: /estado avisa retirada y las escrituras responden 409 (lectura sigue)', async () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    const e = await request(app()).get('/api/guardia-ml/estado');
    expect(e.body.data.retirada).toBe(true);
    expect((await request(app()).get('/api/guardia-ml/pedidos-retenidos')).status).toBe(200);
    const w = await request(app()).post('/api/guardia-ml/escanear').send({});
    expect(w.status).toBe(409);
    expect(w.body.error).toMatch(/Identidad/);
  });

  it('en sombra: nada cambia', async () => {
    process.env.IDENTIDAD_PROTECCION = 'sombra';
    const e = await request(app()).get('/api/guardia-ml/estado');
    expect(e.body.data.retirada).toBe(false);
    expect((await request(app()).post('/api/guardia-ml/escanear').send({})).status).toBe(200);
  });
});
