/**
 * Motor de escritura automática de SKUs en MercadoLibre (matcher → push).
 *
 * Antes vivía en el navegador (public/matcher/index.html: escribirSkusEnMl), llamando al
 * backend en lotes desde la pestaña — cerrarla cortaba el trabajo. Ahora corre acá, disparado
 * por un cron en server.js y consultable vía GET /push-skus-pendientes/estado.
 *
 * Fail-open/fail-closed explícito por tipo de error (ver pushSkusPendientes):
 *  - 429 (rate limit) → NO es un fallo de la publicación: se reintenta con backoff y, si
 *    persiste, se corta la corrida ENTERA sin marcar fallo (fail-open: se reintenta solo,
 *    en el próximo ciclo de cron, sin penalizar publicaciones que nunca se llegaron a intentar).
 *    Aplica igual al PUT individual y al PUT agrupado por publicación (paso 2).
 *  - status:0 (no llegamos a hablar con ML: config faltante, error de red, excepción antes
 *    de la respuesta) → NO es un rechazo de ML a la publicación: fail-open, no se registra
 *    backoff (no penalizamos algo que ML nunca evaluó) y se corta la corrida entera, porque
 *    la causa probablemente afecta a todo el lote (ej. ML_CLIENT_ID no configurado).
 *  - Cualquier otro error (400/403/etc., fallo de publicación real, hubo respuesta de ML)
 *    → SÍ se registra en ml_sku_push_fallos con backoff exponencial por publicación
 *    (fail-closed respecto de esa publicación puntual: no se reintenta en cada ciclo, se
 *    espera el backoff).
 *
 * `cfg` acepta tanto la config de sync completa `{woo, ml}` como el cfg de ML puntual —
 * pushSkusPendientes() normaliza internamente (cfg?.ml ?? cfg) para cubrir a los dos
 * llamadores (cron en server.js y POST /push-skus-pendientes en routes/matcher.js).
 *
 * Ahorro de llamadas a ML (2026-08-06, ver docs/superpowers/plans/2026-08-06-push-skus-menos-
 * llamadas.md): antes se podía reescribir un SKU que ML ya tenía (cache stale, solo se
 * refresca a mano vía POST /refrescar-ml) y siempre se hacía 1 PUT por variación. Ahora:
 *  - Verificación previa: antes de procesar un lote, se refresca `ml_publicaciones_cache`
 *    (seller_sku y status) contra ML en vivo con un multiget en chunks de 20 — mismo patrón
 *    que `evaluarPreciosReactivables`/`reactivarItems` en routes/sync.js. Existe SOLO porque
 *    `ml_publicaciones_cache.seller_sku` no tiene refresco automático (mismo acoplamiento
 *    implícito que ya se documentó para `precio` en `necesitaRecheck`, routes/sync.js). Una
 *    clave cuyo SELLER_SKU en ML ya coincide con la decisión se descarta del lote SIN PUT
 *    (idempotencia de escribirSkuEnMl, que ya usaba esta misma caché). Fail-closed: si el
 *    multiget de un chunk falla o la respuesta no trae el dato, la caché queda como estaba y
 *    la clave sigue su camino normal de escritura — nunca se descarta por ausencia de dato.
 *  - Agrupado: publicaciones con 2+ variaciones pendientes se escriben con 1 solo PUT a
 *    /items/{itemId} (en vez de 1 PUT por variación), con fallback automático por variación
 *    si ML rechaza el agrupado (revalida el item completo, ej. límite de fotos).
 *  - Cuota de pausadas por corrida automática (cron): las activas entran siempre y primero;
 *    las pausadas avanzan de a `CUOTA_PAUSADAS_DEFAULT` publicaciones por corrida para no
 *    competir con el sync por presupuesto de ML. El botón manual la ignora (ver
 *    routes/matcher.js): el usuario está esperando el resultado.
 */

import { mlFetch } from './mlClient.js';
import { partirClaveMl, armarClaveMl, extraerErrorMl } from './mlUtil.js';
import { mapConLimite } from './concurrencia.js';

