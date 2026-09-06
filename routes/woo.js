import axios from 'axios';
import { protegerPorBajaWoo } from '../lib/identidadProductos.js';
import express from 'express';
import { normalizarProductoWc, normalizarVariacionWc, filaCatalogo } from '../lib/modelos/producto.js';
import { mapConLimite } from '../lib/concurrencia.js';
import { buildWooPath } from '../lib/wooStock.js';
import { syncSkuPuntual } from './sync.js';
import { abrirOActualizarIncidente, confirmarCicloSano } from '../lib/incidentes.js';

const MAX_PAGES = 200; // 200 × 100 items = 20.000 productos máximo por refresco

// Máximo de productos variables cuyos endpoints de variaciones se consultan en paralelo.
// Antes se recorrían en serie (una request tras otra), lo que con catálogos grandes hacía
// que el POST /catalogo/recargar superara el proxy_read_timeout de nginx (~120s) y se cayera
// el request. Se acota la concurrencia (mismo patrón que Sync ML con ML_CONCURRENCIA_MAX) para
// no dispararlas todas de golpe y evitar rate-limits/carga en WooCommerce.
const WOO_CONCURRENCIA_MAX = 4;

// `Retry-After` puede venir en segundos (entero) o como fecha HTTP (RFC 7231) — Woo/el
// hosting delante no documentan cuál eligen, así que se soportan los dos.
//
// Hallazgo del revisor: `Number('')`, `Number('  ')` y `Number([])` dan `0` (no `NaN`), así
// que un header vacío/malformado pasaba el `>= 0` y devolvía 0ms — con eso, wooFetchConReintento
// dormía 0ms en vez del backoff, disparando 3 reintentos inmediatos justo contra un Woo que
// pidió frenar. Se exige explícitamente un string no vacío antes de intentar parsear.
function parseRetryAfterMs(valorHeader) {
  if (typeof valorHeader !== 'string' || !valorHeader.trim()) return null;
  const texto = valorHeader.trim();
  // Solo dígitos (RFC 7231: la forma "delay-seconds" es un entero no negativo tal cual, sin
  // signo). Un "-5" NO debe caer a Date.parse('-5') — eso resuelve a una fecha real (año 2001,
  // "2001-05" corto) muy en el pasado, que Math.max(0,...) clampeaba a 0ms sin avisar.
  if (/^\d+$/.test(texto)) return Number(texto) * 1000;
  const fechaMs = Date.parse(texto);
  return Number.isNaN(fechaMs) ? null : Math.max(0, fechaMs - Date.now());
}

