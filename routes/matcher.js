import { Router } from 'express';
import { mlFetch, categorizarErrorMl, estadoCooldownMl } from '../lib/mlClient.js';
import { clavesNecesitanAtencion } from '../lib/mlMapeo.js';
import { aplanarItemMl } from '../lib/modelos/publicacionMl.js';
import {
  construirWC, construirMLdesdeApi, candidatosDeItem, derivarEstadoApi,
} from '../lib/matcherResolver.js';
import {
  contarPendientes, getEstadoPush,
} from '../lib/matcherPush.js';
import { armarClaveMl } from '../lib/mlUtil.js';
import { abrirOActualizarIncidente, confirmarCicloSano } from '../lib/incidentes.js';
import { escanearGuardiaMl } from '../lib/guardiaMl.js';

// Solo interesan publicaciones matcheables (las cerradas son listings muertos).
const STATUSES_A_TRAER = ['active', 'paused'];
const MULTIGET_CHUNK = 20;   // ML permite hasta 20 ids por multiget
const SEARCH_LIMIT = 100;    // máximo por página de items/search
// MEDIDO el 2026-08-07 en routes/sync.js (RECONCILIACION_PAUSA_CHUNK_MS): ML empieza a
// devolver 429 tras 2-3 multiget consecutivos con menos de ~1,5s de por medio. 350ms
// (el valor previo acá) garantizaba 429 en cualquier refresco de más de un puñado de
// chunks — root cause adicional del incidente 2026-08-27 además de la falta de retry.
const CALL_DELAY_MS = 1500;

// Estado del refresco de publicaciones (async, no bloqueante). El scan completo superaba
// el proxy_read_timeout de nginx (120s) → el POST devolvía HTML de error que el frontend
// no podía parsear. Ahora el POST arranca el trabajo y devuelve 202 al toque; el frontend
// sondea GET /refrescar-ml/estado. Un solo refresco a la vez.
// Duración: con CALL_DELAY_MS=1500ms (pacing seguro contra el 429 de ML, incidente
// 2026-08-27) y ~6840 publicaciones, un refresco completo son ~10-15 min reales (antes,
// con 350ms sin ese resguardo, "1-3 min" — pero eso mismo garantizaba el 429).
//
// Candado COMPARTIDO a nivel de módulo (no solo dentro de matcherRouter): el botón
// "Actualizar desde ML" de Cobertura (routes/cobertura.js) pega exactamente al mismo
// recurso — ml_publicaciones_cache completo — así que usa este mismo `_refresco` a través
// de dispararRefrescoMl()/estadoRefrescoMl() en vez de tener su propio candado. Dos
// candados independientes sobre el mismo recurso permitirían un refresco del Matcher y uno
// de Cobertura corriendo en paralelo, duplicando la carga contra ML sin que el presupuesto
// lo note hasta que ya es tarde (ver lib/mlLimites.js).
let _refresco = {
  running: false, scope: null, phase: null, done: 0, total: 0,
  error: null, resultado: null, actualizado_en: null, iniciado_en: null,
};

/** Snapshot de solo lectura del estado del refresco compartido — para sondeo del frontend. */
export function estadoRefrescoMl() {
  const { running, scope, phase, done, total, error, resultado, actualizado_en } = _refresco;
  return { running, scope, phase, done, total, error, resultado, actualizado_en };
}

/**
 * Dispara el refresco compartido de publicaciones ML (candado anti-reentrada único: si ya
 * hay un refresco en curso —disparado desde el Matcher o desde Cobertura, da igual—, NO
 * arranca otro y devuelve running:true con el motivo, en vez de lanzar un segundo scan en
 * paralelo. Mismo patrón que _wcToMlEnCurso/_reconciliarStockEnCurso/_refrescarCatalogoEnCurso
 * de routes/sync.js. Devuelve `{ ok:false, running:true, error, scope }` si estaba en curso
 * (para responder 409), o `{ ok:true, running:true, scope }` si lo arrancó (para responder 202).
 *
 * UM1: además de los endpoints HTTP manuales, server.js lo programa cada 15 minutos para
 * mantener la Guardia actualizada. El mismo candado y los cooldowns globales aplican a ambos
 * caminos; un refresco fallido no avanza la frescura ni borra el último resultado válido.
 */
