/**
 * Cliente para la API de MercadoLibre.
 * Maneja OAuth 2.0 con auto-refresh del access_token (dura 6h).
 * El refresh_token es de un solo uso — se persiste en DB tras cada rotación.
 *
 * El lock _refreshLock serializa los refreshes concurrentes para evitar que
 * múltiples crons consuman el mismo refresh_token de un solo uso.
 */

import axios from 'axios';
import { enviarAlertaTokenMl } from './mailer.js';

const ML_API = 'https://api.mercadolibre.com';
const ML_OAUTH = 'https://api.mercadolibre.com/oauth/token';

// Timeout de red obligatorio. Sin esto, una request colgada (ML sin responder,
// conexión estancada) congela indefinidamente el loop de sync y deja el candado
// tomado para siempre. Con timeout, la request falla y el loop sigue con el próximo.
const ML_HTTP_TIMEOUT_MS = 20000;

// Margen de renovación: el access_token dura 6h. Renovar cuando falten 30 minutos
// (antes eran 60 segundos) deja margen real para reintentar con backoff ante un 429/5xx
// transitorio de ML sin que el token llegue a vencer en el medio.
const MARGEN_RENOVACION_MS = 30 * 60 * 1000;

// Backoff exponencial con tope tras un fallo transitorio (429/5xx/red) al renovar.
// Incidente real: 9 crons (cada 3-15min) llamaban a getAccessToken sin backoff; cada uno
// disparaba un refresh nuevo contra ML, que devolvía 429 en loop — auto-DoS que mantuvo
// el token vencido 16h. Con backoff compartido en memoria del módulo, mientras dure el
// cooldown getAccessToken falla rápido con el último error SIN pegarle de nuevo a ML.
const BACKOFF_STEPS_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000]; // 1m,2m,5m,10m,30m
// Umbral de fallos sostenidos para mandar la alerta por mail (o token ya vencido, lo que
// ocurra primero). Un solo mail por episodio; otro al recuperarse.
const ALERTA_UMBRAL_MS = 15 * 60 * 1000;

// Promise activa de refresh; null cuando no hay refresh en curso.
let _refreshLock = null;
// Cooldown compartido entre todos los llamadores (crons + rutas manuales).
let _backoffUntil = 0;
let _backoffStepIdx = 0;
// Último error de refresh, para diagnóstico y para el endpoint de estado.
// clase: 'transitorio' (429/5xx/red — reintentable solo) | 'fatal' (400/401 — refresh_token
// quemado/credenciales inválidas, requiere re-autorización manual).
let _ultimoError = null; // { mensaje, en, clase }
let _fallaDesde = null; // timestamp (ms) del primer fallo del episodio actual, null si sano
let _alertaEnviada = false;

/**
 * Devuelve el access_token vigente.
 * Si vence en menos de MARGEN_RENOVACION_MS, hace el refresh antes de devolver.
 * Serializa el refresh con un lock para evitar race conditions con tokens de un solo uso.
 * Si hay un cooldown de backoff activo por un fallo transitorio previo, falla rápido con
 * el último error conocido en vez de golpear a ML de nuevo (fail-closed: nunca se sigue
 * con un token vencido silenciosamente).
 * cfg: { clientId, clientSecret, userId }
 */
export async function getAccessToken(db, cfg) {
  if (!cfg?.clientId) throw new Error('ML_CLIENT_ID no configurado');

  const row = db.prepare('SELECT access_token, refresh_token, expires_at FROM ml_oauth_token WHERE id = 1').get();
  if (!row) throw new Error('Token ML no inicializado — ejecutar bootstrap OAuth primero');

  const expiresAt = new Date(row.expires_at).getTime();

  if (Date.now() < expiresAt - MARGEN_RENOVACION_MS) {
    return row.access_token;
  }

  if (Date.now() < _backoffUntil) {
    throw new Error(_ultimoError?.mensaje || 'Token ML sin renovar — en espera de backoff tras un fallo previo');
  }

  // Si ya hay un refresh en curso, esperar su resultado en lugar de hacer otro.
  // Evita race condition: dos crons no pueden consumir el mismo refresh_token de un solo uso.
  if (_refreshLock) return _refreshLock;

  _refreshLock = _doRefresh(db, cfg, row.refresh_token, expiresAt).finally(() => { _refreshLock = null; });
  return _refreshLock;
}

