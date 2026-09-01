import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { preparacionRouter } from '../routes/preparacion.js';

const DB = './test/tmp-jornada-olas.sqlite';
const CFG = { ml: {}, andreaniStatus: 'lpaandreani' };
function app(db) { const a = express(); a.use(express.json()); a.use((req, _r, n) => { req.user = { username: 'tester' }; n(); }); a.use('/api/preparacion', preparacionRouter(db, CFG)); return a; }
function pedido(db, clave, canal, fecha, estado = 'pendiente') {
  db.prepare(`INSERT INTO pedidos_cache (clave, canal, numero_pedido, fecha, estado_envio, items_json, actualizado_en) VALUES (?,?,?,?,?,?,?)`).run(clave, canal, clave, fecha, estado, '[]', new Date().toISOString());
}

describe('jornada operativa y olas congeladas', () => {
  let db;
  beforeEach(() => { db = openDb(DB); });
  afterEach(() => { db.close(); try { fs.unlinkSync(DB); } catch {} });

  it('exige cutoffs válidos y no inventa SLA', async () => {
    const a = app(db);
    expect((await request(a).post('/api/preparacion/jornada/abrir').send({ fecha: '2026-09-01' })).status).toBe(400);
    expect((await request(a).post('/api/preparacion/jornada/abrir').send({ fecha: '2026-09-01', ml_cutoff: '25:00', web_cutoff: '17:00' })).status).toBe(400);
    const ok = await request(a).post('/api/preparacion/jornada/abrir').send({ fecha: '2026-09-01', ml_cutoff: '16:00', web_cutoff: '17:00' });
    expect(ok.status).toBe(201); expect(ok.body.jornada.ml_cutoff).toBe('16:00');
  });

  it('abrir es idempotente y respeta expected_version', async () => {
    const a = app(db); const body = { fecha: '2026-09-02', ml_cutoff: '16:00', web_cutoff: '17:00' };
    expect((await request(a).post('/api/preparacion/jornada/abrir').send(body)).status).toBe(201);
    expect((await request(a).post('/api/preparacion/jornada/abrir').send(body)).body.jornada.version).toBe(1);
    const r = await request(a).post('/api/preparacion/jornada/abrir').send({ ...body, expected_version: 9 });
    expect(r.status).toBe(409); expect(r.body.code).toBe('VERSION_CONFLICT');
  });

  it('congela la inicial, ordena ML primero y manda el nuevo a una mini-ola', async () => {
    const a = app(db); await request(a).post('/api/preparacion/jornada/abrir').send({ fecha: '2026-09-03', ml_cutoff: '16:00', web_cutoff: '17:00' });
    pedido(db, 'web-viejo', 'web', '2026-09-03T08:00:00Z'); pedido(db, 'ml-viejo', 'ml', '2026-09-03T10:00:00Z');
    const first = await request(a).post('/api/preparacion/olas').send({ fecha: '2026-09-03' });
    expect(first.status).toBe(201); expect(first.body.ola.tipo).toBe('inicial');
    pedido(db, 'ml-nuevo', 'ml', '2026-09-03T11:00:00Z');
    const second = await request(a).post('/api/preparacion/olas').send({ fecha: '2026-09-03', tipo: 'mini' });
    expect(second.status).toBe(201); expect(second.body.ola.items.map(x => x.clave)).toEqual(['ml-nuevo']);
    const listed = await request(a).get('/api/preparacion/olas?fecha=2026-09-03');
    expect(listed.body.olas[0].items.map(x => x.clave)).toEqual(['ml-viejo', 'web-viejo']);
  });

  it('rechaza ola vacía, y cerrar es idempotente', async () => {
    const a = app(db); await request(a).post('/api/preparacion/jornada/abrir').send({ fecha: '2026-09-04', ml_cutoff: '16:00', web_cutoff: '17:00' });
    expect((await request(a).post('/api/preparacion/olas').send({ fecha: '2026-09-04' })).status).toBe(409);
    pedido(db, 'web-1', 'web', '2026-09-04T08:00:00Z'); const wave = await request(a).post('/api/preparacion/olas').send({ fecha: '2026-09-04' });
    expect((await request(a).post(`/api/preparacion/olas/${wave.body.ola.id}/cerrar`)).status).toBe(200);
    expect((await request(a).post(`/api/preparacion/olas/${wave.body.ola.id}/cerrar`)).body.repetido).toBe(true);
  });
});
