/**
 * Sincronización bidireccional WooCommerce ↔ MercadoLibre.
 *
 * syncMlToWc: pull de órdenes pagadas ML → descuenta stock en WC
 * syncWcToMl: push de diffs de stock WC → actualiza available_quantity en ML
 * procesarReintentos: reprocesa sync_log con estado='error' (máx MAX_RETRIES intentos)
 * syncRouter: Express Router con endpoints manuales de control
 */

import { Router } from 'express';
import { mlFetch, bootstrapToken } from '../lib/mlClient.js';
import { skuDesdeMl, publicacionesDesdeWc, descartarVariacionMuerta } from '../lib/mlMapeo.js';
import { buscarEnCache } from '../lib/wooStock.js';
import { wooFetch } from './woo.js';
import { netoMl, veredictoNeto, precioWebClave } from '../lib/mlPrecios.js';
import { partirClaveMl, extraerErrorMl } from '../lib/mlUtil.js';
import { normalizarOrdenMl, billingWcDesdeOrdenMl } from '../lib/modelos/ordenVenta.js';
import { mapConLimite } from '../lib/concurrencia.js';

const ML_AUTH_URL = 'https://auth.mercadolibre.com.ar/authorization';
// ML exige un dominio https real (rechaza localhost en el panel de la app).
// Se usa una ruta que no existe en el WordPress (da 404, sin confundir con
// contenido real del sitio) solo como destino válido — el bootstrap OAuth es
// manual: se copia el ?code= de la barra de direcciones después de autorizar.
const REDIRECT_URI = 'https://fusionbikes.com.ar/oauth-mercadolibre';
const MAX_RETRIES = 5;
// Delay entre llamadas a la API de ML. El límite de ML ronda 1000+ req/min;
// 500ms (~120/min) es seguro y ~3x más rápido que el valor original de 1500ms,
// clave para que la sincronización masiva inicial (miles de variaciones) termine.
const ML_CALL_DELAY_MS = 500;
// Máximo de llamadas a ML en vuelo simultáneamente en los lotes de reactivación
// (evaluación de precios y push de stock+activación). Con concurrencia acotada se baja el
// tiempo total del lote sin dispararlo todo a la vez ni saturar el rate-limit de ML (que
// ronda 1000+ req/min): 4 en paralelo queda muy por debajo. Es la palanca a ajustar si ML
// empieza a devolver 429 — subir/bajar según cómo responda.
const ML_CONCURRENCIA_MAX = 4;

// ─── helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function now() {
  return new Date().toISOString();
}

function logSync(db, { direccion, clave, sku, cantAnterior, cantNueva, estado, error, intentos = 0 }) {
  db.prepare(`
    INSERT INTO sync_log (direccion, clave, sku, cant_anterior, cant_nueva, estado, error, intentos, creado_en, actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(direccion, clave ?? null, sku ?? null, cantAnterior ?? null, cantNueva ?? null, estado, error ?? null, intentos, now(), now());
}

function mlCfgOk(cfg) {
  return cfg?.ml?.clientId && cfg?.ml?.clientSecret && cfg?.ml?.userId;
}

/**
 * Persiste el stock ML de una publicación en ml_stock_estado.
 * Centraliza el upsert que antes estaba triplicado en sync y reintentos.
 */
function upsertMlStockEstado(db, clave, sku, cantidad) {
  db.prepare(`
    INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET cantidad_ml = excluded.cantidad_ml, actualizado_en = excluded.actualizado_en
  `).run(clave, sku, cantidad, now());
}

/**
 * Construye path + body para actualizar disponibilidad en ML.
 *
 * Para variaciones se usa el endpoint puntual PUT /items/{id}/variations/{varId}
 * en vez de PUT /items/{id} con { variations: [...] }: este último revalida
 * la publicación ENTERA (incluye reglas no relacionadas al stock, como el
 * límite de fotos por categoría) y puede rechazar el update con HTTP 400 aunque
 * el stock en sí sea válido. El endpoint puntual solo toca esa variación.
 */
function buildMlStockUpdate(itemId, variationId, cantidad) {
  if (variationId) {
    return { path: `/items/${itemId}/variations/${variationId}`, body: { available_quantity: cantidad } };
  }
  return { path: `/items/${itemId}`, body: { available_quantity: cantidad } };
}

// CTE compartido que calcula el stock disponible para ML por publicación mapeada
// (respeta reservas de skus_config_ml). Lo consumen _syncWcToMl, /dashboard y /reactivables.
// Columnas: clave, sku, stock_wc, modo, reserva, stock_disponible_ml, cantidad_ml.
//
// catalogo_dedup: WooCommerce no permite SKUs duplicados de verdad, así que un SKU con más
// de una fila en catalogo_cache es siempre un residuo (nunca un caso de negocio legítimo) —
// en el incidente real (2026-07-25) que motivó esto, eran dos productos borrados hace tiempo
// en WooCommerce (404 al consultarlos) que refrescarCatalogo nunca había limpiado de la
// caché local, porque el upsert original solo agregaba/actualizaba y no borraba lo que ya no
// existía en Woo. Esto ya se corrigió de raíz en refrescarCatalogo (routes/woo.js), que ahora
// borra las filas de catalogo_cache que no vienen en el fetch actual. Este dedup queda como
// red de seguridad barata para esa clase de bug (o para un refresh interrumpido a mitad de
// camino): si igual aparece un SKU repetido, se elige el MENOR stock entre las filas — opción
// fail-closed, como mucho se pierde una venta, nunca se sobrevende en ML.
const COMPUTED_STOCK_CTE = `
  WITH catalogo_dedup AS (
    SELECT sku, stock,
      ROW_NUMBER() OVER (PARTITION BY sku ORDER BY stock ASC, id_woo ASC) AS rn
    FROM catalogo_cache
    WHERE sku IS NOT NULL AND sku <> ''
  ),
  computed AS (
    SELECT d.clave, d.sku, c.stock AS stock_wc,
      cfg.modo, COALESCE(cfg.reserva, 0) AS reserva,
      CASE
        WHEN cfg.modo = 'solo_local' THEN 0
        WHEN cfg.modo = 'reserva' THEN MAX(c.stock - COALESCE(cfg.reserva, 0), 0)
        ELSE MAX(c.stock, 0)
      END AS stock_disponible_ml,
      e.cantidad_ml
    FROM sku_matcher_decisiones d
    JOIN catalogo_dedup c ON c.sku = d.sku AND c.rn = 1
    LEFT JOIN ml_stock_estado e ON e.clave = d.clave
    LEFT JOIN skus_config_ml cfg ON cfg.sku = d.sku
    WHERE d.accion IN ('asignar','confirmar')
      AND d.sku IS NOT NULL AND d.sku <> ''
  )`;

// ─── syncMlToWc ──────────────────────────────────────────────────────────────

// Candado para evitar corridas concurrentes de ML→WC dentro del mismo proceso (una corrida
// que tarda más que el intervalo del cron se solaparía con la siguiente, o el endpoint manual
// POST /api/sync/ml-wc disparado mientras el cron corre). La protección real contra pedidos
// WC duplicados —incluso entre procesos distintos— es la reserva atómica de ml_order_id en
// _procesarOrden (INSERT antes de llamar a Woo); este candado es solo una optimización para
// no competir innecesariamente por esa reserva dentro del mismo proceso. Mismo patrón que
// _wcToMlEnCurso más abajo.
let _mlToWcEnCurso = false;

export async function syncMlToWc(db, cfg) {
  if (!mlCfgOk(cfg)) return { omitido: true };
  // Ya hay una corrida en curso (cron o llamada manual): se saltea para no competir
  // innecesariamente por la reserva atómica. Se informa omitido:true para que el
  // caller no crea que sincronizó.
  if (_mlToWcEnCurso) return { omitido: true };
  _mlToWcEnCurso = true;
  try {
    await _syncMlToWc(db, cfg);
    return { omitido: false };
  } finally {
    _mlToWcEnCurso = false;
  }
}

async function _syncMlToWc(db, cfg) {
  const { ml: mlCfg, woo: wooCfg } = cfg;
  const cursorRow = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'ultima_orden_ml'").get();
  const desde = cursorRow?.valor ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  let offset = 0;
  const limit = 50;
  let ultimaFecha = desde;
  let hayMas = true;

  while (hayMas) {
    const resp = await mlFetch(
      db, mlCfg, 'get',
      `/orders/search?seller=${mlCfg.userId}&order.status=paid&sort=date_asc&order.date_created.from=${encodeURIComponent(desde)}&offset=${offset}&limit=${limit}`
    );

    if (resp.status !== 200) {
      console.error(`syncMlToWc: error API ML ${resp.status}`);
      break;
    }

    const orders = resp.data.results ?? [];
    hayMas = orders.length === limit;
    offset += orders.length;

    for (const orden of orders) {
      const orderId = String(orden.id);

      // Idempotencia: saltar si ya fue procesada
      const yaProc = db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id = ?').get(orderId);
      if (yaProc) continue;

      await _procesarOrden(db, wooCfg, mlCfg, orden);

      if (orden.date_created && orden.date_created > ultimaFecha) {
        ultimaFecha = orden.date_created;
      }
    }
  }

  // Avanzar cursor
  if (ultimaFecha > desde) {
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('ultima_orden_ml', ?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
    `).run(ultimaFecha, now());
  }
}