const LOTE_PUSH = 120; // tamaño de cada tanda; una corrida puede encadenar varias tandas (ver TIEMPO_MAX_CORRIDA_MS)
const CALL_DELAY_MS = 350; // respeta rate limit entre publicaciones (igual que el resto del matcher)
const REINTENTOS_429_MS = [350, 1000]; // backoff creciente ante 429 persistente
// mlFetch ya duerme el `retry-after` real y reintenta una vez (lib/mlClient.js) antes de
// devolvernos el 429; esto es una segunda capa por si ML sigue rechazando después. Con solo
// 2 pasos evitamos que un retry-after real (ej. 5s) sumado a estos reintentos deje una sola
// publicación consumiendo más de un minuto.
// Tope de tiempo por corrida: cicla tandas de LOTE_PUSH hasta agotar pendientes, cortar por
// 429/error o llegar a este tope — así el botón manual y el cron completan más rápido que
// esperar 90 min de ciclos de 120, sin arriesgar solaparse con el próximo cron (corre cada
// 10 min). Con el agrupado y la cuota de pausadas, una corrida real debería terminar mucho
// antes de este tope: queda como red de seguridad, no como objetivo.
const TIEMPO_MAX_CORRIDA_MS = 5 * 60 * 1000;

const MULTIGET_CHUNK = 20; // ML permite hasta 20 ids por multiget
const ML_CONCURRENCIA_MAX = 4; // mismo tope que evaluarPreciosReactivables/reactivarItems (routes/sync.js)
const CUOTA_PAUSADAS_DEFAULT = 20; // publicaciones pausadas por corrida automática (no variaciones)

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Escribe el SELLER_SKU de una publicación/variación en MercadoLibre.
 * Variaciones usan el endpoint puntual /items/{id}/variations/{varId} (evita la
 * revalidación del item completo, ej. límite de fotos). Devuelve { ok, status, saltado }.
 *
 * opts.manual === true saltea el cooldown de 429 y solo corresponde cuando la escritura
 * la dispara el usuario a mano (confirmar un match). El push automático DEBE dejarlo en
 * false: si ignorara el cooldown, la cola entera martillaría a ML durante un 429.
 */
export async function escribirSkuEnMl(db, cfg, clave, sku, opts = {}) {
  const { itemId, variationId } = partirClaveMl(clave);
  if (!itemId || !sku) return { ok: false, status: 0, error: 'clave o sku inválido' };

  // Idempotencia: si ML ya tiene ese SKU, no reescribir
  const cacheRow = db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
  if (cacheRow && (cacheRow.seller_sku || '') === sku) return { ok: true, status: 200, saltado: true };

  const path = variationId
    ? `/items/${itemId}/variations/${variationId}`
    : `/items/${itemId}`;
  const body = { attributes: [{ id: 'SELLER_SKU', value_name: sku }] };

  const resp = await mlFetch(db, cfg, 'put', path, body, { manual: opts.manual === true });
  if (resp.status === 200) {
    db.prepare('UPDATE ml_publicaciones_cache SET seller_sku = ? WHERE clave = ?').run(sku, clave);
    return { ok: true, status: 200 };
  }
  return { ok: false, status: resp.status, error: extraerErrorMl(resp) };
}

/**
 * Escribe el SELLER_SKU de VARIAS variaciones de la MISMA publicación en un solo PUT a
 * /items/{itemId} (en vez de un PUT por variación). Solo se usa cuando hay 2+ variaciones
 * pendientes de la misma publicación (ver agruparPorItem). No hace la idempotencia por
 * variación de escribirSkuEnMl: se asume que el llamador ya filtró lo ya resuelto (ver
 * pushSkusPendientes) — reescribir un SELLER_SKU que ML ya tiene es inofensivo porque va
 * en el mismo PUT que las demás, no cuesta una llamada extra.
 * Devuelve { ok, status, error }. Solo status 200 cuenta como éxito (mlFetch nunca lanza
 * por status HTTP, ver lib/mlClient.js).
 */
