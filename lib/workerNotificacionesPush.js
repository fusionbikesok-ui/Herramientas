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

// ALTO 3: Candado de concurrencia — evita que dos ticks del cron se interleaven.
// Patrón: igual a _refrescarCatalogoEnCurso en routes/woo.js, _refresco en routes/matcher.js
let _procesarEnCurso = false;

// ALTO 4: Backoff creciente para reintentos fallidos.
// Escala en minutos (el cron corre cada 2 min): 2, 10, 30 min después del 1°, 2°, 3° fallo.
// Después del 3° fallo, no reintentar (dar por perdido el dispositivo).
const BACKOFF_MINUTOS = [2, 10, 30];

/**
 * Calcula si debe reintentarse un envío fallido dado el número de intentos fallidos.
 * Retorna true si ya pasó el backoff y se debe reintentar.
 *
 * ALTO 4: backoff creciente — evita bombardear al proveedor si está caído.
 */
function debeReintentarSegunBackoff(intentosFallidos, ultimoIntentoEn) {
  if (intentosFallidos === 0) return true; // Primer intento
  if (intentosFallidos > BACKOFF_MINUTOS.length) return false; // Demasiados intentos, dar por perdido

  const minutosAEsperar = BACKOFF_MINUTOS[intentosFallidos - 1];
  const msAEsperar = minutosAEsperar * 60 * 1000;
  const ahora = Date.now();
  const ultimoIntento = new Date(ultimoIntentoEn).getTime();

  return ahora - ultimoIntento >= msAEsperar;
}

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
 *
 * ALTO 1 fix: Para reintentos fallidos, usa UPDATE para mantener el contador escalando.
 * En lugar de DELETE+INSERT (que perdía el contador), aquí se incrementa intentos y
 * se actualiza creado_en/error en una fila existente fallida.
 *
 * ALTO 2 fix: Si ya existe una fila 'agotado' para este (device, tipo, incidente),
 * no crear una fila nueva — respeta el estado terminal 'agotado'.
 *
 * Retorna: { insertado: boolean } — true si la fila fue insertada realmente,
 * false si chocó con UNIQUE constraint, fue actualizada, o fue bloqueada por 'agotado'.
 */