export async function wooFetch(cfg, path, method = 'get', body = null) {
  if (!cfg.url.startsWith('https://')) {
    // Hallazgo del revisor (MEDIO-1, 3ra pasada): sin `.categoria`, categorizarErrorWoo caía a
    // 'transitorio' (sin status, sin match con el mensaje de Woo) — un WOO_URL mal configurado
    // en el .env tras un deploy generaba un incidente recurrente de "WooCommerce no responde"
    // cada 5 minutos, mandando al operador a revisar hosting/red/firewall por un problema que
    // es una variable de entorno y nunca se autoresuelve solo. Mismo mecanismo que A5 (el
    // circuito abierto) para fijar la categoría en el origen.
    const err = new Error('WooCommerce URL debe usar HTTPS');
    err.categoria = 'config';
    throw err;
  }
  const url = cfg.url.replace(/\/$/, '') + '/wp-json/wc/v3' + path;
  const resp = await axios.request({
    url,
    method,
    data: body ?? undefined,
    auth: { username: cfg.ck, password: cfg.cs },
    timeout: 20000, // sin timeout, una request colgada congela el sync y toma el candado
    validateStatus: () => true
  });
  if (resp.status < 200 || resp.status >= 300) {
    const err = new Error(`WooCommerce API error ${resp.status}`);
    // .status/.retryAfterMs: propiedades nuevas, no rompen los `new Error('WooCommerce API
    // error 500')` que ya usan los tests existentes (quedan undefined ahí, wooFetchConReintento
    // cae al parseo del mensaje como antes — ver parseStatusDelMensaje).
    err.status = resp.status;
    err.retryAfterMs = parseRetryAfterMs(resp.headers?.['retry-after']);
    throw err;
  }
  return resp;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Backoff acotado a 3 reintentos (mismo patrón que VERIF_WC_BACKOFF_MS en routes/sync.js).
const WOO_RETRY_BACKOFF_MS = [500, 1500, 4000];
// Techo de espera si Woo manda Retry-After: por encima de esto no tiene sentido bloquear el
// ciclo actual esperando — mejor abortar (fail-closed, como ya hace el resto de la función) y
// que la próxima corrida del cron lo reintente fresco.
const RETRY_AFTER_MAX_MS = 60_000;

function parseStatusDelMensaje(msg) {
  const m = /WooCommerce API error (\d+)/.exec(msg ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Clasifica un error de Woo en una de 5 categorías reportables (incidente 2026-08-27, plan de
 * confiabilidad operativa): `rate_limit` (429), `auth` (401/403 — credencial revocada o mal
 * configurada, no se arregla reintentando ni con backoff), `transitorio` (5xx, timeout, error
 * de red — el único caso donde reintentar tiene sentido más allá del rate-limit),
 * `datos` (400/404/422 — Woo rechazó la request en sí, un producto/payload puntual, no debe
 * frenar el resto del lote ni activar el circuit breaker), `interno` (excepción no-HTTP:
 * bug propio, parseo, etc.).
 */
export function categorizarErrorWoo(e) {
  // Si algo ya calculó la categoría de antemano (ej. el circuito abierto, que sintetiza un
  // error propio sin `.status` real — ver wooFetchConCircuito) se respeta tal cual: es más
  // precisa que cualquier inferencia por status/mensaje.
  if (e?.categoria) return e.categoria;
  const status = e?.status ?? parseStatusDelMensaje(e?.message);
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status != null && status >= 500) return 'transitorio';
  if (status != null) return 'datos'; // cualquier otro 4xx: Woo evaluó y rechazó
  return 'transitorio'; // sin status HTTP: timeout/ECONNRESET/DNS — mismo trato que 5xx
}

/**
 * wooFetch con reintento ante errores TRANSITORIOS (5xx de Woo, timeout, error de red).
 * NO reintenta 4xx (401/403/404/422/etc.): esos no se arreglan reintentando la misma request.
 * 429 es la excepción: SÍ se reintenta, respetando `Retry-After` si Woo lo manda (en vez del
 * backoff fijo) — por encima de `RETRY_AFTER_MAX_MS` se aborta en vez de bloquear el ciclo.
 *
 * Motivo (incidente 2026-08-27): `_refrescarCatalogo` pagina decenas de páginas de
 * `/products` sin ningún try/catch; un solo 500/503 transitorio de Woo en cualquier página
 * abortaba TODO el ciclo (la excepción de `wooFetch` se propaga sin capturar) y descartaba
 * todo lo ya traído — con Woo devolviendo 500/503 de forma intermitente, ciclos enteros de
 * refresco (cada 5 min) fallaban seguido, dejando `catalogo_cache` sin actualizar por horas
 * hasta que un ciclo lograba completar las ~decenas de páginas sin ningún hiccup en el medio.
 * Reintentar la página que falló, en vez de descartar el ciclo entero, resuelve la enorme
 * mayoría de esos casos sin tocar la semántica de "todo o nada" del ciclo completo (que sigue
 * siendo necesaria: escribir un catálogo parcial en modo `completo` haría que la poda de
 * productos borrados de más abajo borre por error todo lo que no se llegó a pedir).
 */
export async function wooFetchConReintento(cfg, path, method = 'get', body = null) {
  let ultimoError;
  for (let intento = 0; intento <= WOO_RETRY_BACKOFF_MS.length; intento++) {
    if (intento > 0) {
      // Piso = el backoff normal de este intento: un Retry-After:0 (legal, "reintentá ya")
      // no debe bajar por debajo de lo que ya considerábamos seguro (hallazgo del revisor:
      // sin este piso, un header en 0 o casi disparaba 3 reintentos casi inmediatos contra
      // un Woo que recién pidió frenar).
      const esperaMs = (ultimoError?.status === 429 && ultimoError?.retryAfterMs != null)
        ? Math.max(ultimoError.retryAfterMs, WOO_RETRY_BACKOFF_MS[intento - 1])
        : WOO_RETRY_BACKOFF_MS[intento - 1];
      await sleep(esperaMs);
    }
    try {
      return await wooFetch(cfg, path, method, body);
    } catch (e) {
      ultimoError = e;
      const msg = e?.message ?? '';
      // Error de configuración (URL sin HTTPS): nunca es transitorio, reintentarlo repite el
      // mismo fallo 4 veces por nada.
      if (msg.includes('WooCommerce URL debe usar HTTPS')) throw e;
      const status = e.status ?? parseStatusDelMensaje(msg);
      // 429 con Retry-After más largo de lo razonable: abortar ahora en vez de bloquear todo
      // el ciclo esperando — la próxima corrida (5-10 min) lo reintenta fresco.
      if (status === 429 && e.retryAfterMs != null && e.retryAfterMs > RETRY_AFTER_MAX_MS) throw e;
      // 429 (rate-limit) SÍ se reintenta pese a ser 4xx: es transitorio por definición, y
      // routes/sync.js:415-417 ya documenta el mismo criterio para Woo ("timeouts / errores
      // de red / 5xx / 429 dejan dudas" — un 4xx normal significa que Woo rechazó la
      // request, pero 429 significa que ni la evaluó). Sin esta excepción, un rate-limit del
      // hosting bajo carga abortaría el ciclo entero por la misma puerta que este fix vino a
      // cerrar.
      if (status !== null && status < 500 && status !== 429) throw e;
    }
  }
  throw ultimoError;
}

// ── Circuit breaker (incidente 2026-08-27, plan de confiabilidad) ─────────────────────────
// Mismo patrón de candado en memoria que _refrescarCatalogoEnCurso (más abajo) y el cooldown
// de lib/mlClient.js, pero para una noción distinta: no es "hay una corrida en vuelo", es
// "Woo viene fallando de forma sostenida, no vale la pena seguir golpeándolo". Sin esto, un
// Woo caído de verdad (no un blip transitorio) sigue recibiendo el ciclo completo de
// reintentos en CADA página de CADA corrida del cron — una tormenta de requests contra un
// servicio que ya está mal, justo cuando menos lo puede soportar.
const CIRCUITO_UMBRAL_FALLOS = 5;
const CIRCUITO_COOLDOWN_MS = 5 * 60 * 1000;
// `generacion` (hallazgo del revisor, MEDIO-2): identifica cada episodio de apertura del
// circuito para distinguir un éxito TARDÍO de un worker paralelo (M6, no debe cerrar) de un
// éxito DELIBERADO de una prueba manual (`manual:true`) mientras el circuito sigue abierto
// (sí debe cerrar). `Date.now()` solo no alcanza para distinguirlos: los dos ocurren mientras
// `abiertoHasta` sigue en el futuro. Se incrementa únicamente cuando el circuito ABRE de
// verdad (no en el medio-abierto de M7, que es el mismo episodio continuando).
let _circuitoWoo = { fallosConsecutivos: 0, abiertoHasta: 0, ultimaCategoria: null, generacion: 0 };

export function circuitoWooAbierto() {
  if (Date.now() < _circuitoWoo.abiertoHasta) return true;
  // Medio-abierto (hallazgo del revisor, M7): al vencer el cooldown sin esto, el PRIMER
  // fallo post-cooldown reabría otros 5 min completos porque `fallosConsecutivos` seguía en
  // el umbral — un solo blip aislado bastaba para repetir el castigo entero aunque Woo ya
  // esté sano. Al detectar que el cooldown venció, se deja pasar UNA prueba (se resta 1 al
  // contador) en vez de resetear a 0 de golpe: si esa prueba también falla, alcanza para
  // reabrir con un solo fallo más, sin volver a esperar 5 fallos limpios desde cero.
  if (_circuitoWoo.abiertoHasta !== 0) {
    _circuitoWoo.abiertoHasta = 0;
    _circuitoWoo.fallosConsecutivos = CIRCUITO_UMBRAL_FALLOS - 1;
  }
  return false;
}

// Exportado solo para tests — mismo criterio que _resetCooldownParaTests en lib/mlClient.js.
export function _resetCircuitoWooParaTests() {
  _circuitoWoo = { fallosConsecutivos: 0, abiertoHasta: 0, ultimaCategoria: null, generacion: 0 };
}

function circuitoWooRegistrarResultado(categoria, generacionAlLlamar) {
  // Un error de `datos` (Woo rechazó ESE producto puntual), `auth` o `config` (URL sin
  // HTTPS — MEDIO-1: ni siquiera llega a salir a red) no dice nada sobre la salud general
  // del servicio — no debe abrir el circuito, y tampoco debe resetear una racha de fallos
  // transitorios en curso (ver más abajo, se ignora en ambos sentidos).
  if (categoria === 'datos' || categoria === 'auth' || categoria === 'config') return;
  if (categoria === null) { // éxito
    _circuitoWoo.fallosConsecutivos = 0;
    // Hallazgo del revisor (M6, corregido en MEDIO-2 de la 3ra pasada): NO pisar un
    // `abiertoHasta` que sigue en el futuro salvo que este éxito sea de la MISMA generación
    // que vio el circuito abierto (o ya haya vencido solo). Con solo `Date.now()`, un éxito
    // TARDÍO de un worker paralelo que arrancó antes de que otros abrieran el circuito era
    // indistinguible de un éxito DELIBERADO de una prueba manual (`manual:true`, salteando el
    // circuito) hecha para verificar si Woo ya se recuperó — la primera versión de este fix
    // dejaba el segundo caso sin poder cerrar nunca el circuito hasta que venciera el cooldown
    // solo, pese a tener la prueba de que Woo respondía bien en la mano.
    if (Date.now() >= _circuitoWoo.abiertoHasta || generacionAlLlamar === _circuitoWoo.generacion) {
      _circuitoWoo.abiertoHasta = 0;
    }
    return;
  }
  _circuitoWoo.ultimaCategoria = categoria;
  _circuitoWoo.fallosConsecutivos++;
  if (_circuitoWoo.fallosConsecutivos >= CIRCUITO_UMBRAL_FALLOS) {
    _circuitoWoo.abiertoHasta = Date.now() + CIRCUITO_COOLDOWN_MS;
    _circuitoWoo.generacion++;
  }
}

/**
 * `wooFetchConReintento` con el circuit breaker por delante: si el circuito está abierto,
 * falla YA (sin salir a red) salvo `manual:true` (mismo criterio que las llamadas manuales de
 * ML saltean su cooldown — un admin que aprieta "recargar" a mano quiere intentarlo de nuevo
 * ahora, no que el sistema decida por él). Actualiza el estado del circuito según el
 * resultado real de cada llamada.
 */
export async function wooFetchConCircuito(cfg, path, method = 'get', body = null, { manual = false } = {}) {
  // Capturado ANTES de intentar la llamada (MEDIO-2): identifica el episodio de apertura que
  // esta llamada "vio" al arrancar, para que circuitoWooRegistrarResultado distinga un éxito
  // de esta misma generación (cierra) de un éxito tardío de una generación ya vieja (no cierra).
  const generacionAlLlamar = _circuitoWoo.generacion;
  if (!manual && circuitoWooAbierto()) {
    // Hallazgo del revisor (A5): sin `.categoria`, categorizarErrorWoo caía siempre a
    // 'transitorio' para este error sintético (no tiene `.status` real) — si lo que abrió el
    // circuito fue en realidad un rate-limit sostenido, el incidente reportado decía
    // "no responde" en vez de "está limitando la frecuencia", justo el diagnóstico que más
    // importa acertar en el caso sostenido que amerita acción humana.
    const err = new Error('Circuito de WooCommerce abierto por fallos sostenidos — se pospone hasta que se recupere');
    err.circuitoAbierto = true;
    err.categoria = _circuitoWoo.ultimaCategoria ?? 'transitorio';
    throw err;
  }
  try {
    const resp = await wooFetchConReintento(cfg, path, method, body);
    circuitoWooRegistrarResultado(null, generacionAlLlamar);
    return resp;
  } catch (e) {
    if (!e.circuitoAbierto) circuitoWooRegistrarResultado(categorizarErrorWoo(e), generacionAlLlamar);
    throw e;
  }
}

// Claves en sync_estado que gobiernan el modo incremental (ver plan
// 2026-08-10-codigos-frescura-y-catalogo-incremental.md, Paso 2):
// - CLAVE_ULTIMO_REFRESCO: marca de tiempo de la ÚLTIMA corrida exitosa, sea completa o
//   incremental. Es la base para calcular `modified_after` de la PRÓXIMA corrida incremental.
// - CLAVE_ULTIMO_COMPLETO: marca de tiempo del último barrido COMPLETO exitoso. Determina
//   cuándo toca el próximo barrido completo (red de seguridad + poda de borrados).
const CLAVE_ULTIMO_REFRESCO = 'catalogo_ultimo_refresco';
const CLAVE_ULTIMO_COMPLETO = 'catalogo_ultimo_completo';

// Cada cuánto se fuerza un barrido completo aunque el incremental venga andando bien.
// Es la única corrida que poda productos borrados en Woo (el incremental no los ve) y la
// única red de seguridad ante algo que el incremental pudiera pasar por alto — incluido
// `status=any`, que NO incluye `trash`: un producto papelereado en Woo desaparece de toda
// consulta (completa o incremental) sin que el incremental lo pode, así que puede quedar
// como fila fantasma con SKU repetido hasta el próximo completo (mismo cuadro que el
// incidente 2026-07-25). Es un motivo más, independiente del de abajo, para no estirar
// mucho este intervalo.
// 1 hora. El riesgo que definía este número era: `catalogo_cache.stock` (que alimenta
// `stock_disponible_ml`) solo se refresca desde Woo acá, así que si una venta moviera el
// stock SIN mover el `date_modified` del producto, el incremental nunca la vería y el
// barrido completo sería la única red — o sea, sobreventa hacia ML durante todo el intervalo.
//
// MEDIDO el 2026-08-10 y descartado: muestreo de solo lectura sobre 2181 entidades
// (productos y variaciones), ventanas de 10 min durante ~2,5 h. Se observaron 5 cambios de
// stock por ventas reales del sitio y los 5 movieron `date_modified`; cero contraejemplos.
// Uno de ellos dejó el producto en 0, o sea una venta que agotó la existencia. Las ventas
// bajan stock por el camino interno de Woo (`wc_reduce_stock_levels`), el mismo que usan los
// pedidos que creamos nosotros desde ML — así que la muestra habla del mecanismo, no de un
// caso especial.
//
// Conclusión: el incremental SÍ ve las ventas, y la frescura efectiva del stock pasa a ser
// la del cron (5 min) contra los 15 min de antes. Este barrido completo queda como red para
// lo que el incremental no puede ver por diseño: borrados y papelera (ver comentario de
// arriba sobre `trash`), que es lo que ahora fija el número.
const INTERVALO_COMPLETO_MS = 60 * 60 * 1000; // 1 hora

// Margen de solape al calcular `modified_after`: sin esto, una edición que ocurrió DURANTE
// la corrida anterior (entre que se leyó `modified_after` y que Woo terminó de responder)
// podría quedar justo debajo de la marca y perderse para siempre. 5 min es generoso frente
// a la duración real de una corrida (segundos).
const SOLAPE_INCREMENTAL_MS = 5 * 60 * 1000; // 5 minutos

function leerMarca(db, clave) {
  const row = db.prepare('SELECT valor FROM sync_estado WHERE clave = ?').get(clave);
  return row ? row.valor : null;
}

function guardarMarca(db, clave, valorIso) {
  db.prepare(`
    INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
  `).run(clave, valorIso, valorIso);
}

// Candado anti-solape en memoria, mismo patrón que _mlToWcEnCurso/_wcToMlEnCurso/
// _reconciliarStockEnCurso en routes/sync.js. A 15 min el solape entre corridas era
// improbable; a 5 min ya no, y un completo lento (o el botón manual, que ahora SIEMPRE
// fuerza completo) puede pisarse con uno o varios incrementales en danza, multiplicando la
// carga contra Woo justo cuando ya viene lento.
let _refrescarCatalogoEnCurso = false;

// Fase 0 (higiene), Tarea 3: abre/cierra alertas de stock negativo en cada refresco de
// catálogo (cada 15 min). No duplica fila para el mismo SKU mientras siga en negativo
// entre refrescos sucesivos: solo abre una si no hay ya una fila abierta (resuelto_en IS
// NULL) para ese SKU, y cierra (resuelto_en=now) las abiertas que dejaron de estar en
// negativo. `sku <> ''` porque un producto variable padre no tiene SKU propio.
export function registrarAlertasStockNegativo(db, ahora = new Date().toISOString()) {
  const negativos = db.prepare(
    "SELECT sku, stock FROM catalogo_cache WHERE stock < 0 AND COALESCE(sku,'')<>''"
  ).all();
  const skusNegativos = new Set(negativos.map(r => r.sku));

  const abiertas = db.prepare(
    'SELECT id, sku FROM stock_negativo_alertas WHERE resuelto_en IS NULL'
  ).all();
  const skusConAlertaAbierta = new Set(abiertas.map(r => r.sku));

  const insertar = db.prepare(
    'INSERT INTO stock_negativo_alertas (sku, stock, detectado_en) VALUES (?,?,?)'
  );
  const resolver = db.prepare(
    'UPDATE stock_negativo_alertas SET resuelto_en=? WHERE id=?'
  );

  const tx = db.transaction(() => {
    for (const row of negativos) {
      if (!skusConAlertaAbierta.has(row.sku)) insertar.run(row.sku, row.stock, ahora);
    }
    for (const fila of abiertas) {
      if (!skusNegativos.has(fila.sku)) resolver.run(ahora, fila.id);
    }
  });
  tx();
}

const INTEGRACION_WOO = 'woocommerce';
const PROCESO_REFRESCAR_CATALOGO = 'refrescar_catalogo';

const MENSAJE_HUMANO_POR_CATEGORIA = {
  rate_limit: 'WooCommerce está limitando la frecuencia de refrescos del catálogo (429).',
  auth: 'WooCommerce rechazó las credenciales del catálogo — revisar Consumer Key/Secret.',
  transitorio: 'WooCommerce no responde de forma sostenida al refrescar el catálogo.',
  datos: 'WooCommerce rechazó una solicitud puntual al refrescar el catálogo.',
  interno: 'Error interno al refrescar el catálogo de WooCommerce.',
  config: 'Configuración inválida de WooCommerce (URL sin HTTPS) — revisar variables de entorno, no la conexión.',
};

function registrarMetricaCiclo(db, { integracion, proceso, iniciadoEn, inicioMonotonico, procesados, fallidos, circuitoAbierto }) {
  try {
    const finalizadoEn = new Date().toISOString();
    // performance.now() (reloj monotónico) para la DURACIÓN, no Date.now()/los ISO strings:
    // un ajuste de reloj del sistema (NTP) durante el ciclo podía dar una duración negativa
    // con el reloj de pared (hallazgo del revisor, mismo tipo de problema ya visto en otro
    // hito de este plan). Los timestamps ISO quedan igual, son solo para mostrar/ordenar.
    const duracionMs = Math.round(performance.now() - inicioMonotonico);
    db.prepare(`
      INSERT INTO metricas_ciclo_sync
        (integracion, proceso, iniciado_en, finalizado_en, duracion_ms, procesados, fallidos, reintentados, circuito_abierto, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(integracion, proceso, iniciadoEn, finalizadoEn, duracionMs, procesados, fallidos, circuitoAbierto ? 1 : 0, finalizadoEn);
  } catch (e) {
    // Telemetría, nunca debe tumbar el ciclo real que la dispara.
    console.error('[woo] error registrando métrica de ciclo (no afecta el refresco):', e.message);
  }
}

// options.forzarCompleto: true fuerza un barrido completo (usado por el botón manual
// POST /catalogo/recargar, que siempre debe traer y podar TODO, sin depender del cron) — y
// además saltea el circuit breaker (ver wooFetchConCircuito): un admin que aprieta "recargar"
// a mano quiere intentarlo ahora, no que el sistema decida por él.
export async function refrescarCatalogo(db, cfg, opts = {}) {
  if (_refrescarCatalogoEnCurso) return { omitido: true, motivo: 'en_curso' };
  _refrescarCatalogoEnCurso = true;
  const inicioMetrica = new Date().toISOString();
  const inicioMonotonico = performance.now();
  try {
    const resultado = await _refrescarCatalogo(db, cfg, opts);
    const sospechoso = resultado && typeof resultado === 'object' && resultado.sospechoso;
    registrarMetricaCiclo(db, {
      integracion: INTEGRACION_WOO, proceso: PROCESO_REFRESCAR_CATALOGO, iniciadoEn: inicioMetrica, inicioMonotonico,
      procesados: typeof resultado === 'number' ? resultado : 0, fallidos: sospechoso ? 1 : 0,
    });
    if (sospechoso) {
      // Hallazgo BLOQUEANTE del revisor (B1): NO se confirma ciclo sano acá — un catálogo
      // completo con 0 productos es siempre sospechoso (ver _refrescarCatalogo), y confirmar
      // resolvería en silencio cualquier incidente `transitorio` real que siga activo.
      // Hallazgo del revisor (M2): usar 'datos' acá compartía la misma clave de dedupe
      // (integracion|proceso|tipoError) que el catch genérico de más abajo, que también usa
      // 'datos' para un 4xx puntual — un 404 aislado en la corrida siguiente pisaba este
      // incidente de "catálogo vacío" con "WooCommerce rechazó una solicitud puntual",
      // perdiendo la señal original. 'catalogo_vacio' es su propia clave.
      abrirOActualizarIncidente(db, {
        integracion: INTEGRACION_WOO, proceso: PROCESO_REFRESCAR_CATALOGO, tipoError: 'catalogo_vacio',
        severidad: 'advertencia',
        mensajeTecnico: 'Barrido completo devolvió 0 productos — poda omitida por seguridad',
        mensajeHumano: 'WooCommerce devolvió el catálogo vacío en un barrido completo — revisar antes de confiar en el catálogo local.',
        contexto: { forzarCompleto: !!opts.forzarCompleto },
      });
      return resultado;
    }
    // Hallazgo del revisor (M5): un incremental con 0 productos es ambiguo por diseño — el
    // propio _refrescarCatalogo documenta que puede ser "nada cambió" o "Woo degradado en
    // silencio" y por eso NO avanza la marca de frescura. Confirmar ciclo sano acá igual
    // resolvía cualquier incidente `transitorio` activo con la misma ambigüedad que el caso
    // B1 ya cerró para el completo — un Woo que pasó de tirar 500s a responder 200 vacío
    // "se veía" recuperado sin que el catálogo realmente lo esté. Solo se confirma cuando el
    // ciclo trajo productos de verdad (señal inequívoca de que Woo respondió con datos).
    if (typeof resultado === 'number' && resultado === 0) return resultado;
    confirmarCicloSano(db, { integracion: INTEGRACION_WOO, proceso: PROCESO_REFRESCAR_CATALOGO });
    return resultado;
  } catch (e) {
    // Hallazgo del revisor (A3, corregido tras regresión detectada en la 2da pasada): la
    // primera versión usaba una allowlist ("¿vino de HTTP?") para decidir 'interno' — pero un
    // timeout de axios o un ECONNRESET real NO tienen `.status` (axios solo lo setea si hubo
    // respuesta) y tampoco matchean el mensaje "WooCommerce API error N", así que cualquier
    // falla de red genuina — el outage más común y justo lo que este hito existe para
    // detectar — se reportaba como 'interno' ("bug propio") en vez de 'transitorio'.
    // Ahora se usa una denylist: solo se clasifica como bug propio un error de un tipo que
    // categorizarErrorWoo no podría producir (TypeError/RangeError de nuestro código,
    // SqliteError de la persistencia) — cualquier otra cosa (incluido "sin status, sin
    // match") sigue el criterio ya correcto de categorizarErrorWoo (sin status → transitorio).
    const esBugPropio = e instanceof TypeError || e instanceof RangeError || e?.name === 'SqliteError';
    const categoria = esBugPropio ? 'interno' : categorizarErrorWoo(e);
    registrarMetricaCiclo(db, {
      integracion: INTEGRACION_WOO, proceso: PROCESO_REFRESCAR_CATALOGO, iniciadoEn: inicioMetrica, inicioMonotonico,
      procesados: 0, fallidos: 1, circuitoAbierto: !!e.circuitoAbierto,
    });
    abrirOActualizarIncidente(db, {
      integracion: INTEGRACION_WOO, proceso: PROCESO_REFRESCAR_CATALOGO, tipoError: categoria,
      severidad: (categoria === 'auth' || categoria === 'config') ? 'critico' : (categoria === 'datos' ? 'info' : 'advertencia'),
      mensajeTecnico: e.message,
      mensajeHumano: MENSAJE_HUMANO_POR_CATEGORIA[categoria] ?? MENSAJE_HUMANO_POR_CATEGORIA.interno,
      contexto: { forzarCompleto: !!opts.forzarCompleto, circuitoAbierto: !!e.circuitoAbierto },
    });
    throw e; // el comportamiento ante el caller (cron/endpoint) no cambia — solo se agrega telemetría.
  } finally {
    _refrescarCatalogoEnCurso = false;
  }
}

/**
 * Relee una sola entidad de Woo tras un webhook de producto. Las variaciones no son recursos
 * independientes para el catálogo: ante un evento de una de ellas se relee su padre completo,
 * lo que elimina del cache las hermanas que Woo ya no devuelve sin afectar otros productos.
 *
 * Esta función nunca escribe en Woo. Un `product.deleted` ya es una confirmación firmada del
 * origen, por lo que retira únicamente la fila afectada (y sus hijas si era el padre).
 */
export async function refrescarProductoPuntual(db, cfg, { productoId, parentId = null, eliminado = false } = {}) {
  const id = Number(productoId);
  const parent = Number(parentId || productoId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(parent) || parent <= 0) {
    throw Object.assign(new Error('webhook Woo de producto sin id válido'), { retryable: false, code: 'woo_product_invalid_id' });
  }

  if (eliminado) {
    // El SKU se lee ANTES de borrar la fila: después de borrarla no hay de dónde sacarlo, y sin
    // SKU no se pueden encontrar las publicaciones de ML ni los pedidos que quedaron colgando.
    const bajas = parentId
      ? db.prepare('SELECT id_woo, sku FROM catalogo_cache WHERE id_woo=?').all(id)
      : db.prepare('SELECT id_woo, sku FROM catalogo_cache WHERE id_woo=? OR id_padre=?').all(id, id);
    db.transaction(() => {
      if (parentId) db.prepare('DELETE FROM catalogo_cache WHERE id_woo=?').run(id);
      else db.prepare('DELETE FROM catalogo_cache WHERE id_woo=? OR id_padre=?').run(id, id);
    })();
    // PM-104: un `product.deleted` firmado por Woo ya es la confirmación del origen, así que no
    // hace falta releer. Esta mitad marca y retiene; poner stock cero y bloquear en ML es una
    // escritura remota y va en una entrega aparte.
    let protegidas = 0;
    for (const b of bajas) {
      try {
        const r = protegerPorBajaWoo(db, { idWoo: b.id_woo, sku: b.sku, motivo: 'baja_woo', confirmado: true }, 'webhook_woo');
        if (r.ok) protegidas += r.claves;
      } catch (e) {
        // La protección no puede impedir que el catálogo local refleje la baja: si falla, la
        // fila ya se borró y el detector de publicaciones sin respaldo lo sigue viendo.
        console.error('[woo] proteccion por baja no aplicada para', b.id_woo, '-', e.message);
      }
    }
    return { producto_id: id, parent_id: parentId ? parent : null, eliminado: true, filas: 0, claves_protegidas: protegidas };
  }

  const productoResp = await wooFetch(cfg, `/products/${parent}?context=view`);
  const padre = normalizarProductoWc(productoResp.data);
  const filas = [padre];
  if (padre.tipo === 'variable') {
    let page = 1;
    while (page <= 20) {
      const varsResp = await wooFetch(cfg, `/products/${parent}/variations?per_page=100&page=${page}&status=any`);
      const variaciones = Array.isArray(varsResp.data) ? varsResp.data : [];
      for (const variacion of variaciones) {
        // Se conserva el contrato del refresco general: variaciones sin SKU no entran al
        // catálogo vendible ni pueden convertirse en identidad Fusion.
        if (variacion.sku) filas.push(normalizarVariacionWc(variacion, padre));
      }
      if (variaciones.length < 100) break;
      page += 1;
    }
  }

  const actualizadoEn = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, regular_price, atributos_json, marca, gtin, actualizado_en)
    VALUES (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @regular_price, @atributos_json, @marca, @gtin, @actualizado_en)
    ON CONFLICT(id_woo) DO UPDATE SET
      nombre=excluded.nombre, sku=excluded.sku, tipo=excluded.tipo, id_padre=excluded.id_padre,
      stock=excluded.stock, categorias_json=excluded.categorias_json, img=excluded.img,
      precio=excluded.precio, regular_price=excluded.regular_price, atributos_json=excluded.atributos_json,
      marca=excluded.marca, gtin=excluded.gtin, actualizado_en=excluded.actualizado_en
  `);
  db.transaction(() => {
    // Si el padre dejó de ser variable, también se retiran las hijas que el origen ya no expone.
    db.prepare('DELETE FROM catalogo_cache WHERE id_padre=?').run(parent);
    for (const fila of filas) upsert.run(filaCatalogo(fila, actualizadoEn));
  })();
  return { producto_id: id, parent_id: parent, eliminado: false, filas: filas.length };
}

async function _refrescarCatalogo(db, cfg, { forzarCompleto = false } = {}) {
  const inicio = new Date();
  const ultimoCompleto = leerMarca(db, CLAVE_ULTIMO_COMPLETO);
  const completo = forzarCompleto || !ultimoCompleto
    || (inicio.getTime() - new Date(ultimoCompleto).getTime() >= INTERVALO_COMPLETO_MS);

  // `dates_are_gmt=true` NO es opcional: sin él, Woo interpreta `modified_after` en la hora
  // LOCAL del sitio, no en UTC — el mismo problema que ya costó los pedidos duplicados
  // 66554/66555 el 2026-07-29 (ver docs, incidente [[woo-after-hora-local]]). Con eso mal,
  // el incremental pediría "productos modificados en el futuro" y siempre volvería vacío,
  // dejando el catálogo local congelado sin que nada avise el error.
  let modifiedAfterQS = '';
  if (!completo) {
    const ultimoRefresco = leerMarca(db, CLAVE_ULTIMO_REFRESCO);
    // Si por algún motivo no hay marca de refresco (no debería pasar: completo=false implica
    // que hubo al menos un barrido completo previo, que siempre deja la marca), caemos al
    // último completo como base — nunca a "sin marca", que equivaldría a un fetch completo
    // disfrazado de incremental sin decirlo.
    const base = ultimoRefresco || ultimoCompleto;
    const modifiedAfter = new Date(new Date(base).getTime() - SOLAPE_INCREMENTAL_MS).toISOString();
    modifiedAfterQS = `&modified_after=${encodeURIComponent(modifiedAfter)}&dates_are_gmt=true`;
  }

  const crudos = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const resp = await wooFetchConCircuito(cfg, `/products?per_page=100&page=${page}&status=any${modifiedAfterQS}`, 'get', null, { manual: forzarCompleto });
    if (!resp.data.length) break;
    crudos.push(...resp.data);
    if (resp.data.length < 100) break;
    page++;
  }

  const productos = crudos.map(normalizarProductoWc);

  // Fetch variations for variable products (they have their own SKUs and aren't returned by /products).
  // Se paraleliza por producto con concurrencia acotada (WOO_CONCURRENCIA_MAX): la paginación de
  // variaciones de un mismo padre sigue siendo serial (cada página depende de la anterior), pero los
  // distintos padres se consultan en paralelo. Cada tarea captura su propio error y lo devuelve, así
  // un producto que falla no frena a los demás; los errores se re-lanzan al final para conservar el
  // comportamiento observable anterior (recargar falla si alguna llamada a WC falla).
  //
  // OJO: no hay cancelación anticipada. A diferencia del loop serial anterior (que cortaba en el
  // primer error), ante un fallo las demás tareas en vuelo y las pendientes de la cola siguen
  // ejecutándose hasta drenar todo el lote — es decir, se pueden disparar hasta WOO_CONCURRENCIA_MAX
  // requests en paralelo aun cuando WC ya está fallando (ej. 429/5xx), amplificando la carga. El
  // corte es fail-closed de la ESCRITURA, no de las llamadas HTTP: recién se aborta antes de la
  // transacción de persistencia (más abajo), no de las requests a WC. Aceptado por simplicidad.
  const variableProds = crudos.filter(p => p.type === 'variable');
  const resultadosVar = await mapConLimite(variableProds, WOO_CONCURRENCIA_MAX, async (vp) => {
    const padre = normalizarProductoWc(vp);
    const variaciones = [];
    try {
      let vpage = 1;
      while (vpage <= 20) {
        // Mismo reintento que el loop de /products de más arriba (incidente 2026-08-27):
        // acá hay cientos de llamadas de variaciones, con hasta WOO_CONCURRENCIA_MAX en
        // paralelo — un único 500/503/429 transitorio en cualquiera de ellas abortaba TODO
        // el refresco (fail-closed sí sigue vigente, solo que ahora tolera un blip pasajero
        // antes de rendirse). El aislamiento por producto padre (mapConLimite + try/catch)
        // sigue igual: esto solo reduce la chance de llegar a ese catch por una falla que
        // se hubiera resuelto sola.
        const vresp = await wooFetchConCircuito(cfg, `/products/${vp.id}/variations?per_page=100&page=${vpage}&status=any`, 'get', null, { manual: forzarCompleto });
        if (!vresp.data.length) break;
        for (const v of vresp.data) {
          if (!v.sku) continue;
          variaciones.push(normalizarVariacionWc(v, padre));
        }
        if (vresp.data.length < 100) break;
        vpage++;
      }
      return { variaciones };
    } catch (e) {
      return { variaciones, error: e };
    }
  });

  const errorVar = resultadosVar.find(r => r.error);
  if (errorVar) throw errorVar.error;
  for (const r of resultadosVar) {
    for (const v of r.variaciones) productos.push(v);
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, regular_price, atributos_json, marca, gtin, actualizado_en)
    VALUES (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @regular_price, @atributos_json, @marca, @gtin, @actualizado_en)
    ON CONFLICT(id_woo) DO UPDATE SET
      nombre = excluded.nombre, sku = excluded.sku, tipo = excluded.tipo,
      id_padre = excluded.id_padre, stock = excluded.stock,
      categorias_json = excluded.categorias_json, img = excluded.img, precio = excluded.precio,
      regular_price = excluded.regular_price,
      atributos_json = excluded.atributos_json, marca = excluded.marca, gtin = excluded.gtin,
      actualizado_en = excluded.actualizado_en
  `);
  // Borrar de catalogo_cache los productos que ya no existen en WooCommerce (borrados
  // permanentemente, o pasados a un estado que "status=any" no devuelve). El upsert de
  // arriba solo agrega/actualiza, nunca borra — así que un producto eliminado en WC quedaba
  // como fila fantasma para siempre. Encontrado en un incidente real (2026-07-25): dos
  // productos borrados hacía tiempo (404 al día de hoy en la API de WC) seguían en
  // catalogo_cache con el mismo SKU que un producto real vigente, y el sync de stock a ML
  // terminaba oscilando entre el valor real y el de la fila fantasma según el orden interno
  // de SQLite en cada corrida — WooCommerce no permite SKUs duplicados de verdad, así que
  // ver el "mismo SKU" en más de una fila acá siempre es un residuo de un borrado, nunca un
  // caso de negocio legítimo.
  const idsActuales = productos.map(p => p.id_woo).filter(id => id != null);
  // Fail-closed: un fetch que trae 0 productos (WooCommerce respondiendo 200 con body vacío
  // por un problema propio — mantenimiento, permisos degradados, etc. — sin que wooFetch lo
  // trate como error) NO debe interpretarse como "se borró todo el catálogo real". En SQL,
  // "id_woo NOT IN (<conjunto vacío>)" es siempre verdadero, así que sin este guard la poda
  // de abajo borraría el 100% de catalogo_cache. Se omite la poda (y el upsert, que de todos
  // modos no tendría nada que escribir) y se avisa — mucho más seguro que perder todo el
  // stock local de golpe.
  if (idsActuales.length === 0) {
    // Guard fail-closed, completo E incremental: 0 productos siempre puede ser Woo
    // devolviendo 200 con lista vacía por un problema propio (mantenimiento, permisos
    // degradados), no solo "nada cambió". En COMPLETO ese caso siempre fue sospechoso
    // (nunca es un catálogo real vacío). Hallazgo del revisor: en INCREMENTAL el mismo 0
    // es indistinguible entre "nada cambió de verdad" y "Woo está fallando en silencio" —
    // así que tampoco ahí se avanza la marca. Es más barato que acotar el caso: la próxima
    // corrida vuelve a pedir la MISMA ventana (sigue siendo 1 sola llamada mientras nada
    // cambie), la ventana solo crece mientras no haya nada nuevo, y en cuanto algo cambie
    // se trae completo y correcto — sin ventana ciega ni log de sospecha en el camino feliz.
    if (completo) {
      console.warn('[woo] refrescarCatalogo: WooCommerce devolvió 0 productos, se omite la poda de catalogo_cache por seguridad (posible corte/permiso, no un catálogo real vacío).');
      // Hallazgo BLOQUEANTE del revisor (B1): un `return 0` acá caía en la rama de ÉXITO de
      // `refrescarCatalogo` y llamaba `confirmarCicloSano`, resolviendo cualquier incidente
      // `transitorio` que ya estuviera activo — justo el caso ("Woo fallando en silencio") que
      // este sistema de incidentes existe para detectar quedaba marcado como "recuperado" sin
      // haberse recuperado. En COMPLETO, 0 productos SIEMPRE es sospechoso (nunca es un
      // catálogo real vacío, ver comentario de arriba) — se marca explícito para que el
      // wrapper abra/actualice un incidente en vez de confirmar el ciclo como sano.
      return { total: 0, sospechoso: true };
    }
    // En INCREMENTAL, 0 es el camino feliz más común (nada cambió desde la marca) — no se
    // marca sospechoso ni abre incidente por esto solo. Pero (hallazgo del revisor, MEDIO-3
    // tras el fix de M5) TAMPOCO confirma ciclo sano: sigue siendo ambiguo entre "nada
    // cambió de verdad" y "Woo degradado en silencio", ver el wrapper `refrescarCatalogo`
    // (retorna temprano sin confirmar cuando el resultado numérico es 0).
    return 0;
  }
  // La poda (detectar y borrar productos ya no vigentes en Woo) SOLO corre en el barrido
  // completo: el incremental, por diseño, solo ve los padres modificados desde la marca —
  // un producto borrado en Woo no "modificado" nunca aparecería ahí, así que podar con ese
  // universo parcial borraría por error todo lo que el incremental no tocó esta vez.
  const tx = db.transaction((rows, idsVigentes, podar) => {
    for (const p of rows) {
      upsert.run(filaCatalogo(p, now));
    }
    if (!podar) return;
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _catalogo_ids_vigentes (id_woo INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM _catalogo_ids_vigentes');
    const insertId = db.prepare('INSERT OR IGNORE INTO _catalogo_ids_vigentes (id_woo) VALUES (?)');
    for (const id of idsVigentes) insertId.run(id);
    db.prepare('DELETE FROM catalogo_cache WHERE id_woo NOT IN (SELECT id_woo FROM _catalogo_ids_vigentes)').run();
    db.exec('DROP TABLE _catalogo_ids_vigentes');
  });
  tx(productos, idsActuales, completo);

  // H-08: chequeo de calidad de datos WC — avisa (no bloquea) problemas upstream que
  // ensucian el sync/matcher. Los productos 'variable' (padres) no tienen SKU a propósito,
  // se excluyen del conteo de SKU vacío.
  const negs = db.prepare('SELECT COUNT(*) n FROM catalogo_cache WHERE stock<0').get().n;
  registrarAlertasStockNegativo(db);
  const sinSku = db.prepare("SELECT COUNT(*) n FROM catalogo_cache WHERE tipo<>'variable' AND COALESCE(sku,'')=''").get().n;
  // Un SKU repetido en más de un producto/variación no debería pasar nunca en WooCommerce
  // (SKU es único ahí) — si aparece acá es señal de un residuo de borrado que la limpieza de
  // arriba no alcanzó a cubrir (ej. un refresh viejo que falló a mitad de camino). Se avisa
  // para investigar, ya no se espera que ocurra en operación normal.
  const skusDup = db.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT sku FROM catalogo_cache WHERE COALESCE(sku,'')<>'' GROUP BY sku HAVING COUNT(*)>1
    )
  `).get().n;
  if (negs || sinSku || skusDup) {
    console.warn(`[woo] calidad catálogo: ${negs} con stock negativo, ${sinSku} sin SKU (no-variable), ${skusDup} SKU repetidos en más de un producto. Revisar en WooCommerce.`);
  }

  // Fail-closed: las marcas solo avanzan si la corrida llegó hasta acá sin errores (un fetch
  // de variaciones fallido ya relanzó su excepción más arriba, antes de la transacción de
  // persistencia). Si algo falla, la próxima corrida vuelve a mirar desde la marca vieja.
  guardarMarca(db, CLAVE_ULTIMO_REFRESCO, inicio.toISOString());
  if (completo) guardarMarca(db, CLAVE_ULTIMO_COMPLETO, inicio.toISOString());

  return productos.length;
}

// Tope defensivo por defecto: bien por encima del catálogo real (~miles) y del MAX
// de refresco (20.000), así que no trunca a ningún consumidor actual (matcher, etc.)
// pero evita una respuesta sin límite si la tabla crece sin control.
const CATALOGO_LIMIT_DEFAULT = 100000;

export function getCatalogo(db, { limit = CATALOGO_LIMIT_DEFAULT, offset = 0 } = {}) {
  return db.prepare('SELECT * FROM catalogo_cache LIMIT ? OFFSET ?').all(limit, offset);
}

// Parsea ?limit / ?offset opcionales; si no vienen (o son inválidos) usa el tope alto.
function parsePaginado(query) {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, CATALOGO_LIMIT_DEFAULT)
    : CATALOGO_LIMIT_DEFAULT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit: Math.floor(limit), offset };
}

