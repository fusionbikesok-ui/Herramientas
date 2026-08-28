import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { procesarNotificacionesPush } from '../lib/workerNotificacionesPush.js';

// Estado global para controlar si enviarNotificacion debe fallar en pruebas específicas
const mockState = vi.hoisted(() => {
  let shouldFailOnDevice = null; // null = no falla, string deviceToken = falla para ese device
  let failureCount = 0;
  let callCount = 0; // Contar total de llamadas a enviarNotificacion
  return {
    setShouldFailOnDevice: (deviceToken) => { shouldFailOnDevice = deviceToken; },
    clearFailure: () => { shouldFailOnDevice = null; failureCount = 0; },
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
        return { ok: false, error: 'Simulated network failure' };
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
});