function registrarIntentoDeSend(db, deviceTokenId, tipo, incidenteId, resultado) {
  const ts = now();

  // ALTO 2: Verificar si ya existe 'agotado' — si es así, no hacer nada (estado terminal)
  const yaAgotado = db
    .prepare(`
      SELECT 1 FROM notificaciones_enviadas
      WHERE device_token_id = ? AND tipo = ? AND incidente_id = ? AND estado = 'agotado'
      LIMIT 1
    `)
    .get(deviceTokenId, tipo, incidenteId);
  if (yaAgotado) {
    // Ya está marcado como agotado — no reintentar más
    return { insertado: false, actualizado: false };
  }

  // Leer si existe una fila fallida previa para este (device, tipo, incidente)
  const filaPrevia = db
    .prepare(`
      SELECT id, intentos FROM notificaciones_enviadas
      WHERE device_token_id = ? AND tipo = ? AND incidente_id = ? AND estado = 'fallido'
      ORDER BY creado_en DESC LIMIT 1
    `)
    .get(deviceTokenId, tipo, incidenteId);

  // Si hay fila fallida previa, hacer UPDATE para incrementar intentos
  if (filaPrevia) {
    const proximoIntento = filaPrevia.intentos + 1;
    db.prepare(`
      UPDATE notificaciones_enviadas
      SET intentos = ?, estado = ?, error = ?, creado_en = ?
      WHERE id = ?
    `).run(
      proximoIntento,
      resultado.ok ? 'enviado' : 'fallido',
      resultado.ok ? null : resultado.error,
      ts,
      filaPrevia.id
    );
    return { insertado: false, actualizado: true };
  }

  // Si no hay fila previa, hacer INSERT
  try {
    db.prepare(`
      INSERT INTO notificaciones_enviadas
      (device_token_id, tipo, incidente_id, estado, intentos, error, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      deviceTokenId,
      tipo,
      incidenteId,
      resultado.ok ? 'enviado' : 'fallido',
      1, // Primer intento
      resultado.ok ? null : resultado.error,
      ts
    );
    return { insertado: true, actualizado: false };
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      // Ya existe un registro 'nuevo'/'resuelto' — es normal, es un duplicado
      return { insertado: false, actualizado: false };
    } else {
      console.error('[push-worker] error registrando intento:', err.message);
      return { insertado: false, actualizado: false };
    }
  }
}

/**
 * Crea una notificación visible en notificaciones_usuario.
 *
 * BLOQUEANTE 2: el índice único (user_id, tipo, incidente_id) previene duplicados para
 * 'nuevo' y 'resuelto' — pero 'reaviso' es intencional repetirse.
 *
 * ALTO 3 fix: cuando se actualiza un 'reaviso' existente, resetear leida=0 para que
 * el nuevo reaviso vuelva a aparecer como no leído.
 *
 * ALTO 4 fix: si choca con UNIQUE y es 'reaviso', hacer UPDATE de esa fila existente
 * para reflejar el estado más reciente (cuerpo actualizado, creado_en más nuevo).
 * Opción elegida: Opción A del revisor — UPDATE en vez de nueva fila.
 */
function crearNotificacionUsuario(db, userId, tipo, payload, incidenteId) {
  const ts = now();
  try {
    db.prepare(`
      INSERT INTO notificaciones_usuario
      (user_id, tipo, titulo, cuerpo, deep_link, leida, incidente_id, creado_en)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(userId, tipo, payload.titulo, payload.cuerpo, payload.deepLink, incidenteId, ts);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      // Chocó con el índice único — comportamiento distinto por tipo
      if (tipo === 'reaviso') {
        // ALTO 3 + ALTO 4: 'reaviso' se permite repetir — actualizar la fila existente
        // con el estado más reciente, Y resetear leida=0 para que aparezca como no leído
        db.prepare(`
          UPDATE notificaciones_usuario
          SET titulo = ?, cuerpo = ?, creado_en = ?, leida = 0
          WHERE user_id = ? AND tipo = ? AND incidente_id = ?
        `).run(payload.titulo, payload.cuerpo, ts, userId, tipo, incidenteId);
      }
      // Para 'nuevo'/'resuelto', ignorar (ya tiene la notificación, es intencional)
    } else {
      console.error('[push-worker] error creando notificación usuario:', err.message);
    }
  }
}

/**
 * Procesa un incidente para un usuario específico: determina qué tipo(s) de notificación
 * enviar y los despacha.
 *
 * BLOQUEANTE 1 fix: 'nuevo' y 'reaviso' son mutuamente excluyentes en el mismo tick.
 * - Sin notificación previa → solo 'nuevo'
 * - Con notificación previa y ≥ intervalo vencido → solo 'reaviso'
 * - Nunca ambos en el mismo procesamiento
 *
 * MEDIO 4 fix: La decisión se toma POR USUARIO, no globalmente. Cada usuario tiene su
 * propio historial en notificaciones_usuario, y la decisión filtra por (user_id, incidente_id).
 *
 * MEDIO 5 fix: la decisión de qué tipo enviar mira notificaciones_usuario en vez de
 * notificaciones_enviadas. Razón: notificaciones_usuario es la fuente de verdad del
 * feed (se crea SIEMPRE, incluso sin dispositivos o si push falla). Un usuario sin
 * dispositivos ahora ve reavisos sin esperar a un push exitoso.
 */