export async function escribirSkusAgrupadoEnMl(db, cfg, itemId, entradas) {
  const body = {
    variations: entradas.map(e => ({
      id: /^\d+$/.test(String(e.variationId)) ? Number(e.variationId) : e.variationId,
      attributes: [{ id: 'SELLER_SKU', value_name: e.sku }],
    })),
  };
  const resp = await mlFetch(db, cfg, 'put', `/items/${itemId}`, body);
  if (resp.status === 200) {
    const upd = db.prepare('UPDATE ml_publicaciones_cache SET seller_sku = ? WHERE clave = ?');
    for (const e of entradas) upd.run(e.sku, e.clave);
    return { ok: true, status: 200 };
  }
  return { ok: false, status: resp.status, error: extraerErrorMl(resp) };
}

/** Busca el atributo SELLER_SKU en un array de atributos de ML (item o variación). */
function extraerSellerSkuDeAtributos(attributes) {
  const attr = (attributes || []).find(a => a?.id === 'SELLER_SKU');
  return attr?.value_name || '';
}

/**
 * Vuelca en ml_publicaciones_cache el status y seller_sku reales que devolvió el multiget
 * de verificación, para el item y todas sus variaciones presentes en la respuesta.
 * Solo toca las claves que existen en la caché (UPDATE, no INSERT): si una clave no está
 * cacheada, no hace nada — no es su trabajo poblar la caché desde cero.
 */
function actualizarCacheDesdeItemMl(db, body) {
  const itemId = String(body?.id ?? '');
  if (!itemId) return;
  const status = body.status || null;
  const upd = db.prepare('UPDATE ml_publicaciones_cache SET status = COALESCE(?, status), seller_sku = ? WHERE clave = ?');
  upd.run(status, extraerSellerSkuDeAtributos(body.attributes), armarClaveMl(itemId, ''));
  for (const v of body.variations || []) {
    upd.run(status, extraerSellerSkuDeAtributos(v.attributes), armarClaveMl(itemId, v.id));
  }
}

/**
 * Refresca contra ML en vivo (multiget en chunks de MULTIGET_CHUNK) el status y seller_sku
 * de las publicaciones involucradas en `lote`. Existe SOLO porque
 * ml_publicaciones_cache.seller_sku no tiene refresco automático (se refresca a mano vía
 * POST /refrescar-ml) — sin esto se puede reescribir en loop un SKU que ML ya tiene.
 * Fail-closed por chunk: si un chunk de multiget lanza (timeout/error de red de axios, que
 * SÍ lanza a diferencia de un status HTTP) o responde algo distinto de 200, ese chunk queda
 * sin refrescar y sus claves siguen su camino normal de escritura (mismo criterio que
 * evaluarPreciosReactivables/reactivarItems en routes/sync.js) — nunca se descartan por
 * falta de dato.
 */
export async function verificarLoteEnMl(db, cfg, lote) {
  const itemIds = [...new Set(lote.map(p => partirClaveMl(p.clave).itemId).filter(Boolean))];
  if (itemIds.length === 0) return;

  const chunks = [];
  for (let i = 0; i < itemIds.length; i += MULTIGET_CHUNK) chunks.push(itemIds.slice(i, i + MULTIGET_CHUNK));

  await mapConLimite(chunks, ML_CONCURRENCIA_MAX, async (chunk) => {
    try {
      const resp = await mlFetch(db, cfg, 'get', `/items?ids=${chunk.join(',')}&attributes=id,status,variations,attributes`);
      if (resp.status === 200 && Array.isArray(resp.data)) {
        for (const e of resp.data) if (e.code === 200 && e.body) actualizarCacheDesdeItemMl(db, e.body);
      }
    } catch (e) {
      console.error(`push SKUs matcher: verificación multiget falló para un chunk: ${e.message}`);
    }
  });
}

