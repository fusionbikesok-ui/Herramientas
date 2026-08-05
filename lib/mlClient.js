/**
 * Cliente para la API de MercadoLibre.
 * Maneja OAuth 2.0 con auto-refresh del access_token (dura 6h).
 * El refresh_token es de un solo uso — se persiste en DB tras cada rotación.
 *
 * El lock _refreshLock serializa los refreshes concurrentes para evitar que
 * múltiples crons consuman el mismo refresh_token de un solo uso.
 */

import axios from 'axios';
import { clasificarRecurso } from './mlLimites.js';
import { reservarCupo, _resetPresupuestoParaTests } from './mlRateLimiter.js';
import { enviarAlertaTokenMl } from './mailer.js';

const ML_API = 'https://api.mercadolibre.com';
const ML_OAUTH = 'https://api.mercadolibre.com/oauth/token';

// Timeout de red obligatorio. Sin esto, una request colgada (ML sin responder,
// conexión estancada) congela indefinidamente el loop de sync y deja el candado
// tomado para siempre. Con timeout, la request falla y el loop sigue con el próximo.
const ML_HTTP_TIMEOUT_MS = 20000;

// Promise activa de refresh; null cuando no hay refresh en curso.
let _refreshLock = null;

// --- Cooldown global de rate-limit (429) ---
// ML limita por cuenta, no por endpoint: un 429 en cualquier llamada frena TODAS
// las llamadas de los crons hasta que expire.
//
// Las llamadas manuales (opts.manual) ignoran el cooldown, PERO solo para el
// recurso que piden — no para el refresh de /oauth/token. Es una asimetría
// intencional: una consulta puntual del usuario a un endpoint de la API no
// tumba nada aunque ML esté rate-limitando; en cambio /oauth/token es el
// recurso compartido y escaso, y una acción manual puede disparar muchas
// llamadas secuenciales (p.ej. "Refrescar ML" del matcher, ~200 en un scan).
// Si cada una golpeara el refresh sin frenar, reproduciría el incidente
// 2026-08-04 con un solo click. Por eso getAccessToken corta por cooldown
// SIEMPRE, sin mirar opts.manual — el chequeo de "manual" solo vive en
// mlFetch, antes de llegar a getAccessToken.
//
// Backoff escalonado con tope: 1 → 2 → 5 → 10 min, y ahí se planta.
// NO subir a 30 min: se come el margen de renovación del token (6h, refresco con
// 60s de margen).
const BACKOFF_ESCALONES_MS = [60_000, 120_000, 300_000, 600_000];

let _cooldownHasta = 0; // timestamp ms; 0 = sin cooldown activo
let _backoffNivel = -1; // -1 = sin backoff acumulado; índice en BACKOFF_ESCALONES_MS

// --- Estado del último refresh, para GET /api/ml/token-estado y el banner del Home ---
// clase: 'transitorio' (429/5xx/red — se recupera solo tras el cooldown) | 'fatal'
// (400/401 — refresh_token quemado o credenciales mal, requiere re-autorizar a mano).
// La distinción es la que decide si el banner manda al usuario a rehacer el OAuth o solo
// informa: mandar a re-autorizar ante un 429 fue justamente el error de diagnóstico que
// alargó el incidente 2026-08-04.
let _ultimoError = null;   // { mensaje, en, clase }
let _fallaDesde = null;    // timestamp ms del primer fallo del episodio actual
let _alertaEnviada = false;

// Un episodio de fallos manda UN solo mail (y otro al recuperarse), pasado este umbral
// o si el token ya venció, lo que ocurra primero.
const ALERTA_UMBRAL_MS = 15 * 60 * 1000;

function _cooldownActivo() {
  return Date.now() < _cooldownHasta;
}

/**
 * Activa o escala el cooldown global tras un fallo de ML que conviene no repetir
 * en el próximo ciclo: 429 (rate limit), 5xx o fallo de conectividad.
 * Si ML manda Retry-After y es mayor al escalón calculado, se respeta ese valor.
 * `motivo` sale en el log: sin él, un 503 se reportaba como "429 recibido" y
 * mandaba a diagnosticar un rate limit cuando ML en realidad estaba caído.
 */