async function procesarIncidenteParaUsuario(db, inc, userId) {
  try {
    const tiposAEnviar = [];

    if (inc.estado === 'activo') {
      // MEDIO 4: Buscar notificación previa PARA ESTE USUARIO EN EL FEED
      const hayNotificacionEnFeed = db
        .prepare(`
          SELECT 1 FROM notificaciones_usuario
          WHERE user_id = ? AND incidente_id = ? AND tipo IN ('nuevo', 'reaviso')
          LIMIT 1
        `)
        .get(userId, inc.id);

      if (!hayNotificacionEnFeed) {
        // Sin notificación previa en el feed → enviar 'nuevo' (y SOLO 'nuevo', no 'reaviso')
        tiposAEnviar.push('nuevo');
      } else {
        // Hay notificación previa en el feed → evaluar 'reaviso'
        // MEDIO 4: Filtrar por user_id también
        const ultimaNotif = db
          .prepare(`
            SELECT creado_en FROM notificaciones_usuario
            WHERE user_id = ? AND incidente_id = ? AND tipo IN ('nuevo', 'reaviso')
            ORDER BY creado_en DESC LIMIT 1
          `)
          .get(userId, inc.id);

        const fechaVencimiento = fechaVencimientoReaviso();
        if (ultimaNotif && ultimaNotif.creado_en <= fechaVencimiento) {
          tiposAEnviar.push('reaviso');
        }
      }
    }

    // ¿Hay notificación 'resuelto' ya en el feed para este usuario?
    if (inc.estado === 'resuelto') {
      // MEDIO 4: Filtrar por user_id
      const hayResuelto = db
        .prepare(`
          SELECT 1 FROM notificaciones_usuario
          WHERE user_id = ? AND incidente_id = ? AND tipo = 'resuelto'
        `)
        .get(userId, inc.id);

      if (!hayResuelto) {
        tiposAEnviar.push('resuelto');
      }
    }

    if (tiposAEnviar.length === 0) return; // Nada que hacer para este usuario

    // Enviar a todos los dispositivos de este usuario para cada tipo
    for (const tipo of tiposAEnviar) {
      await enviarADispositivosDelUsuario(db, userId, inc, tipo);
    }
  } catch (err) {
    console.error('[push-worker] error procesando incidente', inc.id, 'para usuario', userId, ':', err.message);
  }
}

/**
 * Procesa un incidente: para cada usuario que debe ser notificado, decide qué tipos
 * enviar (delegando a procesarIncidenteParaUsuario).
 */
async function procesarIncidente(db, inc) {
  try {
    const usuarios = obtenerUsuariosParaNotificar(db, inc);
    if (usuarios.length === 0) return; // Nadie quiere notificaciones de este incidente

    // MEDIO 4: Iterar usuarios y procesar CADA UNO con su propia decisión
    for (const usr of usuarios) {
      await procesarIncidenteParaUsuario(db, inc, usr.id);
    }
  } catch (err) {
    console.error('[push-worker] error procesando incidente', inc.id, ':', err.message);
  }
}

/**
 * Envía un tipo de notificación a todos los dispositivos activos de un usuario.
 *
 * BLOQUEANTE 2 fix: crearNotificacionUsuario se llama UNA SOLA VEZ después de intentar
 * con todos los dispositivos, no una vez por dispositivo.
 *
 * ALTO 5 fix: crear notificaciones_usuario SIEMPRE (incluso si no hay dispositivos o
 * falla el push), para que el usuario vea que hubo un incidente en su feed web.
 *
 * ALTO 1 fix: registrarIntentoDeSend usa UPDATE para reintentos, no DELETE+INSERT.
 * ALTO 2 fix: marcar dispositivo como 'agotado' cuando supera 3 reintentos.
 *
 * ALTO 1 (5ª pasada): 'agotado' NO es terminal para 'reaviso'. Cuando el FEED decide
 * que corresponde un nuevo ciclo de reaviso (pasó REAVISO_INCIDENTE_MIN), si hay una fila
 * 'agotado' de tipo 'reaviso', resetearla (intentos=0, estado='fallido') en lugar de
 * saltarla. Cada ciclo de reaviso es una "nueva oportunidad", no continuación del anterior.
 */
