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

// `ML_API_BASE` sólo existe para el entorno QA (simulador de canales, plan
// 2026-09-13-qa-bajo-demanda.md). Producción no la define y usa la API real.
const ML_API = (process.env.ML_API_BASE || 'https://api.mercadolibre.com').replace(/\/+$/, '');
const ML_OAUTH = `${ML_API}/oauth/token`;

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
// Marca de tiempo propia de cuándo terminó la última ventana de cooldown (por
// éxito que la cerró antes, o por vencimiento natural). Deliberadamente NO se
// deduce de _cooldownHasta: un éxito pone _cooldownHasta = 0 para dejar salir
// llamadas ya mismo, y si la gracia dependiera de ese campo el nivel nunca
// decaería (0 no es "hace GRACIA_DECAIMIENTO_MS", es "ahora mismo/nunca").
let _ultimoCooldownVencidoEn = 0; // timestamp ms; 0 = todavía no hubo ningún cooldown

// --- Trazabilidad de errores: qué request exacta causó cada fallo ---
// Motivación: 117 corridas de reconciliarStockMl comiéndose 429 sin que el log
// dijera qué llamada los causaba, mientras sondas aisladas al mismo endpoint
// devolvían 200. El log central de acá abajo es la respuesta.

/** Colapsa listas largas de ids (multiget) — común al path de ejemplo y a la clave de dedup. */
function _colapsarIds(path) {
  return String(path || '').replace(/([?&]ids=)([^&]*)/i, (_, pre, val) => {
    const n = val ? val.split(',').length : 0;
    return `${pre}<${n} ids>`;
  });
}

const MAX_LEN = 150;
function _truncar(p) {
  return p.length > MAX_LEN ? `${p.slice(0, MAX_LEN)}…(truncado)` : p;
}

/** Path concreto para mostrar como ejemplo en el log — colapsa ids largos y trunca, pero
 * conserva la instancia real (qué publicación/orden/envío), que es lo que sirve para
 * diagnosticar. No confundir con _normalizarClave: esto es para LEER, no para AGRUPAR. */
function _pathParaLog(path) {
  return _truncar(_colapsarIds(path));
}

/** Normaliza los segmentos e ids variables del path para que la clave de dedup identifique
 * el ENDPOINT, no la instancia. Sin esto, "/items/MLA1" y "/items/MLA2" (o un offset/fecha
 * que cambia en cada corrida de /orders/search) generan una clave nueva cada vez y el
 * dedup nunca agrupa nada — justo el escenario que rompía el mecanismo con un 500
 * sistemático sobre PUT /items/{id} en una corrida de sync de cientos de publicaciones. */
function _normalizarClave(path) {
  let p = _colapsarIds(path);
  // ids de ML embebidos en el path (/items/MLA123, /orders/MLA123, etc.)
  p = p.replace(/\/[A-Z]{2,4}\d+/g, '/{id}');
  // segmentos puramente numéricos (/orders/123, /shipments/123, /users/123, /variations/456)
  p = p.replace(/\/\d+(?=\/|\?|$)/g, '/{id}');
  // valores de query que cambian en cada corrida: paginación, ids puntuales, fechas
  // `price` va en la lista porque /sites/{site}/listing_prices?price=… lo cambia en CADA
  // publicación: sin normalizarlo, una corrida de reactivación con ese endpoint fallando
  // genera una clave por publicación y además purga del Map las entradas útiles de otros
  // endpoints. `category_id` NO se normaliza a propósito: tiene cardinalidad baja y saber
  // qué categoría falla es justamente información de diagnóstico.
  p = p.replace(/([?&](?:offset|limit|page|item_id|meta_value|scroll_id|scroll|search_after|after|price)=)[^&]*/gi, '$1{val}');
  p = p.replace(/([?&][\w.]*date[\w.]*=)[^&]*/gi, '$1{val}');
  return _truncar(p);
}

// Deduplicación por ventana: la primera aparición de (método, ENDPOINT normalizado,
// status) se loguea de una; las repeticiones dentro de la ventana solo se cuentan
// y se emiten como resumen al vencer la ventana — evita que un error sistemático
// (p.ej. "variations is not modifiable" en cada corrida) inunde el log y tape lo
// que se busca diagnosticar.
const DEDUP_VENTANA_MS = 10 * 60 * 1000;
const DEDUP_MAX_ENTRADAS = 200; // techo en memoria — no un Map sin límite
const _dedupErrores = new Map(); // clave -> { repeticiones, timer, method, ejemplo, status }