function _activarCooldown(retryAfterHeader, motivo = '429') {
  // Si ya había cooldown activo, este 429 es de una request concurrente que
  // salió a red antes de que el cooldown se activara (varias en vuelo a la
  // vez) — no es señal de que el escalón actual no alcanzó. No escalar nivel
  // ni extender la ventana: solo escala un 429 que llega con el cooldown ya
  // vencido, que es la señal real de que el escalón anterior no alcanzó.
  if (_cooldownActivo()) return;

  _backoffNivel = Math.min(_backoffNivel + 1, BACKOFF_ESCALONES_MS.length - 1);
  let esperaMs = BACKOFF_ESCALONES_MS[_backoffNivel];

  // Retry-After: parseInt de un formato HTTP-date (ej. "Wed, 21 Oct 2026
  // 07:28:00 GMT") da NaN y cae al escalón calculado — comportamiento
  // aceptable, ML normalmente manda segundos.
  // Tope duro en el mismo techo del backoff (10 min): un Retry-After grande
  // (p. ej. 3600) no puede dejar la web sin sync de ventas ML por más de eso.
  const TOPE_MS = BACKOFF_ESCALONES_MS[BACKOFF_ESCALONES_MS.length - 1];
  const retryAfter = parseInt(retryAfterHeader || '0', 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    esperaMs = Math.min(Math.max(esperaMs, retryAfter * 1000), TOPE_MS);
  }

  _cooldownHasta = Date.now() + esperaMs;

  console.error(`[ML] ${motivo} — cooldown activado por ${Math.round(esperaMs / 1000)}s (nivel ${_backoffNivel})`);
}

// Gracia tras la que el nivel de backoff decae solo, aunque no llegue un 200:
// si pasó bastante desde que venció el último cooldown sin que nadie haya
// llamado de nuevo (o las llamadas siguieron fallando por otra razón), no
// tiene sentido arrancar el próximo 429 desde el nivel acumulado.
const GRACIA_DECAIMIENTO_MS = 15 * 60 * 1000;

/** Resetea el backoff tras una respuesta exitosa NO manual. */
function _resetBackoff() {
  const salioDeCooldown = _cooldownHasta !== 0;
  _backoffNivel = -1;
  _cooldownHasta = 0;
  if (salioDeCooldown) {
    console.error('[ML] cooldown finalizado — backoff reseteado');
  }
}

function _decaimientoPorGracia() {
  if (_backoffNivel >= 0 && _cooldownHasta !== 0 && Date.now() > _cooldownHasta + GRACIA_DECAIMIENTO_MS) {
    _backoffNivel = -1;
    _cooldownHasta = 0;
  }
}

/**
 * Devuelve el estado actual del cooldown global de ML.
 * Lo consume `GET /api/sync/estado` (campo `cooldownMl`), para que el operador
 * vea "ML en cooldown hasta las HH:MM" en vez de un sync que parece colgado.
 */
export function estadoCooldownMl() {
  _decaimientoPorGracia();
  const activo = _cooldownActivo();
  return {
    activo,
    hasta: activo ? new Date(_cooldownHasta).toISOString() : null,
    nivel: _backoffNivel,
  };
}

/**
 * Solo para tests: limpia el cooldown global y el nivel de backoff.
 * Es estado a nivel de módulo, así que un test que provoca un 429 se lo deja
 * activo al siguiente y lo hace fallar por un cooldown que nunca pidió.
 * Llamar en beforeEach de cualquier suite que ejercite caminos de 429/5xx.
 */
export function _resetCooldownParaTests() {
  _cooldownHasta = 0;
  _backoffNivel = -1;
  _ultimoError = null;
  _fallaDesde = null;
  _alertaEnviada = false;
  // El presupuesto también es estado de módulo: el bucket de /oauth/token es de
  // apenas 17/min, así que sin esto un archivo de tests con varios refreshes lo
  // agota y los siguientes fallan por "presupuesto agotado" en vez de por lo que
  // el test quería probar.
  _resetPresupuestoParaTests();
}

/** Registra un fallo de refresh y dispara la alerta por mail una sola vez por episodio. */
function _registrarFalloRefresh(clase, mensaje, expiresAtMs) {
  const ahora = Date.now();
  if (!_fallaDesde) _fallaDesde = ahora;
  _ultimoError = { mensaje, en: new Date(ahora).toISOString(), clase };

  const vencido = Number.isFinite(expiresAtMs) && ahora >= expiresAtMs;
  const episodioLargo = ahora - _fallaDesde >= ALERTA_UMBRAL_MS;
  // Un fatal no se arregla solo: avisar de una, sin esperar el umbral.
  if (!_alertaEnviada && (clase === 'fatal' || vencido || episodioLargo)) {
    _alertaEnviada = true;
    enviarAlertaTokenMl({ to: process.env.ALERTAS_EMAIL, mensaje, recuperado: false })
      .catch(e => console.error('[ALERTA ML] fallo enviando alerta:', e.message));
  }
}

/** Refresh exitoso: cierra el episodio y avisa la recuperación si se había alertado. */
function _registrarExitoRefresh() {
  if (_alertaEnviada) {
    enviarAlertaTokenMl({ to: process.env.ALERTAS_EMAIL, mensaje: 'Token ML renovado correctamente', recuperado: true })
      .catch(e => console.error('[ALERTA ML] fallo enviando alerta de recuperación:', e.message));
  }
  _ultimoError = null;
  _fallaDesde = null;
  _alertaEnviada = false;
}