async function _procesarOrden(db, wooCfg, mlCfg, orden) {
  const orderId = String(orden.id);
  const items = orden.order_items ?? [];
  let algunSinMapeo = false;

  // Reservas abandonadas (proceso murió entre reservar y confirmar/liberar, ej: kill -9)
  // no deben bloquear la orden para siempre. Umbral generoso (60min, muy por encima de
  // cualquier operación real a Woo/ML) a propósito: un umbral corto puede confundir un
  // proceso vivo pero lento (Woo lenta, reintentos) con uno muerto, y liberar su reserva
  // mientras sigue trabajando — eso reintroduce el duplicado que este fix corrige.
  db.prepare(`
    DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND wc_order_id = 0 AND creado_en < ?
  `).run(orderId, new Date(Date.now() - 60 * 60 * 1000).toISOString());

  // Idempotencia: si ya se creó el pedido en WC para esta orden ML, no reprocesar.
  const yaCreado = db.prepare('SELECT 1 FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(orderId);
  if (yaCreado) {
    db.prepare(`
      INSERT OR IGNORE INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en)
      VALUES (?, ?, ?, 'ok', ?)
    `).run(orderId, orden.date_created ?? now(), JSON.stringify(items), now());
    return;
  }

  // Reserva atómica de ml_order_id (ml_order_id es PRIMARY KEY): entre este chequeo y la
  // creación real del pedido en Woo hay varios `await` (precios, POST /orders) que ceden el
  // event loop. Si dos procesos corren este sync en paralelo (ver incidente 2026-07-25:
  // procesos huérfanos + el cron real corriendo a la vez), ambos pasaban el chequeo de
  // arriba antes de que ninguno insertara, y ambos terminaban creando un pedido duplicado en
  // WooCommerce. Reservar la fila ahora, antes de cualquier llamada a Woo, hace que el
  // segundo proceso pierda la carrera acá (INSERT falla por PK) en vez de después.
  try {
    db.prepare(`
      INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en)
      VALUES (?, 0, NULL, ?)
    `).run(orderId, now());
  } catch (e) {
    if (!/UNIQUE|PRIMARY ?KEY/i.test(e.message ?? '')) {
      // No es un conflicto de reserva (otro proceso llegó primero) — es un error real de
      // DB (disco lleno, locked, etc.). No lo tragamos en silencio.
      console.error(`syncMlToWc: error reservando ${orderId}:`, e.message);
    }
    // Otro proceso ya reservó esta orden, o falló la reserva — no reprocesar acá.
    return;
  }

  const ov = normalizarOrdenMl(orden);
  const lineItems = [];
  for (const item of ov.items) {
    const itemId = item.item_id_ml;
    const varId = item.variation_id_ml;
    const qty = item.cantidad;
    const clave = item.clave;

    const sku = skuDesdeMl(db, itemId, varId);
    if (!sku) {
      algunSinMapeo = true;
      logSync(db, { direccion: 'ml_wc', clave, estado: 'sin_mapeo' });
      continue;
    }

    const prod = buscarEnCache(db, sku);
    if (!prod) {
      algunSinMapeo = true;
      logSync(db, { direccion: 'ml_wc', clave, sku, estado: 'error', error: 'SKU no encontrado en WC' });
      continue;
    }

    // El precio del pedido WC sale del precio REAL de venta de la orden ML
    // (item.unit_price, ya presente en ov.items), NO del catálogo Woo vigente al
    // momento del sync: ese catálogo pudo cambiar entre la venta y el procesamiento
    // (el cron puede demorar por el rate-limit de ML), dejando el pedido con un precio
    // que no es ni el pagado en ML ni el actual. Fail-closed: si ML no informó el
    // precio de la venta, no se inventa uno — se marca error y no se agrega el ítem.
    const unitPrice = item.unit_price;
    if (unitPrice == null || !(unitPrice >= 0)) {
      algunSinMapeo = true;
      logSync(db, { direccion: 'ml_wc', clave, sku, estado: 'error', error: 'Orden ML sin unit_price — no se puede fijar el precio del pedido WC' });
      continue;
    }
    const total = (unitPrice * qty).toFixed(2);

    const li = { quantity: qty, subtotal: total, total: total };
    if (prod.tipo === 'variation' && prod.id_padre) {
      li.product_id = prod.id_padre;
      li.variation_id = prod.id_woo;
    } else {
      li.product_id = prod.id_woo;
    }
    lineItems.push(li);
  }

  if (lineItems.length === 0) {
    // Nada mapeable/valido en esta orden — no se puede crear el pedido. Liberar la reserva
    // para que el próximo ciclo del cron pueda reintentar (ej: el SKU se mapea después).
    db.prepare('DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND wc_order_id = 0').run(orderId);
    db.prepare(`
      INSERT OR IGNORE INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en)
      VALUES (?, ?, ?, 'parcial', ?)
    `).run(orderId, orden.date_created ?? now(), JSON.stringify(items), now());
    return;
  }

  const billing = billingWcDesdeOrdenMl(orden);

  try {
    const resp = await wooFetch(wooCfg, '/orders', 'post', {
      status: 'mercadolibre',
      set_paid: true,
      line_items: lineItems,
      billing,
      meta_data: [{ key: '_ml_order_id', value: orderId }],
    });

    const wcOrderId = resp.data.id;
    // La fila de control ya fue reservada (wc_order_id=0) antes del POST a Woo, así que acá
    // solo hace falta completarla con el id real. Esa reserva atómica (INSERT sobre la PK
    // ml_order_id, hecha antes de cualquier llamada a Woo) es la protección real contra
    // pedidos duplicados, incluso entre procesos distintos.
    db.prepare(`
      UPDATE ordenes_ml_wc_pedidos SET wc_order_id = ?, comprador_json = ?
      WHERE ml_order_id = ?
    `).run(wcOrderId, JSON.stringify(orden.buyer ?? null), orderId);

    logSync(db, { direccion: 'ml_wc', clave: orderId, cantNueva: wcOrderId, estado: 'ok' });

    db.prepare(`
      INSERT OR IGNORE INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en)
      VALUES (?, ?, ?, ?, ?)
    `).run(orderId, orden.date_created ?? now(), JSON.stringify(items), algunSinMapeo ? 'parcial' : 'ok', now());
  } catch (e) {
    // No marcar como procesada — liberar la reserva para reintentar en el próximo ciclo.
    // (Si el POST a Woo en realidad tuvo éxito pero la respuesta se perdió, esto podría
    // reintentar y crear un duplicado — mismo riesgo que ya existía antes de este fix,
    // no lo introduce; ver reintentos vía ordenes_ml_procesadas para ese caso aparte.)
    db.prepare('DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND wc_order_id = 0').run(orderId);
    logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'error', error: e.message });
  }
}

// ─── procesarCancelacionesMl ───────────────────────────────────────────────────

/**
 * Detecta ventas de ML canceladas y cancela el pedido correspondiente en WooCommerce.
 * Al pasar el pedido WC a estado 'cancelled', WooCommerce devuelve el stock
 * automáticamente (mecanismo nativo, inverso a la reducción). Ese stock recuperado
 * luego lo re-sincroniza syncWcToMl hacia la publicación de ML.
 *
 * Ventana de 30 días: las cancelaciones de órdenes más viejas son raras y ML ordena
 * por date_created; solo se revisan pedidos que creamos nosotros (ordenes_ml_wc_pedidos)
 * y que todavía no fueron cancelados.
 */
export async function procesarCancelacionesMl(db, cfg) {
  if (!mlCfgOk(cfg)) return;

  const { ml: mlCfg, woo: wooCfg } = cfg;
  const desde = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  let offset = 0;
  const limit = 50;
  let hayMas = true;

  while (hayMas) {
    const resp = await mlFetch(
      db, mlCfg, 'get',
      `/orders/search?seller=${mlCfg.userId}&order.status=cancelled&sort=date_desc&order.date_created.from=${encodeURIComponent(desde)}&offset=${offset}&limit=${limit}`
    );

    if (resp.status !== 200) {
      console.error(`procesarCancelacionesMl: error API ML ${resp.status}`);
      break;
    }

    const orders = resp.data.results ?? [];
    hayMas = orders.length === limit;
    offset += orders.length;

    for (const orden of orders) {
      const orderId = String(orden.id);

      // ¿Creamos un pedido WC para esta venta y todavía no lo cancelamos? wc_order_id=0 es
      // una reserva en curso de syncMlToWc (ver _procesarOrden) — todavía no existe pedido
      // real en Woo para cancelar, así que se ignora hasta que se confirme o libere.
      const registro = db.prepare(
        'SELECT wc_order_id, cancelado_en FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?'
      ).get(orderId);
      if (!registro || registro.cancelado_en || registro.wc_order_id === 0) continue;

      try {
        await wooFetch(wooCfg, `/orders/${registro.wc_order_id}`, 'put', { status: 'cancelled' });
        db.prepare('UPDATE ordenes_ml_wc_pedidos SET cancelado_en = ? WHERE ml_order_id = ?')
          .run(now(), orderId);
        logSync(db, { direccion: 'ml_wc', clave: orderId, cantNueva: registro.wc_order_id, estado: 'ok' });
      } catch (e) {
        logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'error', error: `cancelar WC: ${e.message}` });
      }
    }
  }
}

// ─── syncWcToMl ──────────────────────────────────────────────────────────────

// Candado para evitar corridas concurrentes de WC→ML (cron + disparo manual +
// backlog masivo se pisarían y golpearían el rate limit de ML).
let _wcToMlEnCurso = false;

// Candado para la reactivación manual de publicaciones pausadas (no solapar con
// otra corrida de reactivación ni golpear el rate limit de ML).
let _reactivarEnCurso = false;

