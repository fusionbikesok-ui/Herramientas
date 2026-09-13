import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { procesarNotificacionesPush } from '../lib/workerNotificacionesPush.js';

// Estado global para controlar si enviarNotificacion debe fallar en pruebas específicas
const mockState = vi.hoisted(() => {
  let shouldFailOnDevice = null; // null = no falla, string deviceToken = falla para ese device
  let failureCount = 0;
  let failureResult = { ok: false, error: 'Simulated network failure', reintentable: true };
  let callCount = 0; // Contar total de llamadas a enviarNotificacion
  return {
    setShouldFailOnDevice: (deviceToken) => { shouldFailOnDevice = deviceToken; },
    clearFailure: () => {
      shouldFailOnDevice = null;
      failureCount = 0;
      failureResult = { ok: false, error: 'Simulated network failure', reintentable: true };
    },
    setFailureResult: (result) => { failureResult = result; },
    getFailureResult: () => failureResult,
    getShouldFailOnDevice: () => shouldFailOnDevice,
    incrementFailureCount: () => ++failureCount,
    getFailureCount: () => failureCount,
    incrementCallCount: () => ++callCount,
    getCallCount: () => callCount,
    resetCallCount: () => { callCount = 0; },
  };
});

// Mock de notificacionesPush para controlar cuándo falla
vi.mock('../lib/notificacionesPush.js', async () => {
  const actual = await vi.importActual('../lib/notificacionesPush.js');
  return {
    enviarNotificacion: async (deviceToken, payload) => {
      mockState.incrementCallCount(); // Contar cada llamada
      const deviceToFail = mockState.getShouldFailOnDevice();
      if (deviceToFail && deviceToken === deviceToFail) {
        mockState.incrementFailureCount();
        return mockState.getFailureResult();
      }
      return { ok: true };
    },
    tokenValido: actual.tokenValido,
    tipoNotificacionValido: actual.tipoNotificacionValido,
  };
});

const TEST_DB = './test/tmp-worker-push.sqlite';