async function enviarADispositivosDelUsuario(db, userId, inc, tipo) {
  try {
    const dispositivos = obtenerDispositivosDelUsuario(db, userId);
    const payload = payloadDelIncidente(inc, tipo);

    // Intentar enviar a cada dispositivo (si los hay)
    for (const dev of dispositivos) {
      try {
        // ALTO 1: Leer si hay estado previo ('fallido' O 'agotado') para evaluar
        const estadoPrevio = db
          .prepare(`
            SELECT estado, intentos, creado_en FROM notificaciones_enviadas
            WHERE device_token_id = ? AND tipo = ? AND incidente_id = ? AND estado IN ('fallido', 'agotado')
            ORDER BY creado_en DESC LIMIT 1
          `)
          .get(dev.id, tipo, inc.id);

        if (estadoPrevio) {
          // MEDIO 3 fix (6ª pasada): Ciclo de reaviso tiene prioridad sobre backoff
          // Opción A elegida: cuando corresponde un nuevo ciclo de reaviso (decidido por el FEED),
          // permitir el intento sin esperar a que el backoff venza.
          // La decisión "toca reaviso" ya es una "nueva oportunidad", no una continuación del backoff anterior.
          if (tipo === 'reaviso' && inc.estado === 'activo') {
            // MEDIO 2 fix (7ª pasada revisor): Para 'reaviso' en incidente activo, resetear
            // LA FILA FALLIDA/AGOTADA (no todas, incluyendo las exitosas 'enviado').
            // Sin filtro de estado, pisa filas 'enviado' de reavisos anteriores exitosos,
            // que luego se reintentan y causan spam (envío duplicado).
            db.prepare(`
              UPDATE notificaciones_enviadas
              SET estado = 'fallido', intentos = 0, error = null
              WHERE device_token_id = ? AND tipo = ? AND incidente_id = ? AND estado IN ('fallido', 'agotado')
            `).run(dev.id, tipo, inc.id);
            console.log(
              `[push-worker] reaviso reseteado (ciclo de reaviso) para dispositivo ${dev.id}/${inc.id}`
            );
            // Continuar a intentar este dispositivo con intentos=0 (nuevo primer intento)
          } else if (estadoPrevio.estado === 'agotado') {
            // No es 'reaviso' en incidente activo, y ya está 'agotado' — terminal
            console.warn(
              `[push-worker] dispositivo ${dev.id} ya está agotado para ${tipo}/${inc.id} — no reintentar`
            );
            continue;
          } else {
            // Estado es 'fallido' — evaluar backoff y reintentos (no es reaviso en incidente activo)

            // ALTO 2: Si tiene 'fallido' pero ya agotó los 3 reintentos, marcar como 'agotado' y saltar
            if (estadoPrevio.intentos > BACKOFF_MINUTOS.length) {
              const id = db
                .prepare(`
                  SELECT id FROM notificaciones_enviadas
                  WHERE device_token_id = ? AND tipo = ? AND incidente_id = ? AND estado = 'fallido'
                  ORDER BY creado_en DESC LIMIT 1
                `)
                .get(dev.id, tipo, inc.id).id;

              db.prepare(`
                UPDATE notificaciones_enviadas SET estado = 'agotado' WHERE id = ?
              `).run(id);

              console.warn(
                `[push-worker] dispositivo ${dev.id} agotó reintentos para ${tipo}/${inc.id}`
              );
              continue;
            }

            // Hay fallo previo pero aún dentro del tope — evaluar backoff
            if (!debeReintentarSegunBackoff(estadoPrevio.intentos, estadoPrevio.creado_en)) {
              // Aún no ha pasado el backoff — saltar este dispositivo
              continue;
            }
            // Backoff cumplido — proceder a reintentar (registrarIntentoDeSend hace UPDATE)
          }
        }

        const resultado = await enviarNotificacion(dev.token, payload);
        registrarIntentoDeSend(db, dev.id, tipo, inc.id, resultado);
      } catch (err) {
        console.error('[push-worker] error enviando a dispositivo', dev.id, ':', err.message);
        // No re-lanzar — seguir con el siguiente dispositivo
      }
    }

    // ALTO 5: crear notificación en feed web SIEMPRE, independientemente de:
    // - Si hay dispositivos registrados (usuario sin app instalada sigue siendo usuario)
    // - Si el push fue exitoso (notificación usuario es el registro de "esto pasó")
    crearNotificacionUsuario(db, userId, tipo, payload, inc.id);
  } catch (err) {
    console.error('[push-worker] error en enviarADispositivosDelUsuario:', err.message);
  }
}

