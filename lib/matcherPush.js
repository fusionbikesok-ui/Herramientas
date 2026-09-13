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
 *    2026-08-06 (incidente "561 pendientes, escritos=0 días enteros"): mlFetch devuelve DOS
 *    tipos de 429 y hay que tratarlos distinto, porque antes se los trataba igual y eso
 *    ocultó el diagnóstico durante días:
 *      · `__cooldownSintetico` / `__sinCupo` — 429 NUESTRO (cooldown propio o presupuesto
 *        propio agotado, ver lib/mlClient.js), ML nunca fue consultado. NO se aborta la
 *        corrida: se espera a que venza (o un paso corto para __sinCupo, que no tiene un
 *        `hasta`) y se reintenta la MISMA publicación, acotado por TIEMPO_MAX_CORRIDA_MS —
 *        si esperar se pasaría del tope, ahí sí se corta sin marcar fallo, para la próxima
 *        corrida (fail-open, igual que el 429 real).
 *      · Sin esas marcas — 429 REAL de ML: reintentos con REINTENTOS_429_MS y corte de la
 *        corrida entera sin marcar fallo si persiste.
 *    CORRECCIÓN 2026-08-06 (revisión posterior, bloqueante del `revisor`): mlFetch activa su
 *    propio cooldown ANTES de devolvernos el 429 real (ver `_activarCooldown` en
 *    lib/mlClient.js), así que el intento siguiente de la MISMA publicación SIEMPRE ve el
 *    cooldown ya activo y recibe `__cooldownSintetico` — nunca un segundo 429 "real puro". Sin
 *    esta corrección, todo 429 real terminaba clasificado como `cortado_por_cooldown_propio`
 *    ("no es rechazo de ML") y `cortado_por_rate_limit`/REINTENTOS_429_MS quedaban código
 *    muerto: la inversión exacta del diagnóstico que este cambio vino a resolver, y además la
 *    corrida podía quedarse hasta 5 minutos reintentando la misma publicación (rama de espera)
 *    en vez de cortar en ~1,4s. Por eso se rastrea `real429EstaPublicacion` por PUBLICACIÓN
 *    (no por corrida, hallazgo del `revisor` en revisión posterior): el primer 429 sin marcas
 *    la enciende, y un `__cooldownSintetico` posterior EN LA MISMA PUBLICACIÓN se trata como
 *    continuación de ese 429 real (consume REINTENTOS_429_MS, termina en
 *    `cortado_por_rate_limit`). Solo un `__cooldownSintetico` que aparece SIN que esta
 *    publicación haya visto un 429 real antes —heredado de otro cron de los 9 corriendo en
 *    paralelo— va a la rama de espera (`cortado_por_cooldown_propio`). `__sinCupo` no
 *    participa de esta distinción: es presupuesto propio (mlRateLimiter.js), no una respuesta
 *    de ML, así que siempre va a la rama de espera, acotada por MAX_REINTENTOS_SIN_CUPO (ver
 *    esa constante).
 *    El estado sondeable (`getEstadoPush`) distingue `cortado_por_rate_limit` (ML real) de
 *    `cortado_por_cooldown_propio` (nuestro, tras una espera real por cooldown/cupo) de
 *    `cortado_por_tiempo` (se acabó el tope de tiempo de la corrida sin ningún cooldown/cupo
 *    de por medio — antes se reportaba, incorrectamente, como `cortado_por_cooldown_propio`).
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
 * Cuota de pausadas: las activas listas para intentar entran siempre, sin cuota y primero. Las
 * pausadas se acotan a CUOTA_PAUSADAS_DEFAULT publicaciones DISTINTAS (no variaciones) por
 * CORRIDA completa del cron automático (no por tanda — ver el contador `cuotaRestante` en
 * pushSkusPendientes), para no competirle presupuesto de llamadas a ML al sync. El botón
 * manual (routes/matcher.js) pasa `cuotaPausadas: null` y la ignora: el usuario disparó la
 * acción a propósito y está esperando el resultado completo. Sin starvation: el orden
 * (más recientes primero) más el backoff garantizan que la cola se vacíe en varias corridas.
 *
 * Se evaluó (y se descartó) verificar el SKU contra ML antes de escribir y agrupar varias
 * variaciones en un solo PUT — ver la sección "Descartados" del plan de arriba: contra la
 * API real de ML, el multiget de variaciones no trae el atributo SELLER_SKU (solo lo trae
 * el endpoint puntual /items/{id}/variations/{varId}, que cuesta 1 llamada por variación,
 * igual que el PUT que pretendía evitar), y el PUT agrupado con array `variations` parcial
 * puede borrar variaciones no incluidas — riesgo no verificable sin escribir sobre una
 * publicación real. `escribirSkuEnMl` sigue siendo 1 PUT por variación/publicación.
 */

