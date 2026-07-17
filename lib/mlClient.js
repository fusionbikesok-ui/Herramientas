/**
 * Cliente para la API de MercadoLibre.
 * Maneja OAuth 2.0 con auto-refresh del access_token (dura 6h).
 * El refresh_token es de un solo uso — se persiste en DB tras cada rotación.
 *
 * El lock _refreshLock serializa los refreshes concurrentes para evitar que
 * múltiples crons consuman el mismo refresh_token de un solo uso.
 */

import axios from 'axios';

const ML_API = 'https://api.mercadolibre.com';
const ML_OAUTH = 'https://api.mercadolibre.com/oauth/token';

// Timeout de red obligatorio. Sin esto, una request colgada (ML sin responder,
// conexión estancada) congela indefinidamente el loop de sync y deja el candado
// tomado para siempre. Con timeout, la request falla y el loop sigue con el próximo.
const ML_HTTP_TIMEOUT_MS = 20000;

// Promise activa de refresh; null cuando no hay refresh en curso.
let _refreshLock = null;

/**
 * Devuelve el access_token vigente.
 * Si vence en menos de 60 segundos, hace el refresh antes de devolver.
 * Serializa el refresh con un lock para evitar race conditions con tokens de un solo uso.
 * cfg: { clientId, clientSecret, userId }
 */
export async function getAccessToken(db, cfg) {
  if (!cfg?.clientId) throw new Error('ML_CLIENT_ID no configurado');

  const row = db.prepare('SELECT access_token, refresh_token, expires_at FROM ml_oauth_token WHERE id = 1').get();
  if (!row) throw new Error('Token ML no inicializado — ejecutar bootstrap OAuth primero');

  const expiresAt = new Date(row.expires_at).getTime();
  const margenMs = 60 * 1000;

  if (Date.now() < expiresAt - margenMs) {
    return row.access_token;
  }

  // Si ya hay un refresh en curso, esperar su resultado en lugar de hacer otro.
  // Evita race condition: dos crons no pueden consumir el mismo refresh_token de un solo uso.
  if (_refreshLock) return _refreshLock;

  _refreshLock = _doRefresh(db, cfg, row.refresh_token).finally(() => { _refreshLock = null; });
  return _refreshLock;
}

async function _doRefresh(db, cfg, refreshToken) {
  let resp;
  try {
    resp = await axios.post(ML_OAUTH, new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: ML_HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (e) {
    throw new Error('Error de conectividad con MercadoLibre');
  }

  if (resp.status !== 200) {
    throw new Error(`Error de autenticación ML (${resp.status}) — verificar credenciales`);
  }

  const { access_token, refresh_token, expires_in } = resp.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      actualizado_en = excluded.actualizado_en
  `).run(access_token, refresh_token, expiresAt, now);

  return access_token;
}

/**
 * Wrapper HTTP para la API de ML.
 * Inyecta el token, reintenta una vez en 429 (rate limit).
 * method: 'get' | 'post' | 'put'
 * path: '/items/MLA123' (sin base URL)
 * body: objeto JS o null
 */
export async function mlFetch(db, cfg, method, path, body = null) {
  const token = await getAccessToken(db, cfg);
  const resp = await _request(token, method, path, body);

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers['retry-after'] || '2', 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    const token2 = await getAccessToken(db, cfg);
    return _request(token2, method, path, body);
  }

  return resp;
}

async function _request(token, method, path, body) {
  return axios.request({
    url: ML_API + path,
    method,
    headers: { Authorization: `Bearer ${token}` },
    data: body ?? undefined,
    timeout: ML_HTTP_TIMEOUT_MS,
    validateStatus: () => true,
  });
}

/**
 * Intercambia el code de autorización por tokens y los persiste en DB.
 * Solo se usa una vez durante el bootstrap OAuth inicial.
 * Devuelve { userId, expiresAt }.
 */
export async function bootstrapToken(db, cfg, code) {
  if (!cfg?.clientId) throw new Error('ML_CLIENT_ID no configurado');

  const resp = await axios.post(ML_OAUTH, new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri || 'https://localhost:3001/callback',
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: ML_HTTP_TIMEOUT_MS,
    validateStatus: () => true,
  });

  if (resp.status !== 200) {
    throw new Error(`Bootstrap ML falló (${resp.status}) — verificar código de autorización`);
  }

  const { access_token, refresh_token, expires_in, user_id } = resp.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      actualizado_en = excluded.actualizado_en
  `).run(access_token, refresh_token, expiresAt, now);

  return { userId: user_id, expiresAt };
}