/**
 * BLOQUEANTE 1 fix: Reintentos independientes de la decisión del feed.
 *
 * Busca todas las filas de notificaciones_enviadas con estado='fallido',
 * y reintenta el envío A ESE DISPOSITIVO ESPECÍFICO, sin importar si el
 * feed ya tiene la notificación creada (feed y push físico son independientes).
 *
 * MEDIO 2 fix: Cuando una fila fallida supera el tope de reintentos,
 * marcala como 'agotado' (transición de estado, sin reintentar).
 *
 * MEDIO 2 (5ª pasada): Revalida usuario activo + preferencias antes de reintentar.
 * Si el usuario se desactivó DESPUÉS de que el push falló, o desactivó la preferencia,
 * marcar la fila como 'agotado' (obsoleta) en lugar de reintentar.
 */
async function procesarReintentosDeFallidos(db) {
  try {
    // Buscar TODAS las filas fallidas (sin límite de intentos)
    const fallidas = db
      .prepare(`
        SELECT * FROM notificaciones_enviadas
        WHERE estado = 'fallido'
        ORDER BY creado_en ASC
      `)
      .all();

    for (const fila of fallidas) {
      try {
        // MEDIO 2: Si ya superó el tope de reintentos, marcar como 'agotado'
        if (fila.intentos > BACKOFF_MINUTOS.length) {
          db.prepare(`
            UPDATE notificaciones_enviadas SET estado = 'agotado' WHERE id = ?
          `).run(fila.id);
          console.warn(
            `[push-worker] fila ${fila.id} (dispositivo ${fila.device_token_id}, tipo ${fila.tipo}) marcada como agotada tras ${fila.intentos} intentos`
          );
          continue;
        }

        // Verificar que el backoff ha pasado
        if (!debeReintentarSegunBackoff(fila.intentos, fila.creado_en)) {
          // Backoff no ha vencido aún — saltar este dispositivo
          continue;
        }

        // Obtener el dispositivo, incidente y payload
        const device = db
          .prepare('SELECT * FROM device_tokens WHERE id = ?')
          .get(fila.device_token_id);
        if (!device || device.revocado_en) {
          // MEDIO 2 fix (6ª pasada): dispositivo revocado es una condición terminal
          // Marcar la fila como 'agotado' para no rescanearia en futuros ticks
          db.prepare(`
            UPDATE notificaciones_enviadas SET estado = 'agotado' WHERE id = ?
          `).run(fila.id);
          console.warn(
            `[push-worker] fila ${fila.id} (dispositivo revocado) marcada como agotada`
          );
          continue;
        }

        const inc = db
          .prepare('SELECT * FROM incidentes_operativos WHERE id = ?')
          .get(fila.incidente_id);
        if (!inc) {
          // MEDIO 2 fix (6ª pasada): incidente inexistente es una condición terminal
          // Marcar la fila como 'agotado' para no rescanearia en futuros ticks
          db.prepare(`
            UPDATE notificaciones_enviadas SET estado = 'agotado' WHERE id = ?
          `).run(fila.id);
          console.warn(
            `[push-worker] fila ${fila.id} (incidente inexistente) marcada como agotada`
          );
          continue;
        }

        // MEDIO 3: Si el tipo es 'nuevo' o 'reaviso' y el incidente ya está 'resuelto',
        // marcar la fila como obsoleta (agotada) en vez de reintentar
        if ((fila.tipo === 'nuevo' || fila.tipo === 'reaviso') && inc.estado === 'resuelto') {
          db.prepare(`
            UPDATE notificaciones_enviadas SET estado = 'agotado' WHERE id = ?
          `).run(fila.id);
          console.warn(
            `[push-worker] fila ${fila.id} (tipo ${fila.tipo} para incidente resuelto) marcada como obsoleta`
          );
          continue;
        }

        // MEDIO 2 (5ª pasada): Revalidar usuario activo y preferencias
        const user = db
          .prepare('SELECT activo FROM users WHERE id = ?')
          .get(device.user_id);

        if (!user || !user.activo) {
          // Usuario no existe o está inactivo — marcar como obsoleta, no reintentar
          db.prepare(`
            UPDATE notificaciones_enviadas SET estado = 'agotado' WHERE id = ?
          `).run(fila.id);
          console.warn(
            `[push-worker] fila ${fila.id} (usuario ${device.user_id} inactivo) marcada como obsoleta`
          );
          continue;
        }

        // MEDIO 2 (5ª): Si el incidente es crítico, verificar que el usuario quiera recibirlos
        if (inc.severidad === 'critico') {
          const pref = db
            .prepare(`
              SELECT incidentes_criticos FROM preferencias_notificacion
              WHERE user_id = ?
            `)
            .get(device.user_id);

          // Si la fila de preferencias existe y está desactivada, no reintentar
          if (pref && !pref.incidentes_criticos) {
            db.prepare(`
              UPDATE notificaciones_enviadas SET estado = 'agotado' WHERE id = ?
            `).run(fila.id);
            console.warn(
              `[push-worker] fila ${fila.id} (usuario ${device.user_id} desactivó notificaciones de críticos) marcada como obsoleta`
            );
            continue;
          }
          // Si la fila no existe (pref IS NULL), el default es recibir (opt-in by default, ausencia = recibe)
        }

        const payload = payloadDelIncidente(inc, fila.tipo);

        // Reintentar el envío
        const resultado = await enviarNotificacion(device.token, payload);
        registrarIntentoDeSend(db, device.id, fila.tipo, inc.id, resultado);

        if (resultado.ok) {
          console.log(
            `[push-worker] reintento exitoso para dispositivo ${device.id}, tipo ${fila.tipo}`
          );
        }
      } catch (err) {
        console.error('[push-worker] error en reintento de fila', fila.id, ':', err.message);
      }
    }
  } catch (err) {
    console.error('[push-worker] error en procesarReintentosDeFallidos:', err.message);
  }
}