// Filtro base compartido: decisiones con SKU de FusionBikes, mapeadas a una publicación
// cacheada, todavía no escritas en ML — SIN filtro de status (activas y pausadas se
// escriben; las activas van primero en la cola, ver ORDER BY). Excluye claves con un fallo
// reciente cuyo backoff (proximo_intento_en) todavía no venció.
const FILTRO_BASE = `
  FROM sku_matcher_decisiones d
  JOIN ml_publicaciones_cache p ON p.clave = d.clave
  LEFT JOIN ml_sku_push_fallos f ON f.clave = d.clave
  WHERE d.accion IN ('asignar','confirmar')
    AND d.sku LIKE 'FB-%'
    AND COALESCE(p.seller_sku,'') <> d.sku`;

const EN_ESPERA = `(f.proximo_intento_en IS NOT NULL AND f.proximo_intento_en > @ahora)`;

/**
 * Selecciona hasta `limite` decisiones pendientes de escribir, listas para intentar ahora
 * (fuera de backoff). Activas antes que pausadas; dentro de cada grupo, más recientes primero.
 *
 * Cuota de pausadas (paso 3, ahorro de llamadas 2026-08-06): con `cuotaPausadas` (número),
 * TODAS las activas listas entran siempre sin cuota, y las pausadas se toman después hasta
 * cuotaPausadas PUBLICACIONES distintas (no variaciones) — con `cuotaPausadas: null` (default,
 * usado por el botón manual) no hay cuota y las pausadas se acotan solo por `limite`, como
 * antes de este cambio.
 */
export function seleccionarPendientes(db, opts = {}) {
  // Compat: algunos tests/llamadores viejos pasaban un número como 2do argumento
  // (limite a secas). Se sigue aceptando para no romper ese uso.
  if (typeof opts === 'number') opts = { limite: opts };
  const { limite = LOTE_PUSH, cuotaPausadas = null } = opts;

  const activas = db.prepare(`
    SELECT d.clave, d.sku, p.status
    ${FILTRO_BASE}
      AND p.status = 'active'
      AND NOT ${EN_ESPERA}
    ORDER BY d.actualizado_en DESC
  `).all({ ahora: now() });

  if (cuotaPausadas == null) {
    const restante = Math.max(0, limite - activas.length);
    const pausadas = db.prepare(`
      SELECT d.clave, d.sku, p.status
      ${FILTRO_BASE}
        AND p.status <> 'active'
        AND NOT ${EN_ESPERA}
      ORDER BY d.actualizado_en DESC
      LIMIT @restante
    `).all({ ahora: now(), restante });
    return [...activas, ...pausadas];
  }

  if (cuotaPausadas <= 0) return activas;

  // Publicaciones pausadas distintas más recientes, hasta la cuota — después, TODAS sus
  // variaciones pendientes (la cuota es de publicaciones, no de variaciones).
  const itemsPausados = db.prepare(`
    SELECT p.item_id AS item_id, MAX(d.actualizado_en) AS ultimo
    ${FILTRO_BASE}
      AND p.status <> 'active'
      AND NOT ${EN_ESPERA}
    GROUP BY p.item_id
    ORDER BY ultimo DESC
    LIMIT @cuotaPausadas
  `).all({ ahora: now(), cuotaPausadas });

  if (itemsPausados.length === 0) return activas;

  const params = { ahora: now() };
  const inClause = itemsPausados.map((r, i) => { params[`item${i}`] = r.item_id; return `@item${i}`; }).join(',');
  const pausadas = db.prepare(`
    SELECT d.clave, d.sku, p.status
    ${FILTRO_BASE}
      AND p.status <> 'active'
      AND NOT ${EN_ESPERA}
      AND p.item_id IN (${inClause})
    ORDER BY d.actualizado_en DESC
  `).all(params);

  return [...activas, ...pausadas];
}

/** Cuenta pendientes por status, separando lo listo para intentar de lo que está en backoff. */
export function contarPendientes(db) {
  const rows = db.prepare(`
    SELECT p.status, ${EN_ESPERA} AS en_espera, COUNT(*) n
    ${FILTRO_BASE}
    GROUP BY p.status, en_espera
  `).all({ ahora: now() });

  let activas = 0, pausadas = 0, enEspera = 0;
  for (const r of rows) {
    if (r.en_espera) { enEspera += r.n; continue; }
    if (r.status === 'active') activas += r.n; else pausadas += r.n;
  }
  return { total: activas + pausadas, activas, pausadas, enEspera };
}

