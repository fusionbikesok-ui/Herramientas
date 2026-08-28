/**
 * Infraestructura de notificaciones push (iOS, Android, web vía FCM).
 *
 * Desacoplada del proveedor real (Firebase Cloud Messaging) — hoy simula con 'mock',
 * en el futuro puede extenderse a 'fcm' cuando las credenciales estén configuradas.
 *
 * Política FAIL-OPEN: cualquier error en el envío de push se ataúd y se devuelve
 * `{ok: false, error}`. Nunca lanza excepciones que rompan a quien lo llama.
 * La razón: un proveedor push caído NO DEBE bloquear el ciclo de sync ML/Woo ni
 * tumbar el worker de notificaciones — el usuario sigue usando el sistema, solo no
 * recibe alerts hasta que el proveedor vuelva.
 */

const PUSH_PROVIDER = process.env.PUSH_PROVIDER || 'mock';

/**
 * Envía una notificación push a un dispositivo.
 *
 * @param {string} deviceToken - Token del dispositivo (APNs para iOS, FCM para Android/web)
 * @param {object} payload - Objeto con { titulo, cuerpo, deepLink?, ... }
 * @returns {Promise<{ok: boolean, error?: string}>}
 *
 * Nunca lanza excepciones — siempre devuelve un objeto {ok, error?}.
 */
export async function enviarNotificacion(deviceToken, payload) {
  if (!deviceToken) {
    return { ok: false, error: 'deviceToken vacío' };
  }
  if (!payload) {
    return { ok: false, error: 'payload vacío' };
  }

  try {
    if (PUSH_PROVIDER === 'mock') {
      return enviarViaMock(deviceToken, payload);
    } else if (PUSH_PROVIDER === 'fcm') {
      return await enviarViaFCM(deviceToken, payload);
    } else {
      return {
        ok: false,
        error: `Proveedor desconocido: ${PUSH_PROVIDER}`,
      };
    }
  } catch (err) {
    console.error('[push] error no capturado en enviarNotificacion:', err.message);
    return { ok: false, error: `Error no capturado: ${err.message}` };
  }
}

/**
 * Mock provider: simula éxito instantáneo, útil para desarrollo y testing.
 */
function enviarViaMock(deviceToken, payload) {
  console.log(
    `[push-mock] SIMULADO: enviando a ${deviceToken} | ${payload.titulo || '(sin título)'}`,
    payload
  );
  return { ok: true };
}

/**
 * FCM provider: implementación futura cuando las credenciales estén configuradas.
 *
 * Requiere:
 * - FIREBASE_PROJECT_ID (env var)
 * - FIREBASE_PRIVATE_KEY (env var)
 * - FIREBASE_CLIENT_EMAIL (env var)
 *
 * TODO: Implementar integración real con Firebase Admin SDK cuando esté disponible.
 */
async function enviarViaFCM(deviceToken, payload) {
  return {
    ok: false,
    error: 'FCM no implementado — configurar credenciales y completar este branch',
  };
}

/**
 * Valida que un token sea un string no vacío.
 */
export function tokenValido(token) {
  return typeof token === 'string' && token.trim().length > 0;
}

/**
 * Valida que un tipo de notificación sea válido.
 * (Puede extenderse con nuevos tipos sin cambiar la validación fundamental.)
 */
export function tipoNotificacionValido(tipo) {
  const tipos = ['nuevo', 'reaviso', 'resuelto'];
  return tipos.includes(tipo);
}
