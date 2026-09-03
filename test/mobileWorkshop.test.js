import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { hashPassword, mobileAuthMiddleware } from '../lib/auth.js';
import { mobileAuthRouter } from '../routes/mobileAuth.js';
import { mobileWorkshopRouter } from '../routes/mobileWorkshop.js';

const DB = './test/tmp-mobile-workshop.sqlite';
const SECRET = 'mobile-workshop-test-secret-at-least-32-chars';

describe('E21 — evidencia móvil autenticada e idempotente', () => {
  afterEach(() => {
    try { fs.unlinkSync(DB); } catch {}
  });

  it('autentica, sube multipart y no duplica una repetición', async () => {
    const db = openDb(DB);
    const ts = new Date().toISOString();
    db.prepare('INSERT INTO users(username,pass_hash,is_admin,activo,creado_en,actualizado_en) VALUES(?,?,?,?,?,?)')
      .run('e21-mobile', hashPassword('correcta123'), 1, 1, ts, ts);
    const job = db.prepare('INSERT INTO workshop_jobs(codigo,tipo,creado_por,creado_en,actualizado_en,operation_id) VALUES(?,?,?,?,?,?)')
      .run('E21-MOBILE', 'cliente', 'e21-mobile', ts, ts, 'e21-job');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', mobileAuthRouter(db, SECRET));
    app.use('/api/v1/workshop', mobileWorkshopRouter(db, mobileAuthMiddleware(db, SECRET)));
    const login = await request(app).post('/api/v1/auth/login').send({
      username: 'e21-mobile', password: 'correcta123', platform: 'ios', push_token: 'e21-device',
    });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.access_token}` };
    const first = await request(app).post(`/api/v1/workshop/${job.lastInsertRowid}/evidence`)
      .set(auth).field('operation_id', 'e21-photo-1').field('tipo', 'foto')
      .attach('archivo', Buffer.from('synthetic-photo'), 'evidence.jpg');
    expect(first.status).toBe(201);
    const second = await request(app).post(`/api/v1/workshop/${job.lastInsertRowid}/evidence`)
      .set(auth).field('operation_id', 'e21-photo-1').field('tipo', 'foto')
      .attach('archivo', Buffer.from('synthetic-photo'), 'evidence.jpg');
    expect(second.status).toBe(200);
    expect(second.body.repetido).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM workshop_evidence').get().n).toBe(1);
    const missingOperation = await request(app).post(`/api/v1/workshop/${job.lastInsertRowid}/evidence`)
      .set(auth).attach('archivo', Buffer.from('synthetic-photo'), 'evidence.jpg');
    expect(missingOperation.status).toBe(422);
    db.close();
  });
});