function _flushDedup(clave) {
  const entrada = _dedupErrores.get(clave);
  if (!entrada) return;
  if (entrada.repeticiones > 0) {
    console.error(`[ML][error] ${entrada.method} ${entrada.ejemplo} → ${entrada.status} — ${entrada.repeticiones} veces más en los últimos 10 min`);
  }
  _dedupErrores.delete(clave);
}

function _purgarDedupSiExcede() {
  if (_dedupErrores.size <= DEDUP_MAX_ENTRADAS) return;
  const primeraClave = _dedupErrores.keys().next().value;
  const vieja = _dedupErrores.get(primeraClave);
  if (vieja?.timer) clearTimeout(vieja.timer);
  _flushDedup(primeraClave);
}

/** Registra en el log central un no-2xx o error de red real (nunca sintético). */
function _registrarErrorMl(method, path, status) {
  const metodo = String(method).toUpperCase();
  const clave = `${metodo} ${_normalizarClave(path)} → ${status}`;
  const entrada = _dedupErrores.get(clave);
  if (!entrada) {
    const ejemplo = _pathParaLog(path);
    console.error(`[ML][error] ${metodo} ${ejemplo} → ${status}`);
    const timer = setTimeout(() => _flushDedup(clave), DEDUP_VENTANA_MS);
    if (typeof timer.unref === 'function') timer.unref();
    _dedupErrores.set(clave, { repeticiones: 0, timer, method: metodo, ejemplo, status });
    _purgarDedupSiExcede();
    return;
  }
  entrada.repeticiones += 1;
}

// --- Contadores de los 429 sintéticos (propios, no de ML) ---
// Se disparan potencialmente miles de veces por hora — nunca se loguean por
// llamada. Se cuentan, acumulativos desde el arranque del proceso, globales y
// por recurso, para poder distinguir en /api/sync/estado "ML nos rechazó" de
// "nos frenamos solos" sin gastar una sola llamada a ML.
const _contadoresSinteticos = { cooldown_sintetico: 0, sin_cupo: 0 };
const _contadoresSinteticosPorRecurso = new Map(); // recurso -> { cooldown_sintetico, sin_cupo }

function _contarSintetico(motivo, recurso) {
  _contadoresSinteticos[motivo] += 1;
  const entrada = _contadoresSinteticosPorRecurso.get(recurso) || { cooldown_sintetico: 0, sin_cupo: 0 };
  entrada[motivo] += 1;
  _contadoresSinteticosPorRecurso.set(recurso, entrada);
}

/**
 * Contadores de 429 sintéticos (propio freno, no rechazo de ML), para
 * `GET /api/sync/estado`. Ver comentario junto a `_contarSintetico`.
 */
export function estadoErroresMl() {
  return {
    sinteticos: { ..._contadoresSinteticos },
    porRecurso: Object.fromEntries(
      Array.from(_contadoresSinteticosPorRecurso, ([recurso, valores]) => [recurso, { ...valores }])
    ),
  };
}

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
 * `contexto` (opcional) es { method, path } de la request que lo disparó: sin
 * esto un `[ML] 429 — cooldown activado` no dice qué llamada lo causó, que es
 * justo la pregunta que costó horas de diagnóstico (117 corridas de
 * reconciliarStockMl comiéndose 429 sin saber cuál request era la culpable).
 */
function _activarCooldown(retryAfterHeader, motivo = '429', contexto = null) {
  // Si ya había cooldown activo, este 429 es de una request concurrente que
  // salió a red antes de que el cooldown se activara (varias en vuelo a la
  // vez) — no es señal de que el escalón actual no alcanzó. No escalar nivel
  // ni extender la ventana: solo escala un 429 que llega con el cooldown ya
  // vencido, que es la señal real de que el escalón anterior no alcanzó.
  //
  // Devuelve si LOGUEÓ, no si activó: quien llama necesita saberlo para no
  // dejar el 429 sin rastro en ningún lado. Este `return false` es el camino
  // normal, no un borde: el reintento manual siempre cae acá (el primer intento
  // acabó de poner un cooldown de 60s y el sleep del reintento es de segundos),
  // y las llamadas manuales ignoran el cooldown por diseño, así que salen a red
  // y comen 429 reales mientras está activo.
  if (_cooldownActivo()) return false;

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
  // Referencia por defecto para la gracia: si nadie cierra la ventana antes
  // (ver éxito en mlFetch), el vencimiento natural de este cooldown es el
  // punto desde el que se cuenta GRACIA_DECAIMIENTO_MS.
  _ultimoCooldownVencidoEn = _cooldownHasta;

  const ctxTxt = contexto ? ` (${String(contexto.method).toUpperCase()} ${_pathParaLog(contexto.path)})` : '';
  console.error(`[ML] ${motivo}${ctxTxt} — cooldown activado por ${Math.round(esperaMs / 1000)}s (nivel ${_backoffNivel})`);
  return true;
}