import { mlFetch, estadoCooldownMl } from './mlClient.js';
import { partirClaveMl, extraerErrorMl } from './mlUtil.js';
import { claveBloqueadaGuardia } from './guardiaBloqueo.js';
import { espera } from './esperas.js';

const LOTE_PUSH = 120; // tamaño de cada tanda; una corrida puede encadenar varias tandas (ver TIEMPO_MAX_CORRIDA_MS)
const CALL_DELAY_MS = 350; // respeta rate limit entre publicaciones (igual que el resto del matcher)
const REINTENTOS_429_MS = [350, 1000]; // backoff creciente ante 429 REAL de ML persistente
// Espera fija ante __sinCupo (presupuesto propio agotado, ver mlRateLimiter.js): a
// diferencia del cooldown sintético no hay un `hasta` puntual (el bucket se rellena
// continuo), así que reintentamos con un paso corto — el chequeo de TIEMPO_MAX_CORRIDA_MS
// en cada vuelta evita que esto se convierta en un busy-wait sin límite.
const ESPERA_SIN_CUPO_MS = 1000;
// IMPORTANTE 4 (revisor): __sinCupo no tiene un `hasta` que acote naturalmente la espera (a
// diferencia del cooldown sintético) — con el presupuesto propio agotado de forma sostenida
// (9 crons compitiendo), reservarCupo ya tarda ~15s por intento antes de devolver false, así
// que sin este tope una sola publicación podía girar ~19 vueltas y monopolizar los 5 minutos
// de la corrida. Se corta (mismo flag que el cooldown propio: es presupuesto NUESTRO, no un
// rechazo de ML) tras este número de reintentos por publicación.
const MAX_REINTENTOS_SIN_CUPO = 3;
// mlFetch ya duerme el `retry-after` real y reintenta una vez (lib/mlClient.js) antes de
// devolvernos el 429; esto es una segunda capa por si ML sigue rechazando después. Con solo
// 2 pasos evitamos que un retry-after real (ej. 5s) sumado a estos reintentos deje una sola
// publicación consumiendo más de un minuto.
// Tope de tiempo por corrida: cicla tandas de LOTE_PUSH hasta agotar pendientes, cortar por
// 429/error o llegar a este tope — así el botón manual y el cron completan más rápido que
// esperar 90 min de ciclos de 120, sin arriesgar solaparse con el próximo cron (corre cada
// 10 min).
const TIEMPO_MAX_CORRIDA_MS = 5 * 60 * 1000;

const CUOTA_PAUSADAS_DEFAULT = 10; // publicaciones pausadas DISTINTAS por corrida automática (no variaciones)

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
 *
 * opts.guardianOperation === true permite bypassear el bloqueo de Guardia: esta operación
 * viene autorizada internamente por procesarOperacionesGuardia, no es un caller legacy.
 * Sin esta bandera, legacy callers reciben fail-closed.
 */