export function wooRouter(db, cfg) {
  const router = express.Router();

  router.get('/test', async (req, res) => {
    try {
      const resp = await wooFetch(cfg, '/products?per_page=1&status=any');
      res.json({ ok: true, total: resp.headers['x-wp-total'] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/catalogo', (req, res) => {
    res.json({ ok: true, data: getCatalogo(db, parsePaginado(req.query)) });
  });

  router.post('/catalogo/recargar', async (req, res) => {
    try {
      // El botón manual siempre fuerza el barrido COMPLETO: es la única corrida que poda
      // borrados, y quien lo aprieta espera ver el catálogo entero al día, no un delta.
      const resultado = await refrescarCatalogo(db, cfg, { forzarCompleto: true });
      // El candado anti-solape puede devolver {omitido:true} si ya había una corrida en
      // curso (cron u otro botón). No hay que disfrazarlo de éxito vacío: quien lo apretó
      // tiene que enterarse de que no pasó nada todavía, no ver "total:0" como si el
      // catálogo estuviera realmente vacío.
      if (resultado && typeof resultado === 'object' && resultado.omitido) {
        return res.json({ ok: true, omitido: true, motivo: resultado.motivo });
      }
      if (resultado && typeof resultado === 'object' && resultado.sospechoso) {
        return res.json({ ok: true, total: 0, sospechoso: true });
      }
      res.json({ ok: true, total: resultado });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Actualiza stock de una lista de productos directamente en WooCommerce
  // Body: { updates: [{id_woo, sku, stock_nuevo}] }
  router.post('/stock/aplicar', async (req, res) => {
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || !updates.length) {
      return res.status(400).json({ ok: false, error: 'updates requerido' });
    }
    const resultados = [];
    for (const u of updates) {
      if (!u.id_woo || u.stock_nuevo == null) {
        resultados.push({ sku: u.sku, ok: false, error: 'faltan id_woo o stock_nuevo' });
        continue;
      }
      try {
        // El path depende de si es variación (/products/{padre}/variations/{id}) o simple.
        // Sin la fila del cache no se puede saber: fail-closed en vez de pegarle a
        // /products/{id}, que para una variación devuelve 404.
        // El sku sale de ESTA fila (no de u.sku, que viene del body del cliente sin validar
        // contra el producto real) — si el cliente manda un sku stale o de otro renglón,
        // el push a ML de más abajo terminaría sincronizando el SKU equivocado.
        const prod = db.prepare('SELECT id_woo, id_padre, tipo, sku FROM catalogo_cache WHERE id_woo=?').get(u.id_woo);
        if (!prod) {
          throw new Error(`No se encontró el producto id_woo=${u.id_woo} en catalogo_cache; no se puede determinar si es variación o simple`);
        }
        const resp = await wooFetch(cfg, buildWooPath(prod), 'put', {
          stock_quantity: u.stock_nuevo,
          manage_stock: true
        });
        if (resp.status && resp.status !== 200) throw new Error(`WC status ${resp.status}`);
        db.prepare('UPDATE catalogo_cache SET stock=?, actualizado_en=? WHERE id_woo=?')
          .run(u.stock_nuevo, new Date().toISOString(), u.id_woo);
        resultados.push({ sku: prod.sku, ok: true, stock_nuevo: u.stock_nuevo });
      } catch (e) {
        resultados.push({ sku: u.sku, ok: false, error: e.message });
      }
    }

    // Sincronizar a ML DESPUÉS de aplicar todo el lote, un solo push por SKU (no por
    // renglón): si el lote repite un SKU, aplicar el push renglón a renglón terminaría
    // pusheando el valor intermedio si el dedup se queda con la primera aparición — acá
    // se lee el stock FINAL de catalogo_cache (ya actualizado arriba), así que el orden
    // de los renglones no importa. Solo para SKUs que sí se aplicaron con éxito: si Woo
    // falló, catalogo_cache sigue con el stock viejo y no hay nada correcto que empujar.
    const skusAplicados = [...new Set(resultados.filter(r => r.ok && r.sku).map(r => r.sku))];
    const sync_ml = [];
    for (const sku of skusAplicados) {
      try {
        sync_ml.push(await syncSkuPuntual(db, cfg, sku));
      } catch (eSync) {
        // syncSkuPuntual no debería tirar (devuelve {estado:'error'} internamente), pero
        // un fallo acá nunca debe tocar `resultados` — la escritura a Woo ya está hecha.
        sync_ml.push({ sku, estado: 'error', detalle: `Excepción inesperada: ${eSync.message}` });
      }
    }

    const errores = resultados.filter(r => !r.ok).length;
    res.json({ ok: errores === 0, aplicados: resultados.filter(r => r.ok).length, errores, resultados, sync_ml });
  });

  return router;
}