// Gracia tras la que el nivel de backoff decae solo, aunque no llegue un 200:
// si pasó bastante desde que venció el último cooldown sin que nadie haya
// llamado de nuevo (o las llamadas siguieron fallando por otra razón), no
// tiene sentido arrancar el próximo 429 desde el nivel acumulado.
const GRACIA_DECAIMIENTO_MS = 15 * 60 * 1000;

/**
 * Cierra la ventana de cooldown tras una respuesta exitosa NO manual.
 * OJO: esto ya NO baja el nivel de escalada (ver diseño arriba). Un 200 solo
 * prueba que ML nos atiende AHORA, no que el régimen de los últimos minutos
 * dejó de ser hostil — eso es lo que decide `_decaimientoPorGracia`, por
 * tiempo transcurrido, no por eventos de éxito. Con ~9 crons pegando a
 * recursos distintos siempre hay un 200 barato entre dos 429; si ese 200
 * bajara el nivel, el backoff nunca escala (medido: 0 veces llegó al techo
 * en 4000 líneas de log real).
 */
function _cerrarCooldown() {
  const salioDeCooldown = _cooldownHasta !== 0;
  _cooldownHasta = 0;
  // Deliberadamente NO se toca _ultimoCooldownVencidoEn acá. Se podría pensar
  // que un 200 que cierra la ventana "antes de tiempo" debería adelantar la
  // gracia a partir de ahora, pero el único caso donde eso pasa de verdad es
  // una request no-manual que ya estaba en vuelo cuando otra activó el
  // cooldown (el guard de mlFetch bloquea salir a red mientras el cooldown
  // está activo, así que en el camino normal el 200 SIEMPRE llega después
  // del vencimiento proyectado, nunca antes). En ese caso raro de
  // concurrencia, pisar la marca con Date.now() la ADELANTARÍA (p. ej. un
  // cooldown de 10 min recién armado por un 429 real quedaría con gracia
  // contada desde 1s después en vez de desde los 600s), justo lo opuesto de
  // lo que este backoff existe para lograr. Una sola semántica sin bordes:
  // la gracia siempre se cuenta desde el vencimiento que _activarCooldown
  // proyectó al escalar, nunca desde cuándo un 200 la cerró en la práctica.
  if (salioDeCooldown) {
    console.error(`[ML] cooldown finalizado — backoff en nivel ${_backoffNivel}`);
  }
}

