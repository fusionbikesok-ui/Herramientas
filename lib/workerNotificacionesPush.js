/**
 * Worker de notificaciones push — escanea incidentes activos y envía notificaciones.
 *
 * Patrón: cron periódico (ej. cada 1-5 min, ver server.js) que dispara esta función.
 * Lógica:
 * 1. Buscar incidentes en estado 'activo' sin notificación 'nuevo' → enviar 'nuevo'
 * 2. Buscar incidentes en estado 'activo' con reaviso vencido (> REAVISO_INCIDENTE_MIN) → enviar 'reaviso'
 * 3. Buscar incidentes en estado 'resuelto' sin notificación 'resuelto' → enviar 'resuelto'
 *
 * FAIL-OPEN: cualquier error en el envío de un incidente no bloquea el procesamiento
 * de los demás; el worker nunca lanza excepciones que tumben el proceso.
 *
 * Configuración:
 * - REAVISO_INCIDENTE_MIN: minutos entre reavisos (default 30)
 */

import { enviarNotificacion } from './notificacionesPush.js';

const REAVISO_INCIDENTE_MIN = parseInt(process.env.REAVISO_INCIDENTE_MIN || '30', 10);

const now = () => new Date().toISOString();

/**
 * Calcula cuándo vence el intervalo de reaviso para un incidente.
 */
function fechaVencimientoReaviso() {
  const ms = Date.now() - REAVISO_INCIDENTE_MIN * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * Crea el payload de notificación push basado en el tipo de incidente.
 */
function payloadDelIncidente(inc, tipo) {
  const integraciones = { mercadolibre: 'ML', woocommerce: 'WooCommerce', otro: 'Sistema' };
  const integracionNombre = integraciones[inc.integracion] || inc.integracion;

  switch (tipo) {
    case 'nuevo':
      return {
        titulo: `⚠️ Incidente en ${integracionNombre}`,
        cuerpo: inc.mensaje_humano || 'Un error fue detectado en la integración.',
        deepLink: 'incidentes', // Ruta interna de la app
      };
    case 'reaviso':
      return {
        titulo: `🔔 Recordatorio: incidente en ${integracionNombre}`,
        cuerpo: `${inc.mensaje_humano || 'Incidente activo.'} (${inc.contador_repeticiones}x)`,
        deepLink: 'incidentes',
      };
    case 'resuelto':
      return {
        titulo: `✅ Resuelto: ${integracionNombre}`,
        cuerpo: `El incidente ha sido resuelto.`,
        deepLink: 'incidentes',
      };
    default:
      return {
        titulo: 'Notificación del Sistema',
        cuerpo: 'Nueva actividad en los incidentes.',
        deepLink: 'incidentes',
      };
  }
}

/**
 * Obtiene los usuarios a notificar para un incidente.
 * Hoy: todos los usuarios con `preferencias_notificacion.incidentes_criticos = 1`.
 */
function obtenerUsuariosParaNotificar(db, inc) {
  // Si el incidente es crítico y el usuario quiere críticos, notificar.
  if (inc.severidad === 'critico') {
    return db
      .prepare(`
        SELECT DISTINCT u.id
        FROM users u
        LEFT JOIN preferencias_notificacion pn ON u.id = pn.user_id
        WHERE u.activo = 1 AND (pn.incidentes_criticos = 1 OR pn.user_id IS NULL)
      `)
      .all();
  }
  // Para otros niveles, podés implementar lógica adicional aquí.
  return [];
}

/**
 * Obtiene todos los dispositivos activos de un usuario.
 */
function obtenerDispositivosDelUsuario(db, userId) {
  return db
    .prepare(`
      SELECT * FROM device_tokens
      WHERE user_id = ? AND revocado_en IS NULL
      ORDER BY actualizado_en DESC
    `)
    .all(userId);
}

/**
 * Registra el intento de envío en notificaciones_enviadas.
 * Deduplica 'nuevo' y 'resuelto', permite múltiples 'reaviso'.
 */
function registrarIntentoDeSend(db, deviceTokenId, tipo, incidenteId, resultado) {
  const ts = now();

  // Intentar insertar — si choca con UNIQUE (para 'nuevo'/'resuelto'), ignorar
  try {
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(
      deviceTokenId,
      tipo,
      incidenteId,
      resultado.ok ? 'enviado' : 'fallido',
      resultado.ok ? null : resultado.error,
      ts
    );
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      // Ya existe un registro 'nuevo'/'resuelto' — es normal, omitir
      // (excepción: 'reaviso' no tiene constraint UNIQUE, así que sigue siendo insertable)
    } else {
      console.error('[push-worker] error registrando intento:', err.message);
    }
  }
}

/**
 * Crea una notificación visible en notificaciones_usuario.
 */