// Candado para la limpieza masiva de variaciones muertas (no solapar corridas).
let _limpiezaMuertasEnCurso = false;

export async function syncWcToMl(db, cfg) {
  if (!mlCfgOk(cfg)) return { omitido: true };
  // Ya hay una corrida en curso: se saltea. Se informa omitido:true (mismo criterio
  // que syncMlToWc) para que el caller no crea que sincronizó.
  if (_wcToMlEnCurso) return { omitido: true };
  _wcToMlEnCurso = true;
  try {
    await _syncWcToMl(db, cfg);
    return { omitido: false };
  } finally {
    _wcToMlEnCurso = false;
  }
}

async function _syncWcToMl(db, cfg) {
  const { ml: mlCfg } = cfg;

  // JOIN para encontrar publicaciones ML cuyo stock disponible difiere del estado conocido.
  // LEFT JOIN skus_config_ml para aplicar reservas de unidades para local/web.
  const diffs = db.prepare(`
    ${COMPUTED_STOCK_CTE}
    SELECT * FROM computed
    WHERE cantidad_ml IS NULL OR cantidad_ml <> stock_disponible_ml
  `).all();

  // Cache de estado de publicación por itemId (una consulta por item por corrida).
  // ML rechaza con HTTP 400 cualquier update de stock sobre publicaciones que no
  // estén activas (paused, closed, under_review). Se saltan silenciosamente para
  // no ensuciar el log de errores — el vendedor las reactiva manualmente cuando quiera.
  //
  // El status se lee primero de ml_publicaciones_cache (poblado por el matcher al
  // traer publicaciones) para NO hacer un GET a la API por cada item en cada corrida
  // — eran cientos de llamadas de 500ms desperdiciadas re-verificando pausadas. Solo
  // se hace el GET como fallback si el item no está en el cache. Si el cache está algo
  // desactualizado no hay drama: si una pausada figura activa, el PUT falla con 400
  // (manejado); si una activa figura pausada, se saltea hasta el próximo refresh.
  const estadoItem = new Map();
  const itemsBloqueados = new Set();
  try {
    const cacheStatus = db.prepare('SELECT DISTINCT item_id, status FROM ml_publicaciones_cache').all();
    for (const r of cacheStatus) {
      if (r.status && !estadoItem.has(r.item_id)) estadoItem.set(r.item_id, r.status);
    }
  } catch (_) { /* cache puede no existir todavía */ }

  for (const diff of diffs) {
    const { clave, sku, stock_disponible_ml } = diff;
    const { itemId, variationId } = partirClaveMl(clave);
    const cantidad = Math.max(0, Math.round(stock_disponible_ml));

    try {
      if (!estadoItem.has(itemId)) {
        const est = await mlFetch(db, mlCfg, 'get', `/items/${itemId}?attributes=status`);
        estadoItem.set(itemId, est.status === 200 ? est.data.status : 'desconocido');
        await sleep(ML_CALL_DELAY_MS);
      }
      const status = estadoItem.get(itemId);
      if (status !== 'active') {
        // Publicación no activa: saltar sin registrar error.
        continue;
      }
      if (status === 'active' && itemsBloqueados.has(itemId)) {
        // Ya se detectó en esta corrida que ML rechaza cualquier update de esta
        // publicación (ver más abajo). No repetir el intento por cada variación.
        continue;
      }

      const { path, body } = buildMlStockUpdate(itemId, variationId, cantidad);
      const resp = await mlFetch(db, mlCfg, 'put', path, body);

      if (resp.status === 200) {
        upsertMlStockEstado(db, clave, sku, cantidad);
        logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: diff.cantidad_ml, cantNueva: cantidad, estado: 'ok' });
      } else {
        const causa = extraerErrorMl(resp, resp.data?.error || JSON.stringify(resp.data ?? {}));

        if (/doesn'?t have a variation/i.test(causa)) {
          // La variación mapeada ya no existe en ML (publicación editada/recreada o
          // convertida a simple). Como ML nunca reutiliza variation_id, esa variación
          // está muerta para siempre: se descarta la clave (borra el mapeo + errores_descartados)
          // para que deje de reintentarse y no reaparezca en ninguna vista de atención. La
          // publicación vigente (simple o con variaciones nuevas) se mapea aparte desde el matcher.
          descartarVariacionMuerta(db, clave, `Variación inexistente en ML: ${causa}`.slice(0, 200));
          logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: diff.cantidad_ml, cantNueva: cantidad, estado: 'remapeo_requerido', error: causa.slice(0, 500) });
        } else if (/cannot exceeds? \d+ pictures/i.test(causa)) {
          // ML rechaza CUALQUIER update de la publicación (no solo fotos) porque
          // ya tiene más fotos de las que su categoría permite hoy. No es algo que
          // el sync pueda resolver — requiere que el vendedor saque fotos en ML.
          // Se cachea por publicación para no repetir el intento en cada variación.
          itemsBloqueados.add(itemId);
          logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: diff.cantidad_ml, cantNueva: cantidad, estado: 'requiere_atencion_ml', error: causa.slice(0, 500) });
        } else {
          logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: diff.cantidad_ml, cantNueva: cantidad, estado: 'error', error: `HTTP ${resp.status}: ${causa}`.slice(0, 500) });
        }
      }
    } catch (e) {
      logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: diff.cantidad_ml, cantNueva: cantidad, estado: 'error', error: e.message });
    }

    // Delay para respetar rate limits de ML.
    await sleep(ML_CALL_DELAY_MS);
  }
}

// ─── procesarReintentos ───────────────────────────────────────────────────────

export async function procesarReintentos(db, cfg) {
  if (!mlCfgOk(cfg)) return;

  // Los dos syncs principales ya re-atienden todo automáticamente cada ciclo y son
  // idempotentes: syncWcToMl reintenta cada diff de stock pendiente, y syncMlToWc
  // reintenta cada orden no procesada. Un reintentador ACTIVO acá es redundante y,
  // peor, hace llamadas a la API de ML que compiten con el sync principal por el
  // rate limit (era la causa del enlentecimiento del backlog).
  //
  // Por eso este proceso ya NO llama a ninguna API: solo envejece el contador de los
  // errores viejos para que terminen en 'agotado' y dejen de figurar como pendientes.
  // Sin sleeps ni requests externos — es una limpieza puramente local.
  const pendientes = db.prepare(
    `SELECT id, intentos FROM sync_log WHERE estado = 'error' AND intentos < ${MAX_RETRIES}`
  ).all();

  const envejecer = db.prepare('UPDATE sync_log SET estado = ?, intentos = ?, actualizado_en = ? WHERE id = ?');
  const tx = db.transaction((rows) => {
    for (const entry of rows) {
      const intentos = entry.intentos + 1;
      const nuevoEstado = intentos >= MAX_RETRIES ? 'agotado' : 'error';
      envejecer.run(nuevoEstado, intentos, now(), entry.id);
    }
  });
  tx(pendientes);
}

// ─── reactivación de pausadas por falta de stock ────────────────────────────────

/**
 * Lista las publicaciones ML pausadas por out_of_stock que ya tienen stock
 * disponible en la web y están mapeadas. Devuelve filas por variación.
 * (El agrupado por publicación lo hace el router para el display.)
 */
export function getReactivablesRows(db, itemIds = null) {
  let sql = `
    ${COMPUTED_STOCK_CTE}
    SELECT cm.clave, cm.sku, cm.stock_disponible_ml,
           p.item_id, p.variation_id, p.titulo, p.variations_texto, p.thumbnail
    FROM computed cm
    JOIN ml_publicaciones_cache p ON p.clave = cm.clave
    WHERE p.status = 'paused'
      AND p.sub_status LIKE '%out_of_stock%'
      AND p.sub_status NOT LIKE '%paused_by_seller%'
      AND cm.stock_disponible_ml > 0`;
  const params = [];
  if (Array.isArray(itemIds) && itemIds.length) {
    sql += ` AND p.item_id IN (${itemIds.map(() => '?').join(',')})`;
    params.push(...itemIds);
  }
  sql += ' ORDER BY p.titulo, cm.clave';
  return db.prepare(sql).all(...params);
}

// Prioridad de bloqueo para elegir el "peor caso" entre variaciones de una misma publicación.
const PRECIO_ESTADO_PRIORIDAD = { bajo: 0, alto: 1, sin_precio: 2, ok: 3 };

/**
 * Precio ML vivo + neto para las publicaciones reactivables, para mostrar en la tabla antes
 * de que el usuario decida reactivar (mismo cálculo que chequearNetoReactivar, pero informativo
 * y para todas las publicaciones a la vez). Multiget de a MULTIGET_CHUNK items + 1 GET de
 * comisión y, si aplica, 1 de envío gratis por variación (cacheados por combinación / item para
 * no repetir llamadas). Devuelve Map(item_id -> {precio_ml, sale_fee, envio, neto, precio_web,
 * estado, deficit_pct}) con el peor caso (más prioridad de bloqueo) entre sus variaciones.
 */
