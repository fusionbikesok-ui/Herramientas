import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { procesarNotificacionesPush } from '../lib/workerNotificacionesPush.js';

const TEST_DB = './test/tmp-worker-push.sqlite';

function seedUser(db, { id = 1, username = 'tester' } = {}) {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, ?, 0, 1, ?, ?)
    `).run(id, username, 'hash', now, now);
  } catch (_) {}
}

function seedPreferencias(db, userId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO preferencias_notificacion
    (user_id, incidentes_criticos, actualizado_en)
    VALUES (?, 1, ?)
  `).run(userId, now);
}

function seedDevice(db, userId, token = 'device-token-123', plataforma = 'ios') {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, token, plataforma, now, now);
  } catch (e) {
    if (!e.message.includes('UNIQUE')) throw e;
  }
}

function seedIncidente(db, { integracion = 'mercadolibre', severidad = 'critico', estado = 'activo' } = {}) {
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO incidentes_operativos
    (integracion, proceso, tipo_error, clave_dedupe, severidad, estado, mensaje_humano,
     contador_repeticiones, primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    integracion,
    'sync',
    'network_error',
    `${integracion}|sync|network_error`,
    severidad,
    estado,
    'Error de red detectado',
    now,
    now,
    now,
    now
  );
  return info.lastInsertRowid;
}

