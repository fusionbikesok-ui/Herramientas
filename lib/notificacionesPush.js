/**
 * Delivery push para iOS, Android y web.
 *
 * `mock` es únicamente desarrollo/pruebas: devuelve `simulated: true` y el worker lo
 * persiste como `simulado`, nunca como `enviado`. `fcm` usa HTTP v1 real y requiere una
 * cuenta de servicio configurada por entorno. Ningún log contiene tokens ni payloads.
 */

import crypto from 'crypto';

const base64url = (value) => Buffer.from(value).toString('base64url');
const config = () => ({
  provider: process.env.PUSH_PROVIDER || (process.env.NODE_ENV === 'production' ? 'invalid' : 'mock'),
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
});

let oauthCache = null;
const PUSH_HTTP_TIMEOUT_DEFAULT_MS = 10_000;

function cuentaServicioDesdeEntorno(env) {
  const rawJson = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch (_) {
      return null;
    }
    return {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key?.replace(/\\n/g, '\n'),
    };
  }
  return {
    projectId: env.FIREBASE_PROJECT_ID,
    clientEmail: env.FIREBASE_CLIENT_EMAIL,
    privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };
}

function cuentaServicioValida(cuenta) {
  if (!cuenta || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(String(cuenta.projectId || ''))) return false;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(cuenta.clientEmail || ''))) return false;
  if (typeof cuenta.privateKey !== 'string' || !/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(cuenta.privateKey)) return false;
  try {
    crypto.createPrivateKey(cuenta.privateKey);
  } catch (_) {
    return false;
  }
  return true;
}

/** Configuración de APNs desde el entorno. */
function cuentaApnsDesdeEntorno(env) {
  return {
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    bundleId: env.APNS_BUNDLE_ID,
    privateKey: env.APNS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };
}

function cuentaApnsValida(cuenta) {
  return Boolean(cuenta.keyId && cuenta.teamId && cuenta.bundleId)
    && typeof cuenta.privateKey === 'string'
    && /-----BEGIN (?:EC )?PRIVATE KEY-----/.test(cuenta.privateKey);
}

export function validarConfiguracionPush(env = process.env) {
  const provider = env.PUSH_PROVIDER?.trim();
  if (provider && !['mock', 'fcm', 'apns'].includes(provider)) {
    throw new Error('PUSH_PROVIDER debe ser mock, fcm o apns');
  }
  if (env.NODE_ENV === 'production' && (!provider || provider === 'mock')) {
    throw new Error('En producción PUSH_PROVIDER=fcm o apns es obligatorio; mock no está permitido');
  }
  if (env.NODE_ENV === 'production' && provider === 'fcm') {
    const cuenta = cuentaServicioDesdeEntorno(env);
    if (!cuentaServicioValida(cuenta)) {
      throw new Error('En producción FCM requiere projectId, clientEmail y private key válidos');
    }
  }
  if (env.NODE_ENV === 'production' && provider === 'apns') {
    if (!cuentaApnsValida(cuentaApnsDesdeEntorno(env))) {
      throw new Error('En producción APNs requiere APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID y APNS_PRIVATE_KEY válidos');
    }
  }
  return provider || 'mock';
}

function serviceAccount(cfg, env = process.env) {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) return cuentaServicioDesdeEntorno(env);
  return cfg.projectId && cfg.clientEmail && cfg.privateKey ? cfg : null;
}

function timeoutPushMs() {
  const configured = Number(process.env.PUSH_HTTP_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : PUSH_HTTP_TIMEOUT_DEFAULT_MS;
}

async function fetchConTimeout(url, options, descripcion) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutPushMs());
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') {
      const timeoutError = new Error(`${descripcion} agotó el tiempo de espera`);
      timeoutError.code = 'PUSH_TIMEOUT';
      timeoutError.reintentable = true;
      throw timeoutError;
    }
    throw err;
  } finally {
    // El timer debe desaparecer también cuando fetch falla: no dejar handles vivos
    // evita que un worker de cron quede retenido por una request ya terminada.
    clearTimeout(timer);
  }
}