export async function escribirSkuEnMl(db, cfg, clave, sku, opts = {}) {
  const { itemId, variationId } = partirClaveMl(clave);
  if (!itemId || !sku) return { ok: false, status: 0, error: 'clave o sku inválido' };

  // GUARDIA: bloqueo de clave detectada con seller_sku divergente o sin cobertura
  // EXCEPCIÓN: operaciones autorizadas por Guardia (opts.guardianOperation=true) pueden pasar
  if (claveBloqueadaGuardia(db, clave) && opts.guardianOperation !== true) {
    return { ok: false, status: 0, bloqueado_por_guardia: true, error: 'clave bloqueada por Guardia ML (detectada con divergencia o sin cobertura); requiere acción manual' };
  }

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
  // Propaga __cooldownSintetico/__sinCupo (lib/mlClient.js): pushSkusPendientes necesita
  // distinguir un 429 NUESTRO de uno REAL de ML para decidir si espera y reintenta o corta
  // la corrida (ver el bloque de manejo de 429 ahí) — perderlas acá los volvía indistinguibles.
  return {
    ok: false, status: resp.status, error: extraerErrorMl(resp),
    ...(resp.__cooldownSintetico ? { __cooldownSintetico: true } : {}),
    ...(resp.__sinCupo ? { __sinCupo: true } : {}),
  };
}

/**
 * Desvincula el SELLER_SKU de una publicación/variación (limpia el campo en ML y en caché).
 * Usada por Cobertura al deshacer un vínculo ya efectivizado, y por Multi-publicación al
 * desvincular una publicación puntual del SKU. Escritura hacia afuera: FAIL-CLOSED explícito
 * — si ML no confirma, NO se toca la caché local ni ninguna decisión, y se propaga el error
 * al llamador para que decida (no hay "reintentar después" acá: a diferencia del push, dejar
 * el estado local a mitad de camino —local ya desvinculado, ML todavía con el SKU viejo—
 * puede terminar en dos publicaciones con el mismo SKU sin que nadie lo note).
 *
 * opts.guardianOperation === true permite bypassear el bloqueo de Guardia: esta operación
 * viene autorizada internamente por procesarOperacionesGuardia, no es un caller legacy.
 * Sin esta bandera, legacy callers reciben fail-closed.
 */
export async function desvincularSkuEnMl(db, cfg, clave, opts = {}) {
  const { itemId, variationId } = partirClaveMl(clave);
  if (!itemId) return { ok: false, status: 0, error: 'clave inválida' };

  // GUARDIA: bloqueo de clave detectada — la desvinculación debe pasar por Guardia
  // EXCEPCIÓN: operaciones autorizadas por Guardia (opts.guardianOperation=true) pueden pasar
  if (claveBloqueadaGuardia(db, clave) && opts.guardianOperation !== true) {
    return { ok: false, status: 0, bloqueado_por_guardia: true, error: 'clave bloqueada por Guardia ML; requiere acción manual desde /api/guardia-ml' };
  }

  const path = variationId ? `/items/${itemId}/variations/${variationId}` : `/items/${itemId}`;
  const body = { attributes: [{ id: 'SELLER_SKU', value_name: null }] };
  const resp = await mlFetch(db, cfg, 'put', path, body, { manual: true });
  if (resp.status === 200) {
    db.prepare('UPDATE ml_publicaciones_cache SET seller_sku = NULL WHERE clave = ?').run(clave);
    return { ok: true, status: 200 };
  }
  return { ok: false, status: resp.status, error: extraerErrorMl(resp) };
}

/**
 * Pausa una publicación en ML (nunca cierra — regla de negocio no negociable del plan de
 * Cobertura: cerrar es irreversible y pierde historial/reputación). FAIL-CLOSED: si ML no
 * confirma el status, la caché local NO se actualiza — mostrar "pausada" localmente cuando
 * ML todavía la tiene activa escondería sobreventa real, que es justo lo que esta pantalla
 * existe para detectar.
 */