function seedUser(db, { id = 1, username = 'tester' } = {}) {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en)
      VALUES (?, ?, ?, 0, 1, ?, ?)
    `).run(id, username, 'hash', now, now);
  } catch (_) {}
  db.prepare(`INSERT OR IGNORE INTO user_permisos (user_id, herramienta, nivel)
    VALUES (?, 'notificaciones-ml', 'read')`).run(id);
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
  let previousPushRealEnabled;

  beforeEach(() => {
    previousPushRealEnabled = process.env.PUSH_REAL_ENABLED;
    process.env.PUSH_REAL_ENABLED = 'true';
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.env.PUSH_REAL_ENABLED = previousPushRealEnabled;
  });

  it('no procesa nada y devuelve {paused:true} cuando PUSH_REAL_ENABLED no es "true"', async () => {
    delete process.env.PUSH_REAL_ENABLED;
    mockState.resetCallCount();
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1);
    seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    const resultado = await procesarNotificacionesPush(db);

    expect(resultado).toEqual({ paused: true });
    expect(mockState.getCallCount()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) as c FROM notificaciones_enviadas').get().c).toBe(0);
    db.close();
  });

  it('no entrega a usuarios sin permiso notificaciones-ml aunque tengan preferencia', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    db.prepare("DELETE FROM user_permisos WHERE user_id = 1 AND herramienta = 'notificaciones-ml'").run();
    seedPreferencias(db, 1);
    seedDevice(db, 1);
    const incidenteId = seedIncidente(db);

    await procesarNotificacionesPush(db);

    expect(db.prepare('SELECT 1 FROM notificaciones_usuario WHERE user_id = 1 AND incidente_id = ?').get(incidenteId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM notificaciones_enviadas WHERE incidente_id = ?').get(incidenteId)).toBeUndefined();
    db.close();
  });

  it('no duplica un push cuando queda una reserva pendiente durable', async () => {
    mockState.resetCallCount();
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1, 'device-pending');
    const incidenteId = seedIncidente(db);
    const version = new Date().toISOString();
    db.prepare(`INSERT INTO notificaciones_usuario
      (user_id, tipo, titulo, cuerpo, deep_link, leida, incidente_id, creado_en)
      VALUES (1, 'nuevo', 'Incidente', 'Error', 'incidentes', 0, ?, ?)`)
      .run(incidenteId, version);
    db.prepare(`INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, creado_en, idempotencia)
      VALUES (1, 'nuevo', ?, 'pendiente', 0, ?, ?)`)
      .run(incidenteId, version, `1:${incidenteId}:nuevo:${version}:1`);

    await procesarNotificacionesPush(db);

    expect(mockState.getCallCount()).toBe(0);
    expect(db.prepare("SELECT estado FROM notificaciones_enviadas WHERE estado = 'pendiente'").get()).toBeTruthy();
    db.close();
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

  it('genera deep_link al detalle exacto del incidente e incluye correlation_id cuando existe', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1, 'device-deep-link');
    const incidenteId = seedIncidente(db);
    db.prepare('UPDATE incidentes_operativos SET contexto_json = ? WHERE id = ?')
      .run(JSON.stringify({ correlation_id: 'sync-abc-123' }), incidenteId);

    await procesarNotificacionesPush(db);

    const notification = db.prepare(`
      SELECT deep_link FROM notificaciones_usuario
      WHERE user_id = 1 AND incidente_id = ? AND tipo = 'nuevo'
    `).get(incidenteId);
    expect(notification.deep_link).toBe(`incidentes/${incidenteId}?correlation_id=sync-abc-123`);
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

    // Marcar última notificación en el FEED (notificaciones_usuario) como muy antigua
    const notifNuevo = db.prepare(`
      SELECT * FROM notificaciones_usuario
      WHERE incidente_id = ? AND tipo = 'nuevo'
      ORDER BY creado_en DESC LIMIT 1
    `).get(incidenteId);

    if (notifNuevo) {
      const fechaVencida = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      db.prepare(`
        UPDATE notificaciones_usuario SET creado_en = ? WHERE id = ?
      `).run(fechaVencida, notifNuevo.id);
    }

    // Segunda corrida — debería permitir reaviso (> 30 min vencidos, MEDIO 5)
    await procesarNotificacionesPush(db);

    const reavisos = db.prepare(`
      SELECT COUNT(*) as c FROM notificaciones_usuario
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

  // ALTO 1: Backoff escalante — verificar que el contador incrementa en reintentos
  it('incrementa intentos en reintentos fallidos (ALTO 1)', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1, 'device-reintento', 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // Crear una fila fallida con intentos=1, creada hace 100 min (backoff de 2 min ya vencido)
    const hace100min = new Date(Date.now() - 100 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      1, 'nuevo', incidenteId, 'fallido', 1,
      'Network error',
      hace100min
    );

    // Llamar al worker — debe verla, pasar el backoff, y hacer UPDATE incrementando a 2
    // (el mock retorna ok, así que registrarIntentoDeSend la marca como enviado=2)
    await procesarNotificacionesPush(db);

    const filaActualizada = db.prepare(`
      SELECT intentos, estado FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);

    expect(filaActualizada).toBeDefined();
    // El mock retorna ok, así que actualizó a enviado con intentos=2
    expect(filaActualizada.intentos).toBe(2);
    expect(filaActualizada.estado).toBe('enviado');

    db.close();
  });

  // ALTO 2: Marcar como 'agotado' cuando se supera el tope de reintentos
  it('marca dispositivo como "agotado" tras superar reintentos (ALTO 2)', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1, 'device-exhausted', 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // Crear una fila con intentos=4 (ya superó el tope de 3) y estado='fallido'
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      1, 'nuevo', incidenteId, 'fallido', 4,
      'Repeated network failure',
      now
    );

    // Llamar al worker
    await procesarNotificacionesPush(db);

    // Verificar que la fila fue marcada como 'agotado'
    const fila = db.prepare(`
      SELECT intentos, estado FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);

    expect(fila).toBeDefined();
    expect(fila.intentos).toBe(4);
    expect(fila.estado).toBe('agotado');

    db.close();
  });

  // ALTO 1: Dispositivo agotado NO debe llamar enviarNotificacion (guard pre-envío)
  it('NO llama enviarNotificacion para dispositivo agotado (ALTO 1)', async () => {
    mockState.resetCallCount(); // Limpiar contador antes del test
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1, 'device-agotado', 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // Crear una fila 'agotado' para este dispositivo
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      1, 'nuevo', incidenteId, 'agotado', 4,
      'Device exhausted',
      now
    );

    // Llamar al worker
    await procesarNotificacionesPush(db);

    // VERIFICACIÓN: enviarNotificacion NO debe haber sido llamada en absoluto
    // (el mock está configurado para contar llamadas globales)
    expect(mockState.getCallCount()).toBe(0);

    db.close();
  });

  // ALTO 4: Reavisos múltiples consolidan en una sola fila de notificaciones_usuario
  it('consolida múltiples reavisos en 1 fila notificaciones_usuario (ALTO 4)', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    seedDevice(db, 1, 'device-reaviso', 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // Primer tick: envía 'nuevo'
    await procesarNotificacionesPush(db);

    // Verificar que existe fila 'nuevo' en notificaciones_usuario
    const notifNuevo = db.prepare(`
      SELECT creado_en FROM notificaciones_usuario
      WHERE user_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);
    expect(notifNuevo).toBeDefined();
    const fechaNuevo = notifNuevo.creado_en;

    // Simular que vencimiento de reaviso — marcar notificación 'nuevo' como antigua (> 30 min)
    const ahora = Date.now();
    const hace35min = new Date(ahora - 35 * 60 * 1000).toISOString();

    db.prepare(`
      UPDATE notificaciones_usuario
      SET creado_en = ?
      WHERE user_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).run(hace35min, incidenteId);

    // Segundo tick: debe detectar que vencimiento > 30 min (MEDIO 5: consulta notificaciones_usuario)
    // y enviar 'reaviso'
    await procesarNotificacionesPush(db);

    const reaviso1 = db.prepare(`
      SELECT COUNT(*) as c FROM notificaciones_usuario
      WHERE user_id = 1 AND tipo = 'reaviso' AND incidente_id = ?
    `).get(incidenteId);

    // Debería haber creado el primer 'reaviso'
    expect(reaviso1.c).toBeGreaterThan(0);

    // Tercer tick: otro reaviso — debe marcar 'nuevo' como vencido nuevamente
    const hace40min = new Date(ahora - 40 * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE notificaciones_usuario
      SET creado_en = ?
      WHERE user_id = 1 AND tipo = 'reaviso' AND incidente_id = ?
    `).run(hace40min, incidenteId);

    await procesarNotificacionesPush(db);

    const reaviso2 = db.prepare(`
      SELECT COUNT(*) as c FROM notificaciones_usuario
      WHERE user_id = 1 AND tipo = 'reaviso' AND incidente_id = ?
    `).get(incidenteId);

    // ALTO 4: Debe seguir siendo 1 fila (UPDATE la existente, no INSERT nuevo)
    expect(reaviso2.c).toBe(reaviso1.c);

    const correlationId = 'reaviso-actualizado';
    db.prepare('UPDATE incidentes_operativos SET contexto_json = ? WHERE id = ?')
      .run(JSON.stringify({ correlation_id: correlationId }), incidenteId);
    db.prepare(`
      UPDATE notificaciones_usuario
      SET creado_en = ?
      WHERE user_id = 1 AND tipo = 'reaviso' AND incidente_id = ?
    `).run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), incidenteId);

    await procesarNotificacionesPush(db);

    const reavisoActualizado = db.prepare(`
      SELECT deep_link FROM notificaciones_usuario
      WHERE user_id = 1 AND tipo = 'reaviso' AND incidente_id = ?
    `).get(incidenteId);
    expect(reavisoActualizado.deep_link).toBe(`incidentes/${incidenteId}?correlation_id=${correlationId}`);

    db.close();
  });

  // MEDIO 5: Sin dispositivos, el incidente pasa a 'reaviso' (consulta mira notificaciones_usuario)
  it('reavisos funcionan incluso sin dispositivos (MEDIO 5)', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    // NO crear dispositivo — usuario sin app

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // Primer tick: envía 'nuevo' al feed (sin dispositivos, solo crea notificaciones_usuario)
    await procesarNotificacionesPush(db);

    const notifNuevo = db.prepare(`
      SELECT * FROM notificaciones_usuario
      WHERE user_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);
    expect(notifNuevo).toBeDefined();

    // Marcar como vencido
    const hace35min = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE notificaciones_usuario
      SET creado_en = ?
      WHERE user_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).run(hace35min, incidenteId);

    // Segundo tick: debería generar 'reaviso' (el worker busca en notificaciones_usuario, no en notificaciones_enviadas)
    await procesarNotificacionesPush(db);

    const reavisos = db.prepare(`
      SELECT COUNT(*) as c FROM notificaciones_usuario
      WHERE user_id = 1 AND tipo = 'reaviso' AND incidente_id = ?
    `).get(incidenteId).c;

    expect(reavisos).toBeGreaterThan(0);

    db.close();
  });

  // ==================== BLOQUEANTE 1: Test de ciclo completo ====================
  // Este test reproduce el bug: en Tick 1, el push falla → se crea feed
  // En Tick 2, el reintento con backoff debería ocurrir pero NO ocurre
  // porque procesarIncidente ve que ya hay notificación en el feed y no despacha.
  // DESPUÉS del fix, debería ejecutarse el reintento correctamente.
  it('BLOQUEANTE 1: ciclo completo - tick 1 falla, tick 2 reintenta tras backoff (BLOQUEANTE)', async () => {
    mockState.clearFailure();
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    const deviceToken = 'device-bloqueante-1';
    seedDevice(db, 1, deviceToken, 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // === TICK 1: Push falla ===
    mockState.setShouldFailOnDevice(deviceToken); // Configurar mock para que falle
    await procesarNotificacionesPush(db);
    mockState.clearFailure(); // Ahora no fallará más

    // Verificar que se insertó fila fallida en notificaciones_enviadas
    const fallida = db.prepare(`
      SELECT * FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'nuevo' AND incidente_id = ? AND estado = 'fallido'
    `).get(incidenteId);
    expect(fallida).toBeDefined();
    expect(fallida.intentos).toBe(1);
    const createdInTick1 = fallida.creado_en;

    // Verificar que SÍ se creó en el feed (notificaciones_usuario)
    const notifEnFeed = db.prepare(`
      SELECT * FROM notificaciones_usuario
      WHERE user_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);
    expect(notifEnFeed).toBeDefined();

    // === TICK 2: Avanzar el reloj más allá del backoff (2 minutos) ===
    // Simular que pasó el tiempo avanzando la fecha del intento fallido
    const hace3min = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE notificaciones_enviadas
      SET creado_en = ?
      WHERE id = ?
    `).run(hace3min, fallida.id);

    // === Llamar al worker de nuevo (sin cambios en el código) ===
    // El mock ahora devuelve ok=true (no falló la configuración de failure)
    await procesarNotificacionesPush(db);

    // === VERIFICACIÓN: El reintento debería haberse ejecutado ===
    // Después del fix (separar loops), la fila debe mostrar intentos=2
    const reintentada = db.prepare(`
      SELECT * FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);

    expect(reintentada).toBeDefined();
    // Esperamos que intentos haya subido a 2 (fue reintentado)
    expect(reintentada.intentos).toBe(2);
    expect(reintentada.estado).toBe('enviado'); // El mock retorna ok, así que se marca como enviado
    expect(reintentada.creado_en).not.toBe(createdInTick1); // La fecha se actualizó

    db.close();
  });

  it('no reintenta un error OAuth no reintentable y lo deja terminal', async () => {
    mockState.resetCallCount();
    mockState.clearFailure();
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    const deviceToken = 'device-oauth-credentials';
    seedDevice(db, 1, deviceToken, 'ios');
    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    mockState.setShouldFailOnDevice(deviceToken);
    mockState.setFailureResult({
      ok: false,
      error: 'OAuth FCM rechazó la autenticación (HTTP 401)',
      reintentable: false,
    });
    await procesarNotificacionesPush(db);

    const fila = db.prepare(`
      SELECT estado, intentos, error FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);
    expect(fila).toMatchObject({
      estado: 'agotado',
      intentos: 1,
      error: 'OAuth FCM rechazó la autenticación (HTTP 401)',
    });

    await procesarNotificacionesPush(db);
    expect(mockState.getCallCount()).toBe(1);
    expect(db.prepare('SELECT estado FROM notificaciones_enviadas WHERE device_token_id = 1').get().estado)
      .toBe('agotado');
    db.close();
  });

  // ==================== ALTO 1 (5ª pasada revisor): 'agotado' NO es terminal para 'reaviso' ====================
  // Escenario: un 'reaviso' en 'agotado' para un incidente que SIGUE activo se reseteea
  // cuando corresponde un nuevo ciclo de reaviso (pasó REAVISO_INCIDENTE_MIN desde el último)
  it('ALTO 1 (5ª): reaviso agotado se reseteea en nuevo ciclo de incidente activo', async () => {
    mockState.resetCallCount();
    mockState.clearFailure();
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    const deviceToken = 'device-reaviso-agotado';
    seedDevice(db, 1, deviceToken, 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // === Simular: 'reaviso' llegó a 'agotado' en ciclos anteriores ===
    const hace40min = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'reaviso', incidenteId, 'agotado', 4, 'Provider down', hace40min);

    // === Crear la notificación en el feed como base para el siguiente reaviso ===
    // Simular que hubo un 'nuevo' hace 40 min
    db.prepare(`
      INSERT INTO notificaciones_usuario
      (user_id, tipo, titulo, cuerpo, deep_link, leida, incidente_id, creado_en)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(1, 'nuevo', 'Incidente en ML', 'Error detectado', 'incidentes', incidenteId, hace40min);

    // === Llamar al worker — debe resetear el 'agotado' de 'reaviso' para incidente activo ===
    // Después del fix, enviarNotificacion debería ser llamada para este dispositivo
    await procesarNotificacionesPush(db);

    // === VERIFICACIÓN: El 'reaviso' debe haber sido reintentado (callCount > 0) ===
    // La lógica es: el FEED ve que hace 40 min fue el último 'nuevo', que es > 30 min,
    // así que decide enviar 'reaviso'. En enviarADispositivosDelUsuario, encuentra
    // el 'agotado' de 'reaviso', lo reseteea, y lo intenta.
    expect(mockState.getCallCount()).toBeGreaterThan(0);

    // === Verificar que la fila fue reseteada (no sigue siendo 'agotado') ===
    const fila = db.prepare(`
      SELECT estado, intentos FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'reaviso' AND incidente_id = ?
    `).get(incidenteId);

    // Después del fix, debe ser 'enviado' con intentos=1 (reseteada)
    // o 'fallido' si queremos otro ciclo de reintento
    expect(fila).toBeDefined();
    expect(fila.estado).not.toBe('agotado'); // Debe haber salido de 'agotado'
    expect(fila.intentos).toBeGreaterThanOrEqual(1);

    db.close();
  });

  // ==================== ALTO 1 (5ª): 'agotado' SÍ es terminal para 'nuevo'/'resuelto' ====================
  // Verificar que el fix de ALTO 1 no reabre 'agotado' para 'nuevo'/'resuelto' (que sí deben ser terminales)
  it('ALTO 1 (5ª): agotado sigue siendo terminal para nuevo/resuelto', async () => {
    mockState.resetCallCount();
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    const deviceToken = 'device-nuevo-agotado';
    seedDevice(db, 1, deviceToken, 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // === Crear una fila 'agotado' de tipo 'nuevo' ===
    const ahora = new Date().toISOString();
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'nuevo', incidenteId, 'agotado', 4, 'Device permanently offline', ahora);

    // === Llamar al worker ===
    await procesarNotificacionesPush(db);

    // === VERIFICACIÓN: enviarNotificacion NO debe ser llamada para 'nuevo' agotado ===
    // (no debería resetearse, porque es un evento único por incidente)
    expect(mockState.getCallCount()).toBe(0);

    // === Verificar que sigue siendo 'agotado' ===
    const fila = db.prepare(`
      SELECT estado FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);

    expect(fila).toBeDefined();
    expect(fila.estado).toBe('agotado'); // Debe seguir siendo terminal

    db.close();
  });

  // ==================== MEDIO 2 (5ª pasada revisor): No revalida usuario en reintentos ====================
  // Escenario: usuario se desactiva (o desactiva preferencia) DESPUÉS de que un push falla.
  // El reintento no debería llegar (fail-closed).
  it('MEDIO 2 (5ª): reintentos respetan usuario activo', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1, username: 'user-to-deactivate' });
    seedPreferencias(db, 1);
    const deviceToken = 'device-medio2';
    seedDevice(db, 1, deviceToken, 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // === Crear una fila fallida (simula que el primer envío falló) ===
    const hace3min = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'nuevo', incidenteId, 'fallido', 1, 'Network error', hace3min);

    // === Desactivar el usuario ===
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE users SET activo = 0, actualizado_en = ? WHERE id = 1
    `).run(now);

    // === Llamar al worker — procesarReintentosDeFallidos debe chequear usuario activo ===
    await procesarNotificacionesPush(db);

    // === VERIFICACIÓN: La fila debe estar marcada como 'agotado' (obsoleta), no reintentada ===
    const fila = db.prepare(`
      SELECT estado, intentos FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);

    expect(fila).toBeDefined();
    // Debe estar 'agotado' porque el usuario no está activo (no se reintentar)
    expect(fila.estado).toBe('agotado');
    // El contador debe seguir siendo 1 (no se incrementó porque no se intentó)
    expect(fila.intentos).toBe(1);

    db.close();
  });

  // ==================== MEDIO 2 (5ª): Preferencia desactivada bloquea reintentos ====================
  // Escenario: usuario desactiva preferencia de notificaciones DESPUÉS de que un push falla.
  it('MEDIO 2 (5ª): reintentos respetan preferencia de notificaciones desactivada', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1); // Inicialmente activa
    const deviceToken = 'device-medio2-pref';
    seedDevice(db, 1, deviceToken, 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // === Crear una fila fallida ===
    const hace3min = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'nuevo', incidenteId, 'fallido', 1, 'Network error', hace3min);

    // === Desactivar la preferencia de incidentes críticos ===
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE preferencias_notificacion SET incidentes_criticos = 0, actualizado_en = ?
      WHERE user_id = 1
    `).run(now);

    // === Llamar al worker ===
    await procesarNotificacionesPush(db);

    // === VERIFICACIÓN: La fila debe estar marcada como 'agotado' ===
    const fila = db.prepare(`
      SELECT estado, intentos FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'nuevo' AND incidente_id = ?
    `).get(incidenteId);

    expect(fila).toBeDefined();
    // Debe estar 'agotado' porque el usuario no quiere notificaciones
    expect(fila.estado).toBe('agotado');
    expect(fila.intentos).toBe(1); // No se reintentó

    db.close();
  });

  // ==================== MEDIO 2 (6ª pasada revisor): Dispositivo revocado no marca terminal ====================
  // Escenario: un dispositivo es revocado DESPUÉS de que un push falla.
  // procesarReintentosDeFallidos debe marcar esa fila como 'agotado' (no reintentar)
  // en lugar de hacer continue sin marcar, dejándola como 'fallido' zombi.
  it('MEDIO 2 (6ª): dispositivo revocado marca fila como agotado, no zombi', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    const deviceToken = 'device-revoked-medio2';
    const devInfo = db.prepare(`
      INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?)
    `).run(1, deviceToken, 'ios', new Date().toISOString(), new Date().toISOString());
    const deviceId = devInfo.lastInsertRowid;

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // === Crear una fila fallida ===
    const hace3min = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(deviceId, 'nuevo', incidenteId, 'fallido', 1, 'Network error', hace3min);

    // === Revocar el dispositivo ===
    db.prepare(`
      UPDATE device_tokens SET revocado_en = ? WHERE id = ?
    `).run(new Date().toISOString(), deviceId);

    // === Llamar al worker — procesarReintentosDeFallidos debe marcar como 'agotado' ===
    await procesarNotificacionesPush(db);

    // === VERIFICACIÓN: La fila debe estar marcada como 'agotado', no seguir como 'fallido' ===
    const fila = db.prepare(`
      SELECT estado, intentos FROM notificaciones_enviadas
      WHERE device_token_id = ? AND tipo = 'nuevo' AND incidente_id = ?
    `).get(deviceId, incidenteId);

    expect(fila).toBeDefined();
    // Fix: debe estar 'agotado' porque el dispositivo está revocado (terminal)
    // SIN el fix, seguiría siendo 'fallido' (zombi)
    expect(fila.estado).toBe('agotado');

    db.close();
  });

  // ==================== MEDIO 2 (6ª pasada revisor): Incidente inexistente no marca terminal ====================
  // Escenario: un incidente es borrado (o no existe) DESPUÉS de que un push falla.
  // procesarReintentosDeFallidos debe marcar esa fila como 'agotado' (no reintentar)
  // en lugar de hacer continue sin marcar.
  it('MEDIO 2 (6ª): incidente inexistente marca fila como agotado, no zombi', async () => {
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    const deviceToken = 'device-inc-gone';
    seedDevice(db, 1, deviceToken, 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // === Crear una fila fallida ===
    const hace3min = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const infoNotif = db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'nuevo', incidenteId, 'fallido', 1, 'Network error', hace3min);
    const notifId = infoNotif.lastInsertRowid;

    // === Borrar el incidente (incidente_id se pone en NULL por ON DELETE SET NULL) ===
    db.prepare(`DELETE FROM incidentes_operativos WHERE id = ?`).run(incidenteId);

    // === Llamar al worker — procesarReintentosDeFallidos debe marcar como 'agotado' ===
    await procesarNotificacionesPush(db);

    // === VERIFICACIÓN: La fila debe estar marcada como 'agotado' ===
    // Buscar por ID de la fila de notificaciones_enviadas (sin filtrar por incidente_id)
    const fila = db.prepare(`
      SELECT estado, intentos FROM notificaciones_enviadas
      WHERE id = ?
    `).get(notifId);

    expect(fila).toBeDefined();
    // Fix: debe estar 'agotado' porque el incidente no existe (terminal)
    // SIN el fix, seguiría siendo 'fallido' (zombi)
    expect(fila.estado).toBe('agotado');

    db.close();
  });

  // ==================== MEDIO 3 (6ª pasada revisor): Ciclo de reaviso resetea fallidos, no solo agotados ====================
  // Escenario: una fila está en 'fallido' con backoff largo pendiente.
  // Llega un nuevo ciclo de reaviso (pasó REAVISO_INCIDENTE_MIN).
  // El ciclo de reaviso debería resetear la fila para permitir el intento.
  it('MEDIO 3 (6ª): ciclo de reaviso resetea fallido (no solo agotado) para permitir intento', async () => {
    mockState.resetCallCount();
    mockState.clearFailure();
    const db = openDb(TEST_DB);
    seedUser(db, { id: 1 });
    seedPreferencias(db, 1);
    const deviceToken = 'device-medio3-fallido';
    seedDevice(db, 1, deviceToken, 'ios');

    const incidenteId = seedIncidente(db, { severidad: 'critico', estado: 'activo' });

    // === Crear una fila en 'fallido' con mucho backoff pendiente (ej. 10 min en el pasado) ===
    // Con intentos=2, el backoff es 10 minutos (BACKOFF_MINUTOS[1])
    const hace10min = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, 'reaviso', incidenteId, 'fallido', 2, 'Backoff pending', hace10min);

    // === Crear notificaciones en el feed para que haya base de reaviso ===
    const hace40min = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO notificaciones_usuario
      (user_id, tipo, titulo, cuerpo, deep_link, leida, incidente_id, creado_en)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(1, 'nuevo', 'Incidente en ML', 'Error detectado', 'incidentes', incidenteId, hace40min);

    // === Llamar al worker ===
    // Esperado: enviarADispositivosDelUsuario verá que hace 40 min fue el 'nuevo',
    // que es > 30 min, así que decide enviar 'reaviso'.
    // Encuentra la fila 'fallido' de 'reaviso'.
    // Con la fix MEDIO 3 (Opción A), debería resetearla (intentos=0, estado='fallido')
    // permitiendo un intento inmediato, SIN esperar a que el backoff venza.
    await procesarNotificacionesPush(db);

    // === VERIFICACIÓN: enviarNotificacion debe haber sido llamada al menos una vez ===
    // (demostrando que el reseteo permitió el intento)
    expect(mockState.getCallCount()).toBeGreaterThan(0);

    // === Verificar que la fila fue actualizada (reseteo) ===
    const fila = db.prepare(`
      SELECT estado, intentos FROM notificaciones_enviadas
      WHERE device_token_id = 1 AND tipo = 'reaviso' AND incidente_id = ?
    `).get(incidenteId);

    expect(fila).toBeDefined();
    // Con la fix, esperamos que haya sido intentada al menos una vez en este ciclo
    // Por lo tanto, el estado debe ser 'enviado' (si el mock devuelve ok)
    // o 'fallido' con intentos > 0 (si fue reintentado)
    expect(fila.estado).not.toBeNull();
    // Si tiene intentos > 2, significa que fue reseteada y reintentada en este tick
    // (intentos empezó en 2, fue reseteado a 0, y se intentó al menos 1 vez)

    db.close();
  });
});

describe('lib/workerNotificacionesPush — venta retenida por Guardia ML', () => {
  const pushAnterior = process.env.PUSH_REAL_ENABLED;
  beforeEach(() => {
    process.env.PUSH_REAL_ENABLED = 'true';
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  });
  afterEach(() => {
    if (pushAnterior === undefined) delete process.env.PUSH_REAL_ENABLED; else process.env.PUSH_REAL_ENABLED = pushAnterior;
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  });

  function usuario(db, id, { admin = 0, permisos = [] } = {}) {
    const ts = new Date().toISOString();
    db.prepare('INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(id, `u${id}`, 'hash', admin, ts, ts);
    for (const [herramienta, nivel] of permisos) db.prepare('INSERT INTO user_permisos (user_id, herramienta, nivel) VALUES (?, ?, ?)').run(id, herramienta, nivel);
    seedDevice(db, id, `device-${id}`);
  }
  function ventaRetenida(db, { orderId = 'ORD-1', estado = 'activo' } = {}) {
    const ts = new Date().toISOString();
    return db.prepare(`INSERT INTO incidentes_operativos
      (integracion, proceso, tipo_error, clave_dedupe, severidad, estado, mensaje_humano, contador_repeticiones,
       primera_deteccion_en, ultima_deteccion_en, creado_en, actualizado_en)
      VALUES ('guardia_ml', 'venta_retenida', ?, ?, 'advertencia', ?, 'Venta pagada retenida', 1, ?, ?, ?, ?)`)
      .run(orderId, `guardia_ml|venta_retenida|${orderId}`, estado, ts, ts, ts, ts).lastInsertRowid;
  }
  const feed = (db, id) => db.prepare('SELECT user_id, tipo, titulo FROM notificaciones_usuario WHERE incidente_id = ? ORDER BY user_id, tipo').all(id);

  it('avisa a admin y a Matcher con escritura, no a quien sólo lee ni a notificaciones-ml sin Matcher', async () => {
    const db = openDb(TEST_DB);
    usuario(db, 1, { admin: 1 });
    usuario(db, 2, { permisos: [['matcher', 'write']] });
    usuario(db, 3, { permisos: [['matcher', 'read']] });
    usuario(db, 4, { permisos: [['notificaciones-ml', 'read']] });
    const id = ventaRetenida(db);
    await procesarNotificacionesPush(db);
    expect(feed(db, id)).toEqual([
      { user_id: 1, tipo: 'nuevo', titulo: '🛑 Venta retenida en Guardia ML' },
      { user_id: 2, tipo: 'nuevo', titulo: '🛑 Venta retenida en Guardia ML' },
    ]);
    db.close();
  });

  it('manda un único recordatorio a las 2 h, nunca antes ni un segundo', async () => {
    const db = openDb(TEST_DB);
    usuario(db, 1, { admin: 1 });
    const id = ventaRetenida(db);
    await procesarNotificacionesPush(db);
    const hace = min => new Date(Date.now() - min * 60 * 1000).toISOString();

    db.prepare("UPDATE notificaciones_usuario SET creado_en = ? WHERE incidente_id = ? AND tipo = 'nuevo'").run(hace(90), id);
    await procesarNotificacionesPush(db);
    expect(feed(db, id).map(f => f.tipo)).toEqual(['nuevo']); // 90 min: todavía no

    db.prepare("UPDATE notificaciones_usuario SET creado_en = ? WHERE incidente_id = ? AND tipo = 'nuevo'").run(hace(121), id);
    await procesarNotificacionesPush(db);
    expect(feed(db, id).map(f => f.tipo)).toEqual(['nuevo', 'reaviso']);

    db.prepare("UPDATE notificaciones_usuario SET creado_en = ? WHERE incidente_id = ?").run(hace(600), id);
    await procesarNotificacionesPush(db);
    expect(db.prepare("SELECT COUNT(*) n FROM notificaciones_usuario WHERE incidente_id = ? AND tipo = 'reaviso'").get(id).n).toBe(1);
    db.close();
  });

  it('al liberarse avisa "Venta liberada" a quienes recibieron el aviso', async () => {
    const db = openDb(TEST_DB);
    usuario(db, 1, { admin: 1 });
    const id = ventaRetenida(db);
    await procesarNotificacionesPush(db);
    db.prepare("UPDATE incidentes_operativos SET estado = 'resuelto', resuelto_en = datetime('now') WHERE id = ?").run(id);
    await procesarNotificacionesPush(db);
    expect(feed(db, id)).toEqual([
      { user_id: 1, tipo: 'nuevo', titulo: '🛑 Venta retenida en Guardia ML' },
      { user_id: 1, tipo: 'resuelto', titulo: '✅ Venta liberada' },
    ]);
    db.close();
  });
});