export function dispararRefrescoMl(db, cfg, scope = 'all') {
  if (_refresco.running) {
    return { ok: false, running: true, error: 'Ya hay un refresco en curso', scope: _refresco.scope };
  }
  const scopeNorm = scope === 'atencion' ? 'atencion' : 'all';
  _refresco = {
    running: true, scope: scopeNorm, phase: 'iniciando', done: 0, total: 0,
    // actualizado_en se conserva del refresco anterior hasta que este termine bien: así
    // "última actualización" nunca queda en null mientras un refresco está en curso.
    error: null, resultado: null, actualizado_en: _refresco.actualizado_en, iniciado_en: now(),
  };
  const onProgress = (p) => { _refresco.phase = p.phase; _refresco.done = p.done || 0; _refresco.total = p.total || 0; };

  // Corre en background; el handler ya respondió. FAIL-CLOSED: si ML falla a mitad de
  // camino, refrescarPublicacionesMl/Acotado ya garantizan no pisar el cache con datos
  // parciales (abortan antes del upsert atómico) — acá solo se registra el error, `resultado`
  // queda null y `actualizado_en` NO avanza (se ve reflejado también en MAX(actualizado_en)
  // de ml_publicaciones_cache, que es la fuente real que consulta Cobertura para "hace X").
  (async () => {
    try {
      let r;
      if (scopeNorm === 'atencion') {
        const itemIds = [...new Set(clavesNecesitanAtencion(db).map(c => String(c).split('|')[0]))];
        r = await refrescarPublicacionesMlAcotado(db, cfg, itemIds, onProgress);
      } else {
        // Refresco TOTAL con métricas e integración de incidentes (Hito 4)
        r = await refrescarPublicacionesMlConMetricas(db, cfg, onProgress);
      }
      _refresco.resultado = r;
      _refresco.actualizado_en = now();
      // UM1: solo genera/actualiza casos locales; nunca escribe seller_sku, stock ni estados
      // remotos. Si el refresco fue completo, la lectura de Guardia tiene una base confiable.
      escanearGuardiaMl(db, 'sistema', { lecturaMlConfirmada: true });
    } catch (e) {
      _refresco.error = e.message;
      try {
        db.prepare('UPDATE guardia_ml_config SET ultimo_scan_error=?, actualizado_en=? WHERE id=1')
          .run(e.message.slice(0, 500), now());
      } catch (_) { /* la lectura de Guardia no debe ocultar el error original del refresco */ }
    } finally {
      _refresco.running = false;
      _refresco.phase = _refresco.error ? 'error' : 'listo';
    }
  })();

  return { ok: true, running: true, scope: scopeNorm };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Backoff acotado a 3 reintentos (mismo patrón que wooFetchConReintento en routes/woo.js).
const ML_RETRY_BACKOFF_MS = [500, 1500, 4000];

// Excepciones NO transitorias que getAccessToken/mlFetch puede tirar (lib/mlClient.js):
// credencial mal configurada, refresh_token quemado, cooldown de OAuth activo o
// presupuesto de /oauth/token agotado. Reintentar estas 4 veces en ~6s no las arregla —
// en el caso de "cooldown"/"Presupuesto" activa el MISMO martilleo del incidente
// 2026-08-04 que el cooldown de mlClient.js existe para evitar; en el caso de
// "Autenticación ML rechazada" son 4 POST de más a /oauth/token con un refresh_token
// ya quemado. Mismo criterio que el filtro de wooFetchConReintento (routes/woo.js) para
// el error de configuración "URL debe usar HTTPS".
const ML_ERRORES_NO_TRANSITORIOS = [
  'ML_CLIENT_ID no configurado',
  'Token ML no inicializado',
  'Autenticación ML rechazada',
  'cooldown',
  'Presupuesto de llamadas a /oauth/token agotado',
  // 4ta pasada del revisor (ALTO 1): sin este patrón, un fallo de ESCRITURA en sqlite tras
  // rotar el refresh_token (disco lleno, DB en readonly, lock) no matcheaba nada de la lista
  // de arriba → se reintentaba con el refresh_token YA QUEMADO por ML → el 400 invalid_grant
  // resultante SÍ matcheaba 'Autenticación ML rechazada' y llegaba al incidente en vez del
  // mensaje CRÍTICO original, mandando al operador a revisar client_secret cuando el problema
  // real es la base de datos local.
  'no se pudo persistir en sqlite',
];

/**
 * mlFetch con reintento ante errores TRANSITORIOS (5xx, excepción de red/timeout).
 * NO reintenta 4xx (401/403/404/429/etc.) ni las excepciones no transitorias de
 * getAccessToken (credenciales, cooldown de OAuth, presupuesto agotado): esos no se
 * arreglan reintentando la misma request.
 *
 * Motivo (incidente 2026-08-27, mismo patrón que refrescarCatalogo en routes/woo.js):
 * `ml_publicaciones_cache` quedó con TODAS sus 6840 filas en el mismo timestamp del
 * 2026-08-19 — el refresco completo (`refrescarPublicacionesMl`) no había terminado con
 * éxito ni una sola vez en 8 días. La causa: `listarItemIds` pagina por scroll (hasta 200
 * páginas por status) y el multiget de acá abajo pagina en chunks de 20 (para ~6840
 * publicaciones, ~342 llamadas secuenciales) — cualquiera de esas llamadas que devuelva un
 * error transitorio aborta TODO el refresco (fail-closed a propósito: nunca se pisa el
 * cache con datos parciales). Con cientos de llamadas secuenciales sin ningún reintento, la
 * probabilidad de que el refresco completo termine bien tiende a cero. Reintentar cada
 * llamada individual, en vez de todo el refresco, resuelve la enorme mayoría de esos casos
 * sin tocar la semántica fail-closed (que sigue siendo necesaria y no cambia acá).
 */
export async function mlFetchConReintento(db, cfg, method, path, body = null, opts = {}) {
  let ultimoResp, ultimoError;
  for (let intento = 0; intento <= ML_RETRY_BACKOFF_MS.length; intento++) {
    if (intento > 0) await sleep(ML_RETRY_BACKOFF_MS[intento - 1]);
    try {
      const resp = await mlFetch(db, cfg, method, path, body, opts);
      if (resp.status === 200) return resp;
      ultimoResp = resp;
      // 429 (real o sintético por cooldown/cupo) NO se reintenta acá a propósito, a
      // diferencia de wooFetchConReintento: mlFetch ya tiene su PROPIO cooldown global
      // (_cooldownActivo(), lib/mlClient.js) que dura decenas de segundos — un backoff
      // corto (hasta 4s) no lo va a esquivar, así que reintentar acá solo demoraría sin
      // chance real de éxito. El caller ya recibe el 429 y decide (abortar fail-closed,
      // como hace hoy `refrescarPublicacionesMl`/`listarItemIds`).
      if (resp.status < 500) return resp; // 4xx (incluido 429): no reintentar.
      // 5xx: sí es transitorio, reintentar.
    } catch (e) {
      const msg = e?.message ?? '';
      if (ML_ERRORES_NO_TRANSITORIOS.some(patron => msg.includes(patron))) throw e;
      ultimoError = e;
      // Excepción de red/timeout genuina (u otra no reconocida arriba): reintentar.
    }
  }
  if (ultimoResp) return ultimoResp; // agotados los reintentos: devolver el último status, que el caller ya sabe manejar (aborta fail-closed).
  throw ultimoError;
}

function now() {
  return new Date().toISOString();
}

function mlCfgOk(cfg) {
  return cfg?.clientId && cfg?.clientSecret && cfg?.userId;
}

// ── Integración con sistema de incidentes y métricas (Hito 4) ───────────────────────────

const INTEGRACION_ML = 'mercadolibre';
const PROCESO_REFRESCAR_PUBLICACIONES = 'refrescar_publicaciones';

const MENSAJE_HUMANO_POR_CATEGORIA = Object.create(null); // evita herencia indeseada del prototipo de Object (BAJO 8)
MENSAJE_HUMANO_POR_CATEGORIA['rate_limit'] = 'MercadoLibre está limitando la frecuencia de refrescos de publicaciones (429).';
MENSAJE_HUMANO_POR_CATEGORIA['auth'] = 'MercadoLibre rechazó las credenciales del refresco — revisar Client ID/Secret.';
MENSAJE_HUMANO_POR_CATEGORIA['config'] = 'Configuración inválida de MercadoLibre (Client ID/Secret/User ID faltantes) — revisar variables de entorno, no la conexión.';
MENSAJE_HUMANO_POR_CATEGORIA['transitorio'] = 'MercadoLibre no responde de forma sostenida al refrescar publicaciones.';
MENSAJE_HUMANO_POR_CATEGORIA['datos'] = 'MercadoLibre rechazó una solicitud puntual al refrescar publicaciones.';
MENSAJE_HUMANO_POR_CATEGORIA['interno'] = 'Error interno al refrescar publicaciones de MercadoLibre.';

function registrarMetricaCicloMl(db, { iniciadoEn, inicioMonotonico, procesados, fallidos, circuitoAbierto }) {
  try {
    const finalizadoEn = new Date().toISOString();
    // performance.now() (reloj monotónico) para DURACIÓN, nunca Date.now() o timestamps ISO:
    // un ajuste de reloj del sistema durante el ciclo podía dar duración negativa.
    const duracionMs = Math.round(performance.now() - inicioMonotonico);
    db.prepare(`
      INSERT INTO metricas_ciclo_sync
        (integracion, proceso, iniciado_en, finalizado_en, duracion_ms, procesados, fallidos, reintentados, circuito_abierto, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(INTEGRACION_ML, PROCESO_REFRESCAR_PUBLICACIONES, iniciadoEn, finalizadoEn, duracionMs, procesados, fallidos, circuitoAbierto ? 1 : 0, finalizadoEn);
  } catch (e) {
    // Telemetría: nunca debe tumbar el ciclo real que la dispara.
    console.error('[ML] error registrando métrica de ciclo (no afecta el refresco):', e.message);
  }
}

/**
 * Lista TODOS los item_id del vendedor para un status dado.
 *
 * Usa paginación `search_type=scan` (scroll): la paginación por offset de ML topa
 * en 1000 resultados, pero el vendedor tiene miles de pausadas. El scan no tiene
 * ese límite — se itera con scroll_id hasta que no vengan más resultados.
 */
async function listarItemIds(db, cfg, status) {
  const ids = [];
  let scrollId = null;
  const MAX_PAGINAS = 200; // guarda: 200 × 100 = 20.000 items máximo por status
  for (let pag = 0; pag < MAX_PAGINAS; pag++) {
    const scrollParam = scrollId ? `&scroll_id=${encodeURIComponent(scrollId)}` : '';
    // manual: true — este refresco lo dispara el usuario a mano desde el botón
    // "Refrescar ML" (POST /refrescar-ml), no un cron. No debe quedar bloqueado
    // por el cooldown global de los crons.
    const resp = await mlFetchConReintento(
      db, cfg, 'get',
      `/users/${cfg.userId}/items/search?search_type=scan&status=${status}&limit=${SEARCH_LIMIT}${scrollParam}`,
      null, { manual: true }
    );
    // Fallo de API (429/500/etc.): abortar en vez de devolver una lista parcial
    // — el llamador reemplaza el cache de forma atómica y una lista incompleta
    // borraría publicaciones válidas del cache.
    if (resp.status !== 200) {
      // BLOQUEANTE 1: setear status para que categorizarErrorMl lo reciba
      const err = new Error(`ML scan falló (status ${resp.status}) para status=${status}`);
      err.status = resp.status;
      // Si el status viene marcado como sintético por nuestro propio cooldown, anotarlo
      if (resp.__cooldownSintetico) err.__cooldownSintetico = true;
      // ALTO 2: también propagar flag de "sin cupo" para distinguir 429s sintéticos
      if (resp.__sinCupo) err.__sinCupo = true;
      throw err;
    }
    const results = resp.data.results ?? [];
    if (results.length === 0) break;
    ids.push(...results);
    scrollId = resp.data.scroll_id;
    if (!scrollId) break;
    await sleep(CALL_DELAY_MS);
  }
  return ids;
}

/**
 * Trae todas las publicaciones activas/pausadas del vendedor desde la API de ML,
 * extrae atributos estructurados (COLOR, SIZE) y SELLER_SKU, y las cachea.
 * Devuelve { total, items, variaciones }.
 */
export async function refrescarPublicacionesMl(db, cfg, onProgress) {
  if (!mlCfgOk(cfg)) {
    // BLOQUEANTE 2: categoría 'config' para que incidente sea 'critico', no 'advertencia'
    const err = new Error('Configuración de MercadoLibre incompleta');
    err.categoria = 'config';
    throw err;
  }

  // 1) Reunir todos los item_id (activos + pausados), sin duplicados
  onProgress?.({ phase: 'listando', done: 0, total: 0 });
  const idSet = new Set();
  for (const st of STATUSES_A_TRAER) {
    const ids = await listarItemIds(db, cfg, st);
    ids.forEach(id => idSet.add(id));
    await sleep(CALL_DELAY_MS);
  }
  const allIds = [...idSet];

  // 2) Multiget de a 20 con los atributos necesarios
  const filas = [];
  for (let i = 0; i < allIds.length; i += MULTIGET_CHUNK) {
    const chunk = allIds.slice(i, i + MULTIGET_CHUNK);
    // manual: true — mismo refresco disparado a mano que en listarItemIds.
    const resp = await mlFetchConReintento(
      db, cfg, 'get',
      `/items?ids=${chunk.join(',')}&attributes=id,title,status,sub_status,seller_custom_field,attributes,variations,secure_thumbnail,thumbnail,permalink,catalog_listing,price,available_quantity`,
      null, { manual: true }
    );
    // Fallo del multiget: abortar. Reconstruir el cache con chunks faltantes
    // borraría publicaciones válidas sin aviso.
    if (resp.status !== 200 || !Array.isArray(resp.data)) {
      // BLOQUEANTE 1: setear status para que categorizarErrorMl lo reciba
      const err = new Error(`ML multiget falló (status ${resp.status}) en chunk ${i}-${i + chunk.length}`);
      err.status = resp.status;
      // Si el status viene marcado como sintético por nuestro propio cooldown, anotarlo
      if (resp.__cooldownSintetico) err.__cooldownSintetico = true;
      // ALTO 2: también propagar flag de "sin cupo" para distinguir 429s sintéticos
      if (resp.__sinCupo) err.__sinCupo = true;
      throw err;
    }
    for (const entry of resp.data) {
      // entry.code !== 200 por-ítem: ítem borrado/no accesible en ML — se excluye
      // legítimamente (no es un fallo de fetch del chunk completo).
      if (entry.code !== 200 || !entry.body) continue;
      filas.push(...aplanarItemMl(entry.body));
    }
    onProgress?.({ phase: 'trayendo', done: Math.min(i + MULTIGET_CHUNK, allIds.length), total: allIds.length });
    await sleep(CALL_DELAY_MS);
  }

  // 3) Reemplazar el cache de forma atómica
  // ALTO 4: si filas es vacío, NO borrar el cache existente (mismo criterio que Woo)
  // — una lista 0 es ambigua (podría ser legítimo o degradación) y no debe pisar datos válidos.
  if (filas.length > 0) {
    const upsert = prepararUpsertCache(db);
    const ts = now();
    const tx = db.transaction((rows) => {
      // Limpiar publicaciones que ya no están activas/pausadas
      db.prepare('DELETE FROM ml_publicaciones_cache').run();
      for (const f of rows) upsert.run({ ...f, actualizado_en: ts });
    });
    tx(filas);
  }

  const variaciones = filas.filter(f => f.es_variante === 1).length;
  return { total: filas.length, items: allIds.length, variaciones };
}

/**
 * Wrapper de `refrescarPublicacionesMl` que registra métricas, conecta el cooldown al
 * sistema de incidentes, y confirma ciclo sano. Patrón análogo al de `refrescarCatalogo`
 * en routes/woo.js (Hito 3).
 *
 * Sobre "0 publicaciones": a diferencia de Woo (donde un catálogo vacío es SIEMPRE sospechoso
 * porque la tienda tiene miles de productos), ML puede devolver legítimamente 0 si:
 * - El vendedor pausó todos los items (1 solo status = 'paused', 0 'active')
 * - El seller acaba de empezar (aún sin publicaciones)
 *
 * Sin embargo, un REFRESCO COMPLETO que devuelve 0 items cuando el anterior devolvió miles
 * ES sospechoso (la API degradada en silencio o respondiendo 200 pero vacío). Como no
 * tenemos la historia entre refrescos aquí, usamos un criterio conservador: 0 publicaciones
 * en refresco total es AMBIGUO — no se confirma ciclo sano (por si acaso es degradación
 * silenciosa), pero tampoco se abre incidente crítico (podría ser legítimo). Se registra
 * como `fallidos=0` (no es un error HTTP) y se deja la investigación para el operador si
 * ve que el cache quedó vacío de repente tras días con miles de items.
 */
export async function refrescarPublicacionesMlConMetricas(db, cfg, onProgress) {
  const iniciadoEn = new Date().toISOString();
  const inicioMonotonico = performance.now();
  try {
    const resultado = await refrescarPublicacionesMl(db, cfg, onProgress);
    const totalPublicaciones = resultado?.total ?? 0;

    // Registrar métrica exitosa
    registrarMetricaCicloMl(db, {
      iniciadoEn, inicioMonotonico,
      procesados: totalPublicaciones,
      fallidos: 0,
      circuitoAbierto: false,
    });

    // Criterio de "0 sospechoso" para ML: NO confirmamos ciclo sano si vino 0,
    // porque es ambiguo (podría ser degradación silenciosa). Confirmamos solo
    // si trajo publicaciones de verdad (señal inequívoca de que ML respondió con datos).
    if (totalPublicaciones > 0) {
      confirmarCicloSano(db, { integracion: INTEGRACION_ML, proceso: PROCESO_REFRESCAR_PUBLICACIONES });
    } else {
      // MEDIO 6: 0 publicaciones es legítimo en ML (vendedor nuevo o pausó todo), pero es
      // ambiguo. No es error, pero sí es info que merece visibilidad sin ser crítica.
      // La dedupe se autoresuelve: en el próximo ciclo con datos reales, confirmarCicloSano
      // resuelve todos los incidentes activos del proceso.
      // ALTO 4: subir severidad a 'advertencia' ahora que evitamos pisar el cache
      // (antes era 'info' porque era ambiguo; ahora hay un daño real que se previene).
      abrirOActualizarIncidente(db, {
        integracion: INTEGRACION_ML,
        proceso: PROCESO_REFRESCAR_PUBLICACIONES,
        tipoError: 'publicaciones_vacias',
        severidad: 'advertencia',
        mensajeTecnico: 'Refresco devolvió 0 publicaciones',
        mensajeHumano: 'MercadoLibre devolvió 0 publicaciones — podría ser legítimo (vendedor nuevo, todo pausado) o degradación silenciosa.',
        contexto: { circuitoAbierto: false },
      });
    }

    return resultado;
  } catch (e) {
    // MEDIO 7: `categorizarErrorMl` ya respeta `e.categoria` si está seteada, y clasifica
    // TypeError/RangeError/SqliteError como 'interno'. Llamar directo sin denylist duplicada.
    const categoria = categorizarErrorMl(e);

    // ALTO 3: consultar cooldown ANTES de registrar métrica para que ambas usen el mismo
    // estado (la métrica y el incidente deben ser consistentes en circuitoAbierto)
    const cd = estadoCooldownMl();

    // BAJO 8: optional chaining para evitar excepción si e es null/undefined
    registrarMetricaCicloMl(db, {
      iniciadoEn, inicioMonotonico,
      procesados: 0,
      fallidos: 1,
      circuitoAbierto: cd?.activo ?? !!e?.circuitoAbierto,
    });

    // MEDIO 5: si es un 429 sintético (por cooldown propio o cupo agotado), usar un
    // tipoError distinto para no pisar incidentes de 429s reales. La dedupe es por
    // integracion|proceso|tipo_error, así que esto abre un incidente separado.
    let tipoError = categoria;
    if (categoria === 'rate_limit' && (e?.__cooldownSintetico || e?.__sinCupo)) {
      tipoError = 'rate_limit_propio';
    }

    // BAJO 8: optional chaining en accesos a propiedades de e
    abrirOActualizarIncidente(db, {
      integracion: INTEGRACION_ML,
      proceso: PROCESO_REFRESCAR_PUBLICACIONES,
      tipoError,
      severidad: (categoria === 'auth' || categoria === 'config') ? 'critico' : (categoria === 'datos' ? 'info' : 'advertencia'),
      mensajeTecnico: e?.message ?? 'Error desconocido',
      mensajeHumano: MENSAJE_HUMANO_POR_CATEGORIA[categoria] ?? MENSAJE_HUMANO_POR_CATEGORIA.interno,
      contexto: { circuitoAbierto: cd?.activo ?? !!e?.circuitoAbierto, esErrorSinteticoCooldown: !!e?.__cooldownSintetico, esErrorSinCupo: !!e?.__sinCupo },
    });

    // Re-lanzar: el comportamiento ante el caller (cron/endpoint) no cambia — solo se agrega telemetría.
    throw e;
  }
}

/** Statement de upsert al cache de publicaciones (compartido entre refresco total y acotado). */
function prepararUpsertCache(db) {
  return db.prepare(`
    INSERT INTO ml_publicaciones_cache
      (clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, thumbnail, permalink, catalogo, precio, available_quantity, precio_actualizado_en, actualizado_en)
    VALUES (@clave, @item_id, @variation_id, @titulo, @status, @sub_status, @es_variante, @color, @talle, @seller_sku, @variations_texto, @thumbnail, @permalink, @catalogo, @precio, @available_quantity, @actualizado_en, @actualizado_en)
    ON CONFLICT(clave) DO UPDATE SET
      item_id=excluded.item_id, variation_id=excluded.variation_id, titulo=excluded.titulo,
      status=excluded.status, sub_status=excluded.sub_status, es_variante=excluded.es_variante, color=excluded.color,
      talle=excluded.talle, seller_sku=excluded.seller_sku, variations_texto=excluded.variations_texto,
      thumbnail=excluded.thumbnail, permalink=excluded.permalink, catalogo=excluded.catalogo,
      precio=excluded.precio, available_quantity=excluded.available_quantity,
      precio_actualizado_en=excluded.precio_actualizado_en, actualizado_en=excluded.actualizado_en
  `);
}

/**
 * Refresco ACOTADO: trae de ML solo los item_ids indicados (multiget directo, sin el
 * scan del catálogo completo) y hace upsert. A diferencia del refresco total, NUNCA
 * borra el resto del cache — un subconjunto no puede saber si las demás publicaciones
 * siguen vigentes. Devuelve { total, items, variaciones }.
 *
 * BAJO 9: no se envuelve con métricas+incidentes porque es el ciclo parcial bajo demanda
 * (disparado desde Cobertura con ?scope=atencion en POST /refrescar-ml), no el periódico.
 * El refresco total usa `refrescarPublicacionesMlConMetricas` que sí registra telemetría.
 */
export async function refrescarPublicacionesMlAcotado(db, cfg, itemIds, onProgress) {
  if (!mlCfgOk(cfg)) {
    // 4ta pasada del revisor (MEDIO 2): mismo estilo que el camino total (BLOQUEANTE 2) —
    // hoy este ciclo no está envuelto en métricas+incidentes (ver BAJO 9 arriba), pero dejar
    // el throw sin categoría es la trampa que ya se pisó 3 veces: el día que alguien lo
    // envuelva, un problema de config abriría incidente 'transitorio'/'advertencia' en vez
    // de 'config'/'critico'.
    const err = new Error('Configuración de MercadoLibre incompleta');
    err.categoria = 'config';
    throw err;
  }
  const ids = [...new Set((itemIds || []).map(String).filter(Boolean))];
  if (ids.length === 0) return { total: 0, items: 0, variaciones: 0 };

  const filas = [];
  for (let i = 0; i < ids.length; i += MULTIGET_CHUNK) {
    const chunk = ids.slice(i, i + MULTIGET_CHUNK);
    const resp = await mlFetchConReintento(
      db, cfg, 'get',
      `/items?ids=${chunk.join(',')}&attributes=id,title,status,sub_status,seller_custom_field,attributes,variations,secure_thumbnail,thumbnail,permalink,catalog_listing,price,available_quantity`
    );
    if (resp.status !== 200 || !Array.isArray(resp.data)) {
      // Mismo criterio que BLOQUEANTE 1 en el camino total: .status explícito para que
      // categorizarErrorMl no caiga a 'transitorio' por default, más los flags sintéticos
      // para distinguir un freno propio de un rechazo real de ML.
      const err = new Error(`ML multiget falló (status ${resp.status}) en chunk ${i}-${i + chunk.length}`);
      err.status = resp.status;
      if (resp.__cooldownSintetico) err.__cooldownSintetico = true;
      if (resp.__sinCupo) err.__sinCupo = true;
      throw err;
    }
    for (const entry of resp.data) {
      if (entry.code !== 200 || !entry.body) continue;
      filas.push(...aplanarItemMl(entry.body));
    }
    onProgress?.({ phase: 'trayendo', done: Math.min(i + MULTIGET_CHUNK, ids.length), total: ids.length });
    await sleep(CALL_DELAY_MS);
  }

  const upsert = prepararUpsertCache(db);
  const ts = now();
  const tx = db.transaction((rows) => {
    for (const f of rows) upsert.run({ ...f, actualizado_en: ts });
  });
  tx(filas);

  const variaciones = filas.filter(f => f.es_variante === 1).length;
  return { total: filas.length, items: ids.length, variaciones };
}

/**
 * Cruza el catálogo Woo (catalogo_cache) contra las publicaciones ML cacheadas
 * (ml_publicaciones_cache) y devuelve los ítems ya resueltos (candidatos + score +
 * decisión sugerida) para la fuente "API de ML". Es el cómputo caro que antes rehacía
 * cada dispositivo en un Web Worker; ahora se calcula una vez en el servidor.
 *
 * scope='atencion' → solo las publicaciones que necesitan atención (sin mapeo / a
 * re-mapear); cualquier otro valor → todas las cacheadas. Devuelve { items, total }.
 */
/**
 * Anota cada publicación con stockWc (stock de Woo para su seller_sku, o null si el SKU no
 * está en el catálogo / no tiene seller_sku) y sinStock (true si la publicación no está
 * activa, o si tiene stock ≤ 0; SKU desconocido queda visible). Cruce 100% local contra el
 * catálogo ya cacheado, SIN llamadas nuevas a ninguna API. Muta y devuelve `pubs`.
 *
 * Trim la clave al insertar y al buscar (seller_sku suele venir con espacios sucios) y ante
 * SKUs duplicados en catalogo_cache (simple + variación pueden compartir SKU) se queda con el
 * MÁXIMO stock, para no ocultar por error una publicación que sí tiene stock en alguna fila.
 */
function construirStockPorSku(db) {
  const stockPorSku = new Map();
  for (const c of db.prepare('SELECT sku, stock FROM catalogo_cache').all()) {
    if (c.sku == null) continue;
    const sku = String(c.sku).trim();
    if (sku === '') continue;
    const prev = stockPorSku.get(sku);
    const stock = c.stock;
    stockPorSku.set(sku, prev == null ? stock : Math.max(prev, stock ?? prev));
  }
  return stockPorSku;
}

function marcarStockWc(db, pubs) {
  const stockPorSku = construirStockPorSku(db);
  for (const p of pubs) {
    const sku = (p.seller_sku || '').trim();
    const stockWc = sku && stockPorSku.has(sku) ? stockPorSku.get(sku) : null;
    p.stockWc = stockWc;
    // sinStock: pausada (status != active), o mapeada con stock ≤ 0. SKU desconocido
    // (stockWc null) queda visible.
    p.sinStock = p.status !== 'active' || (stockWc !== null && stockWc <= 0);
  }
  return pubs;
}

/**
 * Re-cruza el stock de Woo sobre los ítems YA RESUELTOS que devuelve el cache de candidatos.
 * Es la parte barata (una lectura de catalogo_cache + un Map) y DEBE correrse en cada request,
 * FUERA del bloque cacheado por firma: firmaCandidatos ignora deliberadamente el stock (ver
 * hashCatalogoMatching), así que el cruce caro (LCS/matching) queda cacheado pero el stock hay
 * que recalcularlo siempre contra el catalogo_cache actual, o el filtro "solo con stock"
 * mostraría stock viejo y habilitaría sobreventa.
 *
 * - Ítems de "verificar" (tienen sku_actual, el SKU real confirmado): se re-cruzan por ESE SKU.
 * - Ítems de "asignar" (sin sku_actual): no hay SKU con que cruzar, así que sin_stock depende
 *   solo del status (igual que en marcarStockWc para SKU desconocido).
 * Muta y devuelve `items`.
 */
export function remarcarStockResueltos(db, items) {
  const stockPorSku = construirStockPorSku(db);
  // Status vivo por item_id (ronda 2, M2 revisor): el `ml_status` cacheado en el payload de
  // candidatos (armado por construirMLdesdeApi al calcular el cruce, dentro del bloque
  // cacheado por firma) puede quedar stale hasta 3h — reconciliarStockMl (routes/sync.js)
  // reescribe status/sub_status de ml_publicaciones_cache en cron sin tocar `actualizado_en`
  // a propósito (ver firmaCandidatos más abajo), así que ese write-back NO invalida el caché
  // de candidatos. Sin este re-cruce, la base ya diría 'active' pero la grilla seguiría
  // mostrando 'paused' hasta el próximo refresh manual o restart. Igual criterio que el
  // stock: barato (una query + Map), se recalcula en cada request, fuera del bloque cacheado.
  // Mapeado por clave (item_id|variation_id), no por item_id solo: dos variaciones del mismo
  // ítem pueden divergir en status (mismo patrón ya corregido en sync.js) y un mapa por
  // item_id le pisaría a todas el status de la última fila leída.
  const statusPorClave = new Map();
  for (const r of db.prepare('SELECT item_id, variation_id, status, sub_status FROM ml_publicaciones_cache').all()) {
    if (r.status != null) {
      statusPorClave.set(armarClaveMl(r.item_id, r.variation_id), { status: r.status, sub_status: r.sub_status || '' });
    }
  }
  for (const it of items) {
    const sku = (it.sku_actual || '').trim();
    const stockWc = sku && stockPorSku.has(sku) ? stockPorSku.get(sku) : null;
    const vivo = statusPorClave.get(armarClaveMl(it.ml_item_id, it.ml_variation_id));
    const statusVivo = vivo ? vivo.status : it.ml_status;
    it.ml_status = statusVivo;
    if (vivo) it.ml_sub_status = vivo.sub_status;
    it.ml_stock_wc = stockWc;
    it.ml_sin_stock = statusVivo !== 'active' || (stockWc !== null && stockWc <= 0);
  }
  return items;
}

export function computarCandidatosApi(db, scope) {
  const catalogo = db.prepare('SELECT id_woo, nombre, sku, tipo, img, atributos_json FROM catalogo_cache').all();

  let pubs;
  if (scope === 'atencion') {
    const claves = clavesNecesitanAtencion(db);
    if (claves.length === 0) return { items: [], total: 0 };
    const placeholders = claves.map(() => '?').join(',');
    pubs = db.prepare(`
      SELECT clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo
      FROM ml_publicaciones_cache WHERE clave IN (${placeholders}) ORDER BY titulo
    `).all(...claves);
  } else {
    pubs = db.prepare(`
      SELECT clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo
      FROM ml_publicaciones_cache ORDER BY titulo
    `).all();
  }

  const { wcItems, indice, wcPorSku } = construirWC(catalogo);
  const { sinSku, conSkuValido } = construirMLdesdeApi(pubs, wcItems);
  const items = [...sinSku, ...conSkuValido];
  const candArr = items.map((it) => candidatosDeItem(it, wcItems, indice));
  const resueltos = derivarEstadoApi(items, candArr, wcPorSku);
  return { items: resueltos, total: resueltos.length };
}

// Cache en memoria del cruce por scope. Recorrer todo el catálogo por publicación es lo
// caro que se quiere evitar repetir; se recalcula solo si cambió la firma de los caches.
// Es un cache de proceso: se pierde al reiniciar, lo cual es correcto (fail-open, se
// recalcula).
const _cacheCandidatos = new Map(); // scope -> { firma, resultado }

// Espejo en disco de _cacheCandidatos (tabla matcher_candidatos_cache, ver db/index.js). El
// Map en memoria se pierde en cada reinicio de pm2; esto evita que el primer usuario del día
// pague de nuevo el cruce completo (~70s) cuando la firma (catálogo Woo + últimas publicaciones
// ML) no cambió desde la última corrida real.
function obtenerCacheValida(db, scope, firma) {
  const enMemoria = _cacheCandidatos.get(scope);
  if (enMemoria && enMemoria.firma === firma) return enMemoria.resultado;
  const fila = db.prepare('SELECT firma, resultado_json FROM matcher_candidatos_cache WHERE scope=?').get(scope);
  if (fila && fila.firma === firma) {
    try {
      const resultado = JSON.parse(fila.resultado_json);
      _cacheCandidatos.set(scope, { firma, resultado });
      return resultado;
    } catch (_) { /* JSON corrupto en disco: tratar como miss y recomputar */ }
  }
  return null;
}

function guardarCacheDisco(db, scope, firma, resultado) {
  // La caché en disco es una optimización de arranque, nunca debe tumbar un cómputo que ya
  // salió bien — cualquier fallo de escritura se ignora y el próximo restart recomputa.
  try {
    db.prepare(`
      INSERT INTO matcher_candidatos_cache (scope, firma, resultado_json, actualizado_en)
      VALUES (?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET firma=excluded.firma, resultado_json=excluded.resultado_json, actualizado_en=excluded.actualizado_en
    `).run(scope, firma, JSON.stringify(resultado), now());
  } catch (_) {}
}

// Estado del cómputo de candidatos en background por scope. El cruce completo
// (computarCandidatosApi: O(publicaciones × catálogo) con LCS) tarda decenas de segundos en
// frío (tras un restart de pm2, con el cache de proceso vacío) y superaba el proxy_read_timeout
// de nginx (120s) → el usuario veía un timeout. Ahora un GET /candidatos con cache MISS arranca
// el cómputo en background y responde 202 al toque; el frontend sondea hasta que hay hit.
// Mismo patrón que _refresco para /refrescar-ml. Un solo cómputo a la vez por scope.
const _computoCandidatos = new Map(); // scope -> { running, done, total, error, iniciado_en }

// Arranca (si no hay uno ya corriendo para ese scope) el cruce completo en background y lo
// guarda en _cacheCandidatos con su firma, para que el próximo GET lo encuentre como hit.
// OJO: computarCandidatosApi es CPU-bound y síncrono; correrlo en background con setImmediate
// no lo saca del event loop (lo bloquea mientras corre), pero el response 202 ya salió antes de
// arrancarlo, así que el request que lo disparó nunca choca el timeout de nginx. Es el mismo
// trade-off (aceptado) que refrescarPublicacionesMl. Devuelve el estado actual.
function lanzarComputoCandidatos(db, scope) {
  const st = _computoCandidatos.get(scope);
  if (st && st.running) return st;
  const nuevo = { running: true, done: 0, total: 0, error: null, iniciado_en: now() };
  _computoCandidatos.set(scope, nuevo);
  setImmediate(() => {
    try {
      const firma = firmaCandidatos(db);
      const resultado = computarCandidatosApi(db, scope);
      _cacheCandidatos.set(scope, { firma, resultado });
      guardarCacheDisco(db, scope, firma, resultado);
      _computoCandidatos.set(scope, { running: false, done: resultado.total, total: resultado.total, error: null, iniciado_en: nuevo.iniciado_en });
    } catch (e) {
      _computoCandidatos.set(scope, { running: false, done: 0, total: 0, error: e.message, iniciado_en: nuevo.iniciado_en });
    }
  });
  return nuevo;
}

// Hash barato (djb2, no criptográfico) de SOLO los campos del catálogo que afectan el
// matching: sku, nombre y atributos. DELIBERADAMENTE ignora stock/precio/actualizado_en,
// que el auto-sync bumpea cada ~15 min: si la firma dependiera de eso, el cruce completo
// (O(publicaciones × catálogo) con LCS) se recomputaría sin necesidad todo el tiempo.
function hashCatalogoMatching(db) {
  const rows = db.prepare('SELECT sku, nombre, atributos_json FROM catalogo_cache').all();
  let h = 5381;
  for (const r of rows) {
    const s = `${r.sku || ''}${r.nombre || ''}${r.atributos_json || ''}`;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return `${rows.length}:${h}`;
}

function firmaCandidatos(db) {
  // Catálogo: hash de campos relevantes al matching (NO stock — ver hashCatalogoMatching).
  const wc = hashCatalogoMatching(db);
  // Publicaciones ML: se refrescan a mano desde ML (el refresh completo del botón del
  // matcher), así que conteo + max(actualizado_en) alcanza para detectar ESE refresco.
  // Excepción deliberada (revisor, B1 2026-08-07): reconciliarStockMl (routes/sync.js)
  // también escribe status/sub_status de esta misma tabla, en cron, pero a propósito NO
  // toca actualizado_en al hacerlo — si lo tocara, cada corrida del barrido invalidaría este
  // caché completo (recómputo de >120s) sin que título/sku/atributos hayan cambiado.
  //
  // OJO (ronda 2, M2 revisor): el cruce de candidatos en sí (candidatosDeItem, en
  // lib/matcherEngine.js) NO usa status/sub_status, solo sku/nombre/atributos — hasta ahí la
  // firma sigue siendo válida como invalidador. Pero el payload cacheado por request SÍ trae
  // status: construirMLdesdeApi (matcherResolver.js) lo mete como `ml_status` en cada ítem
  // resuelto, y ese campo alimenta `ml_sin_stock` en remarcarStockResueltos, y en el front el
  // filtro activa/pausada, el orden y el badge de estado. Sin la re-lectura de status vivo que
  // agrega remarcarStockResueltos (mismo patrón que ya usaba para el stock, ver más abajo en
  // este archivo), la grilla podía mostrar un status stale hasta 3h tras el write-back de
  // reconciliarStockMl. Se acepta no invalidar la firma (evita el recómputo de >120s) a cambio
  // de resolver el stale status con ese re-cruce barato en cada request.
  const ml = db.prepare('SELECT COUNT(*) n, MAX(actualizado_en) t FROM ml_publicaciones_cache').get();
  // Decisiones: afectan el subconjunto 'atencion' (una decisión saca la clave de la lista).
  const dec = db.prepare('SELECT COUNT(*) n, MAX(actualizado_en) t FROM sku_matcher_decisiones').get();
  return `wc:${wc}|ml:${ml.n}:${ml.t || ''}|dec:${dec.n}:${dec.t || ''}`;
}

// peek=true → NO computa ante un miss: devuelve vacío con cache:false al toque. Lo usa el
// warm-start al abrir la página, que sólo quiere saber si hay un resultado ya listo para
// retomar sin pagar el costo del cruce completo (objetivo: abrir el matcher nunca se traba).
function candidatosApiCacheado(db, scope, { peek = false } = {}) {
  const firma = firmaCandidatos(db);
  const cacheado = obtenerCacheValida(db, scope, firma);
  let out;
  if (cacheado) {
    out = { ...cacheado, cache: true };
  } else {
    if (peek) return { items: [], total: 0, cache: false };
    const resultado = computarCandidatosApi(db, scope);
    _cacheCandidatos.set(scope, { firma, resultado });
    guardarCacheDisco(db, scope, firma, resultado);
    out = { ...resultado, cache: false };
  }
  // Recálculo de stock FUERA del bloque cacheado: la firma ignora el stock a propósito, así
  // que en cada request (hit o miss) se re-cruza contra el catalogo_cache actual. Sin esto,
  // un SKU que el auto-sync bajó a 0 seguiría apareciendo "con stock" (sobreventa).
  remarcarStockResueltos(db, out.items);
  return out;
}

export function matcherRouter(db, cfg) {
  const router = Router();
  const mlCfg = cfg?.ml ?? cfg;

  router.get('/decisiones', (req, res) => {
    const rows = db.prepare('SELECT clave, sku, wc_nombre, accion FROM sku_matcher_decisiones').all();
    const data = {};
    for (const row of rows) data[row.clave] = { sku: row.sku, wc_nombre: row.wc_nombre, accion: row.accion };
    res.json({ ok: true, data });
  });

  router.post('/decisiones', (_req, res) => {
    // UM1: esta ruta legacy de mutación directa está bloqueada. Todas las escrituras de
    // vínculo, pausa y seller_sku deben pasar por el servicio Guardia para mantener la
    // auditoría y la coherencia del estado de cobertura.
    return res.status(410).json({
      ok: false,
      error: 'Ruta de mutación legacy bloqueada para UM1 (cobertura única)',
      migracion: 'Las decisiones de vínculo deben hacerse vía /api/guardia-ml/casos/:id/vincular (requiere Guardia habilitada)',
      detalles: {
        old_endpoint: 'POST /api/matcher/decisiones',
        new_flow: 'Accedé a Guardia ML en el frontend → localizá el caso urgente → seleccioná "Vincular" → indicá el SKU Woo',
        direct_api: 'POST /api/guardia-ml/casos/{casoId}/vincular con {sku} en body'
      }
    });
  });

  // Arranca el refresco de publicaciones y devuelve 202 sin bloquear (evita el timeout de
  // nginx). body { scope:'atencion' } → refresco acotado (rápido); sin scope → refresco total.
  // El progreso se consulta en GET /refrescar-ml/estado.
  router.post('/refrescar-ml', (req, res) => {
    const scope = req.body?.scope === 'atencion' ? 'atencion' : 'all';
    const r = dispararRefrescoMl(db, mlCfg, scope);
    res.status(r.ok ? 202 : 409).json(r);
  });

  // Estado del refresco (para sondeo del frontend). Devuelve progreso y último resultado.
  router.get('/refrescar-ml/estado', (req, res) => {
    res.json({ ok: true, ...estadoRefrescoMl() });
  });

  // Mapeos huérfanos: decisiones activas cuya publicación ya no está en el cache (cerrada/
  // borrada o fuera del scan active+paused). No se borran — se listan para revisión manual.
  router.get('/huerfanos', (req, res) => {
    const filtro = `d.accion IN ('asignar','confirmar')
      AND d.clave NOT IN (SELECT clave FROM ml_publicaciones_cache)`;
    const total = db.prepare(`SELECT COUNT(*) n FROM sku_matcher_decisiones d WHERE ${filtro}`).get().n;
    const data = db.prepare(
      `SELECT d.clave, d.sku, d.wc_nombre FROM sku_matcher_decisiones d WHERE ${filtro} ORDER BY d.clave LIMIT 500`
    ).all();
    res.json({ ok: true, total, data });
  });

  // Escribe el SKU de UNA decisión en la publicación de ML (usado al confirmar)
  router.post('/push-sku', async (req, res) => {
    return res.status(410).json({
      ok: false,
      error: 'Push legacy bloqueado: toda escritura de seller_sku debe originarse en una operación durable de Guardia ML',
      migracion: 'POST /api/guardia-ml/casos/:id/vincular',
    });
  });

  // Arranca la escritura en ML de las decisiones mapeadas pendientes en background (mismo
  // patrón que POST /refrescar-ml: evita el timeout de nginx de 120s y permite cerrar la
  // pestaña — corre igual, disparado también por el cron de server.js). 202 al toque, o 409
  // si ya hay una corrida en curso (cron u otro request). El progreso se sondea en
  // GET /push-skus-pendientes/estado.
  //
  // A diferencia del cron (que aplica CUOTA_PAUSADAS_DEFAULT, 10 publicaciones pausadas
  // distintas por corrida, para no competir con el sync por presupuesto de ML), el botón
  // manual IGNORA la cuota de pausadas (cuotaPausadas: null) porque el usuario disparó la
  // acción a propósito y está esperando el resultado completo.
  router.post('/push-skus-pendientes', (req, res) => {
    return res.status(410).json({
      ok: false,
      error: 'Push masivo legacy bloqueado: Guardia procesa únicamente operaciones encoladas y auditadas',
      migracion: 'POST /api/guardia-ml/casos/:id/vincular',
    });
  });

  // Estado del push (para sondeo del frontend, y para ver el resultado del último ciclo
  // del cron aunque nadie haya tocado el botón).
  router.get('/push-skus-pendientes/estado', (req, res) => {
    res.json({ ok: true, ...getEstadoPush() });
  });

  // Cuántas decisiones tienen SKU pendiente de escribir en ML. Incluye activas Y pausadas
  // (las pausadas también se escriben; las activas van primero en la cola de push).
  router.get('/push-skus-pendientes/count', (req, res) => {
    res.status(410).json({
      ok: false,
      error: 'La cola de push legacy fue retirada; consultar y accionar desde Guardia ML',
      migracion: 'GET /api/guardia-ml/casos',
    });
  });

  // Listado (solo lectura) de las decisiones pendientes de escribir en ML — mismo filtro
  // que /push-skus-pendientes (POST) y /count (sin filtro de status), más el estado del
  // último intento fallido (si lo hay), para una vista enfocada de qué falta y por qué.
  router.get('/push-skus-pendientes/list', (req, res) => {
    const rows = db.prepare(`
      SELECT d.clave, d.sku, p.titulo, p.thumbnail, p.item_id, p.status,
             f.intentos, f.ultimo_error, f.proximo_intento_en
      FROM sku_matcher_decisiones d
      JOIN ml_publicaciones_cache p ON p.clave = d.clave
      LEFT JOIN ml_sku_push_fallos f ON f.clave = d.clave
      WHERE d.accion IN ('asignar','confirmar') AND d.sku LIKE 'FB-%'
        AND COALESCE(p.seller_sku,'') <> d.sku
      ORDER BY CASE WHEN p.status = 'active' THEN 0 ELSE 1 END, d.actualizado_en DESC
    `).all();
    res.json({ ok: true, data: rows });
  });

  // Lee las publicaciones cacheadas.
  // ?scope=atencion → solo las que necesitan atención (sin mapeo / a re-mapear).
  const SELECT_PUBS = `
    SELECT clave, item_id, variation_id, titulo, status, sub_status, es_variante, color, talle, seller_sku, variations_texto, permalink, catalogo, actualizado_en
    FROM ml_publicaciones_cache`;
  // Tope defensivo por defecto: por encima del MAX de publicaciones (20.000), así el
  // matcher sigue recibiendo el dataset completo, pero la respuesta nunca queda sin
  // límite. Se puede acotar con ?limit / ?offset.
  const PUBS_LIMIT_DEFAULT = 100000;
  router.get('/publicaciones', (req, res) => {
    const rawLimit = Number(req.query.limit);
    const rawOffset = Number(req.query.offset);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), PUBS_LIMIT_DEFAULT)
      : PUBS_LIMIT_DEFAULT;
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

    let rows;
    if (req.query.scope === 'atencion') {
      const claves = clavesNecesitanAtencion(db);
      if (claves.length === 0) {
        return res.json({ ok: true, data: [], actualizado: null, total: 0 });
      }
      const placeholders = claves.map(() => '?').join(',');
      rows = db.prepare(`${SELECT_PUBS} WHERE clave IN (${placeholders}) ORDER BY titulo LIMIT ? OFFSET ?`)
        .all(...claves, limit, offset);
    } else {
      rows = db.prepare(`${SELECT_PUBS} ORDER BY titulo LIMIT ? OFFSET ?`).all(limit, offset);
    }
    // Mismo cruce de stock que /candidatos, por consistencia (con el push automático,
    // /publicaciones vuelve a alimentar la grilla del matcher).
    marcarStockWc(db, rows);
    const actualizado = rows[0]?.actualizado_en ?? null;
    res.json({ ok: true, data: rows, actualizado, total: rows.length });
  });

  // Cruce ya resuelto para la fuente "API de ML": candidatos + score + decisión sugerida
  // por publicación, calculado server-side (antes lo rehacía cada dispositivo en un Web
  // Worker). El modo Excel NO usa este endpoint (el archivo no llega al servidor).
  // ?scope=atencion → solo las que necesitan atención. Cache corta por firma de caches.
  // ?peek=1 → si el cruce no está cacheado, NO lo computa: devuelve vacío con cache:false
  // al toque (para el warm-start al abrir la página, que sólo quiere saber si retomar).
  router.get('/candidatos', (req, res) => {
    try {
      const scope = req.query.scope === 'atencion' ? 'atencion' : 'all';
      const peek = req.query.peek === '1' || req.query.peek === 'true';
      // HIT-path (rápido): candidatosApiCacheado con peek:true nunca computa; si hay un
      // resultado cacheado válido para la firma actual lo marca cache:true, y ahí lo servimos
      // síncrono como siempre. En un peek explícito también respondemos al toque (vacío si no
      // hay hit): comportamiento del warm-start sin cambios.
      const cacheado = candidatosApiCacheado(db, scope, { peek: true });
      const actualizado = db.prepare('SELECT MAX(actualizado_en) t FROM ml_publicaciones_cache').get().t ?? null;
      if (cacheado.cache || peek) {
        return res.json({ ok: true, data: cacheado.items, total: cacheado.total, actualizado, scope, cache: cacheado.cache });
      }
      // MISS (y no es peek): el cruce completo es lo que bloqueaba el request más de 120s en
      // frío. Si el último cómputo en background falló, devolvemos ese error una vez (y limpiamos
      // el estado para permitir reintento en el próximo pedido). Si no, arrancamos el cómputo en
      // background y respondemos 202 al toque; el frontend sondea /candidatos hasta el hit.
      const prev = _computoCandidatos.get(scope);
      if (prev && !prev.running && prev.error) {
        _computoCandidatos.delete(scope);
        return res.status(500).json({ ok: false, error: prev.error, scope });
      }
      lanzarComputoCandidatos(db, scope);
      return res.status(202).json({ ok: true, computing: true, scope });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
