import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { devicesRouter } from '../routes/devices.js';
import { hashPassword } from '../lib/auth.js';

const TEST_DB = './test/tmp-devices-route.sqlite';

function buildApp(db, authUserId = null) {
  const app = express();
  app.use(express.json());

  // Mock middleware para simular autenticación
  if (authUserId) {
    app.use((req, res, next) => {
      req.session = { userId: authUserId };
      req.user = { id: authUserId, is_admin: false };
      next();
    });
  }

  app.use('/api/devices', devicesRouter(db));
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

describe('routes/devices', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  describe('POST /devices', () => {
    it('rechaza sin autenticación (401)', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, null); // Sin autenticación

      const res = await request(app).post('/api/devices').send({
        platform: 'ios',
        push_token: 'token-123',
      });

      expect(res.status).toBe(401);
      db.close();
    });

    it('rechaza request sin platform (422)', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, 1);

      const res = await request(app).post('/api/devices').send({
        push_token: 'token-123',
      });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('platform_invalido');
      db.close();
    });

    it('rechaza platform inválido', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, 1);

      const res = await request(app).post('/api/devices').send({
        platform: 'windows',
        push_token: 'token-123',
      });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('platform_invalido');
      db.close();
    });

    it('rechaza push_token inválido o vacío', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, 1);

      const res = await request(app).post('/api/devices').send({
        platform: 'ios',
        push_token: '',
      });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('push_token_invalido');
      db.close();
    });

    it('registra un dispositivo iOS con éxito', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, 1);

      const res = await request(app).post('/api/devices').send({
        platform: 'ios',
        push_token: 'apns-token-123',
        device_name: 'iPhone de Juan',
      });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(res.body.platform).toBe('ios');
      expect(res.body.device_name).toBe('iPhone de Juan');
      expect(res.body.creado_en).toBeDefined();

      // Verificar en DB
      const device = db.prepare('SELECT * FROM device_tokens WHERE token = ?').get('apns-token-123');
      expect(device).toBeDefined();
      expect(device.user_id).toBe(1);
      expect(device.plataforma).toBe('ios');
      db.close();
    });

    it('registra un dispositivo Android', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, 1);

      const res = await request(app).post('/api/devices').send({
        platform: 'android',
        push_token: 'fcm-token-456',
      });

      expect(res.status).toBe(200);
      expect(res.body.platform).toBe('android');
      db.close();
    });

    it('registra un dispositivo Web (ALTO 3)', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, 1);

      const res = await request(app).post('/api/devices').send({
        platform: 'web',
        push_token: 'fcm-token-web-123',
        device_name: 'Navegador Firefox',
      });

      expect(res.status).toBe(200);
      expect(res.body.platform).toBe('web');
      expect(res.body.device_name).toBe('Navegador Firefox');

      // Verificar en DB
      const device = db.prepare('SELECT * FROM device_tokens WHERE token = ?').get('fcm-token-web-123');
      expect(device).toBeDefined();
      expect(device.plataforma).toBe('web');
      db.close();
    });

    it('permite re-registrar un token revocado', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const now = new Date().toISOString();

      // Crear un dispositivo revocado
      db.prepare(`
        INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en, revocado_en)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1, 'token-xyz', 'ios', now, now, now);

      const app = buildApp(db, 1);

      // Re-registrar el mismo token (debería limpiar revocado_en)
      const res = await request(app).post('/api/devices').send({
        platform: 'ios',
        push_token: 'token-xyz',
      });

      expect(res.status).toBe(200);

      // Verificar que revocado_en está NULL
      const device = db.prepare('SELECT * FROM device_tokens WHERE token = ?').get('token-xyz');
      expect(device.revocado_en).toBeNull();
      db.close();
    });

    it('reasigna token de otro usuario al usuario actual (MEDIO 7)', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1, username: 'user1' });
      seedUser(db, { id: 2, username: 'user2' });

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
        VALUES (?, ?, ?, ?, ?)
      `).run(2, 'shared-token', 'ios', now, now);

      const app = buildApp(db, 1);

      const res = await request(app).post('/api/devices').send({
        platform: 'ios',
        push_token: 'shared-token',
        device_name: 'iPhone reasignado',
      });

      // MEDIO 7: Ahora es exitoso (200) — el token se reasignó de user 2 a user 1
      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(res.body.platform).toBe('ios');

      // Verificar en DB que el token ahora pertenece a user 1 (búsqueda por usuario activo)
      const device = db.prepare('SELECT * FROM device_tokens WHERE token = ? AND revocado_en IS NULL').get('shared-token');
      expect(device.user_id).toBe(1);

      // Verificar que la vieja fila está revocada (ALTO 1 fix)
      const oldDevice = db.prepare('SELECT * FROM device_tokens WHERE token = ? AND user_id = 2').get('shared-token');
      expect(oldDevice.revocado_en).not.toBeNull();

      db.close();
    });

    it('reasigna token no hereda historial agotado del usuario anterior (ALTO 1)', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1, username: 'user1' });
      seedUser(db, { id: 2, username: 'user2' });

      const now = new Date().toISOString();

      // Crear un incidente
      const incInfo = db.prepare(`
        INSERT INTO incidentes_operativos
        (integracion, proceso, tipo_error, clave_dedupe, severidad, estado, mensaje_humano,
         contador_repeticiones, primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        'mercadolibre', 'sync', 'network_error',
        'ml|sync|network_error',
        'critico', 'activo', 'Error de red',
        now, now, now, now
      );
      const incidenteId = incInfo.lastInsertRowid;

      // Registrar dispositivo para user2 con el token que se reasignará
      const devInfo = db.prepare(`
        INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
        VALUES (?, ?, ?, ?, ?)
      `).run(2, 'reasign-token', 'ios', now, now);
      const deviceId = devInfo.lastInsertRowid;

      // Crear una fila de envío AGOTADA para user2 (simular que el proveedor estaba caído)
      db.prepare(`
        INSERT INTO notificaciones_enviadas
        (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(deviceId, 'nuevo', incidenteId, 'agotado', 3, 'Provider down', now);

      // Ahora user1 registra el MISMO token (reasignación)
      const app = buildApp(db, 1);
      const res = await request(app).post('/api/devices').send({
        platform: 'ios',
        push_token: 'reasign-token',
        device_name: 'iPhone reasignado a user1',
      });

      expect(res.status).toBe(200);

      // Verificar que la vieja fila está revocada
      const oldDevice = db.prepare('SELECT * FROM device_tokens WHERE id = ?').get(deviceId);
      expect(oldDevice.revocado_en).not.toBeNull();

      // Verificar que la NUEVA fila para user1 tiene un device_token_id diferente
      const newDevice = db.prepare('SELECT * FROM device_tokens WHERE user_id = 1 AND token = ?').get('reasign-token');
      expect(newDevice.id).not.toBe(deviceId);
      expect(newDevice.revocado_en).toBeNull();

      // Verificar que la nueva fila NO hereda el historial agotado
      // (debería haber 0 filas agotadas para el nuevo device_token_id)
      const agotadaParaNewDevice = db.prepare(`
        SELECT COUNT(*) as c FROM notificaciones_enviadas
        WHERE device_token_id = ? AND estado = 'agotado'
      `).get(newDevice.id).c;

      expect(agotadaParaNewDevice).toBe(0);

      db.close();
    });
  });

  describe('DELETE /devices/:id', () => {
    it('rechaza sin autenticación', async () => {
      const db = openDb(TEST_DB);
      const app = buildApp(db, null);

      const res = await request(app).delete('/api/devices/999');

      expect(res.status).toBe(401);
      db.close();
    });

    it('retorna 404 si el dispositivo no existe', async () => {
      const db = openDb(TEST_DB);
      seedUser(db);
      const app = buildApp(db, 1);

      const res = await request(app).delete('/api/devices/999');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('no_encontrado');
      db.close();
    });

    it('retorna 403 si el dispositivo pertenece a otro usuario', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1, username: 'user1' });
      seedUser(db, { id: 2, username: 'user2' });

      const ts = new Date().toISOString();
      const info = db.prepare(`
        INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
        VALUES (?, ?, ?, ?, ?)
      `).run(2, 'other-token', 'ios', ts, ts);

      const app = buildApp(db, 1); // User 1 intenta revocar device de user 2

      const res = await request(app).delete(`/api/devices/${info.lastInsertRowid}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('sin_permiso');
      db.close();
    });

    it('revoca un dispositivo con éxito', async () => {
      const db = openDb(TEST_DB);
      seedUser(db, { id: 1 });

      const ts = new Date().toISOString();
      const info = db.prepare(`
        INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, 'token-to-revoke', 'android', ts, ts);

      const app = buildApp(db, 1);

      const res = await request(app).delete(`/api/devices/${info.lastInsertRowid}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Verificar que revocado_en fue seteado
      const device = db.prepare('SELECT * FROM device_tokens WHERE id = ?').get(info.lastInsertRowid);
      expect(device.revocado_en).not.toBeNull();
      db.close();
    });
  });
});