async function evaluarPreciosReactivables(db, mlCfg, filasPorItem) {
  const MULTIGET_CHUNK = 20;
  const itemIds = [...filasPorItem.keys()];
  const resultado = new Map();
  const caches = { fee: new Map(), envio: new Map() };

  // 1) Multiget de los items en chunks, en paralelo con concurrencia acotada (antes: serie
  //    con sleep fijo entre cada chunk). Se completa el mapa `items` compartido antes de evaluar.
  const chunks = [];
  for (let i = 0; i < itemIds.length; i += MULTIGET_CHUNK) chunks.push(itemIds.slice(i, i + MULTIGET_CHUNK));
  const items = new Map();
  await mapConLimite(chunks, ML_CONCURRENCIA_MAX, async (chunk) => {
    const resp = await mlFetch(
      db, mlCfg, 'get',
      `/items?ids=${chunk.join(',')}&attributes=id,price,category_id,listing_type_id,shipping,variations`
    );
    if (resp.status === 200 && Array.isArray(resp.data)) {
      for (const e of resp.data) if (e.code === 200 && e.body) items.set(String(e.body.id), e.body);
    }
  });

  // 2) Evaluar el neto de cada item en paralelo (concurrencia acotada). Cada item resuelve
  //    independiente: la escritura en `resultado` es por itemId (sin choques entre tareas).
  //    Fail-safe por tarea: si mlFetch/netoMl LANZAN (ej. timeout real de axios, que hace throw
  //    en vez de devolver status), se captura acá y esa publicación queda como 'sin_precio' —
  //    NO se propaga al Promise.all del pool, que tumbaría la evaluación entera y haría que
  //    GET /reactivables responda 500 perdiendo el trabajo ya hecho de las demás.
  //    Nota: caches.fee/envio se comparte entre tareas paralelas; varias que encuentren el cache
  //    vacío para la misma categoría pueden disparar listing_prices/envío en paralelo antes de
  //    que la primera lo popule (algún request redundante puntual). No es un bug, solo pierde
  //    algo de eficiencia de cache; no se resuelve con cache de promesas por simplicidad.
  await mapConLimite(itemIds, ML_CONCURRENCIA_MAX, async (itemId) => {
    const item = items.get(itemId);
    const filas = filasPorItem.get(itemId) || [];
    let peor = null;
    try {
      for (const fila of filas) {
        const precioWeb = precioWebClave(db, fila.clave);
        let precio_ml = null, sale_fee = null, envio = null, neto = null;
        let estado = 'sin_precio', deficit_pct = null;
        if (item) {
          precio_ml = item.price ?? null;
          if (fila.variation_id) {
            const vv = (item.variations || []).find(x => String(x.id) === String(fila.variation_id));
            if (vv && vv.price != null) precio_ml = vv.price;
          }
          const freeShipping = !!item.shipping?.free_shipping;
          const r = await netoMl(db, mlCfg, {
            itemId, price: precio_ml, categoryId: item.category_id,
            listingTypeId: item.listing_type_id, freeShipping,
          }, caches);
          sale_fee = r.sale_fee; envio = r.envio; neto = r.neto;
          const v = veredictoNeto(neto, precioWeb);
          estado = v.estado; deficit_pct = v.deficitPct;
        }
        const evalFila = { precio_ml, sale_fee, envio, neto, precio_web: precioWeb, estado, deficit_pct };
        if (!peor || PRECIO_ESTADO_PRIORIDAD[estado] < PRECIO_ESTADO_PRIORIDAD[peor.estado]) peor = evalFila;
      }
    } catch {
      // Falla puntual de esta publicación: no hay dato de precio confiable → sin_precio.
      // No frena ni afecta la evaluación de las demás publicaciones del lote.
      peor = { precio_ml: null, sale_fee: null, envio: null, neto: null, precio_web: null, estado: 'sin_precio', deficit_pct: null };
    }
    if (peor) resultado.set(itemId, peor);
  });
  return resultado;
}

/**
 * Revalida en vivo el item antes de reactivar y verifica el neto del vendedor. Trae en un solo GET
 * status/sub_status + precio/categoría/listing/envío del item y:
 *  1) Revalida el estado real en ML: la lista de "reactivables" sale del caché local, y entre que
 *     se arma y el usuario confirma el lote el vendedor pudo reactivar o pausar manualmente la
 *     publicación. Si ya no está pausada, o si quedó pausada por el vendedor (paused_by_seller),
 *     se omite (no es un error ni un bloqueo por margen: es un skip por dato fresco).
 *  2) Por cada variación mapeada compara el neto contra el precio web. Si alguna queda >5% por
 *     debajo (veredicto 'bajo') devuelve el detalle del bloqueo.
 *
 * Devuelve:
 *  - null  → seguir adelante con la reactivación.
 *  - { omitido: true, motivo } → omitir sin error (revalidación de estado en vivo).
 *  - { error, ... } → bloqueo (por neto o fail-closed).
 *
 * Bloquea también (fail-closed) si no se pudo consultar el item en ML, si falta el precio web
 * mapeado o si no se pudo calcular la comisión: sin esos datos no hay forma de verificar el
 * margen, y dejar pasar la reactivación en ese caso anularía la protección en silencio. La
 * revalidación de estado es igual de fail-closed: si el GET falla, no reactivamos.
 */
async function chequearNetoReactivar(db, mlCfg, itemId, variaciones) {
  const resp = await mlFetch(db, mlCfg, 'get',
    `/items/${itemId}?attributes=id,status,sub_status,price,category_id,listing_type_id,shipping,variations`);
  if (resp.status !== 200 || !resp.data) {
    return { error: 'No se pudo consultar el precio en ML — reintentá', clave: null, neto: null, precio_web: null, deficitPct: null };
  }
  const item = resp.data;

  // 0) Revalidación de estado en vivo (mismo GET, sin llamada extra a ML).
  //    Fail-closed: si ML devolvió 200 pero sin el campo status (respuesta parcial/anómala),
  //    no lo tratamos como skip benigno — bloqueamos, porque no podemos afirmar que sigue pausada.
  if (item.status == null) {
    return { error: 'ML no devolvió el estado de la publicación — reintentá', clave: null, neto: null, precio_web: null, deficitPct: null };
  }
  const subStatus = Array.isArray(item.sub_status) ? item.sub_status.join(',') : String(item.sub_status ?? '');
  if (item.status !== 'paused') {
    // Ya no está pausada (p. ej. alguien la reactivó a mano): actualizar el caché para que
    // salga de la lista de reactivables y no se reintente en loop.
    return { omitido: true, motivo: 'Ya no está pausada en ML, se omitió', cacheStatus: item.status, cacheSubStatus: subStatus };
  }
  if (subStatus.includes('paused_by_seller')) {
    // El vendedor la pausó manualmente después de armar la lista: refrescar sub_status en el
    // caché para que getReactivablesRows deje de listarla (el filtro excluye paused_by_seller).
    return { omitido: true, motivo: 'Pausada manualmente por el vendedor, se omitió por seguridad', cacheStatus: 'paused', cacheSubStatus: subStatus };
  }

  const freeShipping = !!item.shipping?.free_shipping;
  const caches = { fee: new Map(), envio: new Map() };

  for (const v of variaciones) {
    const precioWeb = precioWebClave(db, v.clave);
    if (!(precioWeb > 0)) {
      return { error: 'Sin precio web mapeado para esta variación — no se puede verificar el margen', clave: v.clave, neto: null, precio_web: null, deficitPct: null };
    }
    let precio = item.price ?? null;
    if (v.variation_id) {
      const vv = (item.variations || []).find(x => String(x.id) === String(v.variation_id));
      if (vv && vv.price != null) precio = vv.price;
    }
    const { neto } = await netoMl(db, mlCfg, {
      itemId, price: precio, categoryId: item.category_id,
      listingTypeId: item.listing_type_id, freeShipping,
    }, caches);
    if (neto == null) {
      return { error: 'No se pudo calcular la comisión en ML — reintentá', clave: v.clave, neto: null, precio_web: precioWeb, deficitPct: null };
    }
    const { estado, deficitPct } = veredictoNeto(neto, precioWeb);
    if (estado === 'bajo') {
      return { error: 'El neto de ML queda por debajo del precio web', clave: v.clave, neto, precio_web: precioWeb, deficitPct };
    }
  }
  return null;
}

/**
 * Reactiva en ML las publicaciones indicadas: empuja el stock de cada variación
 * mapeada y luego pasa la publicación a 'active'. Revalida en el servidor, contra ML en vivo,
 * que sigan pausadas por out_of_stock y que el vendedor no las haya reactivado (status active)
 * ni pausado manualmente (paused_by_seller) desde que se armó la lista; en esos casos las omite
 * y refresca el caché local para no reintentarlas en loop (no confía en el cliente ni en el
 * caché stale). Procesa un lote acotado para no chocar el timeout de nginx. Devuelve resultado
 * por publicación.
 */
