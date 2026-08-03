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
 *  - Cualquier otro error (400/403/etc., fallo de publicación real) → SÍ se registra en
 *    ml_sku_push_fallos con backoff exponencial por publicación (fail-closed respecto de esa
 *    publicación puntual: no se reintenta en cada ciclo, se espera el backoff).
 */

import { mlFetch } from './mlClient.js';
import { partirClaveMl, extraerErrorMl } from './mlUtil.js';

const LOTE_PUSH = 120;
const CALL_DELAY_MS = 350; // respeta rate limit entre publicaciones (igual que el resto del matcher)
const REINTENTOS_429_MS = [350, 1000, 3000, 8000]; // backoff creciente ante 429 persistente

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
 */
export async function escribirSkuEnMl(db, cfg, clave, sku) {
  const { itemId, variationId } = partirClaveMl(clave);
  if (!itemId || !sku) return { ok: false, status: 0, error: 'clave o sku inválido' };

  // Idempotencia: si ML ya tiene ese SKU, no reescribir
  const cacheRow = db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
  if (cacheRow && (cacheRow.seller_sku || '') === sku) return { ok: true, status: 200, saltado: true };

  const path = variationId
    ? `/items/${itemId}/variations/${variationId}`
    : `/items/${itemId}`;
  const body = { attributes: [{ id: 'SELLER_SKU', value_name: sku }] };

  const resp = await mlFetch(db, cfg, 'put', path, body);
  if (resp.status === 200) {
    db.prepare('UPDATE ml_publicaciones_cache SET seller_sku = ? WHERE clave = ?').run(sku, clave);
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
 */
export function seleccionarPendientes(db, limite = LOTE_PUSH) {
  return db.prepare(`
    SELECT d.clave, d.sku, p.status
    ${FILTRO_BASE}
      AND NOT ${EN_ESPERA}
    ORDER BY CASE WHEN p.status = 'active' THEN 0 ELSE 1 END, d.actualizado_en DESC
    LIMIT @limite
  `).all({ ahora: now(), limite });
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
}

// Estado sondeable de la última corrida (o la corrida en curso). Un solo push a la vez:
// pushSkusPendientes() usa este mismo objeto como mutex (running=true bloquea una nueva
// corrida), tanto si la dispara el cron como el endpoint POST — comparten el mismo motor.
let _estado = {
  running: false, escritos: 0, errores: 0, restantes: 0, fallos: [],
  iniciado_en: null, fin_en: null, cortado_por_rate_limit: false, error: null,
};

/** Copia de solo lectura del estado actual, para el endpoint de sondeo. */
export function getEstadoPush() {
  return { ..._estado, fallos: [..._estado.fallos] };
}

/** Solo para tests: resetea el estado del módulo entre casos. */
export function _resetEstadoPushParaTests() {
  _estado = {
    running: false, escritos: 0, errores: 0, restantes: 0, fallos: [],
    iniciado_en: null, fin_en: null, cortado_por_rate_limit: false, error: null,
  };
}

/**
 * Corre un lote de escrituras pendientes. Devuelve el estado final de la corrida.
 * Si ya hay una corrida en curso, no arranca otra: devuelve { running: true } sin tocar nada
 * (anti-solape).
 */
export async function pushSkusPendientes(db, cfg, { limite = LOTE_PUSH } = {}) {
  if (_estado.running) return { ...getEstadoPush(), yaEnCurso: true };

  _estado = {
    running: true, escritos: 0, errores: 0, restantes: 0, fallos: [],
    iniciado_en: now(), fin_en: null, cortado_por_rate_limit: false, error: null,
  };

  try {
    const lote = seleccionarPendientes(db, limite);
    let cortado = false;

    for (const p of lote) {
      let resultado;
      for (let intento = 0; ; intento++) {
        try {
          resultado = await escribirSkuEnMl(db, cfg, p.clave, p.sku);
        } catch (e) {
          resultado = { ok: false, status: 0, error: e.message };
        }
        if (resultado.status !== 429) break;
        if (intento >= REINTENTOS_429_MS.length) { cortado = true; break; }
        await sleep(REINTENTOS_429_MS[intento]);
      }
      if (cortado) break; // resto de la corrida queda para el próximo ciclo, sin marcar fallo

      if (resultado.ok) {
        _estado.escritos++;
        db.prepare('DELETE FROM ml_sku_push_fallos WHERE clave = ?').run(p.clave);
      } else {
        _estado.errores++;
        registrarFallo(db, p.clave, p.sku, resultado);
        if (_estado.fallos.length < 20) {
          _estado.fallos.push({ clave: p.clave, sku: p.sku, error: resultado.error, status: resultado.status });
        }
      }
      await sleep(CALL_DELAY_MS);
    }

    _estado.cortado_por_rate_limit = cortado;
    _estado.restantes = contarPendientes(db).total;
    // Única traza: hoy no hay ninguna en pm2, que es por qué los fallos eran invisibles.
    console.log(
      `push SKUs matcher: escritos=${_estado.escritos} errores=${_estado.errores} restantes=${_estado.restantes}` +
      (cortado ? ' (cortado por rate limit 429)' : '')
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