function _decaimientoPorGracia() {
  if (_backoffNivel >= 0 && _ultimoCooldownVencidoEn !== 0 && Date.now() > _ultimoCooldownVencidoEn + GRACIA_DECAIMIENTO_MS) {
    _backoffNivel = -1;
    _ultimoCooldownVencidoEn = 0;
    // H3: sin esto, _cooldownHasta queda con un timestamp pasado en vez de 0
    // y GET /api/ml/token-estado (mlClient.js ~363, backoffHasta) reporta un
    // vencimiento viejo indefinidamente; además el próximo 200 dispara un log
    // espurio "cooldown finalizado" aunque hace rato que no hay nada frenado.
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
 * Clasifica un error de ML en una de 6 categorías reportables (incidente 2026-08-27, plan de
 * confiabilidad operativa): `rate_limit` (429), `auth` (401/403 — credencial revocada o mal
 * configurada, no se arregla reintentando ni con backoff), `config` (variables de entorno faltantes
 * o mal configuradas), `transitorio` (5xx, timeout, error de red — el único caso donde reintentar
 * tiene sentido más allá del rate-limit), `datos` (400/404/422/etc. — ML rechazó la request en sí,
 * un producto/payload puntual, no debe frenar el resto del lote ni activar el cooldown de forma
 * desproporcionada), `interno` (excepción no-HTTP: bug propio, parseo, etc.).
 *
 * Mismo patrón que `categorizarErrorWoo` en routes/woo.js.
 */
export function categorizarErrorMl(e) {
  // Si algo ya calculó la categoría de antemano se respeta tal cual: es más precisa que
  // cualquier inferencia por status/mensaje.
  if (e?.categoria) return e.categoria;
  const status = e?.status;
  if (status === 429) return 'rate_limit';
  if (status === 401) return 'auth';
  // 403 NO es lo mismo que 401. 401 es "tus credenciales no sirven"; 403 es "estás
  // autenticado pero no podés hacer esto ahora", y ML lo devuelve también para límites
  // temporales. El 2026-09-12 el scan de pausadas dio 403 a las 07:31 y otra vez a las 10:31,
  // se curó SOLO las dos veces, y el mismo scan con las mismas credenciales respondía 200
  // minutos después. Clasificarlo como 'auth' abría un incidente CRÍTICO —con email y push—
  // que mandaba a revisar un Client ID que estaba perfecto. Un aviso que se equivoca de
  // diagnóstico enseña a ignorar los avisos.
  //
  // Un fallo real de credenciales no llega por acá: llega como 401, o como el 400 de
  // invalid_grant del refresh de token, que setea .categoria='auth' explícitamente.
  if (status === 403) return 'permiso';
  if (status != null && status >= 500) return 'transitorio';
  if (status != null) return 'datos'; // cualquier otro 4xx: ML evaluó y rechazó
  // Sin status HTTP: timeout/ECONNRESET/DNS — mismo trato que 5xx. Pero antes de caer acá,
  // verificar si es un error propio de nuestro código (TypeError, RangeError, SqliteError) —
  // esos sí son 'interno', no transitorios. Esto cierra la regresión que pasó en Woo:
  // un timeout REAL de red sin status HTTP nunca debe caer en 'interno'.
  if (e instanceof TypeError || e instanceof RangeError || e?.name === 'SqliteError') {
    return 'interno';
  }

  // BLOQUEANTE 1: fallback — parsear status del mensaje en caso de que no haya venido en .status
  // (patrón similar a parseStatusDelMensaje en routes/woo.js para cubrir herencia)
  const msg = e?.message ?? '';
  const statusMatch = /\(status (\d+)\)/.exec(msg);
  if (statusMatch) {
    const statusDelMensaje = parseInt(statusMatch[1], 10);
    if (statusDelMensaje === 429) return 'rate_limit';
    if (statusDelMensaje === 401 || statusDelMensaje === 403) return 'auth';
    if (statusDelMensaje >= 500) return 'transitorio';
    return 'datos'; // otro 4xx
  }

  return 'transitorio'; // default seguro: sin status, asumir timeout/red.
}

/** Solo para tests: cantidad de entradas activas y de timers pendientes en el dedup de errores. */
export function _estadoDedupParaTests() {
  let timers = 0;
  for (const entrada of _dedupErrores.values()) {
    if (entrada.timer) timers += 1;
  }
  return { entradas: _dedupErrores.size, timers };
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
  _ultimoCooldownVencidoEn = 0;
  _ultimoError = null;
  _fallaDesde = null;
  _alertaEnviada = false;
  // El presupuesto también es estado de módulo: el bucket de /oauth/token es de
  // apenas 17/min, así que sin esto un archivo de tests con varios refreshes lo
  // agota y los siguientes fallan por "presupuesto agotado" en vez de por lo que
  // el test quería probar.
  _resetPresupuestoParaTests();

  for (const entrada of _dedupErrores.values()) {
    if (entrada.timer) clearTimeout(entrada.timer);
  }
  _dedupErrores.clear();
  _contadoresSinteticos.cooldown_sintetico = 0;
  _contadoresSinteticos.sin_cupo = 0;
  _contadoresSinteticosPorRecurso.clear();
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
  if (!cfg?.clientId) {
    const err = new Error('ML_CLIENT_ID no configurado');
    err.categoria = 'config';
    throw err;
  }

  const row = db.prepare('SELECT access_token, refresh_token, expires_at FROM ml_oauth_token WHERE id = 1').get();
  if (!row) {
    const err = new Error('Token ML no inicializado — ejecutar bootstrap OAuth primero');
    err.categoria = 'config';
    throw err;
  }

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
    const err = new Error(`Refresh de token ML en cooldown por rate-limit — reintentará solo en ~${restanteS}s (vence ${new Date(_cooldownHasta).toISOString()})`);
    err.status = 429;
    // 3ra pasada del revisor (ALTO 2): sin este flag, este 429 propio (nuestro cooldown,
    // no un rechazo de ML) se reportaba indistinguible de un 429 real — pisando el
    // incidente del 429 real que originó el cooldown (la misma colisión de dedupe que
    // MEDIO 5 ya había cerrado para el camino de mlFetch, pero faltaba acá).
    err.__cooldownSintetico = true;
    throw err;
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
    // 3ra pasada del revisor (MEDIO 3): sin .status/.categoria, esto caía en 'transitorio'
    // por default — "ML no responde" cuando en realidad ML nunca fue contactado, es
    // nuestro propio presupuesto agotado. Mismo criterio que el cooldown sintético de
    // arriba: status 429 + flag sintético para no colisionar con un 429 real de ML.
    const err = new Error('Presupuesto de llamadas a /oauth/token agotado — se pospone el refresh del token ML');
    err.status = 429;
    err.__sinCupo = true;
    throw err;
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
    _activarCooldown(null, 'fallo de conectividad al refrescar el token', { method: 'post', path: '/oauth/token' });
    const msg = 'Error de conectividad con MercadoLibre al refrescar el token — cooldown activado, reintentará solo';
    _registrarFalloRefresh('transitorio', msg, expiresAtMs);
    const err = new Error(msg);
    // No hay status HTTP (fallo de red puro), pero los callers necesitan saber que
    // es un fallo transitorio en el OAuth — la categorización por timeout/red se hace
    // en categorizarErrorMl según la presencia de status. Acá no lo seteamos.
    throw err;
  }

  if (resp.status !== 200) {
    if (resp.status === 429) {
      // Rate limit también en el endpoint OAuth: armar el mismo cooldown global
      // que arma un 429 de la API normal. Con el cooldown activo, el chequeo de
      // mlFetch (antes de llegar a getAccessToken) corta el próximo ciclo sin
      // volver a pegarle a /oauth/token — es lo que rompe el auto-sostenimiento
      // del incidente 2026-08-04 (9 crons martillando el refresh sin backoff).
      _activarCooldown(resp.headers?.['retry-after'], '429 real de ML al refrescar el token', { method: 'post', path: '/oauth/token' });
      const msg = 'Error transitorio de rate limit ML (429) al refrescar el token — reintentará solo tras el cooldown';
      _registrarFalloRefresh('transitorio', msg, expiresAtMs);
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    if (resp.status === 400 || resp.status === 401) {
      // 401 puede ser invalid_client (client_secret mal en el .env), no solo el
      // refresh_token quemado — nombrar las dos causas para no mandar a
      // rehacer todo el OAuth cuando el problema es una credencial.
      const msg = `Autenticación ML rechazada (${resp.status}) — revisar client_secret o rehacer la autorización OAuth`;
      _registrarErrorMl('post', '/oauth/token', resp.status);
      _registrarFalloRefresh('fatal', msg, expiresAtMs);
      const err = new Error(msg);
      err.status = resp.status;
      // 3ra pasada del revisor (ALTO 1): un 400 (refresh_token quemado/invalid_grant, el
      // escenario que motivó el hito) caía en categorizarErrorMl como 'datos' (cualquier
      // 4xx que no sea 401/403/429 se interpreta como "rechazo puntual de un ítem"), abriendo
      // un incidente severidad 'info' cuando la integración está muerta hasta un OAuth manual.
      // .categoria explícito tiene precedencia sobre la inferencia por status.
      err.categoria = 'auth';
      throw err;
    }
    if (resp.status >= 500) {
      // 5xx sostenido de ML: mismo tratamiento que el 429, para no martillar un
      // servicio caído ciclo tras ciclo con los 9 crons.
      _activarCooldown(null, `${resp.status} al refrescar el token`, { method: 'post', path: '/oauth/token' });
      const msg = `Error de servidor ML (${resp.status}) al refrescar el token — cooldown activado, reintentará solo`;
      _registrarFalloRefresh('transitorio', msg, expiresAtMs);
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    const msg = `Autenticación ML rechazada (${resp.status}) — revisar client_secret o rehacer la autorización OAuth`;
    _registrarErrorMl('post', '/oauth/token', resp.status);
    _registrarFalloRefresh('fatal', msg, expiresAtMs);
    const err = new Error(msg);
    err.status = resp.status;
    err.categoria = 'auth'; // BAJO 7 (3ra pasada): mismo defecto del ALTO 1, este es el fallback
    throw err;
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
    const err = new Error(msg);
    err.categoria = 'auth';
    throw err;
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

  // clasificarRecurso no pega a ML — es seguro calcularlo antes de los cortes
  // sintéticos, para poder contar por recurso incluso cuando ni siquiera
  // llegamos a intentar reservar cupo.
  const recurso = clasificarRecurso(method, path);

  if (!opts.manual && _cooldownActivo()) {
    // Sintético: nuestro propio freno, no un rechazo de ML. Puede dispararse
    // miles de veces por hora — nunca se loguea por llamada, solo se cuenta
    // (ver estadoErroresMl / GET /api/sync/estado). Esta es la distinción que
    // costó horas de diagnóstico: una corrida de 88ms por cooldown activo se
    // veía en el log idéntica a un 429 real de ML.
    _contarSintetico('cooldown_sintetico', recurso);
    return { status: 429, headers: {}, data: null, __cooldownSintetico: true };
  }

  // Presupuesto del 15% (ver lib/mlLimites.js). Consume cupo global Y el del
  // recurso específico; gana el más restrictivo. Si no hay cupo en la espera
  // máxima, se devuelve un 429 sintético: los callers ya son fail-closed ante
  // status !== 200, así que se comportan igual que ante un 429 real, pero sin
  // haber sumado una sola request al límite de ML.
  const recursos = ['global', recurso];
  if (!await reservarCupo(recursos, { manual: opts.manual === true })) {
    _contarSintetico('sin_cupo', recurso);
    return { status: 429, headers: {}, data: null, __sinCupo: true };
  }

  const token = await getAccessToken(db, cfg);
  let resp;
  try {
    resp = await _request(token, method, path, body);
  } catch (e) {
    // Error de red (timeout, DNS, conexión rechazada) — mlFetch usa
    // validateStatus:()=>true así que esto solo pasa por fallo de transporte,
    // nunca por status HTTP. Es "error" a los efectos de este log: deja
    // rastro con método y path, nunca con el body.
    _registrarErrorMl(method, path, `error_red:${e.code || 'desconocido'}`);
    throw e;
  }

  // El 429 se excluye acá: si es real, la línea de _activarCooldown de abajo ya
  // trae método+path+status con contexto propio — loguearlo también desde acá
  // duplicaría la línea más ruidosa del sistema, justo lo que el dedup viene a evitar.
  if ((resp.status < 200 || resp.status >= 300) && resp.status !== 429) {
    _registrarErrorMl(method, path, resp.status);
  }

  if (resp.status === 429) {
    // Real: vino de ML, a diferencia de los sintéticos de arriba (que ni
    // siquiera salen a red). El texto y el contexto (método+path) son el
    // punto central del cambio: sin esto, un 429 real y un cooldown propio
    // se ven idénticos en el log.
    // Si _activarCooldown no logueó (ya había cooldown activo), este 429 real
    // quedaría sin rastro en ningún lado — el punto ciego que este cambio existe
    // para eliminar. En ese caso lo registra el log central, donde el dedup lo
    // agrupa por endpoint en vez de inundar.
    if (!_activarCooldown(resp.headers?.['retry-after'], '429 real de ML', { method, path })) {
      _registrarErrorMl(method, path, 429);
    }

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
      try {
        resp = await _request(token, method, path, body);
      } catch (e) {
        _registrarErrorMl(method, path, `error_red:${e.code || 'desconocido'}`);
        throw e;
      }
      if ((resp.status < 200 || resp.status >= 300) && resp.status !== 429) {
        _registrarErrorMl(method, path, resp.status);
      }
      if (resp.status === 429) {
        // Camino normal, no borde: el primer intento acaba de poner un cooldown de
        // 60s y este sleep es de segundos, así que _activarCooldown siempre sale por
        // su return temprano y el rastro lo deja el log central.
        if (!_activarCooldown(resp.headers?.['retry-after'], '429 real de ML', { method, path })) {
          _registrarErrorMl(method, path, 429);
        }
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
    _cerrarCooldown();
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