function crearNotificacionUsuario(db, userId, tipo, payload, incidenteId) {
  const ts = now();
  db.prepare(`
    INSERT INTO notificaciones_usuario
    (user_id, tipo, titulo, cuerpo, deep_link, leida, incidente_id, creado_en)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(userId, tipo, payload.titulo, payload.cuerpo, payload.deepLink, incidenteId, ts);
}

/**
 * Procesa un incidente: determina qué tipo(s) de notificación enviar y los despacha.
 */
async function procesarIncidente(db, inc) {
  try {
    const usuarios = obtenerUsuariosParaNotificar(db, inc);
    if (usuarios.length === 0) return; // Nadie quiere notificaciones de este incidente

    const tiposAEnviar = [];

    // ¿Hay notificación 'nuevo' ya enviada?
    const hayNuevo = db
      .prepare(`
        SELECT 1 FROM notificaciones_enviadas
        WHERE incidente_id = ? AND tipo = 'nuevo' AND estado = 'enviado'
      `)
      .get(inc.id);

    if (!hayNuevo && inc.estado === 'activo') {
      tiposAEnviar.push('nuevo');
    }

    // ¿Pasó el intervalo de reaviso desde la última notificación?
    if (inc.estado === 'activo') {
      const ultimaNotif = db
        .prepare(`
          SELECT creado_en FROM notificaciones_enviadas
          WHERE incidente_id = ? AND estado = 'enviado'
          ORDER BY creado_en DESC LIMIT 1
        `)
        .get(inc.id);

      const fechaVencimiento = fechaVencimientoReaviso();
      if (!ultimaNotif || ultimaNotif.creado_en <= fechaVencimiento) {
        tiposAEnviar.push('reaviso');
      }
    }

    // ¿Hay notificación 'resuelto' ya enviada?
    if (inc.estado === 'resuelto') {
      const hayResuelto = db
        .prepare(`
          SELECT 1 FROM notificaciones_enviadas
          WHERE incidente_id = ? AND tipo = 'resuelto' AND estado = 'enviado'
        `)
        .get(inc.id);

      if (!hayResuelto) {
        tiposAEnviar.push('resuelto');
      }
    }

    if (tiposAEnviar.length === 0) return; // Nada que hacer

    // Para cada usuario y tipo, enviar a todos sus dispositivos
    for (const usr of usuarios) {
      for (const tipo of tiposAEnviar) {
        await enviarADispositivosDelUsuario(db, usr.id, inc, tipo);
      }
    }
  } catch (err) {
    console.error('[push-worker] error procesando incidente', inc.id, ':', err.message);
  }
}

/**
 * Envía un tipo de notificación a todos los dispositivos activos de un usuario.
 */
async function enviarADispositivosDelUsuario(db, userId, inc, tipo) {
  try {
    const dispositivos = obtenerDispositivosDelUsuario(db, userId);
    if (dispositivos.length === 0) return; // Sin dispositivos, sin nada que hacer

    const payload = payloadDelIncidente(inc, tipo);

    // Intentar enviar a cada dispositivo
    for (const dev of dispositivos) {
      try {
        const resultado = await enviarNotificacion(dev.token, payload);

        // Registrar el intento
        registrarIntentoDeSend(db, dev.id, tipo, inc.id, resultado);

        // Si fue éxito, crear la notificación visible
        if (resultado.ok) {
          crearNotificacionUsuario(db, userId, tipo, payload, inc.id);
        }
      } catch (err) {
        console.error('[push-worker] error enviando a dispositivo', dev.id, ':', err.message);
        // No re-lanzar — seguir con el siguiente dispositivo
      }
    }
  } catch (err) {
    console.error('[push-worker] error en enviarADispositivosDelUsuario:', err.message);
  }
}

/**
 * Dispara el worker: escanea incidentes y envía notificaciones.
 * Llamada periódicamente por cron en server.js.
 *
 * FAIL-OPEN: nunca lanza excepciones.
 */
export async function procesarNotificacionesPush(db) {
  try {
    // Incidentes activos SIN notificación 'nuevo' enviada
    // + Incidentes activos CON intervalo de reaviso vencido
    // + Incidentes resueltos SIN notificación 'resuelto' enviada
    const incidentes = db
      .prepare(`
        SELECT DISTINCT i.* FROM incidentes_operativos i
        WHERE i.estado = 'activo' OR i.estado = 'resuelto'
        ORDER BY i.ultima_deteccion_en DESC
      `)
      .all();

    for (const inc of incidentes) {
      await procesarIncidente(db, inc);
    }
  } catch (err) {
    console.error('[push-worker] error en procesarNotificacionesPush:', err.message);
    // FAIL-OPEN: no re-lanzar
  }
}