describe('lib/workerNotificacionesPush', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('procesa un incidente crítico activo nuevo (sin notificaciones previas)', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1);

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    await procesarNotificacionesPush(db);

    // Verificar que se creó una notificación 'nuevo'
    const notif = db.prepare(`
      SELECT * FROM notificaciones_enviadas
      WHERE incidente_id = ? AND tipo = 'nuevo'
    `).get(incidenteId);

    expect(notif).toBeDefined();
    expect(notif.estado).toBe('enviado'); // mock siempre retorna ok
    db.close();
  });

  it('no reenvía notificación "nuevo" si ya existe', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1);

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // Primera corrida
    await procesarNotificacionesPush(db);

    // Segunda corrida — no debería crear otra 'nuevo'
    const countAntes = db.prepare(`
      SELECT COUNT(*) as c FROM notificaciones_enviadas
      WHERE incidente_id = ? AND tipo = 'nuevo'
    `).get(incidenteId).c;

    await procesarNotificacionesPush(db);

    const countDespues = db.prepare(`
      SELECT COUNT(*) as c FROM notificaciones_enviadas
      WHERE incidente_id = ? AND tipo = 'nuevo'
    `).get(incidenteId).c;

    expect(countDespues).toBe(countAntes);
    db.close();
  });

  it('permite múltiples "reaviso" para un mismo incidente', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1);

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // Primera corrida
    await procesarNotificacionesPush(db);

    // Marcar última notificación como muy antigua
    const ultimas = db.prepare(`
      SELECT * FROM notificaciones_enviadas
      WHERE incidente_id = ? AND estado = 'enviado'
      ORDER BY creado_en DESC LIMIT 1
    `).get(incidenteId);

    if (ultimas) {
      const fechaVencida = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      db.prepare(`
        UPDATE notificaciones_enviadas SET creado_en = ? WHERE id = ?
      `).run(fechaVencida, ultimas.id);
    }

    // Segunda corrida — debería permitir reaviso
    await procesarNotificacionesPush(db);

    const reavisos = db.prepare(`
      SELECT COUNT(*) as c FROM notificaciones_enviadas
      WHERE incidente_id = ? AND tipo = 'reaviso'
    `).get(incidenteId).c;

    expect(reavisos).toBeGreaterThan(0);
    db.close();
  });

  it('envía notificación "resuelto" cuando el incidente pasa a estado resuelto', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1);

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // Primera corrida — notificación nuevo
    await procesarNotificacionesPush(db);

    // Resolver el incidente
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE incidentes_operativos SET estado = 'resuelto', resuelto_en = ?, actualizado_en = ?
      WHERE id = ?
    `).run(now, now, incidenteId);

    // Segunda corrida — debería enviar resuelto
    await procesarNotificacionesPush(db);

    const resuelto = db.prepare(`
      SELECT * FROM notificaciones_enviadas
      WHERE incidente_id = ? AND tipo = 'resuelto'
    `).get(incidenteId);

    expect(resuelto).toBeDefined();
    expect(resuelto.estado).toBe('enviado');
    db.close();
  });

  it('ignora incidentes que no son críticos si el usuario no está suscrito', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    // NO crear preferencias — indica que no quiere notificaciones de críticos
    seedDevice(db, 1);

    const incidenteId = seedIncidente(db, { severidad: 'advertencia', estado: 'activo' });

    await procesarNotificacionesPush(db);

    // No debería haber notificación
    const notif = db.prepare(`
      SELECT * FROM notificaciones_enviadas WHERE incidente_id = ?
    `).get(incidenteId);

    expect(notif).toBeUndefined();
    db.close();
  });

  it('nunca lanza excepciones (fail-open)', async () => {
    const db = openDb(TEST_DB);
    // Base vacía
    let threw = false;
    try {
      await procesarNotificacionesPush(db);
    } catch (err) {
      threw = true;
    }
    expect(threw).toBe(false);
    db.close();
  });

  it('crea notificaciones visibles en notificaciones_usuario cuando envía', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1);

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    await procesarNotificacionesPush(db);

    // Verificar que se creó en notificaciones_usuario
    const notifUsuario = db.prepare(`
      SELECT * FROM notificaciones_usuario WHERE incidente_id = ? AND tipo = 'nuevo'
    `).get(incidenteId);

    expect(notifUsuario).toBeDefined();
    expect(notifUsuario.user_id).toBe(1);
    expect(notifUsuario.titulo).toContain('Incidente');
    expect(notifUsuario.leida).toBe(0);
    db.close();
  });

  // BLOQUEANTE 1: Verificar que 'nuevo' y 'reaviso' nunca salen juntos en el mismo tick
  it('nunca envía "nuevo" y "reaviso" juntos en el mismo tick (BLOQUEANTE 1)', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1);

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // Primer tick — debe enviar solo 'nuevo'
    await procesarNotificacionesPush(db);

    const tiposEnPrimerTick = db.prepare(`
      SELECT DISTINCT tipo FROM notificaciones_enviadas
      WHERE incidente_id = ? AND estado = 'enviado'
      ORDER BY creado_en ASC
    `).all(incidenteId);

    // Después del primer tick, solo debe haber 'nuevo'
    expect(tiposEnPrimerTick.length).toBe(1);
    expect(tiposEnPrimerTick[0].tipo).toBe('nuevo');

    // Segundo tick en el mismo segundo — no debería agregar 'reaviso' junto a 'nuevo'
    await procesarNotificacionesPush(db);

    const tiposEnSegundoTick = db.prepare(`
      SELECT DISTINCT tipo FROM notificaciones_enviadas
      WHERE incidente_id = ? AND estado = 'enviado'
      ORDER BY creado_en ASC
    `).all(incidenteId);

    // Sigue siendo solo 'nuevo' — sin 'reaviso' agregado en el mismo procesamiento
    expect(tiposEnSegundoTick.length).toBe(1);
    expect(tiposEnSegundoTick[0].tipo).toBe('nuevo');

    db.close();
  });

  // BLOQUEANTE 2: Verificar que 2 dispositivos del mismo usuario generan 1 sola fila en
  // notificaciones_usuario, no una por dispositivo
  it('genera 1 notificacion_usuario por (usuario,tipo,incidente), no una por dispositivo (BLOQUEANTE 2)', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);

    // Registrar 2 dispositivos para el MISMO usuario
    seedDevice(db, 1, 'device-token-ios', 'ios');
    seedDevice(db, 1, 'device-token-android', 'android');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    await procesarNotificacionesPush(db);

    // Contar filas en notificaciones_usuario para este usuario + tipo + incidente
    const notificacionesDeUsuario = db.prepare(`
      SELECT COUNT(*) as c FROM notificaciones_usuario
      WHERE user_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId).c;

    // Debe ser exactamente 1, NO 2 (una por dispositivo)
    expect(notificacionesDeUsuario).toBe(1);

    // Verificar que sí hay 2 intentos de envío (uno por dispositivo)
    const enviosDeDevices = db.prepare(`
      SELECT COUNT(*) as c FROM notificaciones_enviadas
      WHERE incidente_id = ? AND tipo = 'nuevo' AND estado = 'enviado'
    `).get(incidenteId).c;

    expect(enviosDeDevices).toBe(2); // 2 dispositivos, 2 intentos de envío

    db.close();
  });
});