async function oauthAccessToken(account) {
  if (oauthCache && oauthCache.accountKey === account.clientEmail && oauthCache.expiresAt > Date.now() + 60_000) {
    return oauthCache.token;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: account.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const input = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(input);
  const assertion = `${input}.${signer.sign(account.privateKey, 'base64url')}`;
  const response = await fetchConTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  }, 'OAuth FCM');
  if (!response.ok) {
    const authError = new Error(`OAuth FCM rechazó la autenticación (HTTP ${response.status})`);
    authError.reintentable = response.status === 429 || response.status >= 500;
    throw authError;
  }
  const body = await response.json();
  if (!body.access_token) return null;
  oauthCache = {
    accountKey: account.clientEmail,
    token: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
  };
  return body.access_token;
}

async function enviarViaFCM(deviceToken, payload) {
  const account = serviceAccount(config(), process.env);
  if (!account) return { ok: false, error: 'FCM no configurado' };
  try {
    const accessToken = await oauthAccessToken(account);
    if (!accessToken) return { ok: false, error: 'FCM no pudo autenticar la cuenta de servicio' };
    const message = {
      message: {
        token: deviceToken,
        notification: { title: String(payload.titulo || ''), body: String(payload.cuerpo || '') },
        data: Object.fromEntries(Object.entries(payload)
          .filter(([key]) => !['titulo', 'cuerpo'].includes(key))
          .map(([key, value]) => [key, String(value ?? '')])),
      },
    };
    const response = await fetchConTimeout(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(message),
    }, 'FCM');
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        error: `FCM rechazó el envío (HTTP ${response.status})`,
        reintentable: retryable,
      };
    }
    const body = await response.json().catch(() => ({}));
    return { ok: true, provider: 'fcm', providerId: body.name || null };
  } catch (err) {
    return {
      ok: false,
      error: err.code === 'PUSH_TIMEOUT' || err.reintentable !== undefined
        ? err.message
        : 'Error de red al enviar por FCM',
      reintentable: err.reintentable !== false,
    };
  }
}

export async function enviarNotificacion(deviceToken, payload, opciones = {}) {
  if (!tokenValido(deviceToken)) return { ok: false, error: 'deviceToken vacío' };
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload vacío' };
  let selected;
  try {
    selected = validarConfiguracionPush(process.env);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (selected === 'mock') return { ok: true, simulated: true, provider: 'mock' };
  if (selected === 'apns') {
    const { enviarApns } = await import('./apnsClient.js');
    const aps = {
      alert: { title: String(payload.titulo || ''), body: String(payload.cuerpo || '') },
      sound: 'default',
      badge: Number(payload.badge) || undefined,
      category: payload.categoryId || undefined,
      'interruption-level': payload.interruptionLevel || undefined,
    };
    // Los datos van fuera de `aps`, que es donde iOS los entrega a la app. Nada de contenido
    // del cliente: sólo identificadores y enrutamiento (ver lib/pushCasoPayload.js).
    const cuerpo = { aps };
    for (const [clave, valor] of Object.entries(payload)) {
      if (['titulo', 'cuerpo', 'badge', 'categoryId', 'interruptionLevel'].includes(clave)) continue;
      cuerpo[clave] = String(valor ?? '');
    }
    return enviarApns(deviceToken, cuerpo, {
      entorno: opciones.entorno || 'production',
      cfg: cuentaApnsDesdeEntorno(process.env),
    });
  }
  if (selected === 'fcm') return enviarViaFCM(deviceToken, payload);
  return { ok: false, error: 'Proveedor push desconocido' };
}

export function tokenValido(token) {
  return typeof token === 'string' && token.trim().length > 0;
}

export function tipoNotificacionValido(tipo) {
  return ['nuevo', 'reaviso', 'resuelto'].includes(tipo);
}