export async function reactivarItems(db, mlCfg, itemIds) {
  const LOTE_MAX = 50;
  const aProcesar = itemIds.slice(0, LOTE_MAX);
  const rows = getReactivablesRows(db, aProcesar);

  // Agrupar variaciones válidas por item
  const porItem = new Map();
  for (const r of rows) {
    if (!porItem.has(r.item_id)) porItem.set(r.item_id, []);
    porItem.get(r.item_id).push(r);
  }

  // Se procesan varias publicaciones EN PARALELO con concurrencia acotada (antes: una a una
  //  con sleep fijo entre requests). La paralelización es ENTRE publicaciones distintas: dentro
  //  de una misma publicación los PUTs de stock siguen yendo en orden y la activación va DESPUÉS
  //  de que todos terminen. Cada publicación resuelve independiente (éxito/omitida/bloqueada/
  //  error): un fallo en una no frena ni afecta a las demás (fn captura su propio error).
  const resultados = await mapConLimite([...porItem], ML_CONCURRENCIA_MAX, async ([itemId, variaciones]) => {
    try {
      // 0) Revalidación en vivo + bloqueo por neto (un solo GET del item). Omite si ya no está
      //    pausada o si el vendedor la pausó manualmente; bloquea si el neto queda >5% por debajo
      //    del precio web de alguna variación mapeada. Server-side (no confía en el cliente).
      const bloqueo = await chequearNetoReactivar(db, mlCfg, itemId, variaciones);
      if (bloqueo) {
        if (bloqueo.omitido) {
          // Refrescar el caché local con el estado real de ML para sacarla de reactivables y
          // que el usuario no la reintente en loop (siempre "omitida") en la próxima carga.
          const refrescar = db.prepare('UPDATE ml_publicaciones_cache SET status=?, sub_status=? WHERE clave = ?');
          for (const v of variaciones) refrescar.run(bloqueo.cacheStatus, bloqueo.cacheSubStatus, v.clave);
          return { item_id: itemId, ok: false, omitido: true, motivo: bloqueo.motivo };
        }
        return { item_id: itemId, ok: false, bloqueado: true, ...bloqueo };
      }

      // 1) Empujar stock de cada variación con stock web disponible (en orden dentro del item)
      for (const v of variaciones) {
        const cantidad = Math.max(0, Math.round(v.stock_disponible_ml));
        const { path, body } = buildMlStockUpdate(itemId, v.variation_id || '', cantidad);
        const resp = await mlFetch(db, mlCfg, 'put', path, body);
        if (resp.status !== 200) {
          throw new Error(`stock ${v.clave}: ${extraerErrorMl(resp)}`);
        }
      }

      // 2) Reactivar la publicación — DESPUÉS de que todos los PUTs de stock de ESTA
      //    publicación terminaron (dependencia intra-publicación, no se paraleliza).
      const act = await mlFetch(db, mlCfg, 'put', `/items/${itemId}`, { status: 'active' });
      if (act.status !== 200) {
        throw new Error(`activar: ${extraerErrorMl(act)}`);
      }

      // 3) Persistir: cache activo + estado de stock + log por variación
      const marcarActivo = db.prepare("UPDATE ml_publicaciones_cache SET status='active', sub_status='' WHERE clave = ?");
      for (const v of variaciones) {
        const cantidad = Math.max(0, Math.round(v.stock_disponible_ml));
        marcarActivo.run(v.clave);
        upsertMlStockEstado(db, v.clave, v.sku, cantidad);
        logSync(db, { direccion: 'wc_ml', clave: v.clave, sku: v.sku, cantNueva: cantidad, estado: 'reactivada' });
      }
      return { item_id: itemId, ok: true, variaciones: variaciones.length };
    } catch (e) {
      const error = e.message;
      logSync(db, { direccion: 'wc_ml', clave: itemId, estado: 'error', error: `reactivar: ${error}`.slice(0, 500) });
      return { item_id: itemId, ok: false, error };
    }
  });

  return { procesados: porItem.size, resultados };
}

// ─── limpieza masiva de variaciones muertas ─────────────────────────────────────

/**
 * Trae de ML las variaciones vivas de cada publicación (multiget de a MULTIGET_CHUNK).
 * Devuelve Map(itemId -> Set(variation_id)). Un itemId AUSENTE del Map significa que ML no
 * lo devolvió (chunk fallido o item inaccesible): el llamador debe tratarlo fail-closed
 * (no asumir que sus variaciones están muertas). No lanza.
 */
async function variacionesVivasDeMl(db, mlCfg, itemIds) {
  const vivas = new Map();
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += MULTIGET_CHUNK) {
    const chunk = ids.slice(i, i + MULTIGET_CHUNK);
    const resp = await mlFetch(db, mlCfg, 'get', `/items?ids=${chunk.join(',')}&attributes=id,status,variations`);
    await sleep(ML_CALL_DELAY_MS);
    if (resp.status !== 200 || !Array.isArray(resp.data)) continue; // chunk fallido → fail-closed
    for (const entry of resp.data) {
      if (entry.code !== 200 || !entry.body) continue;
      const vs = Array.isArray(entry.body.variations) ? entry.body.variations : [];
      vivas.set(String(entry.body.id), new Set(vs.map(v => String(v.id))));
    }
  }
  return vivas;
}

/**
 * Limpieza masiva de variaciones muertas: variation_id que ML confirma que ya no
 * existen (publicaciones convertidas a simple o recreadas). Junta candidatos de dos
 * fuentes —decisiones activas con variation_id, y claves remapeo_requerido pendientes—,
 * verifica cada publicación EN VIVO contra ML y descarta SOLO las que ML confirma muertas.
 * Fail-closed: si ML no devuelve un item, se saltea (no se borra ante la duda).
 * Devuelve { revisados, muertas, saltados, items }.
 */
export async function limpiarVariacionesMuertas(db, mlCfg) {
  const conVariacion = "substr(clave, instr(clave,'|')+1) <> ''";
  // Candidatos 1: decisiones activas de variación (bombas latentes).
  const decisiones = db.prepare(
    `SELECT clave FROM sku_matcher_decisiones WHERE accion IN ('asignar','confirmar') AND ${conVariacion}`
  ).all().map(r => r.clave);
  // Candidatos 2: claves remapeo_requerido pendientes (ya sin decisión, no descartadas).
  const remapeo = db.prepare(
    `SELECT DISTINCT clave FROM sync_log
     WHERE estado='remapeo_requerido' AND clave IS NOT NULL AND ${conVariacion}
       AND clave NOT IN (SELECT clave FROM sku_matcher_decisiones WHERE accion IN ('asignar','confirmar'))
       AND clave NOT IN (SELECT clave FROM errores_descartados)`
  ).all().map(r => r.clave);

  const claves = [...new Set([...decisiones, ...remapeo])];
  if (!claves.length) return { revisados: 0, muertas: 0, saltados: 0, items: 0 };

  const itemIds = [...new Set(claves.map(c => partirClaveMl(c).itemId).filter(Boolean))];
  const vivasPorItem = await variacionesVivasDeMl(db, mlCfg, itemIds);

  let muertas = 0, saltados = 0;
  for (const clave of claves) {
    const { itemId, variationId } = partirClaveMl(clave);
    const vivas = vivasPorItem.get(itemId);
    if (!vivas) { saltados++; continue; }   // ML no confirmó → no tocar (fail-closed)
    if (vivas.has(variationId)) continue;   // la variación sigue viva → intacta
    descartarVariacionMuerta(db, clave, 'Variación inexistente en ML (limpieza masiva)');
    muertas++;
  }

  return { revisados: claves.length, muertas, saltados, items: itemIds.length };
}

/**
 * Diagnóstico en vivo de la vista sin_mapeo: marca variacion_muerta=true en las filas
 * cuya variación vendida ya no existe en ML (publicación convertida a simple o recreada).
 * Asignarles un SKU es inútil —el sync borraría el mapeo por "doesn't have a variation"—;
 * la acción correcta es descartarlas. Fail-closed y degrada elegante: si ML no confirma un
 * item, la fila queda sin marcar (mapeable como hoy). No lanza (el llamador la envuelve).
 */
async function diagnosticarSinMapeo(db, mlCfg, rows) {
  if (!mlCfg?.clientId || !rows.length) return;
  const conVar = rows.filter(r => partirClaveMl(r.clave).variationId);
  if (!conVar.length) return;
  const vivasPorItem = await variacionesVivasDeMl(db, mlCfg, conVar.map(r => partirClaveMl(r.clave).itemId));
  for (const r of rows) {
    const { itemId, variationId } = partirClaveMl(r.clave);
    if (!variationId) continue;
    const vivas = vivasPorItem.get(itemId);
    if (vivas && !vivas.has(variationId)) r.variacion_muerta = true;
  }
}

// ─── enriquecimiento de filas con datos de ML (título + miniatura) ──────────────

const MULTIGET_CHUNK = 20;      // ML permite hasta 20 ids por multiget
const ENRICH_MAX_ITEMS = 60;    // cota de llamadas a ML por carga de la vista de detalle

/**
 * Completa in-place `titulo` y `thumbnail` de las filas que no los tengan en cache,
 * trayéndolos de ML por multiget. Además persiste lo traído en ml_publicaciones_cache
 * (solo publicaciones ya existentes, sin crear filas nuevas). No lanza: el llamador la
 * envuelve en catch; ante fallo de ML o falta de token, las filas quedan como estaban.
 */
async function enriquecerConMl(db, mlCfg, rows) {
  if (!mlCfg?.clientId || !rows.length) return;

  const faltan = new Set();
  for (const r of rows) {
    const itemId = r.item_id || partirClaveMl(r.clave).itemId;
    if (itemId && (!r.titulo || !r.thumbnail)) faltan.add(itemId);
  }
  if (!faltan.size) return;
  const ids = [...faltan].slice(0, ENRICH_MAX_ITEMS);

  const info = new Map(); // itemId -> { title, thumbnail }
  for (let i = 0; i < ids.length; i += MULTIGET_CHUNK) {
    const chunk = ids.slice(i, i + MULTIGET_CHUNK);
    const resp = await mlFetch(db, mlCfg, 'get',
      `/items?ids=${chunk.join(',')}&attributes=id,title,secure_thumbnail,thumbnail`);
    if (resp.status !== 200 || !Array.isArray(resp.data)) continue;
    for (const entry of resp.data) {
      if (entry.code !== 200 || !entry.body) continue;
      const b = entry.body;
      info.set(String(b.id), { title: b.title || '', thumbnail: b.secure_thumbnail || b.thumbnail || '' });
    }
  }
  if (!info.size) return;

  // Persistir en cache lo traído, sin pisar valores no vacíos ya existentes.
  const upd = db.prepare(
    "UPDATE ml_publicaciones_cache SET titulo = COALESCE(NULLIF(titulo,''), ?), thumbnail = COALESCE(NULLIF(thumbnail,''), ?) WHERE item_id = ?"
  );
  db.transaction((entries) => {
    for (const [itemId, v] of entries) upd.run(v.title || null, v.thumbnail || null, itemId);
  })([...info.entries()]);

  // Mergear en las filas devueltas al cliente.
  for (const r of rows) {
    const itemId = r.item_id || partirClaveMl(r.clave).itemId;
    const v = info.get(itemId);
    if (!v) continue;
    if (!r.titulo) r.titulo = v.title;
    if (!r.thumbnail) r.thumbnail = v.thumbnail;
    if (!r.item_id) r.item_id = itemId;
  }
}