function _clasificarStatus(status) {
  // 400/401: refresh_token inválido/quemado o credenciales mal — no se arregla reintentando,
  // requiere re-autorizar a mano. Cualquier otro status (429 rate limit, 5xx) es transitorio.
  return (status === 400 || status === 401) ? 'fatal' : 'transitorio';
}

function _registrarFallo(clase, mensaje, expiresAt) {
  const ahora = Date.now();
  if (!_fallaDesde) _fallaDesde = ahora;
  _ultimoError = { mensaje, en: new Date(ahora).toISOString(), clase };

  const step = BACKOFF_STEPS_MS[Math.min(_backoffStepIdx, BACKOFF_STEPS_MS.length - 1)];
  const jitter = step * (0.8 + Math.random() * 0.4); // ±20%
  _backoffUntil = ahora + jitter;
  _backoffStepIdx++;

  const vencido = ahora >= expiresAt;
  const episodioLargo = ahora - _fallaDesde >= ALERTA_UMBRAL_MS;
  if (!_alertaEnviada && (vencido || episodioLargo)) {
    _alertaEnviada = true;
    enviarAlertaTokenMl({ to: process.env.ALERTAS_EMAIL, mensaje, recuperado: false })
      .catch(e => console.error('[ALERTA ML] fallo enviando alerta:', e.message));
  }
}

function _registrarExito() {
  if (_alertaEnviada) {
    enviarAlertaTokenMl({ to: process.env.ALERTAS_EMAIL, mensaje: 'Token ML renovado correctamente', recuperado: true })
      .catch(e => console.error('[ALERTA ML] fallo enviando alerta de recuperación:', e.message));
  }
  _backoffUntil = 0;
  _backoffStepIdx = 0;
  _ultimoError = null;
  _fallaDesde = null;
  _alertaEnviada = false;
}

/**
 * Estado del último refresh, para el endpoint /api/ml/token-estado.
 */
// Solo para tests: limpia el estado en memoria del módulo (backoff, último error,
// episodio de alerta) entre casos que ejercitan fallos de refresh.
export function _resetEstadoParaTests() {
  _backoffUntil = 0;
  _backoffStepIdx = 0;
  _ultimoError = null;
  _fallaDesde = null;
  _alertaEnviada = false;
}

export function getEstadoRefresh() {
  return {
    ultimoError: _ultimoError,
    fallaDesde: _fallaDesde ? new Date(_fallaDesde).toISOString() : null,
    backoffHasta: _backoffUntil > Date.now() ? new Date(_backoffUntil).toISOString() : null,
  };
}

async function _doRefresh(db, cfg, refreshToken, expiresAt) {
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
    const mensaje = 'Error de conectividad con MercadoLibre al renovar el token — reintentando con backoff';
    _registrarFallo('transitorio', mensaje, expiresAt);
    throw new Error(mensaje);
  }

  if (resp.status !== 200) {
    const clase = _clasificarStatus(resp.status);
    const mensaje = clase === 'fatal'
      ? `Refresh token ML inválido o credenciales rechazadas (${resp.status}) — requiere re-autorización manual`
      : `MercadoLibre no disponible para renovar el token (status ${resp.status}, posible rate limit) — reintentando con backoff`;
    _registrarFallo(clase, mensaje, expiresAt);
    throw new Error(mensaje);
  }

  const { access_token, refresh_token, expires_in } = resp.data;
  const nuevoExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      actualizado_en = excluded.actualizado_en
  `).run(access_token, refresh_token, nuevoExpiresAt, now);

  _registrarExito();
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