/**
 * Dispara el worker: escanea incidentes y envía notificaciones.
 * Llamada periódicamente por cron en server.js.
 *
 * BLOQUEANTE 1 fix: El procesamiento tiene dos pasos independientes:
 * 1. Paso de FEED: decidir qué tipos crear en notificaciones_usuario
 * 2. Paso de REINTENTOS: reintentar filas fallidas cuyo backoff venció
 *
 * ALTO 3: Candado de concurrencia — si ya hay una corrida en curso, salir sin esperar.
 * FAIL-OPEN: nunca lanza excepciones.
 */
export async function procesarNotificacionesPush(db) {
  // ALTO 3: Candado de concurrencia
  if (_procesarEnCurso) return;
  _procesarEnCurso = true;

  try {
    // MEDIO 3 fix (7ª pasada revisor): Incidentes activos (sin ventana) +
    // incidentes resueltos RECIENTES (últimos 7 días). Sin ventana, la query
    // crecía sin límite y procesaba resueltos de hace meses innecesariamente.
    // Nota: los incidentes resueltos pueden tardar hasta 7 días en salir de
    // este procesamiento, tiempo suficiente para que el usuario reciba la
    // notificación de "resuelto" desde una app abierta al momento de la resolución.
    const incidentes = db
      .prepare(`
        SELECT DISTINCT i.* FROM incidentes_operativos i
        WHERE i.estado = 'activo'
           OR (i.estado = 'resuelto' AND i.resuelto_en >= datetime('now', '-7 days'))
        ORDER BY i.ultima_deteccion_en DESC
      `)
      .all();

    // === PASO 1: FEED — decidir qué tipos crear en notificaciones_usuario ===
    for (const inc of incidentes) {
      await procesarIncidente(db, inc);
    }

    // === PASO 2: REINTENTOS — procesar filas fallidas de forma independiente ===
    // Esto ocurre SIEMPRE, incluso si el feed ya tiene notificación, porque
    // el push físico es independiente del feed.
    await procesarReintentosDeFallidos(db);
  } catch (err) {
    console.error('[push-worker] error en procesarNotificacionesPush:', err.message);
    // FAIL-OPEN: no re-lanzar
  } finally {
    _procesarEnCurso = false;
  }
}