/**
 * Diagnóstico en vivo de la vista de errores: re-consulta el estado real de cada publicación
 * en ML y clasifica cada fila con su causa y la acción que la resuelve. No lanza (el llamador
 * la envuelve en catch); si ML falla, las filas quedan sin diagnóstico (fallback en el front).
 *
 * diagnostico → accion:
 *   reactivable (pausada out_of_stock con stock web)      → reactivar
 *   sin_stock   (pausada out_of_stock sin stock web)      → descartar
 *   pausada_manual (paused_by_seller) / pausada_otro      → descartar
 *   estructura_cambiada (variación mapeada ya no existe)  → desvincular
 *   reintentable (activa, debería sincronizar)            → reintentar
 *   no_activa (cerrada / inaccesible)                     → descartar
 */
async function diagnosticarErrores(db, mlCfg, rows) {
  if (!mlCfg?.clientId || !rows.length) return;

  // Stock web disponible por clave (distingue reactivable vs sin_stock real).
  const stockMap = new Map();
  try {
    for (const r of db.prepare(`${COMPUTED_STOCK_CTE} SELECT clave, stock_disponible_ml FROM computed`).all()) {
      stockMap.set(r.clave, r.stock_disponible_ml);
    }
  } catch (_) { /* sin catálogo/mapeo todavía */ }

  const itemIds = [...new Set(rows.map(r => r.item_id || partirClaveMl(r.clave).itemId).filter(Boolean))].slice(0, ENRICH_MAX_ITEMS);
  const info = new Map();
  for (let i = 0; i < itemIds.length; i += MULTIGET_CHUNK) {
    const chunk = itemIds.slice(i, i + MULTIGET_CHUNK);
    const resp = await mlFetch(db, mlCfg, 'get',
      `/items?ids=${chunk.join(',')}&attributes=id,title,status,sub_status,variations,secure_thumbnail,thumbnail`);
    if (resp.status !== 200 || !Array.isArray(resp.data)) continue;
    for (const entry of resp.data) {
      if (entry.code === 200 && entry.body) info.set(String(entry.body.id), entry.body);
    }
  }

  // Persistir título/miniatura traídos en el cache (best-effort), como enriquecerConMl.
  try {
    const upd = db.prepare("UPDATE ml_publicaciones_cache SET titulo=COALESCE(NULLIF(titulo,''),?), thumbnail=COALESCE(NULLIF(thumbnail,''),?) WHERE item_id=?");
    db.transaction((entries) => {
      for (const [id, b] of entries) upd.run(b.title || null, b.secure_thumbnail || b.thumbnail || null, id);
    })([...info.entries()]);
  } catch (_) { /* no crítico */ }

  for (const r of rows) {
    const claveParteada = partirClaveMl(r.clave);
    const itemId = r.item_id || claveParteada.itemId;
    const varId = r.variation_id || claveParteada.variationId;
    if (!r.item_id) r.item_id = itemId;
    r.stock_web = stockMap.has(r.clave) ? stockMap.get(r.clave) : null;

    const it = info.get(itemId);
    if (!it) { r.diagnostico = 'no_activa'; r.accion = 'descartar'; continue; }
    if (!r.titulo) r.titulo = it.title || '';
    if (!r.thumbnail) r.thumbnail = it.secure_thumbnail || it.thumbnail || '';
    const status = it.status;
    const sub = Array.isArray(it.sub_status) ? it.sub_status.join(',') : (it.sub_status || '');
    r.ml_status = status; r.ml_sub_status = sub;
    const vars = Array.isArray(it.variations) ? it.variations : [];

    if (status === 'paused') {
      if (/paused_by_seller/.test(sub)) { r.diagnostico = 'pausada_manual'; r.accion = 'descartar'; }
      else if (/out_of_stock/.test(sub)) {
        if (r.stock_web > 0) { r.diagnostico = 'reactivable'; r.accion = 'reactivar'; }
        else { r.diagnostico = 'sin_stock'; r.accion = 'descartar'; }
      } else { r.diagnostico = 'pausada_otro'; r.accion = 'descartar'; }
    } else if (status === 'active') {
      const existeVar = varId ? vars.some(x => String(x.id) === String(varId)) : vars.length === 0;
      if (existeVar) { r.diagnostico = 'reintentable'; r.accion = 'reintentar'; }
      else { r.diagnostico = 'estructura_cambiada'; r.accion = 'desvincular'; }
    } else {
      r.diagnostico = 'no_activa'; r.accion = 'descartar';
    }
  }
}

// ─── syncRouter ───────────────────────────────────────────────────────────────

