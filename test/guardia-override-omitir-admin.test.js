import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { guardiaMlRouter } from '../routes/guardiaMl.js';

const FILE = './test/tmp-guardia-override-omitir.sqlite';

describe('Guardia: override_omitir es solo de administración', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });
  const app = (admin) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = { username: 'x', is_admin: admin, permisos: [{ herramienta: 'matcher', nivel: 'write' }] }; next(); });
    a.use('/api/guardia-ml', guardiaMlRouter(db, {}));
    return a;
  };
  for (const [metodo, ruta] of [['post', '/api/guardia-ml/casos/1/vincular'], ['post', '/api/guardia-ml/vincular-clave']]) {
    it(`un operador recibe 403 en ${ruta}`, async () => {
      const r = await request(app(false))[metodo](ruta).send({ clave: 'MLA1|', sku: 'FB-1', override_omitir: true });
      expect(r.status).toBe(403);
    });
    it(`el administrador no recibe 403 en ${ruta}`, async () => {
      const r = await request(app(true))[metodo](ruta).send({ clave: 'MLA1|', sku: 'FB-1', override_omitir: true });
      expect(r.status).not.toBe(403);
    });
  }
  it('sin override_omitir un operador pasa el control', async () => {
    const r = await request(app(false)).post('/api/guardia-ml/vincular-clave').send({ clave: 'MLA1|', sku: 'FB-1' });
    expect(r.status).not.toBe(403);
  });
});
