import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { notificationsRouter } from '../routes/notifications.js';
import { hashPassword } from '../lib/auth.js';

const TEST_DB = './test/tmp-notifications-route.sqlite';

function buildApp(db, userId = null) {
  const app = express();
  app.use(express.json());

  // Middleware: inyectar usuario en req si está autenticado
  if (userId) {
    app.use((req, res, next) => {
      req.session = { userId };
      req.user = { id: userId, is_admin: false };
      next();
    });
  }

  app.use('/api/notifications', notificationsRouter(db));
  return app;
}

function seedUser(db, { id = 1, username = 'tester' } = {}) {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, ?, 0, 1, ?, ?)
    `).run(id, username, 'hash', now, now);
  } catch (_) {
    // Ya existe
  }
}

function seedNotification(db, userId, { tipo = 'nuevo', titulo = 'Test', cuerpo = 'Test body' } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO notificaciones_usuario
    (user_id, tipo, titulo, cuerpo, deep_link, leida, creado_en)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(userId, tipo, titulo, cuerpo, 'incidentes', now);
}

describe('routes/notifications', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('GET /notifications', () => {
    it('retorna lista vacía si el usuario no tiene notificaciones', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, 1);

      const res = await request(app).get('/api/notifications');

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.next_cursor).toBeNull();
      db.close();
    });

    it('retorna notificaciones del usuario ordenadas por fecha DESC', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1 });

      // Crear 3 notificaciones
      seedNotification(db, 1, { tipo: 'nuevo', titulo: 'Notif 1' });
      seedNotification(db, 1, { tipo: 'reaviso', titulo: 'Notif 2' });
      seedNotification(db, 1, { tipo: 'resuelto', titulo: 'Notif 3' });

      const app = buildApp(db, 1);
      const res = await request(app).get('/api/notifications');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(3);
      // La última creada debe ser la primera (orden DESC)
      expect(res.body.items[0].titulo).toBe('Notif 3');
      expect(res.body.items[2].titulo).toBe('Notif 1');
      db.close();
    });

    it('hace round-trip del cursor ISO_TIMESTAMP:id y devuelve la página siguiente real', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1 });
      const insert = db.prepare(`INSERT INTO notificaciones_usuario
        (user_id, tipo, titulo, cuerpo, deep_link, leida, creado_en)
        VALUES (1, 'nuevo', ?, 'body', 'incidentes', 0, ?)`);
      const base = Date.parse('2026-08-28T15:00:00.000Z');
      for (let i = 0; i < 21; i++) {
        insert.run(`Notif ${i + 1}`, new Date(base + i * 1000).toISOString());
      }
      const app = buildApp(db, 1);

      const first = await request(app).get('/api/notifications');
      expect(first.status).toBe(200);
      expect(first.body.items).toHaveLength(20);
      expect(first.body.next_cursor).toBeTruthy();
      const decoded = Buffer.from(first.body.next_cursor, 'base64url').toString('utf8');
      expect(decoded).toMatch(/^2026-08-28T15:00:01\.000Z:\d+$/);

      const second = await request(app).get('/api/notifications')
        .query({ cursor: first.body.next_cursor });
      expect(second.status).toBe(200);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.items[0].titulo).toBe('Notif 1');
      expect(second.body.next_cursor).toBeNull();
      db.close();
    });

    it('filtra notificaciones solo del usuario autenticado', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1, username: 'user1' });
      seedUser(db, { id: 2, username: 'user2' });

      seedNotification(db, 1, { titulo: 'Notif user 1' });
      seedNotification(db, 2, { titulo: 'Notif user 2' });

      const app = buildApp(db, 1);
      const res = await request(app).get('/api/notifications');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].titulo).toBe('Notif user 1');
      db.close();
    });

    it('rechaza cursor inválido (MEDIO 6)', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, 1);

      // Cursor corrupto (base64 inválido)
      const res = await request(app).get('/api/notifications?cursor=!!!invalid!!!');

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('cursor_invalido');
      db.close();
    });

    it('rechaza un cursor con ID fuera de Number.isSafeInteger', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const cursor = Buffer.from('2026-08-28T15:00:00.000Z:9007199254740992').toString('base64url');
      const app = buildApp(db, 1);

      const res = await request(app).get('/api/notifications').query({ cursor });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('cursor_invalido');
      db.close();
    });

    it('respeta el campo leida', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1 });

      const ts = new Date().toISOString();
      db.prepare(`
        INSERT INTO notificaciones_usuario
        (user_id, tipo, titulo, cuerpo, deep_link, leida, creado_en)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'nuevo', 'Leída', 'Test', 'incidentes', 1, ts);

      db.prepare(`
        INSERT INTO notificaciones_usuario
        (user_id, tipo, titulo, cuerpo, deep_link, leida, creado_en)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'nuevo', 'No leída', 'Test', 'incidentes', 0, ts);

      const app = buildApp(db, 1);
      const res = await request(app).get('/api/notifications');

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(2);
      const leida = res.body.items.find(n => n.titulo === 'Leída');
      const noLeida = res.body.items.find(n => n.titulo === 'No leída');
      expect(leida.leida).toBe(true);
      expect(noLeida.leida).toBe(false);
      db.close();
    });
  });

  describe('POST /notifications/:id/read', () => {
    it('rechaza sin autenticación', async () => {
      const db = openDb(TEST_DB);
      const app = buildApp(db, null);

      const res = await request(app).post('/api/notifications/999/read');

      expect(res.status).toBe(401);
      db.close();
    });

    it('marca una notificación como leída', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1 });

      const ts = new Date().toISOString();
      const info = db.prepare(`
        INSERT INTO notificaciones_usuario
        (user_id, tipo, titulo, cuerpo, deep_link, leida, creado_en)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(1, 'nuevo', 'Test', 'Test', 'incidentes', ts);

      const app = buildApp(db, 1);
      const res = await request(app).post(`/api/notifications/${info.lastInsertRowid}/read`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Verificar que se marcó como leída
      const notif = db.prepare('SELECT * FROM notificaciones_usuario WHERE id = ?').get(info.lastInsertRowid);
      expect(notif.leida).toBe(1);
      db.close();
    });

    it('retorna 404 si la notificación no existe', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1 });
      const app = buildApp(db, 1);

      const res = await request(app).post('/api/notifications/999/read');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('no_encontrado');
      db.close();
    });

    it('rechaza un ID fuera de Number.isSafeInteger', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1 });
      const app = buildApp(db, 1);

      const res = await request(app).post('/api/notifications/9007199254740992/read');

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('id_invalido');
      db.close();
    });

    it('retorna 404 si la notificación pertenece a otro usuario', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1, username: 'user1' });
      seedUser(db, { id: 2, username: 'user2' });

      const ts = new Date().toISOString();
      const info = db.prepare(`
        INSERT INTO notificaciones_usuario
        (user_id, tipo, titulo, cuerpo, deep_link, leida, creado_en)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(2, 'nuevo', 'Test', 'Test', 'incidentes', ts);

      const app = buildApp(db, 1); // User 1 intentando leer notif de user 2
      const res = await request(app).post(`/api/notifications/${info.lastInsertRowid}/read`);

      expect(res.status).toBe(404);
      db.close();
    });
  });
});