/**
 * Estado del último refresh del token, para GET /api/ml/token-estado (banner del Home).
 * No pega a ML: solo lee el estado en memoria de este módulo.
 */
export function getEstadoRefresh() {
  return {
    ultimoError: _ultimoError,
    backoffHasta: _cooldownHasta ? new Date(_cooldownHasta).toISOString() : null,
    fallaDesde: _fallaDesde ? new Date(_fallaDesde).toISOString() : null,
  };
}

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

  // El cooldown de rate-limit del OAuth aplica siempre, incluso a llamadas
  // manuales (ver comentario junto a BACKOFF_ESCALONES_MS): mlFetch deja pasar
  // las manuales hacia acá saltando SU cooldown de recurso, pero el refresh de
  // token es el recurso compartido que causó el incidente 2026-08-04 — no se
  // saltea nunca.
  if (_cooldownActivo()) {
    const restanteS = Math.max(1, Math.ceil((_cooldownHasta - Date.now()) / 1000));
    throw new Error(`Refresh de token ML en cooldown por rate-limit — reintentará solo en ~${restanteS}s (vence ${new Date(_cooldownHasta).toISOString()})`);
  }

  // Si ya hay un refresh en curso, esperar su resultado en lugar de hacer otro.
  // Evita race condition: dos crons no pueden consumir el mismo refresh_token de un solo uso.
  if (_refreshLock) return _refreshLock;

  _refreshLock = _doRefresh(db, cfg, row.refresh_token, expiresAt).finally(() => { _refreshLock = null; });
  return _refreshLock;
}

async function _doRefresh(db, cfg, refreshToken, expiresAtMs) {
  let resp;
  // /oauth/token es el recurso escaso que causó el incidente 2026-08-04: paga
  // presupuesto propio (LIMITES_ML.oauth) además del global. Sin cupo no se
  // intenta el refresh — mejor un token vencido unos segundos que reabrir el
  // bucle de martilleo al OAuth.
  if (!await reservarCupo(['global', 'oauth'], { manual: false })) {
    throw new Error('Presupuesto de llamadas a /oauth/token agotado — se pospone el refresh del token ML');
  }
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
    // Fallo de conectividad (timeout, DNS, conexión rechazada): misma clase de
    // fallo transitorio que un 429 o un 5xx sostenido — si ML está caído en vez
    // de rate-limitando, sin cooldown los 9 crons reintentarían cada ciclo
    // indefinidamente contra el mismo endpoint (el patrón del incidente
    // 2026-08-04, sin cubrir hasta ahora).
    _activarCooldown(null, 'fallo de conectividad al refrescar el token');
    const msg = 'Error de conectividad con MercadoLibre al refrescar el token — cooldown activado, reintentará solo';
    _registrarFalloRefresh('transitorio', msg, expiresAtMs);
    throw new Error(msg);
  }

  if (resp.status !== 200) {
    if (resp.status === 429) {
      // Rate limit también en el endpoint OAuth: armar el mismo cooldown global
      // que arma un 429 de la API normal. Con el cooldown activo, el chequeo de
      // mlFetch (antes de llegar a getAccessToken) corta el próximo ciclo sin
      // volver a pegarle a /oauth/token — es lo que rompe el auto-sostenimiento
      // del incidente 2026-08-04 (9 crons martillando el refresh sin backoff).
      _activarCooldown(resp.headers?.['retry-after'], '429 al refrescar el token');
      const msg = 'Error transitorio de rate limit ML (429) al refrescar el token — reintentará solo tras el cooldown';
      _registrarFalloRefresh('transitorio', msg, expiresAtMs);
      throw new Error(msg);
    }
    if (resp.status === 400 || resp.status === 401) {
      // 401 puede ser invalid_client (client_secret mal en el .env), no solo el
      // refresh_token quemado — nombrar las dos causas para no mandar a
      // rehacer todo el OAuth cuando el problema es una credencial.
      const msg = `Autenticación ML rechazada (${resp.status}) — revisar client_secret o rehacer la autorización OAuth`;
      _registrarFalloRefresh('fatal', msg, expiresAtMs);
      throw new Error(msg);
    }
    if (resp.status >= 500) {
      // 5xx sostenido de ML: mismo tratamiento que el 429, para no martillar un
      // servicio caído ciclo tras ciclo con los 9 crons.
      _activarCooldown(null, `${resp.status} al refrescar el token`);
      const msg = `Error de servidor ML (${resp.status}) al refrescar el token — cooldown activado, reintentará solo`;
      _registrarFalloRefresh('transitorio', msg, expiresAtMs);
      throw new Error(msg);
    }
    const msg = `Autenticación ML rechazada (${resp.status}) — revisar client_secret o rehacer la autorización OAuth`;
    _registrarFalloRefresh('fatal', msg, expiresAtMs);
    throw new Error(msg);
  }

  const { access_token, refresh_token, expires_in } = resp.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
  const now = new Date().toISOString();

  // ML ya rotó el refresh_token: el viejo quedó quemado. Si la escritura en sqlite
  // falla acá, perdemos el nuevo para siempre y la integración queda muerta hasta
  // rehacer el OAuth a mano — y antes eso pasaba en silencio, con el error
  // confundido con un fallo de red cualquiera. No se puede deshacer la rotación,
  // pero sí dejar rastro inequívoco y alertar.
  try {
    db.prepare(`
      INSERT INTO ml_oauth_token (id, access_token, refresh_token, expires_at, actualizado_en)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        actualizado_en = excluded.actualizado_en
    `).run(access_token, refresh_token, expiresAt, now);
  } catch (e) {
    const msg = `CRÍTICO: ML rotó el refresh_token pero no se pudo persistir en sqlite (${e.message}). `
      + 'El refresh_token anterior quedó quemado — hay que rehacer la autorización OAuth a mano.';
    console.error(`[ML] ${msg}`);
    _registrarFalloRefresh('fatal', msg, expiresAtMs);
    throw new Error(msg);
  }

  _registrarExitoRefresh();
  return access_token;
}