export async function pausarPublicacionMl(db, cfg, itemId, opts = {}) {
  if (!itemId) return { ok: false, status: 0, error: 'item_id requerido' };

  // GUARDIA: bloqueo de cualquier clave bajo este item — la pausa debe coordinarse vía Guardia
  const claveBloqueada = db.prepare(`
    SELECT 1 FROM guardia_ml_casos g
    JOIN ml_publicaciones_cache p ON p.clave=g.clave
    WHERE g.estado!='resuelto' AND g.bloquea_sync=1 AND p.item_id=? LIMIT 1
  `).get(itemId);
  if (claveBloqueada && opts.guardianOperation !== true) {
    return { ok: false, status: 0, bloqueado_por_guardia: true, error: 'Al menos una variación está bloqueada por Guardia ML; requiere acción manual desde /api/guardia-ml/casos/:id/pausar' };
  }

  const resp = await mlFetch(db, cfg, 'put', `/items/${itemId}`, { status: 'paused' }, { manual: true });
  if (resp.status === 200) {
    db.prepare("UPDATE ml_publicaciones_cache SET status = 'paused' WHERE item_id = ?").run(itemId);
    return { ok: true, status: 200 };
  }
  return { ok: false, status: resp.status, error: extraerErrorMl(resp) };
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
 * Cuota de pausadas: con `cuotaPausadas` (número), TODAS las activas listas entran siempre
 * sin cuota, y las pausadas se toman después hasta cuotaPausadas PUBLICACIONES distintas (no
 * variaciones) — con `cuotaPausadas: null` (default, usado por el botón manual) no hay cuota
 * y las pausadas se acotan solo por `limite`, como antes de este cambio.
 *
 * MENOR 2 (revisor): `limite` cambió de semántica respecto de master. La query de activas ya
 * NO lleva `LIMIT` (las activas nunca tienen cuota), así que el lote devuelto puede superar
 * `limite` cuando hay muchas activas listas — en master, `limite` acotaba el lote entero
 * (activas + pausadas) a 120. Hoy `limite` solo acota a las pausadas, y únicamente en el
 * camino sin cuota (`cuotaPausadas: null`, el del botón manual).
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
  running: false, escritos: 0, saltados: 0, errores: 0, restantes: 0, fallos: [],
  iniciado_en: null, fin_en: null, cortado_por_rate_limit: false, cortado_por_error: false,
  cortado_por_cuota: false, cortado_por_cooldown_propio: false, error: null,
};

/** Solo para tests: resetea el estado del módulo entre casos. */
export function _resetEstadoPushParaTests() {
  _estado = {
    running: false, escritos: 0, saltados: 0, errores: 0, restantes: 0, fallos: [],
    iniciado_en: null, fin_en: null, cortado_por_rate_limit: false, cortado_por_error: false,
    cortado_por_cuota: false, cortado_por_cooldown_propio: false, cortado_por_tiempo: false, error: null,
  };
}

/** Copia de solo lectura del estado actual, para el endpoint de sondeo. */
export function getEstadoPush() {
  return { ..._estado, fallos: [..._estado.fallos] };
}