/** Registra el fallo con backoff exponencial. Devuelve { intentos, proximo_intento_en }. */
function registrarFallo(db, clave, sku, resultado) {
  const prev = db.prepare('SELECT intentos FROM ml_sku_push_fallos WHERE clave = ?').get(clave);
  const intentos = (prev?.intentos || 0) + 1;
  const horas = Math.min(2 ** intentos, 24); // backoff exponencial por publicación, tope 24h
  const proximo = new Date(Date.now() + horas * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT INTO ml_sku_push_fallos (clave, sku, intentos, ultimo_error, ultimo_status, proximo_intento_en, actualizado_en)
    VALUES (@clave, @sku, @intentos, @error, @status, @proximo, @ts)
    ON CONFLICT(clave) DO UPDATE SET
      sku=excluded.sku, intentos=excluded.intentos, ultimo_error=excluded.ultimo_error,
      ultimo_status=excluded.ultimo_status, proximo_intento_en=excluded.proximo_intento_en,
      actualizado_en=excluded.actualizado_en
  `).run({
    clave, sku, intentos,
    error: resultado.error || null, status: resultado.status || null,
    proximo, ts: now(),
  });
  return { intentos, proximo_intento_en: proximo };
}

// Estado sondeable de la última corrida (o la corrida en curso). Un solo push a la vez:
// pushSkusPendientes() usa este mismo objeto como mutex (running=true bloquea una nueva
// corrida), tanto si la dispara el cron como el endpoint POST — comparten el mismo motor.
let _estado = {
  running: false, escritos: 0, errores: 0, restantes: 0, fallos: [],
  iniciado_en: null, fin_en: null, cortado_por_rate_limit: false, cortado_por_error: false, error: null,
};

/** Copia de solo lectura del estado actual, para el endpoint de sondeo. */
export function getEstadoPush() {
  return { ..._estado, fallos: [..._estado.fallos] };
}

/** Solo para tests: resetea el estado del módulo entre casos. */
export function _resetEstadoPushParaTests() {
  _estado = {
    running: false, escritos: 0, errores: 0, restantes: 0, fallos: [],
    iniciado_en: null, fin_en: null, cortado_por_rate_limit: false, cortado_por_error: false, error: null,
  };
}

/**
 * Agrupa las decisiones pendientes por publicación (item_id). Devuelve Map(itemId ->
 * [{ clave, sku, variationId }]).
 */
function agruparPorItem(pendientes) {
  const grupos = new Map();
  for (const p of pendientes) {
    const { itemId, variationId } = partirClaveMl(p.clave);
    if (!grupos.has(itemId)) grupos.set(itemId, []);
    grupos.get(itemId).push({ clave: p.clave, sku: p.sku, variationId });
  }
  return grupos;
}

/**
 * Ejecuta `fn` (una llamada a ML) reintentando ante 429 con REINTENTOS_429_MS. Captura
 * cualquier excepción de `fn` (timeout/error de red de axios, que sí lanza) como { ok:false,
 * status:0 } — mismo criterio que el resto del módulo. Devuelve { resultado, cortadoRateLimit }.
 */
async function intentarConReintentos429(fn) {
  let resultado;
  for (let intento = 0; ; intento++) {
    try {
      resultado = await fn();
    } catch (e) {
      resultado = { ok: false, status: 0, error: e.message };
    }
    if (resultado.status !== 429) return { resultado, cortadoRateLimit: false };
    if (intento >= REINTENTOS_429_MS.length) return { resultado, cortadoRateLimit: true };
    await sleep(REINTENTOS_429_MS[intento]);
  }
}

/**
 * Procesa una única decisión (PUT individual, camino de siempre) contra ML, actualizando
 * `_estado` según el resultado (fail-open/fail-closed documentados en la cabecera del
 * archivo). Devuelve { cortar: null | 'rate_limit' | 'error' }.
 */
async function procesarEntradaIndividual(db, mlCfg, entrada) {
  const { resultado, cortadoRateLimit } = await intentarConReintentos429(
    () => escribirSkuEnMl(db, mlCfg, entrada.clave, entrada.sku)
  );
  if (cortadoRateLimit) return { cortar: 'rate_limit' }; // resto de la corrida queda para el próximo ciclo, sin marcar fallo

  if (resultado.ok) {
    _estado.escritos++;
    db.prepare('DELETE FROM ml_sku_push_fallos WHERE clave = ?').run(entrada.clave);
  } else if (resultado.status === 0) {
    // Fail-open: no se registra backoff (ML nunca evaluó esta publicación) y se corta la
    // corrida entera porque la causa (config/red) probablemente afecta a todo el resto.
    _estado.errores++;
    _estado.error = resultado.error || 'sin respuesta de ML (config/red)';
    if (_estado.fallos.length < 20) {
      _estado.fallos.push({ clave: entrada.clave, sku: entrada.sku, error: resultado.error, status: 0 });
    }
    return { cortar: 'error' };
  } else {
    _estado.errores++;
    const { intentos, proximo_intento_en } = registrarFallo(db, entrada.clave, entrada.sku, resultado);
    if (_estado.fallos.length < 20) {
      _estado.fallos.push({
        clave: entrada.clave, sku: entrada.sku, error: resultado.error, status: resultado.status,
        intentos, proximo_intento_en,
      });
    }
  }
  _estado.restantes = Math.max(0, _estado.restantes - 1);
  await sleep(CALL_DELAY_MS);
  return { cortar: null };
}

/** Procesa varias entradas en el camino individual, una por una. Devuelve el motivo de corte o null. */
async function procesarEntradasIndividualmente(db, mlCfg, entradas) {
  for (const e of entradas) {
    const { cortar } = await procesarEntradaIndividual(db, mlCfg, e);
    if (cortar) return cortar;
  }
  return null;
}

/**
 * Procesa un grupo de decisiones de la MISMA publicación. Si hay 2+ variaciones pendientes,
 * intenta 1 solo PUT agrupado (escribirSkusAgrupadoEnMl); si ML lo rechaza (no-200, no-429,
 * no status:0), reintenta por variación con el camino de siempre (fallback obligatorio, ver
 * paso 2 del plan). Un 429 en el agrupado NO dispara el fallback: cae en el camino de rate
 * limit ya existente. Devuelve el motivo de corte ('rate_limit'|'error') o null.
 */
async function procesarGrupo(db, mlCfg, itemId, entradas) {
  const conVariacion = entradas.filter(e => e.variationId);
  const sinVariacion = entradas.filter(e => !e.variationId);

  if (conVariacion.length >= 2) {
    const { resultado, cortadoRateLimit } = await intentarConReintentos429(
      () => escribirSkusAgrupadoEnMl(db, mlCfg, itemId, conVariacion)
    );
    if (cortadoRateLimit) return 'rate_limit';

    if (resultado.ok) {
      for (const e of conVariacion) {
        _estado.escritos++;
        db.prepare('DELETE FROM ml_sku_push_fallos WHERE clave = ?').run(e.clave);
        _estado.restantes = Math.max(0, _estado.restantes - 1);
      }
      await sleep(CALL_DELAY_MS);
    } else if (resultado.status === 0) {
      _estado.errores++;
      _estado.error = resultado.error || 'sin respuesta de ML (config/red)';
      if (_estado.fallos.length < 20) {
        _estado.fallos.push({ clave: conVariacion[0].clave, sku: conVariacion[0].sku, error: resultado.error, status: 0 });
      }
      return 'error';
    } else {
      // Fallback obligatorio por variación: el PUT agrupado revalida la publicación entera
      // y puede rechazarla por algo ajeno al SKU (ej. límite de fotos) — no puede quedar sin
      // escribir por culpa de la optimización.
      const cortar = await procesarEntradasIndividualmente(db, mlCfg, conVariacion);
      if (cortar) return cortar;
    }
  } else {
    const cortar = await procesarEntradasIndividualmente(db, mlCfg, conVariacion);
    if (cortar) return cortar;
  }

  return procesarEntradasIndividualmente(db, mlCfg, sinVariacion);
}

/**
 * Corre un lote de escrituras pendientes. Devuelve el estado final de la corrida.
 * Si ya hay una corrida en curso, no arranca otra: devuelve { running: true } sin tocar nada
 * (anti-solape).
 *
 * `cuotaPausadas`: cuota de publicaciones pausadas por corrida (ver seleccionarPendientes).
 * Default CUOTA_PAUSADAS_DEFAULT para el cron automático; el botón manual
 * (routes/matcher.js) la pasa en `null` para ignorarla — el usuario está esperando el
 * resultado y ya disparó la acción a propósito.
 */
export async function pushSkusPendientes(db, cfg, { limite = LOTE_PUSH, cuotaPausadas = CUOTA_PAUSADAS_DEFAULT } = {}) {
  if (_estado.running) return { ...getEstadoPush(), yaEnCurso: true };

  // Los dos llamadores (cron en server.js y POST /push-skus-pendientes en routes/matcher.js)
  // pueden pasar la config de sync completa `{woo, ml}` o ya el cfg de ML puntual — se
  // normaliza acá para cubrir a ambos en un solo lugar (bug real: el cron pasaba el objeto
  // completo sin normalizar y cada llamada a ML fallaba con "ML_CLIENT_ID no configurado",
  // registrando backoff largo sobre publicaciones sanas).
  const mlCfg = cfg?.ml ?? cfg;

  _estado = {
    running: true, escritos: 0, errores: 0, restantes: contarPendientes(db).total, fallos: [],
    iniciado_en: now(), fin_en: null, cortado_por_rate_limit: false, cortado_por_error: false, error: null,
  };

  try {
    const inicioCorrida = Date.now();
    let cortadoRateLimit = false;
    let cortadoError = false;

    while (true) {
      if (Date.now() - inicioCorrida > TIEMPO_MAX_CORRIDA_MS) break;
      const lote = seleccionarPendientes(db, { limite, cuotaPausadas });
      if (lote.length === 0) break;

      // Verificación previa (paso 1): refresca la caché contra ML en vivo antes de escribir.
      // Las que ya coinciden se descartan sin PUT vía la idempotencia de escribirSkuEnMl/
      // escribirSkusAgrupadoEnMl (que leen esta misma caché). 1 llamada cada 20 publicaciones.
      await verificarLoteEnMl(db, mlCfg, lote);

      // Agrupado (paso 2): 1 PUT por publicación con 2+ variaciones pendientes, con fallback
      // por variación. Publicaciones simples o con 1 sola variación pendiente siguen el
      // camino individual de siempre (sin beneficio de agrupar, sin cambio de comportamiento).
      const grupos = agruparPorItem(lote);
      let motivoCorte = null;
      for (const [itemId, entradas] of grupos) {
        motivoCorte = await procesarGrupo(db, mlCfg, itemId, entradas);
        if (motivoCorte) break;
      }
      if (motivoCorte === 'rate_limit') { cortadoRateLimit = true; break; }
      if (motivoCorte === 'error') { cortadoError = true; break; }
    }

    _estado.cortado_por_rate_limit = cortadoRateLimit;
    _estado.cortado_por_error = cortadoError;
    _estado.restantes = contarPendientes(db).total;
    // Única traza: hoy no hay ninguna en pm2, que es por qué los fallos eran invisibles.
    console.log(
      `push SKUs matcher: escritos=${_estado.escritos} errores=${_estado.errores} restantes=${_estado.restantes}` +
      (cortadoRateLimit ? ' (cortado por rate limit 429)' : '') +
      (cortadoError ? ' (cortado por error de config/red, status 0)' : '')
    );
  } catch (e) {
    _estado.error = e.message;
    console.error('push SKUs matcher error:', e.message);
  } finally {
    _estado.running = false;
    _estado.fin_en = now();
  }

  return getEstadoPush();
}