/**
 * Wrapper HTTP para la API de ML.
 * Inyecta el token. Ante 429 activa/escala un cooldown GLOBAL (compartido entre
 * todos los call sites) con backoff 1→2→5→10 min, y devuelve el 429 sin
 * reintentar de inmediato — el próximo ciclo del cron es el que reintenta.
 * Mientras el cooldown está activo, las llamadas no-manuales ni siquiera
 * salen a red: se devuelve una respuesta sintética status 429 para que los
 * callers (todos fail-closed ante status !== 200) se comporten igual que ante
 * un 429 real, sin sumar tráfico al límite.
 * opts.manual === true: ignora el cooldown (acciones disparadas a mano por el usuario).
 * method: 'get' | 'post' | 'put'
 * path: '/items/MLA123' (sin base URL)
 * body: objeto JS o null
 */
export async function mlFetch(db, cfg, method, path, body = null, opts = {}) {
  _decaimientoPorGracia();

  if (!opts.manual && _cooldownActivo()) {
    return { status: 429, headers: {}, data: null, __cooldownSintetico: true };
  }

  // Presupuesto del 15% (ver lib/mlLimites.js). Consume cupo global Y el del
  // recurso específico; gana el más restrictivo. Si no hay cupo en la espera
  // máxima, se devuelve un 429 sintético: los callers ya son fail-closed ante
  // status !== 200, así que se comportan igual que ante un 429 real, pero sin
  // haber sumado una sola request al límite de ML.
  const recursos = ['global', clasificarRecurso(method, path)];
  if (!await reservarCupo(recursos, { manual: opts.manual === true })) {
    return { status: 429, headers: {}, data: null, __sinCupo: true };
  }

  const token = await getAccessToken(db, cfg);
  let resp = await _request(token, method, path, body);

  if (resp.status === 429) {
    _activarCooldown(resp.headers?.['retry-after']);

    // Reintento único acotado, solo para llamadas manuales (disparadas a mano por el
    // usuario, p.ej. "Refrescar ML" del matcher que puede hacer hasta ~200 llamadas en
    // un scan). Los crons NUNCA reintentan acá — el backoff/cooldown global es el punto
    // de esta función para ellos, y un reintento inmediato lo rompería. Espera acotada
    // a 5s como máximo (aunque Retry-After sea mayor) para no bloquear una acción
    // interactiva del usuario más de lo tolerable.
    if (opts.manual) {
      const retryAfter = parseInt(resp.headers?.['retry-after'] || '0', 10);
      const esperaMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000, 5000);
      await _sleep(esperaMs);
      // El reintento es una request más: también paga presupuesto.
      if (!await reservarCupo(recursos, { manual: true })) return resp;
      resp = await _request(token, method, path, body);
      if (resp.status === 429) {
        _activarCooldown(resp.headers?.['retry-after']);
      }
    }

    return resp;
  }

  // El reset es exclusivo de llamadas NO manuales: una llamada manual ignora
  // el cooldown por diseño, así que un 200 suyo no prueba que el régimen
  // automático (los crons) volvió a ser tolerable para ML. Si reseteara,
  // una consulta manual durante un 429 real mataría el cooldown y los crons
  // dispararían todos juntos de nuevo — el bucle auto-sostenido que este
  // backoff viene a evitar.
  if (!opts.manual && resp.status >= 200 && resp.status < 300) {
    _resetBackoff();
  }

  return resp;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