/**
 * Corre un lote de escrituras pendientes. Devuelve el estado final de la corrida.
 * Si ya hay una corrida en curso, no arranca otra: devuelve { running: true } sin tocar nada
 * (anti-solape).
 *
 * `cuotaPausadas`: cuota de publicaciones pausadas DISTINTAS por CORRIDA completa (no por
 * tanda — ver `cuotaRestante` abajo, que se descuenta en cada vuelta del while hasta
 * agotarse; a partir de ahí solo entran activas). Default CUOTA_PAUSADAS_DEFAULT para el
 * cron automático; el botón manual (routes/matcher.js) la pasa en `null` para ignorarla — el
 * usuario está esperando el resultado y ya disparó la acción a propósito.
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
    running: true, escritos: 0, saltados: 0, errores: 0, restantes: contarPendientes(db).total, fallos: [],
    iniciado_en: now(), fin_en: null, cortado_por_rate_limit: false, cortado_por_error: false,
    cortado_por_cuota: false, cortado_por_cooldown_propio: false, cortado_por_tiempo: false, error: null,
  };

  try {
    const inicioCorrida = Date.now();
    let cortadoRateLimit = false; // 429 REAL de ML, persistente tras REINTENTOS_429_MS
    let cortadoCooldownPropio = false; // 429 nuestro (cooldown/cupo) cuya espera excede el tope de corrida
    let cortadoError = false;
    // HALLAZGO A (revisor): corte por simple agotamiento del tope de tiempo de la corrida
    // (muchas publicaciones sanas, sin ningún cooldown ni cupo agotado de por medio) — no es
    // lo mismo que cortadoCooldownPropio, que implica que hubo una espera real por 429/cupo
    // propio. Mezclarlos le mentía al operador con "(cortado por cooldown/cupo PROPIO...)"
    // cuando en realidad ML respondía 200 a todo y solo se acabó el tiempo del cron.
    let cortadoPorTiempo = false;
    // IMPORTANTE 1 / BLOQUEANTE 1 (revisor): true desde el primer 429 SIN marcas que vea la
    // publicación actual — mlFetch activa su propio cooldown antes de devolvérnoslo, así que
    // el intento siguiente de la misma publicación llega acá como __cooldownSintetico aunque
    // el 429 que lo originó fue real. Un sintético posterior con esta bandera en true es
    // continuación de ESE 429 real (ver bloque de manejo de 429 más abajo), no un cooldown
    // heredado de otro cron. HALLAZGO C (revisor): se declara DENTRO del `for` de la
    // publicación (más abajo, como real429EstaPublicacion), no acá, para que no sobreviva de
    // una publicación a la siguiente dentro de la misma corrida.
    // Cuota de pausadas por CORRIDA (no por tanda, bloqueante 2 del revisor original): se
    // descuenta acá, no dentro de seleccionarPendientes, porque el while vuelve a llamarla
    // en cada vuelta y las ya escritas salen del filtro — sin este contador la cuota nunca
    // frenaba nada más allá de la primera tanda.
    let cuotaRestante = cuotaPausadas;

    while (true) {
      if (Date.now() - inicioCorrida > TIEMPO_MAX_CORRIDA_MS) { cortadoPorTiempo = true; break; }
      const lote = seleccionarPendientes(db, { limite, cuotaPausadas: cuotaRestante });
      if (lote.length === 0) break;

      if (cuotaRestante != null) {
        // MENOR 4 (revisor): una pausada saltada por idempotencia (escribirSkuEnMl ve que el
        // caché ya tiene el SKU al día, típico tras un POST /refrescar-ml) consume cupo de
        // cuota igual que una que sí generó un PUT real a ML, aunque no gastó ninguna llamada.
        // Poco frecuente y solo retrasa el vaciado una corrida — si algún día la cola de
        // pausadas parece no avanzar pese a poca actividad de ML, este es el primer lugar
        // para mirar.
        const itemsPausadosEnLote = new Set(
          lote.filter(p => p.status !== 'active').map(p => partirClaveMl(p.clave).itemId)
        );
        cuotaRestante = Math.max(0, cuotaRestante - itemsPausadosEnLote.size);
      }

      for (const p of lote) {
        // IMPORTANTE 5 (revisor): re-chequear el tope de corrida acá, no solo en el `while`
        // externo — una espera de varios segundos (cooldown propio, __sinCupo) dentro del
        // `for` podía dejar el lote entero corriendo hasta ~90s más allá del tope antes de
        // que el `while` volviera a mirar el reloj.
        if (Date.now() - inicioCorrida > TIEMPO_MAX_CORRIDA_MS) { cortadoPorTiempo = true; break; }

        let resultado;
        let intentosSinCupo = 0; // IMPORTANTE 4: tope de reintentos por __sinCupo (ver MAX_REINTENTOS_SIN_CUPO)
        // HALLAZGO C (revisor): por-publicación, no por-corrida — si una publicación anterior
        // vio un 429 real pero esta ya es otro SKU con historia propia, un sintético heredado
        // acá no debe clasificarse como continuación de aquel 429. Hoy es inocuo (el cooldown
        // de 60s de ML nunca vence dentro de los reintentos de una sola publicación), pero
        // resetear es lo correcto si algún día cambian esos tiempos.
        let real429EstaPublicacion = false;
        for (let intentoReal = 0; ; ) {
          try {
            resultado = await escribirSkuEnMl(db, mlCfg, p.clave, p.sku);
          } catch (e) {
            resultado = { ok: false, status: 0, error: e.message };
          }
          if (resultado.status !== 429) {
            // HALLAZGO B (revisor): el re-chequeo de tiempo va DESPUÉS de este break, no antes
            // — acá es donde de verdad importa (solo la rama 429 puede haber esperado los
            // ~15s de reservarCupo). Chequearlo también cuando resultado.ok === true hacía que
            // una escritura ya confirmada en ML (PUT + UPDATE de caché ya aplicados) se
            // perdiera del contador `escritos` por el `break` de más abajo.
            break;
          }
          // IMPORTANTE 4 (2ª parte, revisor): re-chequear el tope DESPUÉS de la llamada —
          // reservarCupo (mlRateLimiter.js) puede haber esperado ~15s puertas adentro antes
          // de devolver __sinCupo, tiempo que el chequeo de ANTES de la llamada no contempla.
          if (Date.now() - inicioCorrida > TIEMPO_MAX_CORRIDA_MS) { cortadoPorTiempo = true; break; }

          if (resultado.__sinCupo) {
            // Presupuesto propio agotado (mlRateLimiter.js): no es una respuesta de ML, así
            // que nunca participa de la distinción 429-real/heredado de abajo. Sin `hasta`
            // puntual, se acota por cantidad de reintentos (no tiene sentido esperar el
            // cooldown de ML, que acá ni siquiera está activo).
            intentosSinCupo++;
            if (intentosSinCupo > MAX_REINTENTOS_SIN_CUPO) { cortadoCooldownPropio = true; break; }
            if (Date.now() - inicioCorrida + ESPERA_SIN_CUPO_MS > TIEMPO_MAX_CORRIDA_MS) {
              cortadoCooldownPropio = true;
              break;
            }
            await sleep(ESPERA_SIN_CUPO_MS);
            continue; // reintenta la misma publicación, no incrementa intentoReal
          }

          // BLOQUEANTE 1 (revisor): un __cooldownSintetico es "heredado" (de otro cron de los
          // 9 corriendo en paralelo) SOLO si esta corrida todavía no vio un 429 real — si ya
          // lo vio, este sintético es la continuación inevitable de ESE 429 (mlFetch activa
          // su cooldown antes de devolver el 429 real, así que el intento siguiente de la
          // misma publicación SIEMPRE lo ve como sintético) y debe tratarse como tal más abajo.
          if (resultado.__cooldownSintetico && !real429EstaPublicacion) {
            const { hasta } = estadoCooldownMl();
            const esperaMs = hasta ? Math.max(50, new Date(hasta).getTime() - Date.now()) : ESPERA_SIN_CUPO_MS;
            // Si esperar esto se pasaría del tope de la corrida, cortar sin marcar fallo:
            // el resto (incluida esta publicación) queda para el próximo ciclo de cron.
            if (Date.now() - inicioCorrida + esperaMs > TIEMPO_MAX_CORRIDA_MS) {
              cortadoCooldownPropio = true;
              break;
            }
            await sleep(esperaMs);
            continue; // reintenta la misma publicación, no incrementa intentoReal
          }

          // 429 REAL de ML (sin marcas), o continuación sintética de un 429 real ya visto en
          // esta corrida: reintentos con REINTENTOS_429_MS y corte de la corrida entera
          // (fail-open) si persiste — comportamiento documentado en el docstring del módulo.
          if (!resultado.__cooldownSintetico) real429EstaPublicacion = true;
          if (intentoReal >= REINTENTOS_429_MS.length) { cortadoRateLimit = true; break; }
          await sleep(REINTENTOS_429_MS[intentoReal]);
          intentoReal++;
        }
        if (cortadoRateLimit || cortadoCooldownPropio || cortadoPorTiempo) break; // resto de la corrida queda para el próximo ciclo, sin marcar fallo

        if (resultado.ok) {
          // MENOR 9 (revisor): escritos y saltados se cuentan aparte — escribirSkuEnMl
          // devuelve ok:true también cuando saltea el PUT por idempotencia (ML ya tenía ese
          // SKU), y mezclarlos en el mismo contador infla "escritos" con claves que no
          // generaron ninguna llamada a ML.
          if (resultado.saltado) _estado.saltados++; else _estado.escritos++;
          db.prepare('DELETE FROM ml_sku_push_fallos WHERE clave = ?').run(p.clave);
        } else if (resultado.status === 0) {
          // status:0 = no llegamos a hablar con ML (config faltante, error de red, excepción
          // antes de la respuesta) — NO es un rechazo de la publicación por ML. Fail-open:
          // no se registra backoff (no penalizamos una publicación que nunca fue evaluada) y
          // se corta la corrida entera, porque lo más probable es que la causa (config/red)
          // afecte también al resto del lote — seguir intentando solo acumularía el mismo
          // error. Queda para reintentar en el próximo ciclo del cron.
          _estado.errores++;
          _estado.error = resultado.error || 'sin respuesta de ML (config/red)';
          if (_estado.fallos.length < 20) {
            _estado.fallos.push({ clave: p.clave, sku: p.sku, error: resultado.error, status: 0 });
          }
          cortadoError = true;
          break;
        } else {
          _estado.errores++;
          const { intentos, proximo_intento_en } = registrarFallo(db, p.clave, p.sku, resultado);
          if (_estado.fallos.length < 20) {
            _estado.fallos.push({
              clave: p.clave, sku: p.sku, error: resultado.error, status: resultado.status,
              intentos, proximo_intento_en,
            });
          }
        }
        _estado.restantes = Math.max(0, _estado.restantes - 1); // sondeo en vivo durante la corrida
        await sleep(espera(CALL_DELAY_MS));
      }

      if (cortadoRateLimit || cortadoCooldownPropio || cortadoError || cortadoPorTiempo) break;
    }

    _estado.cortado_por_rate_limit = cortadoRateLimit;
    _estado.cortado_por_cooldown_propio = cortadoCooldownPropio;
    _estado.cortado_por_error = cortadoError;
    _estado.cortado_por_tiempo = cortadoPorTiempo;
    const pendientesFinal = contarPendientes(db);
    _estado.restantes = pendientesFinal.total;
    // MENOR 3 (revisor): si la cuota de pausadas se agotó y todavía quedan pausadas
    // pendientes, el operador vería "restantes=N" sin ninguna explicación (ni rate limit ni
    // error) — exactamente el riesgo "cuota que esconde trabajo" que anotó el plan. No es un
    // corte real del while (la corrida sigue vaciando activas hasta el fin), pero conviene
    // dejarlo explícito en el log y en el estado sondeable.
    _estado.cortado_por_cuota = cuotaPausadas != null && cuotaRestante === 0 && pendientesFinal.pausadas > 0;
    // Única traza: hoy no hay ninguna en pm2, que es por qué los fallos eran invisibles.
    console.log(
      `push SKUs matcher: escritos=${_estado.escritos} saltados=${_estado.saltados} errores=${_estado.errores} restantes=${_estado.restantes}` +
      (cortadoRateLimit ? ' (cortado por 429 REAL de ML)' : '') +
      (cortadoCooldownPropio ? ' (cortado por cooldown/cupo PROPIO, no es rechazo de ML)' : '') +
      (cortadoError ? ' (cortado por error de config/red, status 0)' : '') +
      (cortadoPorTiempo ? ' (cortado por tope de tiempo de la corrida, sin cooldown/cupo de por medio)' : '') +
      (_estado.cortado_por_cuota ? ' (cuota de pausadas agotada)' : '')
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