export function syncRouter(db, cfg) {
  const router = Router();
  const { ml: mlCfg } = cfg ?? {};

  router.get('/estado', (req, res) => {
    const cursores = db.prepare('SELECT clave, valor, actualizado_en FROM sync_estado').all();
    const tokenRow = db.prepare('SELECT expires_at, actualizado_en FROM ml_oauth_token WHERE id=1').get();
    const ultimosOk = db.prepare(
      "SELECT direccion, MAX(creado_en) as ultima FROM sync_log WHERE estado='ok' GROUP BY direccion"
    ).all();
    const errores = db.prepare(
      "SELECT COUNT(*) as n FROM sync_log WHERE estado IN ('error','agotado','sin_mapeo','remapeo_requerido','requiere_atencion_ml')"
    ).get();

    res.json({
      ok: true,
      cursores,
      token: tokenRow
        ? { configurado: true, vence: tokenRow.expires_at, vigente: new Date(tokenRow.expires_at) > new Date() }
        : { configurado: false },
      ultimasSyncsOk: ultimosOk,
      erroresPendientes: errores?.n ?? 0,
    });
  });

  router.post('/ml-wc', async (req, res) => {
    try {
      const r = await syncMlToWc(db, cfg);
      // omitido:true cuando ya había una corrida en curso (candado) — no sincronizó.
      res.json({ ok: true, omitido: r?.omitido === true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/wc-ml', async (req, res) => {
    try {
      const r = await syncWcToMl(db, cfg);
      // omitido:true cuando ya había una corrida en curso (candado) — no sincronizó.
      res.json({ ok: true, omitido: r?.omitido === true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/ml-cancelaciones', async (req, res) => {
    try {
      await procesarCancelacionesMl(db, cfg);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/errores', (req, res) => {
    const rows = db.prepare(`
      SELECT id, direccion, clave, sku, cant_anterior, cant_nueva, estado, intentos, error, creado_en, actualizado_en
      FROM sync_log
      WHERE estado IN ('error','agotado','sin_mapeo','remapeo_requerido','requiere_atencion_ml')
      ORDER BY creado_en DESC LIMIT 200
    `).all();
    res.json({ ok: true, data: rows });
  });

  // Dashboard: todo el estado de la integración ML en una sola llamada
  router.get('/dashboard', (req, res) => {
    const tokenRow = db.prepare('SELECT expires_at, actualizado_en FROM ml_oauth_token WHERE id=1').get();
    const ultimasOk = db.prepare(
      "SELECT direccion, MAX(creado_en) as ultima FROM sync_log WHERE estado='ok' GROUP BY direccion"
    ).all();

    // CTE de stock disponible (compartido con syncWcToMl y reactivables)
    const computedCte = COMPUTED_STOCK_CTE;

    const sincronizadas = db.prepare('SELECT COUNT(*) n FROM ml_stock_estado').get().n;
    const pendientes = db.prepare(
      `${computedCte} SELECT COUNT(*) n FROM computed WHERE cantidad_ml IS NULL OR cantidad_ml <> stock_disponible_ml`
    ).get().n;
    // De las pendientes, cuántas son por publicación pausada (usa ml_publicaciones_cache)
    let pendientesPausadas = 0;
    try {
      pendientesPausadas = db.prepare(
        `${computedCte}
         SELECT COUNT(*) n FROM computed cm
         JOIN ml_publicaciones_cache p ON p.clave = cm.clave
         WHERE (cm.cantidad_ml IS NULL OR cm.cantidad_ml <> cm.stock_disponible_ml) AND p.status <> 'active'`
      ).get().n;
    } catch (_) { /* cache puede no existir todavía */ }

    // Publicaciones reactivables (pausadas por out_of_stock con stock web y mapeadas).
    // Reutiliza getReactivablesRows para que el conteo coincida exacto con /reactivables.
    let reactivables = 0;
    try {
      reactivables = new Set(getReactivablesRows(db).map(r => r.item_id)).size;
    } catch (_) { /* cache puede no existir todavía */ }

    // wc_order_id=0 es una reserva en curso (o abandonada, ver _procesarOrden) de un pedido
    // que todavía no se creó en Woo — se excluye para no mostrarla como pedido real.
    const pedidos = db.prepare(
      "SELECT COUNT(*) total, SUM(CASE WHEN cancelado_en IS NOT NULL THEN 1 ELSE 0 END) cancelados FROM ordenes_ml_wc_pedidos WHERE wc_order_id <> 0"
    ).get();
    const ultimosPedidos = db.prepare(
      "SELECT ml_order_id, wc_order_id, comprador_json, creado_en, cancelado_en FROM ordenes_ml_wc_pedidos WHERE wc_order_id <> 0 ORDER BY creado_en DESC LIMIT 12"
    ).all();

    // "Necesita atención" — solo lo REALMENTE pendiente de acción hoy.
    // El sync_log es append-only, así que se filtra lo ya resuelto:
    //  - error/agotado ya sincronizado después → está en ml_stock_estado
    //  - remapeo/sin_mapeo ya re-mapeado → volvió a sku_matcher_decisiones
    //  - o descartado a mano (ej. la variación vieja ya no existe en ML y nunca
    //    va a poder re-mapearse con esa clave exacta) → errores_descartados
    const sinMapeo = db.prepare(
      `SELECT COUNT(DISTINCT clave) n FROM sync_log
       WHERE estado='sin_mapeo' AND clave IS NOT NULL
         AND clave NOT IN (SELECT clave FROM sku_matcher_decisiones WHERE accion IN ('asignar','confirmar'))
         AND clave NOT IN (SELECT clave FROM errores_descartados)`
    ).get().n;
    const remapeoReq = db.prepare(
      `SELECT COUNT(DISTINCT clave) n FROM sync_log
       WHERE estado='remapeo_requerido' AND clave IS NOT NULL
         AND clave NOT IN (SELECT clave FROM sku_matcher_decisiones)
         AND clave NOT IN (SELECT clave FROM errores_descartados)`
    ).get().n;
    const requiereAtencion = db.prepare(
      `SELECT COUNT(DISTINCT clave) n FROM sync_log
       WHERE estado='requiere_atencion_ml' AND clave IS NOT NULL
         AND clave NOT IN (SELECT clave FROM ml_stock_estado)`
    ).get().n;
    const erroresReales = db.prepare(
      `SELECT COUNT(DISTINCT clave) n FROM sync_log
       WHERE estado IN ('error','agotado') AND clave IS NOT NULL
         AND clave NOT IN (SELECT clave FROM ml_stock_estado)
         AND clave NOT IN (SELECT clave FROM errores_descartados)`
    ).get().n;
    const catMap = { sin_mapeo: sinMapeo, remapeo_requerido: remapeoReq, requiere_atencion_ml: requiereAtencion };

    // SKUs de las decisiones: escritos en ML vs pendientes de escribir
    let skus = { escritos: 0, pendientes: 0 };
    try {
      const s = db.prepare(`
        SELECT
          SUM(CASE WHEN COALESCE(p.seller_sku,'') = d.sku THEN 1 ELSE 0 END) escritos,
          SUM(CASE WHEN COALESCE(p.seller_sku,'') <> d.sku THEN 1 ELSE 0 END) pendientes
        FROM sku_matcher_decisiones d
        JOIN ml_publicaciones_cache p ON p.clave = d.clave
        WHERE d.accion IN ('asignar','confirmar') AND d.sku LIKE 'FB-%' AND p.status = 'active'
      `).get();
      skus = { escritos: s.escritos || 0, pendientes: s.pendientes || 0 };
    } catch (_) { /* cache puede no existir */ }

    res.json({
      ok: true,
      token: tokenRow
        ? { configurado: true, vence: tokenRow.expires_at, vigente: new Date(tokenRow.expires_at) > new Date() }
        : { configurado: false },
      ultimasSyncsOk: ultimasOk,
      stock: { sincronizadas, pendientes, pendientesPausadas },
      reactivables,
      pedidos: {
        total: pedidos.total ?? 0,
        cancelados: pedidos.cancelados ?? 0,
        ultimos: ultimosPedidos,
      },
      atencion: {
        sin_mapeo: catMap.sin_mapeo ?? 0,
        remapeo_requerido: catMap.remapeo_requerido ?? 0,
        requiere_atencion_ml: catMap.requiere_atencion_ml ?? 0,
        errores_reales: erroresReales,
      },
      skus,
    });
  });

  // Conteo rápido de reactivables (solo lee el caché local, sin consultar precios en ML).
  // Lo usa el frontend para mostrar "Evaluando N publicaciones…" antes de pedir el detalle
  // completo (que sí evalúa precios en ML y por eso tarda unos segundos).
  router.get('/reactivables/conteo', (req, res) => {
    try {
      const rows = getReactivablesRows(db);
      const totalPublicaciones = new Set(rows.map(r => r.item_id)).size;
      res.json({ ok: true, totalPublicaciones, totalVariaciones: rows.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Publicaciones pausadas por out_of_stock con stock web disponible, agrupadas por publicación.
  // Incluye precio ML/neto vivo (si ML está configurado) para que el usuario vea de entrada
  // si el precio quedó mal puesto, sin tener que intentar reactivar primero.
  router.get('/reactivables', async (req, res) => {
    try {
      const rows = getReactivablesRows(db);
      const porItem = new Map();
      const filasPorItem = new Map();
      for (const r of rows) {
        if (!porItem.has(r.item_id)) {
          porItem.set(r.item_id, { item_id: r.item_id, titulo: r.titulo, thumbnail: r.thumbnail, variaciones: [] });
          filasPorItem.set(r.item_id, []);
        }
        porItem.get(r.item_id).variaciones.push({
          clave: r.clave, sku: r.sku,
          variations_texto: r.variations_texto,
          stock_disponible_ml: r.stock_disponible_ml,
        });
        filasPorItem.get(r.item_id).push({ clave: r.clave, variation_id: r.variation_id });
      }
      const data = [...porItem.values()];

      if (mlCfgOk(cfg) && data.length) {
        const precios = await evaluarPreciosReactivables(db, mlCfg, filasPorItem);
        for (const pub of data) {
          const p = precios.get(pub.item_id);
          if (p) Object.assign(pub, p);
        }
      }

      res.json({ ok: true, data, totalPublicaciones: data.length, totalVariaciones: rows.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Reactiva las publicaciones indicadas (empuja stock + status active). Requiere
  // acción explícita del usuario. Procesa un lote y no se solapa consigo mismo.
  router.post('/reactivar', async (req, res) => {
    if (!mlCfgOk(cfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    const { itemIds } = req.body || {};
    if (!Array.isArray(itemIds) || !itemIds.length) {
      return res.status(400).json({ ok: false, error: 'itemIds requerido' });
    }
    if (_reactivarEnCurso) {
      return res.status(409).json({ ok: false, error: 'Ya hay una reactivación en curso' });
    }
    _reactivarEnCurso = true;
    try {
      const r = await reactivarItems(db, mlCfg, itemIds.map(String));
      // El cliente puede haber cancelado (AbortController) y cerrado la conexión mientras
      // este chunk terminaba de procesarse en ML. En ese caso no intentamos escribir la
      // respuesta (rompería con un stream ya cerrado); igual el trabajo del chunk se completó.
      if (!res.writableEnded) res.json({ ok: true, ...r });
    } catch (e) {
      if (!res.writableEnded) res.status(500).json({ ok: false, error: e.message });
    } finally {
      // Pase lo que pase (incluida una cancelación del cliente a mitad de camino) el candado
      // se libera acá, así el próximo lote no queda bloqueado por una reactivación fantasma.
      _reactivarEnCurso = false;
    }
  });

  // Limpieza masiva de variaciones muertas (verificada contra ML, fail-closed).
  // Requiere acción explícita del usuario. No se solapa consigo misma.
  router.post('/limpiar-variaciones-muertas', async (req, res) => {
    if (!mlCfgOk(cfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    if (_limpiezaMuertasEnCurso) {
      return res.status(409).json({ ok: false, error: 'Ya hay una limpieza en curso' });
    }
    _limpiezaMuertasEnCurso = true;
    try {
      const r = await limpiarVariacionesMuertas(db, mlCfg);
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    } finally {
      _limpiezaMuertasEnCurso = false;
    }
  });

  // Detalle acotado de cada categoría de "necesita atención" del dashboard.
  // Devuelve SOLO los ítems realmente pendientes (mismos filtros que /dashboard),
  // con título/variación de la publicación. No carga catálogos completos.
  const ATENCION_DEFS = {
    sin_mapeo: {
      estados: "'sin_mapeo'",
      exclude: "s.clave NOT IN (SELECT clave FROM sku_matcher_decisiones WHERE accion IN ('asignar','confirmar')) AND s.clave NOT IN (SELECT clave FROM errores_descartados)",
    },
    remapeo_requerido: {
      estados: "'remapeo_requerido'",
      exclude: "s.clave NOT IN (SELECT clave FROM sku_matcher_decisiones) AND s.clave NOT IN (SELECT clave FROM errores_descartados)",
    },
    requiere_atencion_ml: {
      estados: "'requiere_atencion_ml'",
      exclude: "s.clave NOT IN (SELECT clave FROM ml_stock_estado)",
    },
    errores: {
      estados: "'error','agotado'",
      exclude: "s.clave NOT IN (SELECT clave FROM ml_stock_estado) AND s.clave NOT IN (SELECT clave FROM errores_descartados)",
    },
  };

  router.get('/atencion/:cat', async (req, res) => {
    const def = ATENCION_DEFS[req.params.cat];
    if (!def) return res.status(400).json({ ok: false, error: 'categoría inválida' });
    // GROUP BY clave con MAX(creado_en): SQLite toma sku/error de la fila más reciente.
    const rows = db.prepare(`
      SELECT s.clave, s.sku, s.error, s.estado, MAX(s.creado_en) AS creado_en,
             p.item_id, p.variation_id, p.titulo, p.variations_texto, p.status AS ml_status, p.thumbnail
      FROM sync_log s
      LEFT JOIN ml_publicaciones_cache p ON p.clave = s.clave
      WHERE s.estado IN (${def.estados})
        AND s.clave IS NOT NULL
        AND ${def.exclude}
      GROUP BY s.clave
      ORDER BY creado_en DESC
      LIMIT 500
    `).all();

    // Categoría "errores": diagnóstico en vivo (clasifica cada fila con su causa real y su
    // acción). El resto: enriquecimiento de título/miniatura. Ambos degradan elegante si ML falla.
    if (req.params.cat === 'errores') {
      await diagnosticarErrores(db, mlCfg, rows).catch(() => {});
    } else {
      await enriquecerConMl(db, mlCfg, rows).catch(() => {});
      // sin_mapeo: además marcá las filas cuya variación vendida ya no existe en ML,
      // para ofrecer Descartar en vez del buscador de SKU inútil.
      if (req.params.cat === 'sin_mapeo') {
        await diagnosticarSinMapeo(db, mlCfg, rows).catch(() => {});
      }
    }

    res.json({ ok: true, cat: req.params.cat, total: rows.length, data: rows });
  });

  // Descarta claves no accionables (sin stock real, pausa manual, publicación cerrada,
  // o una variación vieja que ya no existe en ML y nunca va a poder re-mapearse con esa
  // clave exacta): dejan de contar en cualquier categoría de atención (errores, sin_mapeo,
  // remapeo_requerido) y desaparecen de la vista. Reaparecen si vuelven a errar más adelante.
  router.post('/descartar-error', (req, res) => {
    const { claves, motivo } = req.body || {};
    const arr = Array.isArray(claves) ? claves.filter(c => typeof c === 'string' && c) : [];
    if (!arr.length) return res.status(400).json({ ok: false, error: 'claves requerido' });
    const ins = db.prepare(`INSERT INTO errores_descartados (clave, motivo, creado_en) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET motivo=excluded.motivo, creado_en=excluded.creado_en`);
    const m = typeof motivo === 'string' ? motivo.slice(0, 200) : null;
    db.transaction((list) => { for (const c of list) ins.run(c, m, now()); })(arr);
    res.json({ ok: true, descartados: arr.length });
  });

  // Desvincula una clave (borra su mapeo) para que el Matcher la vuelva a linkear a la
  // variación/publicación correcta. Para el caso "la variación mapeada ya no existe".
  router.post('/desvincular', (req, res) => {
    const { clave } = req.body || {};
    if (!clave || typeof clave !== 'string') return res.status(400).json({ ok: false, error: 'clave requerida' });
    const info = db.prepare('DELETE FROM sku_matcher_decisiones WHERE clave = ?').run(clave);
    logSync(db, { direccion: 'wc_ml', clave, estado: 'remapeo_requerido', error: 'desvinculada manualmente para re-mapear' });
    res.json({ ok: true, borradas: info.changes });
  });

  // Reintenta la sincronización de stock de UN solo ítem (para resolver un error puntual).
  router.post('/reintentar-item', async (req, res) => {
    if (!mlCfgOk(cfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    const { clave } = req.body || {};
    if (!clave || typeof clave !== 'string') return res.status(400).json({ ok: false, error: 'clave requerida' });

    const row = db.prepare(`${COMPUTED_STOCK_CTE} SELECT * FROM computed WHERE clave = ?`).get(clave);
    if (!row) return res.json({ ok: false, error: 'La clave no tiene mapeo activo o SKU en el catálogo.' });

    const pub = db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
    if (pub && pub.status && pub.status !== 'active') {
      return res.json({ ok: false, error: `La publicación está ${pub.status} — reactivala desde el panel.` });
    }

    const { itemId, variationId } = partirClaveMl(clave);
    const cantidad = Math.max(0, Math.round(row.stock_disponible_ml));
    try {
      const { path, body } = buildMlStockUpdate(itemId, variationId, cantidad);
      const resp = await mlFetch(db, mlCfg, 'put', path, body);
      if (resp.status === 200) {
        upsertMlStockEstado(db, clave, row.sku, cantidad);
        logSync(db, { direccion: 'wc_ml', clave, sku: row.sku, cantNueva: cantidad, estado: 'ok' });
        return res.json({ ok: true, cantidad });
      }
      const causa = extraerErrorMl(resp);
      logSync(db, { direccion: 'wc_ml', clave, sku: row.sku, estado: 'error', error: causa.slice(0, 500) });
      return res.json({ ok: false, error: causa });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/ml-auth-url', (req, res) => {
    if (!mlCfg?.clientId) {
      return res.status(400).json({ ok: false, error: 'ML_CLIENT_ID no configurado' });
    }
    const url = `${ML_AUTH_URL}?response_type=code&client_id=${mlCfg.clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    res.json({ ok: true, url });
  });

  router.post('/ml-bootstrap', async (req, res) => {
    const { code } = req.body ?? {};
    if (!code) return res.status(400).json({ ok: false, error: 'Se requiere { code }' });
    if (typeof code !== 'string' || code.length > 512) {
      return res.status(400).json({ ok: false, error: 'code inválido' });
    }
    if (!mlCfg?.clientId) return res.status(400).json({ ok: false, error: 'ML_CLIENT_ID no configurado' });

    // Evitar re-bootstrap si el token ya está activo y vigente
    const tokenRow = db.prepare('SELECT expires_at FROM ml_oauth_token WHERE id = 1').get();
    if (tokenRow && new Date(tokenRow.expires_at) > new Date()) {
      return res.status(409).json({ ok: false, error: 'Token ML ya activo — usar /estado para verificar vigencia' });
    }

    try {
      const result = await bootstrapToken(db, { ...mlCfg, redirectUri: REDIRECT_URI }, code);
      res.json({ ok: true, userId: result.userId, vence: result.expiresAt });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Config ML (reservas locales) ────────────────────────────────────────────

  // Búsqueda de SKUs del catálogo WC para el autocomplete.
  // ?tipo=all incluye productos simples además de variaciones (para el resolver de faltantes).
  router.get('/buscar-sku', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, data: [] });
    const like = `%${q}%`;
    const soloVar = req.query.tipo !== 'all';
    const rows = db.prepare(`
      SELECT sku, nombre, stock, tipo FROM catalogo_cache
      WHERE (sku LIKE ? OR nombre LIKE ?) AND sku <> ''
      ${soloVar ? "AND tipo = 'variation'" : ''}
      ORDER BY nombre ASC LIMIT 20
    `).all(like, like);
    res.json({ ok: true, data: rows });
  });

  // Lista de SKUs configurados
  router.get('/config-ml', (req, res) => {
    // Mismo dedup que COMPUTED_STOCK_CTE (más arriba): sin esto, un SKU cargado en más de
    // un producto de WooCommerce aparecería duplicado acá con distinto stock_wc, confundiendo
    // al operador justo cuando está diagnosticando ese problema de datos.
    const rows = db.prepare(`
      WITH catalogo_dedup AS (
        SELECT sku, stock,
          ROW_NUMBER() OVER (PARTITION BY sku ORDER BY stock ASC, id_woo ASC) AS rn
        FROM catalogo_cache
        WHERE sku IS NOT NULL AND sku <> ''
      )
      SELECT s.sku, s.nombre, s.modo, s.reserva, s.actualizado_en,
        COALESCE(c.stock, 0) AS stock_wc,
        CASE
          WHEN s.modo = 'solo_local' THEN 0
          WHEN s.modo = 'reserva' THEN MAX(COALESCE(c.stock, 0) - s.reserva, 0)
          ELSE MAX(COALESCE(c.stock, 0), 0)
        END AS stock_disponible_ml
      FROM skus_config_ml s
      LEFT JOIN catalogo_dedup c ON c.sku = s.sku AND c.rn = 1
      ORDER BY s.actualizado_en DESC
    `).all();
    res.json({ ok: true, data: rows });
  });

  // Guardar / actualizar config de un SKU
  router.post('/config-ml', (req, res) => {
    const { sku, modo, reserva, nombre } = req.body || {};
    if (!sku || !['solo_local', 'reserva'].includes(modo)) {
      return res.status(400).json({ ok: false, error: 'sku y modo (solo_local|reserva) requeridos' });
    }
    const reservaVal = modo === 'reserva' ? Math.max(0, parseInt(reserva) || 0) : 0;

    // Obtener nombre del catalogo si no viene en el body
    const catalogoNombre = nombre || db.prepare('SELECT nombre FROM catalogo_cache WHERE sku = ?').get(sku)?.nombre || sku;

    db.prepare(`
      INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sku) DO UPDATE SET
        nombre = excluded.nombre,
        modo = excluded.modo,
        reserva = excluded.reserva,
        actualizado_en = excluded.actualizado_en
    `).run(sku, catalogoNombre, modo, reservaVal, now());

    res.json({ ok: true });
  });

  // Eliminar config de un SKU (vuelve a sincronizar normal)
  router.delete('/config-ml/:sku', (req, res) => {
    const sku = req.params.sku;
    db.prepare('DELETE FROM skus_config_ml WHERE sku = ?').run(sku);
    res.json({ ok: true });
  });

  return router;
}
