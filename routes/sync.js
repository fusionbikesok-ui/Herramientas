/**
 * Sincronización bidireccional WooCommerce ↔ MercadoLibre.
 *
 * syncMlToWc: pull de órdenes pagadas ML → descuenta stock en WC
 * syncWcToMl: push de diffs de stock WC → actualiza available_quantity en ML
 * procesarReintentos: reprocesa sync_log con estado='error' (máx MAX_RETRIES intentos)
 * syncRouter: Express Router con endpoints manuales de control
 */

import { Router } from 'express';
import { mlFetch, bootstrapToken, estadoCooldownMl, estadoErroresMl } from '../lib/mlClient.js';
import { skuDesdeMl, publicacionesDesdeWc, descartarVariacionMuerta } from '../lib/mlMapeo.js';
import { buscarEnCache } from '../lib/wooStock.js';
import { wooFetch } from './woo.js';
import { netoMl, veredictoNeto, precioWebClave, precioContado, totalContado } from '../lib/mlPrecios.js';
import { senalesDeVinculo } from '../lib/vinculosSenales.js';
import { norm, tsr } from '../lib/matcherEngine.js';
import { partirClaveMl, extraerErrorMl } from '../lib/mlUtil.js';
import { normalizarOrdenMl, billingWcDesdeOrdenMl } from '../lib/modelos/ordenVenta.js';
import { mapConLimite } from '../lib/concurrencia.js';
import { armarLike } from '../lib/busqueda.js';
import { parseCategorias } from '../lib/modelos/producto.js';
import { retenerPedidoMl, pedidoMlRetenido } from '../lib/guardiaMl.js';

const ML_AUTH_URL = 'https://auth.mercadolibre.com.ar/authorization';
// ML exige un dominio https real (rechaza localhost en el panel de la app).
// Se usa una ruta que no existe en el WordPress (da 404, sin confundir con
// contenido real del sitio) solo como destino válido — el bootstrap OAuth es
// manual: se copia el ?code= de la barra de direcciones después de autorizar.
const REDIRECT_URI = 'https://fusionbikes.com.ar/oauth-mercadolibre';
const MAX_RETRIES = 5;
// Margen hacia atras al acotar por fecha la busqueda de verificacion en Woo: cubre desfases
// de reloj entre este server y Woo, y el tiempo que Woo pudo tardar en persistir el pedido.
const VERIF_WC_MARGEN_MS = 15 * 60 * 1000;
// Tope de paginas al barrer pedidos de Woo en la verificacion (100 por pagina).
const VERIF_WC_MAX_PAGINAS = 20;
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

// Tope de LLAMADAS A ML (no de filas leídas) por corrida de _syncWcToMl (revisor, M3
// 2026-08-07; corregido a "tope por trabajo hecho" en la ronda 2, B1 revisor). Antes del
// write-back de status de reconciliarStockMl, syncWcToMl saltea cualquier item cuyo status en
// caché no sea 'active' — con ~1255 filas recién alineadas de 'paused' a 'active' tras el
// primer barrido (más ~1061 sin ml_stock_estado todavía), el bucle de diffs pasa de saltear
// casi todo a entrarle a una masa grande de golpe. Sin tope, 600-1200 diffs × ML_CALL_DELAY_MS
// encadenados con el cron cada 10 min (candado _wcToMlEnCurso evita solape pero no acota
// duración) reproduce el patrón del incidente de 429 del 2026-08-04.
//
// BUG real (B1, ronda 2 revisor): un `LIMIT` sobre la QUERY de diffs (filas leídas) en vez de
// sobre las llamadas a ML puede quedar monopolizado para siempre por filas que nunca se
// procesan: "procesar" una fila solo envejece `ml_stock_estado.actualizado_en` en el camino
// feliz (PUT 200). Todo salteo (status no-active, status desconocido, item bloqueado por
// límite de fotos —condición PERMANENTE—, cualquier HTTP≠200, cualquier excepción) deja el
// timestamp intacto. Una publicación pausada de verdad y sin fila en `ml_stock_estado` tiene
// `cantidad_ml IS NULL` (entra siempre a `diffs`) y `ml_stock_actualizado_en NULL` (va PRIMERA
// en el orden): con 200+ filas así al frente de la cola, cada corrida consumía el tope entero
// en `continue` instantáneos (sin `sleep`, que queda salteado por el `continue`) sin empujar
// un solo stock real — el sync quedaba muerto en silencio, sin error ni log.
//
// Por eso el tope ahora cuenta LLAMADAS a ML (el GET de status de fallback + el PUT de stock):
// los skips no cuestan llamada ni tiempo, así que no consumen presupuesto y no pueden clavar
// la corrida. La query de diffs ya NO tiene LIMIT — el corte lo hace el `break` del bucle. El
// ORDER BY se mantiene (más viejo primero) para que, con más llamadas disponibles que tope, el
// corte rote entre corridas y no favorezca siempre a las mismas claves.
const SYNC_WC_ML_MAX_LLAMADAS_ML_POR_CORRIDA = 200;

// ── reconciliarStockMl: constantes ──────────────────────────────────────────
// Tamaño del lote por corrida del cursor (8 multiget de a 20). Con un cron cada 10 min
// el barrido completo tarda ~2h53m. MEDIDO contra la base el 2026-08-07 tras sacar el
// filtro de status del universo (caso Starvos: publicaciones activas en ML que la caché,
// refrescada solo a mano, tenía como pausadas — ver docs/superpowers/plans/
// 2026-08-07-universo-reconciliacion-status.md): el universo pasó de 1358 a 2595 filas
// (1340 con status='active' en caché + 1255 'paused'), de las cuales 1061 no tenían fila
// en ml_stock_estado todavía. El barrido se duplica en tiempo (2h16m → ~4h20m con lote 100),
// por eso el lote sube de 100 a 150: ~8 multiget espaciados 1500ms = ~12s por corrida.
const RECONCILIACION_LOTE = 150;
const RECONCILIACION_MULTIGET_CHUNK = 20;
// MEDIDO el 2026-08-06 (no estimado): ML devuelve 429 tras 2-3 multiget consecutivos SIN
// pausa entre ellos — muy por debajo de los 1500 rpm documentados en lib/mlLimites.js. Con
// ~1,5-2s entre chunks el barrido pasa limpio. Por eso acá el multiget va EN SERIE (no con
// mapConLimite como evaluarPreciosReactivables) con esta pausa explícita: el espaciado no es
// cosmético, es lo que evita el 429.
const RECONCILIACION_PAUSA_CHUNK_MS = 1500;

// MEDIDO el 2026-08-07: 108 corridas seguidas cortadas por 429 en el PRIMER chunk pese a que
// el cooldown estaba libre justo antes de arrancar (429 intermitente real de ML, cuota
// compartida fuera de nuestro control — ver lib/mlLimites.js). Cortar la corrida entera
// perdía el ciclo de 10 min completo. Un único reintento tras esperar a que expire el
// cooldown (estadoCooldownMl().hasta) recupera esas corridas sin pegarle más a ML: la
// llamada reintentada es la misma que se iba a hacer en el ciclo siguiente, no una de más.
// Tope de espera (m1): un cooldown de nivel alto (escala 60s/120s/.../10min en
// lib/mlClient.js) significa que ML está rechazando en serio, no un blip — ahí conviene
// cortar como antes y dejar que la corrida siguiente (10 min después) reintente sola, no
// bloquear ESTA corrida (y el candado _reconciliarStockEnCurso que la acompaña) más de lo
// razonable. 90s es bien menor a los 10 min entre corridas, así que nunca se solapa con el
// tick siguiente.
// OJO (revisor #5): esta espera rompe, para esta única llamada, el aislamiento por minuto que
// server.js separa a propósito entre los crons ML (ver comentario ahí, ":09" para evitar varios
// jobs pegándole a ML de golpe). Con hasta 90s de espera el reintento puede caer dentro de la
// ventana de otro cron ML (ej. */10 en :10). Impacto acotado (una sola llamada de más, no un
// job entero), pero la premisa de "cada job tiene su minuto" deja de ser estrictamente cierta
// mientras dura este reintento — que quede escrito acá para no descubrirlo recién en el
// próximo incidente de cuota.
const RECONCILIACION_ESPERA_MAX_COOLDOWN_MS = 90_000;
// Margen chico sobre el `hasta` del cooldown para no reintentar en el instante exacto en que
// vence (jitter/relojes) y volver a comerse el mismo 429.
const RECONCILIACION_MARGEN_COOLDOWN_MS = 500;

// ─── helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function now() {
  return new Date().toISOString();
}

// Exportado: lo reusa routes/cobertura.js (Matcher unificado, entrega 1) para reasignar/
// desvincular vínculos desde su propia superficie, sin duplicar el statement de sync_log.
// Umbral de la guarda de coherencia, MEDIDO sobre datos reales (2026-08-15), no elegido a ojo.
// Primero probé "alcanza una palabra en común" y la medición lo tiró abajo: el caso real que
// motivó todo esto —"Casco Crazy Safety Azul Niños" vinculado a "Casco Rembrandt Para Niños"—
// comparte "casco" y "niños", así que pasaba la guarda igual. Palabras de categoría, no de
// producto.
//
// Con la similitud del motor (`tsr`, la misma que usa el Matcher) sobre las 54 ventas reales
// que este cambio recupera, la separación es limpia:
//   0.537  ← el caso mal vinculado (el único que hay que frenar)
//   0.602  ← el siguiente más bajo, y es un vínculo CORRECTO ("Soporte Ciclocomputador
//            Igpsport M80" ↔ "Soporte Para Gps Frontal Delantero Igpsport")
// 0.57 cae en el medio de ese hueco: frena 1 de 54 y deja pasar las 53 correctas.
//
// Contraste contra los 2658 vínculos ya hechos y revisados por una persona: la mediana da
// 0.900 y el percentil 1 da 0.554, así que este umbral marcaría ~1,5% de ellos. El costo de
// un falso positivo es no descontar stock y avisar — que es exactamente lo que pasa HOY en el
// 100% de estos casos. El error va siempre hacia el lado seguro.
const UMBRAL_COHERENCIA_SKU_ML = 0.57;

/**
 * ¿El título de la publicación de ML y el nombre del producto de WC hablan del mismo
 * producto? No es un matcher —para eso está `lib/matcherEngine.js`, con sus tokens
 * discriminantes y sus niveles de confianza—: es una guarda contra el caso grosero de que el
 * SKU cargado a mano en una publicación apunte a otro producto.
 */
export function titulosCompatibles(tituloMl, nombreWc) {
  if (!tituloMl || !nombreWc) return false; // sin dato no se afirma compatibilidad
  return tsr(norm(tituloMl), norm(nombreWc)) >= UMBRAL_COHERENCIA_SKU_ML;
}

export function logSync(db, { direccion, clave, sku, cantAnterior, cantNueva, estado, error, intentos = 0 }) {
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
      e.cantidad_ml, e.actualizado_en AS ml_stock_actualizado_en
    FROM sku_matcher_decisiones d
    JOIN catalogo_dedup c ON c.sku = d.sku AND c.rn = 1
    LEFT JOIN ml_stock_estado e ON e.clave = d.clave
      LEFT JOIN skus_config_ml cfg ON cfg.sku = d.sku
      LEFT JOIN guardia_ml_casos gm ON gm.clave = d.clave AND gm.estado != 'resuelto' AND gm.bloquea_sync = 1
      WHERE d.accion IN ('asignar','confirmar') AND gm.id IS NULL
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

  // Avanzar cursor. El WHERE del ON CONFLICT lo hace monótono en SQL (hallazgo del revisor,
  // A.3): este barrido puede tardar minutos (paginado + Woo + shipments) leyendo `desde` al
  // empezar; si mientras tanto syncOrdenMlPuntual ya avanzó el cursor a una orden más nueva
  // (llegó por webhook durante la corrida), este UPDATE incondicional lo haría retroceder.
  // Comparando contra el valor ACTUAL en la tabla (no contra `desde`, que es una copia vieja)
  // nunca se pisa un valor más nuevo ya guardado por el otro camino.
  if (ultimaFecha > desde) {
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('ultima_orden_ml', ?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
        WHERE excluded.valor > sync_estado.valor
    `).run(ultimaFecha, now());
  }
}

/**
 * A.3 — Procesa UNA orden ML puntual (por el `resource` de un webhook), sin el barrido
 * paginado de `/orders/search`. `_procesarOrden` es agnóstico al origen del objeto orden
 * (mismo shape venga de `/orders/search` o de un GET puntual a `/orders/{id}`), así que no
 * hace falta tocar su firma ni su idempotencia.
 *
 * El barrido paginado completo (`syncMlToWc`, cron cada 10 min) queda como respaldo sin
 * tocar: si este camino puntual falla o no llega, la orden igual se procesa en la corrida
 * siguiente del cron. No toma el candado `_mlToWcEnCurso` — no compite por él a propósito:
 * la idempotencia real está en `ordenes_ml_procesadas` (chequeada acá) y, sobre todo, en el
 * `INSERT` de reserva contra la PK `ml_order_id` que hace `_procesarOrden` antes de escribir
 * a Woo (más abajo en este archivo, no el `SELECT` de pre-chequeo que hay antes — ese es solo
 * una optimización barata, no la garantía real). Ese `INSERT` es lo que de verdad impide que
 * una corrida puntual y el barrido paginado dupliquen un pedido si coinciden en el tiempo
 * (mismo criterio que `syncPedidoMlPuntual`/`syncPedidoWebPuntual` de A.1, que tampoco toman
 * ningún candado).
 *
 * Fail-open: nunca tira, solo loguea — un error acá no debe tirar abajo el handler del
 * webhook (que ya respondió 200 antes de llamar a esto).
 */
export async function syncOrdenMlPuntual(db, cfg, mlOrderId) {
  const { ml: mlCfg, woo: wooCfg } = cfg;
  if (!mlCfgOk(cfg)) return { omitido: true };
  if (!mlOrderId) return { omitido: true, motivo: 'sin_order_id' };

  const yaProc = db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id = ?').get(String(mlOrderId));
  if (yaProc) return { omitido: true, motivo: 'ya_procesada' };

  try {
    const resp = await mlFetch(db, mlCfg, 'get', `/orders/${mlOrderId}`);
    if (resp.status !== 200) {
      console.error(`syncOrdenMlPuntual: error API ML ${resp.status} para orden ${mlOrderId} — la retoma el cron`);
      return { omitido: true, motivo: `http_${resp.status}` };
    }
    const orden = resp.data;
    // Mismo filtro que el barrido paginado (`order.status=paid` en el query string de
    // _syncMlToWc, línea ~271) y que el camino puntual hermano de A.1
    // (syncPedidoMlPuntual, routes/preparacion.js:2229). El barrido lo aplicaba en el query
    // string, así que nunca hacía falta chequearlo en _procesarOrden — al reemplazarlo por un
    // GET puntual (que trae la orden sea cual sea su estado) hay que chequearlo acá. Sin
    // esto, una orden en payment_required/payment_in_process (pago con ticket/transferencia
    // pendiente de acreditar) crearía el pedido en Woo y descontaría stock de una venta que
    // puede no concretarse nunca — y quedaría sellada en ordenes_ml_procesadas, así que el
    // cron tampoco la reprocesaría cuando sí pase a 'paid'.
    if (orden.status !== 'paid') {
      return { omitido: true, motivo: `status_${orden.status}` };
    }
    await _procesarOrden(db, wooCfg, mlCfg, orden);
    // Avanzar el cursor del barrido paginado (mismo campo que actualiza _syncMlToWc, línea
    // ~301): sin esto, con el camino puntual sellando la mayoría de las órdenes recientes en
    // ordenes_ml_procesadas antes de que corra el cron, `_syncMlToWc` nunca encuentra una
    // orden "nueva" que hacer avanzar el cursor (su `continue` por yaProc corta ANTES de
    // tocar ultimaFecha) — el barrido de respaldo terminaría re-paginando una ventana cada
    // vez más vieja en cada corrida, sin límite.
    //
    // Solo si la orden quedó SELLADA en ordenes_ml_procesadas (hallazgo del revisor):
    // _procesarOrden puede retornar sin sellar (reserva retenida fail-closed, o liberada para
    // reintento — ver sus comentarios más abajo) cuando algo falló a mitad de camino. Avanzar
    // el cursor igual sacaría esa orden de la ventana del barrido de respaldo apenas llegue
    // una más nueva, perdiéndola en silencio en vez de dejar que el cron la reintente.
    const sellada = db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id = ?').get(String(mlOrderId));
    if (sellada && orden.date_created) {
      const cursorRow = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'ultima_orden_ml'").get();
      if (!cursorRow || orden.date_created > cursorRow.valor) {
        // El WHERE hace el avance monótono también en SQL (mismo criterio que _syncMlToWc):
        // red de seguridad ante otra carrera con el barrido, no solo el chequeo de JS de arriba.
        db.prepare(`
          INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('ultima_orden_ml', ?, ?)
          ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
            WHERE excluded.valor > sync_estado.valor
        `).run(orden.date_created, now());
      }
    }
    return { omitido: false };
  } catch (e) {
    console.error(`syncOrdenMlPuntual: excepción procesando orden ${mlOrderId} — la retoma el cron:`, e.message);
    return { omitido: true, motivo: 'excepcion' };
  }
}

// Backoff simple para la verificacion post-timeout contra Woo (sin libreria de
// resiliencia: es un solo proceso con trafico bajo). 3 reintentos crecientes.
const VERIF_WC_BACKOFF_MS = [500, 1500, 4000];

/**
 * Busca en WooCommerce un pedido con meta `_ml_order_id = orderId`, entre los creados
 * desde `desdeIso` (menos un margen). Devuelve el wc_order_id si existe, null si con
 * certeza no existe, y LANZA si no se pudo verificar -> el llamador decide fail-closed.
 *
 * `meta_key`/`meta_value` no son filtros soportados por el core de WooCommerce en
 * /orders: Woo los ignora y devuelve igual la pagina de pedidos mas recientes. Por eso
 * la busqueda real es: acotar por `after` (fecha de la reserva) y PAGINAR hasta agotar
 * ese rango, verificando `meta_data` localmente en cada pedido. Sin paginar, con mas de
 * 100 pedidos nuevos en la ventana el pedido creado no aparecia -> falso negativo ->
 * duplicado, justo lo que este fix evita.
 *
 * `dates_are_gmt=true` es OBLIGATORIO: sin ese parametro Woo interpreta `after` en la
 * hora LOCAL del sitio (incidente 2026-07-29, pedidos 66554/66555). Con el sitio en
 * UTC-3, mandar `after` en UTC equivale a pedir "3 horas en el futuro": Woo devolvia 0
 * pedidos, la verificacion lo leia como certeza de inexistencia, liberaba la reserva y
 * el siguiente ciclo del cron creaba el pedido DUPLICADO.
 */
function _matchMlOrderId(pedidos, orderId) {
  // El meta se re-verifica localmente porque Woo pudo haber ignorado el filtro por meta:
  // asi un filtro ignorado nunca produce un falso positivo (seria peor: daria por creado
  // un pedido inexistente y la venta de ML nunca llegaria a Woo).
  return pedidos.find(pedido =>
    (pedido?.meta_data ?? []).some(m => m?.key === '_ml_order_id' && String(m?.value) === String(orderId))
  );
}

/**
 * Ultimo control antes de afirmar "el pedido con certeza NO existe" (afirmacion que libera
 * la reserva y habilita que el proximo ciclo del cron cree el pedido).
 *
 * Existe porque la busqueda principal esta acotada por fecha, y CUALQUIER defecto en ese
 * filtro -zona horaria mal interpretada (incidente 2026-07-29), desfase de reloj, lag de
 * indexacion/cache de Woo que todavia no muestra el pedido recien creado- se manifiesta
 * como un falso negativo indistinguible de una ventana legitimamente vacia. Por eso NO
 * alcanza con cubrir el caso "0 pedidos": un rango con 7 pedidos legitimos pero sin el
 * nuestro produce exactamente el mismo duplicado. Se re-consulta sin filtro de fecha.
 *
 * `orderby=date&order=desc` va explicito a proposito: la correctitud depende de que el
 * pedido recien creado este en la primera pagina. Es el default de WC hoy, pero un plugin
 * o un cambio de version que lo altere convertiria esta red en decorativa (devolveria los
 * 100 pedidos mas viejos) sin que nada falle a la vista.
 *
 * Devuelve el wc_order_id si aparece, null si la inexistencia se confirma, y LANZA si no
 * se pudo verificar -> fail-closed en el llamador.
 */
async function _confirmarInexistenciaEnWc(wooCfg, orderId) {
  // `status=any` en Woo NO incluye `trash`, y esa exclusion importa acá: cuando el sistema
  // crea un duplicado, el operador lo manda a la papelera a mano (paso lo del incidente
  // 2026-07-25). Si un pedido en papelera contara como inexistente, el cron lo volveria a
  // crear y el duplicado reapareceria despues de cada limpieza. Se consultan ambos.
  for (const status of ['any', 'trash']) {
    const resp = await wooFetch(
      wooCfg,
      `/orders?per_page=100&status=${status}&orderby=date&order=desc&page=1`
    );
    if (!Array.isArray(resp?.data)) {
      throw new Error('respuesta de Woo con forma inesperada al reverificar sin filtro de fecha');
    }
    const match = _matchMlOrderId(resp.data, orderId);
    if (match) return match.id;
  }
  return null;
}

async function buscarPedidoWcPorMlOrderId(wooCfg, orderId, desdeIso) {
  const after = new Date(new Date(desdeIso).getTime() - VERIF_WC_MARGEN_MS).toISOString();
  let ultimoError;

  for (let intento = 0; intento <= VERIF_WC_BACKOFF_MS.length; intento++) {
    if (intento > 0) await sleep(VERIF_WC_BACKOFF_MS[intento - 1]);
    try {
      for (let page = 1; page <= VERIF_WC_MAX_PAGINAS; page++) {
        const resp = await wooFetch(
          wooCfg,
          `/orders?per_page=100&status=any&page=${page}&dates_are_gmt=true&after=${encodeURIComponent(after)}&meta_key=_ml_order_id&meta_value=${encodeURIComponent(orderId)}`
        );
        if (!Array.isArray(resp?.data)) {
          // 200 con un cuerpo que no es lista (HTML de un WAF, error de plugin, etc.):
          // NO es certeza de inexistencia. Se trata como no concluyente -> fail-closed.
          throw new Error('respuesta de Woo con forma inesperada al verificar el pedido');
        }
        const pedidos = resp.data;
        const match = _matchMlOrderId(pedidos, orderId);
        if (match) return match.id;
        if (pedidos.length < 100) {
          // Rango agotado. NO se concluye inexistencia directo: todo camino que devuelve
          // null pasa antes por la red de seguridad (ver _confirmarInexistenciaEnWc).
          const idReverificado = await _confirmarInexistenciaEnWc(wooCfg, orderId);
          return idReverificado ?? null;
        }
      }
      // Se agotaron las paginas sin encontrarlo y sin agotar el rango: no concluyente.
      throw new Error('demasiados pedidos en el rango, verificacion no concluyente');
    } catch (e) {
      ultimoError = e;
    }
  }
  throw ultimoError ?? new Error('verificacion en Woo fallo');
}

/**
 * (#5) Un error 4xx (salvo 429) significa que la request LLEGO a Woo y Woo la rechazo:
 * no se creo ningun pedido, no hace falta verificar y la reserva se libera directo. Solo
 * los timeouts / errores de red / 5xx / 429 dejan dudas sobre si el pedido se creo.
 */
function requiereVerificacionWc(e) {
  const m = /WooCommerce API error (\d+)/.exec(e?.message ?? '');
  if (!m) return true; // error de red o timeout: la request pudo haber llegado igual
  const status = Number(m[1]);
  return status === 429 || status >= 500;
}

async function _procesarOrden(db, wooCfg, mlCfg, orden) {
  const orderId = String(orden.id);
  const items = orden.order_items ?? [];
  // La Guardia ya conserva esta venta; esperar una liberación humana evita
  // reintentos, reservas o efectos laterales en Woo en cada ciclo.
  if (pedidoMlRetenido(db, orderId)) return;
  let algunSinMapeo = false;

  // Reservas abandonadas (proceso murió entre reservar y confirmar/liberar, ej: kill -9)
  // no deben bloquear la orden para siempre. Umbral generoso (60min, muy por encima de
  // cualquier operación real a Woo/ML) a propósito: un umbral corto puede confundir un
  // proceso vivo pero lento (Woo lenta, reintentos) con uno muerto, y liberar su reserva
  // mientras sigue trabajando — eso reintroduce el duplicado que este fix corrige.
  // `retenido_en IS NULL` distingue una reserva abandonada (proceso muerto) de una
  // retenida a proposito por fail-closed tras un POST no verificable: esa ultima NO debe
  // liberarse sola nunca — liberarla es exactamente el duplicado que este fix evita.
  db.prepare(`
    DELETE FROM ordenes_ml_wc_pedidos
    WHERE ml_order_id = ? AND wc_order_id = 0 AND retenido_en IS NULL AND creado_en < ?
  `).run(orderId, new Date(Date.now() - 60 * 60 * 1000).toISOString());

  // Idempotencia: si ya se creó el pedido en WC para esta orden ML, no reprocesar.
  // OJO con `retenido_en`: una reserva retenida por fail-closed (wc_order_id=0) NO cuenta
  // como "ya creado". Si contara, la orden se sellaria abajo como 'ok' en
  // ordenes_ml_procesadas y, si el pedido en realidad nunca se creo en Woo, la venta de ML
  // se perderia en silencio (el panel filtra wc_order_id<>0 y procesarCancelacionesMl la
  // saltea). Excluida acá, cae en el INSERT de reserva de más abajo, que falla por PK y
  // corta sin sellar nada: la orden queda visible como reserva retenida hasta que un
  // humano la resuelva.
  const yaCreado = db.prepare(
    'SELECT 1 FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND (wc_order_id <> 0 OR retenido_en IS NULL)'
  ).get(orderId);
  if (yaCreado) {
    db.prepare(`
      INSERT OR IGNORE INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en)
      VALUES (?, ?, ?, 'ok', ?)
    `).run(orderId, orden.date_created ?? now(), JSON.stringify(items), now());
    return;
  }

  // Chequeo local barato ANTES de gastar una llamada a ML (2da pasada del revisor,
  // 2026-08-03): una orden con reserva RETENIDA por fail-closed nunca se sella en
  // ordenes_ml_procesadas a propósito, así que el cron (cada 3min) la retoma en cada ciclo
  // hasta que un humano la resuelva. Antes de mover shipments más arriba, esa repetición
  // salía por el fallo de PK del INSERT de la reserva sin ninguna llamada externa; ahora,
  // sin este corte, consultaría /shipments/{id} en CADA ciclo — una sola orden retenida
  // esperando intervención humana son ~480 llamadas/día desperdiciadas compitiendo por el
  // rate-limit de ML (el mismo problema que ya documentó procesarReintentos). Esta consulta
  // es la MISMA que ya hace el INSERT de más abajo (existe la fila, cualquiera sea su
  // estado) — no cambia ninguna semántica, solo evita la llamada a ML cuando ya sabemos que
  // esta corrida no va a llegar a reservar/crear nada.
  if (db.prepare('SELECT 1 FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(orderId)) {
    return;
  }

  // Envío/destinatario vía API de shipments de ML — dato accesorio, FAIL-OPEN a propósito
  // (decisión del usuario, 2026-08-03): si la consulta falla, tira error, o la orden no
  // tiene envío asociado, el pedido se crea igual sin estos datos. Perder la venta entera
  // por no poder resolver un dato accesorio sería peor que crearla incompleta.
  //
  // Se resuelve ACÁ, ANTES de la reserva atómica de abajo (hallazgo del revisor, 2026-08-03):
  // `mlFetch` tiene un timeout HTTP fijo de 20s (ML_HTTP_TIMEOUT_MS) y, ante un 429 activo,
  // ya no duerme — devuelve un 429 sintético al instante (ver lib/mlClient.js). Aun así, si
  // este await quedara DESPUÉS de reservar, la fila podría acercarse al umbral de 60min de
  // limpieza de reservas abandonadas de más arriba mientras el proceso sigue vivo, y otro
  // proceso la liberaría por error → duplicado. Poniéndolo antes, la ventana de la reserva no
  // crece nada: los datos igual entran en el mismo POST de abajo.
  let shipping;
  let metodoEnvio = null;
  if (orden.shipping?.id) {
    try {
      const shipResp = await mlFetch(db, mlCfg, 'get', `/shipments/${orden.shipping.id}`);
      // mlFetch usa validateStatus: () => true (nunca lanza por HTTP status) — un
      // 403/404/500 de ML llega acá como respuesta normal, no como excepción. Hay que
      // chequear el status a mano (mismo patrón que routes/preparacion.js) o un error de
      // ML pasaría desapercibido: el pedido se crearía sin destinatario y sin ningún rastro.
      if (shipResp.status !== 200) {
        throw new Error(`ML respondió ${shipResp.status} al consultar /shipments/${orden.shipping.id}`);
      }
      const ship = shipResp.data;
      const addr = ship?.receiver_address;
      // Solo se arma `shipping` si hay al menos un dato real (nombre o calle) — si no, un
      // objeto shipping vacío deja al pedido con una dirección "declarada" pero en blanco,
      // y la preparación/etiqueta muestra un destinatario vacío en vez de dejar clara la
      // ausencia del dato (hallazgo del revisor, 2026-08-03).
      if (addr && (addr.receiver_name || addr.street_name)) {
        // Woo espera first_name/last_name separados; receiver_name de ML viene junto. Se
        // parte por el primer espacio (mejor esfuerzo: "Juan Pérez" → first="Juan",
        // last="Pérez") en vez de mandar todo en first_name y dejar last_name vacío, que
        // rompe cualquier listado/etiqueta que dependa de last_name.
        const nombreCompleto = (addr.receiver_name || '').trim();
        const espacio = nombreCompleto.indexOf(' ');
        const firstName = espacio === -1 ? nombreCompleto : nombreCompleto.slice(0, espacio);
        const lastName = espacio === -1 ? '' : nombreCompleto.slice(espacio + 1);
        shipping = {
          first_name: firstName,
          last_name: lastName,
          address_1: [addr.street_name, addr.street_number].filter(Boolean).join(' '),
          address_2: [addr.comment, addr.floor ? `Piso ${addr.floor}` : '', addr.apartment]
            .filter(Boolean).join(' '),
          city: addr.city?.name || '',
          state: addr.state?.name || '',
          postcode: addr.zip_code || '',
          country: 'AR',
        };
      }
      metodoEnvio = ship?.logistic_type || ship?.shipping_option?.name || null;
    } catch (eShip) {
      // No aborta, no libera ni retiene la reserva: es solo un aviso para detectar el caso.
      logSync(db, {
        direccion: 'ml_wc', clave: orderId, estado: 'error',
        error: `No se pudo consultar el envío ML (fail-open, el pedido se crea igual sin esos datos): ${eShip.message}`,
      });
    }
  }

  // Reserva atómica de ml_order_id (ml_order_id es PRIMARY KEY): entre este chequeo y la
  // creación real del pedido en Woo hay varios `await` (precios, POST /orders) que ceden el
  // event loop. Si dos procesos corren este sync en paralelo (ver incidente 2026-07-25:
  // procesos huérfanos + el cron real corriendo a la vez), ambos pasaban el chequeo de
  // arriba antes de que ninguno insertara, y ambos terminaban creando un pedido duplicado en
  // WooCommerce. Reservar la fila ahora, antes de cualquier llamada a Woo, hace que el
  // segundo proceso pierda la carrera acá (INSERT falla por PK) en vez de después.
  const reservaCreadaEn = now();
  try {
    db.prepare(`
      INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en)
      VALUES (?, 0, NULL, ?)
    `).run(orderId, reservaCreadaEn);
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
  const clavesSinCobertura = [];
  for (const item of ov.items) {
    const skuVinculado = skuDesdeMl(db, item.item_id_ml, item.variation_id_ml);
    if (!skuVinculado || !buscarEnCache(db, skuVinculado)) clavesSinCobertura.push(item.clave);
  }
  if (clavesSinCobertura.length) {
    retenerPedidoMl(db, { orderId, items, claves: [...new Set(clavesSinCobertura)] });
    logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'retenido_guardia_ml', error: 'pedido ML sin vínculo exacto válido' });
    return;
  }
  const lineItems = [];
  for (const item of ov.items) {
    const itemId = item.item_id_ml;
    const varId = item.variation_id_ml;
    const qty = item.cantidad;
    const clave = item.clave;

    // El SKU sale primero de NUESTRO vínculo y, si no hay, del que la venta de ML ya trae
    // (`seller_sku`). Hasta el 2026-08-15 ese segundo camino no existía: si la publicación no
    // estaba vinculada acá, la venta se marcaba `sin_mapeo`, no se creaba el pedido en WC y el
    // stock NUNCA se descontaba — mientras la web (que alimenta el stock de ML) seguía
    // diciendo que había. Esa es la fábrica de sobreventas: medido sobre 60 días, 83 ventas
    // sin mapear, y 54 de ellas traían un SKU que SÍ existe en el catálogo. Casi una por día.
    // `routes/preparacion.js` ya usaba este fallback; el sync que crea el pedido no.
    let sku = skuDesdeMl(db, itemId, varId);
    const skuDeLaVenta = !sku && !!String(item.seller_sku || '').trim();
    if (skuDeLaVenta) sku = String(item.seller_sku).trim();
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

    // Guarda de coherencia, SOLO para el SKU que viene de ML (nuestro vínculo ya pasó por la
    // revisión de una persona). El SKU de la publicación lo puede haber cargado cualquiera a
    // mano en ML, y puede apuntar a otro producto: el 2026-08-14 se vendió un "Casco Crazy
    // Safety Azul" cuya publicación tenía el SKU de un "Casco Rembrandt Tigre Blanco". Sin
    // esta guarda, el fallback de arriba habría descontado el Rembrandt — cambiando una
    // sobreventa por un descuento del producto equivocado, que es peor porque no se nota.
    // Fail-closed: ante la duda no se descuenta y queda registrado para revisar.
    if (skuDeLaVenta) {
      // `buscarEnCache` no trae el nombre (solo ids y precios), y compararlo contra un
      // undefined daba SIEMPRE incompatible: la guarda frenaba todo, incluidas las 53 ventas
      // que este cambio viene a recuperar. Lo peor es que el test de la guarda pasaba igual
      // —por el motivo equivocado— y sin el test de contraste no se habría notado.
      const nombreWc = db.prepare("SELECT nombre FROM catalogo_cache WHERE sku = ? AND sku <> '' LIMIT 1").get(sku)?.nombre;
      if (!titulosCompatibles(item.nombre, nombreWc)) {
        algunSinMapeo = true;
        logSync(db, {
          direccion: 'ml_wc', clave, sku, estado: 'sku_incoherente',
          error: `el SKU ${sku} de la publicación apunta a "${nombreWc || '(sin nombre)'}", que no se parece a "${item.nombre}" — no se descontó stock`,
        });
        continue;
      }
    }

    // Decisión del usuario (2026-08-03): el pedido WC NO lleva el precio de venta de ML
    // (item.unit_price) como precio de línea — quiere el precio de CONTADO de la propia
    // web. `catalogo_cache.regular_price` es el precio de LISTA; precioContado() calcula el 2/3
    // real de contado/transferencia (ver lib/mlPrecios.js). Si se dejara que Woo pusiera
    // el precio solo con product_id/quantity, Woo aplicaría el de LISTA, no el de contado
    // — por eso hay que fijar subtotal/total a mano.
    // Fail-open a propósito (decisión explícita, no perder la venta por un dato de precio):
    // si el producto del caché no tiene precio, la línea se crea igual con product_id/
    // variation_id + quantity y SIN subtotal/total, para que Woo aplique el precio que
    // tiene registrado (de lista, no de contado) — mejor una línea con precio de lista que
    // ninguna venta registrada. NUNCA se cae al unit_price de ML en este camino.
    //
    // El contado SIEMPRE se calcula sobre el precio de LISTA (`regular_price`), NUNCA sobre
    // el vigente (`precio`): si el producto está en oferta, `precio` ya es el sale_price, y
    // aplicarle otro descuento de contado encima "acumularía" ambos. Hallazgo de la 2da
    // pasada del revisor (2026-08-03): el fallback `regular_price ?? precio` que hubo acá
    // violaba esa regla EN SILENCIO durante toda la ventana de transición entre el refresco
    // de catálogo (15min) y el de ventas (3min) — exactamente el caso real que la regla
    // existe para evitar, sin una sola línea en sync_log. Se sacó: si `regular_price` es
    // null (catálogo sin refrescar todavía, o directamente sin precio de lista cargado), la
    // línea cae en la MISMA rama fail-open que "sin precio en catalogo_cache" de abajo — sin
    // subtotal/total, para que Woo aplique el precio de lista que tiene cargado. Nunca
    // aplica un descuento sobre otro, nunca pierde la venta, reusa un camino ya testeado.
    // Doble redondeo (hallazgo del tester, 2026-08-03): precioContado() ya redondea el
    // UNITARIO a 2 decimales; multiplicarlo por qty y volver a redondear el total puede
    // desviarse hasta un centavo por unidad extra (regular_price=1000, qty=3 → unitario
    // redondeado 666.67 × 3 = 2000.01, cuando el total exacto es 2000.00). totalContado()
    // calcula el total sobre el precio de lista sin pasar por el unitario ya redondeado, y
    // redondea UNA sola vez, al final — ver JSDoc en lib/mlPrecios.js.
    const contado = precioContado(prod.regular_price); // solo para el chequeo de "hay precio"
    const total = totalContado(prod.regular_price, qty);

    const li = { quantity: qty };
    if (prod.tipo === 'variation' && prod.id_padre) {
      li.product_id = prod.id_padre;
      li.variation_id = prod.id_woo;
    } else {
      li.product_id = prod.id_woo;
    }
    if (contado != null && contado > 0) {
      // En Woo, subtotal y total de la línea son ambos el importe de la línea COMPLETA
      // (no el unitario) — los dos toman el mismo total ya redondeado una sola vez.
      // `.toFixed(2)` acá es solo formato de string (2 decimales fijos para la API), no un
      // segundo redondeo: `total` ya viene con precisión de 2 decimales desde totalContado().
      const totalStr = total.toFixed(2);
      li.subtotal = totalStr;
      li.total = totalStr;
    } else {
      // No marca algunSinMapeo: la línea SÍ se creó, solo sin precio de contado propio.
      // Se distingue el motivo (regular_price ausente vs. sin ningún precio) para poder
      // priorizar el refresco de catálogo si el aviso es el primero.
      const motivo = prod.regular_price == null
        ? 'catalogo_cache.regular_price (precio de LISTA) vacío — probablemente el catálogo no se refrescó desde que se agregó este campo'
        : 'catalogo_cache.regular_price es 0/inválido';
      logSync(db, {
        direccion: 'ml_wc', clave, sku, estado: 'error',
        error: `SKU sin precio de LISTA en catalogo_cache (${motivo}) — línea creada con el precio registrado en WC, no con el de contado`,
      });
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

  // Se replican los datos de envío en la facturación (ver comentario en
  // billingWcDesdeOrdenMl): las facturas de ML se emiten por otro medio, la facturación de
  // Woo acá no tiene consecuencia fiscal.
  const billing = billingWcDesdeOrdenMl(orden, shipping);

  // Datos informativos de la venta ML — nunca se usan como precio de línea (eso ya se
  // resolvió arriba con precioContado). "No inventar" aplica a los dos:
  // - precio pagado total: si ALGÚN unit_price vino null, no se suma un total parcial que
  //   parecería completo — se omite la meta entera. Además, ojo: este total es de la orden
  //   ML COMPLETA (todos los order_items), incluidos ítems sin mapeo/sin SKU en WC que no
  //   llegaron a lineItems — no es "lo que se facturó en este pedido WC".
  // - neto: sale_fee es la comisión de ML por order_item; hace falta que TODOS los items la
  //   tengan (no alcanza con que uno la tenga) para no mezclar neto real con bruto de otros
  //   ítems y presentar un neto sobreestimado como si fuera un dato confiable. Además
  //   (2da pasada del revisor, 2026-08-03): en el resto del repo la comisión de ML es POR
  //   UNIDAD (ver saleFeeMl en lib/mlPrecios.js, que consulta listing_prices con el precio
  //   UNITARIO) — no hay forma de confirmar ahora, sin una orden real con quantity>1, si
  //   `order_items[].sale_fee` viene también por unidad o ya multiplicado por la cantidad.
  //   Restando solo UN sale_fee de un total ×quantity subestimaría la comisión real en
  //   ítems con más de una unidad, presentando un neto inflado como dato duro. Criterio de
  //   "no inventar": si algún ítem tiene quantity>1, se omite la meta entera (mejor ausente
  //   que falsa) hasta poder confirmar la semántica exacta contra una orden real.
  const tienenUnitPrice = items.every(oi => oi.unit_price != null);
  const totalMlPagado = tienenUnitPrice
    ? items.reduce((acc, oi) => acc + oi.unit_price * (oi.quantity ?? 1), 0)
    : null;
  const tienenSaleFee = items.length > 0 && items.every(oi => oi.sale_fee != null);
  const soloCantidadUnitaria = items.every(oi => (oi.quantity ?? 1) <= 1);
  const netoMlTotal = (tienenSaleFee && soloCantidadUnitaria)
    ? items.reduce((acc, oi) => acc + (oi.unit_price ?? 0) * (oi.quantity ?? 1) - oi.sale_fee, 0)
    : null;

  const metaData = [{ key: '_ml_order_id', value: orderId }];
  if (totalMlPagado != null) metaData.push({ key: '_ml_precio_pagado_total', value: totalMlPagado.toFixed(2) });
  if (netoMlTotal != null) metaData.push({ key: '_ml_neto_estimado', value: netoMlTotal.toFixed(2) });
  if (metodoEnvio) metaData.push({ key: '_ml_metodo_envio', value: metodoEnvio });

  const linkVentaMl = `https://www.mercadolibre.com.ar/ventas/${orderId}/detalle`;
  const nicknameComprador = orden.buyer?.nickname ?? '';
  // Fecha en hora LOCAL (es-AR), no ISO crudo con milisegundos/Z: la lee una persona en el
  // admin de Woo, no un programa, y un ISO en UTC confunde la hora real (ver la memoria del
  // proyecto sobre Woo interpretando fechas). Si falta algún dato (fecha o nickname), se
  // omite esa parte entera de la nota en vez de dejar paréntesis/frases vacías.
  let fechaLocal = '';
  if (orden.date_created) {
    const d = new Date(orden.date_created);
    fechaLocal = Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  }
  const partesNota = [`Venta MercadoLibre #${orderId}`];
  if (fechaLocal) partesNota.push(`(${fechaLocal})`);
  if (nicknameComprador) partesNota.push(`— comprador: ${nicknameComprador}.`);
  partesNota.push(linkVentaMl);
  const notaPrivada = partesNota.join(' ');

  try {
    const resp = await wooFetch(wooCfg, '/orders', 'post', {
      status: 'mercadolibre',
      set_paid: true,
      line_items: lineItems,
      billing,
      ...(shipping ? { shipping } : {}),
      meta_data: metaData,
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

    // Nota PRIVADA del pedido (decisión del usuario, 2026-08-03): customer_note del POST de
    // creación la ve el cliente en la web y en los mails — se pasa a un recurso separado
    // (POST /orders/{id}/notes con customer_note:false) para que quede solo del lado admin.
    // No es una modificación del pedido (no viola la regla de "nada de PUT/PATCH": es un
    // POST a un sub-recurso de notas, no un UPDATE de la orden), y es FAIL-OPEN: el pedido
    // ya existe y no se toca, no se reintenta ni se retiene/libera la reserva por esto.
    try {
      await wooFetch(wooCfg, `/orders/${wcOrderId}/notes`, 'post', {
        note: notaPrivada, customer_note: false,
      });
    } catch (eNota) {
      logSync(db, {
        direccion: 'ml_wc', clave: orderId, estado: 'error',
        error: `No se pudo agregar la nota privada al pedido ${wcOrderId} (fail-open, el pedido queda creado igual): ${eNota.message}`,
      });
    }
  } catch (e) {
    // El POST pudo haber tenido EXITO en el servidor de Woo aunque la respuesta se haya
    // perdido del lado del cliente (timeout de 20s de wooFetch, corte de red). Liberar la
    // reserva sin mas haria que el proximo ciclo del cron reintente y cree un pedido
    // DUPLICADO real. Antes de liberar, se verifica contra la API de Woo si ya existe un
    // pedido con meta _ml_order_id.
    if (!requiereVerificacionWc(e)) {
      // Woo rechazo la request (4xx): no hay pedido creado, se libera sin verificar.
      db.prepare('DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND wc_order_id = 0').run(orderId);
      logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'error', error: e.message });
      return;
    }

    let wcExistente;
    try {
      wcExistente = await buscarPedidoWcPorMlOrderId(wooCfg, orderId, reservaCreadaEn);
    } catch (eVerif) {
      // FAIL-CLOSED: no se pudo verificar (Woo caida/inaccesible). NO se libera la reserva:
      // bloquear un reintento es preferible a arriesgar un pedido duplicado. Queda para
      // intervencion manual, que el panel de sync expone como "reservas retenidas":
      //   - si el pedido SI existe en Woo: UPDATE ordenes_ml_wc_pedidos SET wc_order_id=<id>,
      //     retenido_en=NULL WHERE ml_order_id=<orden>;
      //   - si NO existe: DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id=<orden>
      //     (alcanza con eso: la orden nunca se sella en ordenes_ml_procesadas mientras
      //     este retenida, asi que el proximo ciclo del cron la reintenta sola).
      db.prepare(
        'UPDATE ordenes_ml_wc_pedidos SET retenido_en = ? WHERE ml_order_id = ? AND wc_order_id = 0'
      ).run(now(), orderId);
      const msg = `POST /orders fallo (${e.message}) y la verificacion en Woo tambien fallo (${eVerif.message}) - reserva RETENIDA (fail-closed), revisar manualmente si el pedido existe en WooCommerce`;
      console.error(`syncMlToWc: orden ML ${orderId}: ${msg}`);
      logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'error', error: msg });
      return;
    }

    if (wcExistente) {
      // El pedido SI se habia creado en Woo: se completa la reserva con el id real (mismo
      // camino que el exito) en vez de dejar que el proximo ciclo cree un duplicado.
      db.prepare(`
        UPDATE ordenes_ml_wc_pedidos SET wc_order_id = ?, comprador_json = ?, retenido_en = NULL
        WHERE ml_order_id = ?
      `).run(wcExistente, JSON.stringify(orden.buyer ?? null), orderId);
      console.warn(`syncMlToWc: orden ML ${orderId}: el POST a Woo fallo (${e.message}) pero el pedido ${wcExistente} SI existe - reserva completada, sin duplicado.`);
      logSync(db, { direccion: 'ml_wc', clave: orderId, cantNueva: wcExistente, estado: 'ok', error: `respuesta perdida (${e.message}), pedido verificado en Woo` });
      db.prepare(`
        INSERT OR IGNORE INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en)
        VALUES (?, ?, ?, ?, ?)
      `).run(orderId, orden.date_created ?? now(), JSON.stringify(items), algunSinMapeo ? 'parcial' : 'ok', now());
      return;
    }

    // Verificacion concluyente: el pedido NO existe en Woo -> falla real. Se libera la
    // reserva y el proximo ciclo puede reintentar sin riesgo de duplicado.
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

// ─── syncSkuPuntual ──────────────────────────────────────────────────────────

// Backoff acotado a UN reintento (no 3 como el resto del repo): esta función corre
// síncrona dentro de un request HTTP de edición manual de stock (A.2), no en un cron
// de fondo — un reintento agresivo por SKU en un lote de 40 puede colgar la request
// minutos. Si falla tras el reintento, el cron periódico de syncWcToMl retoma (fail-open).
const SYNC_SKU_PUNTUAL_BACKOFF_MS = [800];

/**
 * Empuja a ML el diff de UNA clave (item+variación) puntual. No reintenta ante 429:
 * el cooldown es global por cuenta (mismo motivo por el que _syncWcToMl corta la
 * corrida entera ante 429, ver más abajo) — reintentar ahí solo quema el backoff sin
 * chance de éxito. Tampoco reintenta si no se pudo confirmar el status de la
 * publicación (igual que _syncWcToMl: se loguea y se sigue, no es recuperable
 * reintentando el mismo GET).
 */
async function _empujarClaveMl(db, mlCfg, sku, diff) {
  const { clave, stock_disponible_ml, cantidad_ml } = diff;
  const { itemId, variationId } = partirClaveMl(clave);
  const cantidad = Math.max(0, Math.round(stock_disponible_ml));

  let ultimoError = null;
  for (let intento = 0; intento <= SYNC_SKU_PUNTUAL_BACKOFF_MS.length; intento++) {
    if (intento > 0) await sleep(SYNC_SKU_PUNTUAL_BACKOFF_MS[intento - 1]);
    try {
      // Mismo patrón que _syncWcToMl: leer el status del cache primero (poblado por el
      // matcher) y solo hacer el GET a ML como fallback si no está cacheado. En el caso
      // común esto ahorra una llamada + el sleep(ML_CALL_DELAY_MS) por clave — con un
      // lote de 40 SKUs la diferencia es la request HTTP colgada minutos vs. segundos.
      let status;
      const cacheado = db.prepare('SELECT status FROM ml_publicaciones_cache WHERE item_id = ?').get(itemId);
      if (cacheado?.status) {
        status = cacheado.status;
      } else {
        const est = await mlFetch(db, mlCfg, 'get', `/items/${itemId}?attributes=status`);
        if (est.status === 429) {
          // Cooldown global por cuenta: no es un error de este push, es que ML está
          // limitando la cuenta entera — mismo criterio que _syncWcToMl (cortadoPor429):
          // no se intentó nada, se retoma solo en el próximo ciclo del cron.
          return { clave, estado: 'omitido', detalle: 'Cooldown activo en ML (429), lo retoma el cron' };
        }
        status = est.status === 200 ? est.data?.status ?? 'desconocido' : 'desconocido';
        await sleep(ML_CALL_DELAY_MS);
      }
      if (status === 'desconocido') {
        logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: cantidad_ml, cantNueva: cantidad, estado: 'error', error: 'No se pudo consultar el status de la publicación en ML' });
        return { clave, estado: 'error', detalle: 'No se pudo consultar el status de la publicación' };
      }
      if (status !== 'active') {
        return { clave, estado: 'sin_cambios', detalle: `Publicación ${status}, no se sincroniza` };
      }

      const { path, body } = buildMlStockUpdate(itemId, variationId, cantidad);
      const resp = await mlFetch(db, mlCfg, 'put', path, body);

      if (resp.status === 429) {
        return { clave, estado: 'omitido', detalle: 'Cooldown activo en ML (429) durante PUT, lo retoma el cron' };
      }
      if (resp.status === 200) {
        upsertMlStockEstado(db, clave, sku, cantidad);
        logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: cantidad_ml, cantNueva: cantidad, estado: 'ok' });
        return { clave, estado: 'sincronizado', detalle: `Stock actualizado: ${cantidad}` };
      }

      const causa = extraerErrorMl(resp, resp.data?.error || JSON.stringify(resp.data ?? {}));
      if (/doesn'?t have a variation/i.test(causa)) {
        descartarVariacionMuerta(db, clave, `Variación inexistente en ML: ${causa}`.slice(0, 200));
        logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: cantidad_ml, cantNueva: cantidad, estado: 'remapeo_requerido', error: causa.slice(0, 500) });
        return { clave, estado: 'error', detalle: `Remapeo requerido: ${causa}` };
      }
      if (/cannot exceeds? \d+ pictures/i.test(causa)) {
        logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: cantidad_ml, cantNueva: cantidad, estado: 'requiere_atencion_ml', error: causa.slice(0, 500) });
        return { clave, estado: 'error', detalle: `Publicación bloqueada en ML: ${causa}` };
      }
      // No se reintenta un HTTP de respuesta (4xx/5xx que ML SÍ contestó): no es un fallo
      // transitorio de red, es un rechazo — mismo criterio que _syncWcToMl, que loguea y
      // sigue sin reintentar. El caso típico es status stale en ml_publicaciones_cache
      // (activa en cache, pausada de verdad en ML): reintentar el mismo PUT repite el
      // mismo 400 sin chance de éxito, solo suma 800ms de latencia al operario. El único
      // reintento real es para excepciones de red/timeout (catch de abajo).
      ultimoError = `HTTP ${resp.status}: ${causa}`;
      logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: cantidad_ml, cantNueva: cantidad, estado: 'error', error: ultimoError.slice(0, 500) });
      return { clave, estado: 'error', detalle: ultimoError };
    } catch (e) {
      ultimoError = e.message;
      if (intento < SYNC_SKU_PUNTUAL_BACKOFF_MS.length) continue;
      logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: cantidad_ml, cantNueva: cantidad, estado: 'error', error: e.message });
      return { clave, estado: 'error', detalle: `Fallo tras reintento: ${e.message}` };
    }
  }
  return { clave, estado: 'error', detalle: ultimoError || 'Error desconocido' };
}

/**
 * Sincroniza el stock de un SKU puntual a MercadoLibre, disparado al guardar una
 * edición manual de stock (A.2 del plan). Busca TODOS los diffs pendientes de ese
 * SKU contra ML (un SKU puede tener más de una publicación/variación mapeada — un
 * `LIMIT 1` acá reportaría "sincronizado" habiendo dejado otra publicación con el
 * stock viejo) y empuja cada uno con `_empujarClaveMl`. Fail-open: no reemplaza al
 * cron `syncWcToMl`, que sigue de respaldo si esto falla.
 *
 * Lee `_wcToMlEnCurso` pero no lo toma (no se pone en `true` a sí mismo): si el cron
 * general YA está en curso al momento de esta llamada, el push puntual se omite (el
 * cron va a cubrir el mismo diff en su misma corrida, no hace falta duplicar la
 * llamada a ML). Si el cron arranca DESPUÉS de que este push ya empezó, se acepta la
 * ventana de carrera — el PUT de stock a ML es idempotente, así que el peor caso es
 * una llamada de más, no una escritura incorrecta.
 *
 * @returns {Promise<{sku, estado: 'sincronizado'|'sin_cambios'|'error'|'omitido', detalle}>}
 */
export async function syncSkuPuntual(db, cfg, sku) {
  const { ml: mlCfg } = cfg;

  if (!sku || typeof sku !== 'string') {
    return { sku, estado: 'error', detalle: 'SKU inválido' };
  }
  if (!mlCfgOk(cfg)) {
    return { sku, estado: 'omitido', detalle: 'ML no configurado' };
  }
  if (_wcToMlEnCurso) {
    return { sku, estado: 'omitido', detalle: 'Sync general de ML en curso, este SKU se cubre en esa corrida' };
  }

  const diffs = db.prepare(`
    ${COMPUTED_STOCK_CTE}
    SELECT * FROM computed
    WHERE sku = ?
      AND (cantidad_ml IS NULL OR cantidad_ml <> stock_disponible_ml)
  `).all(sku);

  if (diffs.length === 0) {
    return { sku, estado: 'sin_cambios', detalle: 'Sin cambios pendientes en ML' };
  }

  const resultados = [];
  for (const diff of diffs) {
    resultados.push(await _empujarClaveMl(db, mlCfg, sku, diff));
  }

  const errores = resultados.filter(r => r.estado === 'error');
  if (errores.length > 0) {
    return { sku, estado: 'error', detalle: errores.map(r => r.detalle).join('; ').slice(0, 400) };
  }
  const sincronizadas = resultados.filter(r => r.estado === 'sincronizado').length;
  if (sincronizadas === 0) {
    const omitidas = resultados.filter(r => r.estado === 'omitido').length;
    if (omitidas > 0) {
      // Al menos una quedó SIN INTENTAR (cooldown 429): no es "confirmado sin diff", es
      // "no se sabe todavía" — aunque otra clave del mismo SKU sí estuviera sin_cambios
      // de verdad, mezclarlo bajo 'sin_cambios' mentiría (ese estado significa "sin diff
      // pendiente en ML", y acá sigue habiendo un diff que ni se tocó).
      return { sku, estado: 'omitido', detalle: `${omitidas} publicación(es) pospuestas por cooldown de ML, las retoma el cron` };
    }
    const detalle = resultados.length > 1
      ? `${resultados.length} publicaciones sin cambios (${resultados.map(r => r.detalle).join('; ')})`.slice(0, 400)
      : resultados[0]?.detalle || 'Ninguna publicación activa para este SKU';
    return { sku, estado: 'sin_cambios', detalle };
  }
  return { sku, estado: 'sincronizado', detalle: `${sincronizadas}/${resultados.length} publicaciones actualizadas` };
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

// opts.maxLlamadas (m5, ronda 2 revisor): tope de llamadas a ML inyectable, default
// SYNC_WC_ML_MAX_LLAMADAS_ML_POR_CORRIDA. server.js y el router (routes/sync.js más abajo) lo
// llaman sin este tercer argumento (usan el default de producción); existe solo para que los
// tests puedan probar la propiedad "corta al llegar al tope" con un tope chico y pocas filas,
// en vez de escalar el costo del test con la carga de la suite real (~420 iteraciones con
// margen de timeout fijo, propenso a flaky). No cambia la firma que ya usan los callers reales.
export async function syncWcToMl(db, cfg, opts = {}) {
  if (!mlCfgOk(cfg)) return { omitido: true };
  // Ya hay una corrida en curso: se saltea. Se informa omitido:true (mismo criterio
  // que syncMlToWc) para que el caller no crea que sincronizó.
  if (_wcToMlEnCurso) return { omitido: true };
  _wcToMlEnCurso = true;
  try {
    await _syncWcToMl(db, cfg, opts);
    return { omitido: false };
  } finally {
    _wcToMlEnCurso = false;
  }
}

async function _syncWcToMl(db, cfg, opts = {}) {
  const { ml: mlCfg } = cfg;
  const maxLlamadas = opts.maxLlamadas ?? SYNC_WC_ML_MAX_LLAMADAS_ML_POR_CORRIDA;

  // JOIN para encontrar publicaciones ML cuyo stock disponible difiere del estado conocido.
  // LEFT JOIN skus_config_ml para aplicar reservas de unidades para local/web.
  // SIN LIMIT (B1, ronda 2 revisor — ver comentario de SYNC_WC_ML_MAX_LLAMADAS_ML_POR_CORRIDA
  // más arriba): un LIMIT acá tope filas leídas, no trabajo hecho, y podía quedar monopolizado
  // para siempre por filas que solo hacen `continue` (nunca "envejecen"). El corte real es el
  // `break` del bucle de abajo por llamadas a ML. El ORDER BY (más viejo primero, NULL —nunca
  // registrado— primero) se mantiene: sigue siendo útil para que ese corte rote entre corridas
  // y no favorezca siempre a las mismas claves cuando el backlog excede el tope de llamadas.
  const diffs = db.prepare(`
    ${COMPUTED_STOCK_CTE}
    SELECT * FROM computed
    WHERE cantidad_ml IS NULL OR cantidad_ml <> stock_disponible_ml
    ORDER BY ml_stock_actualizado_en IS NOT NULL, ml_stock_actualizado_en ASC
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
  // (manejado); si una activa figura pausada, se saltea, PERO el refresh de esa columna
  // ya no depende de que el usuario apriete el botón del matcher: reconciliarStockMl
  // (más abajo) reescribe status/sub_status con el dato vivo del multiget cada corrida
  // del cron ('9-59/10'), así que el caché queda alineado con ML a lo sumo cada ~3h (el
  // tiempo del barrido completo con RECONCILIACION_LOTE=150) — ventana máxima en la que
  // una activa puede quedar salteada acá antes de corregirse sola.
  const estadoItem = new Map();
  const itemsBloqueados = new Set();
  let cortadoPor429 = false;
  // Contador de LLAMADAS a ML hechas en esta corrida (B1, ronda 2 revisor): el GET de status
  // de fallback y el PUT de stock, cada uno suma 1 al hacerse. Los skips (status no-active,
  // bloqueado, etc.) NO suman — ver comentario de la constante más arriba.
  let llamadasMl = 0;
  let cortadoPorTope = false;
  try {
    const cacheStatus = db.prepare('SELECT DISTINCT item_id, status FROM ml_publicaciones_cache').all();
    for (const r of cacheStatus) {
      if (r.status && !estadoItem.has(r.item_id)) estadoItem.set(r.item_id, r.status);
    }
  } catch (_) { /* cache puede no existir todavía */ }

  for (const diff of diffs) {
    // Tope por LLAMADAS a ML, no por filas leídas (B1, ronda 2 revisor) — ver comentario de la
    // constante. Se chequea al INICIO de cada iteración, no dentro de ella: una iteración
    // puede gastar hasta 2 llamadas (GET de status de fallback + PUT de stock), así que el
    // tope puede excederse en 1 llamada como máximo — irrelevante contra el presupuesto.
    if (llamadasMl >= maxLlamadas) {
      cortadoPorTope = true;
      break;
    }

    const { clave, sku, stock_disponible_ml } = diff;
    const { itemId, variationId } = partirClaveMl(clave);
    const cantidad = Math.max(0, Math.round(stock_disponible_ml));

    try {
      if (!estadoItem.has(itemId)) {
        llamadasMl++;
        const est = await mlFetch(db, mlCfg, 'get', `/items/${itemId}?attributes=status`);
        if (est.status === 429) {
          // Cooldown global activo (real o sintético): TODAS las consultas de status que
          // falten en esta corrida van a devolver el mismo 429 — cortar el bucle entero en
          // vez de seguir recorriendo cientos de diffs haciendo `continue` en silencio, que
          // dejaba el stock de ML desincronizado sin ningún rastro. El próximo ciclo del
          // cron retoma desde el mismo `diffs` (no se pierde nada, solo se pospone).
          cortadoPor429 = true;
          break;
        }
        estadoItem.set(itemId, est.status === 200 ? est.data?.status ?? 'desconocido' : 'desconocido');
        await sleep(ML_CALL_DELAY_MS);
      }
      const status = estadoItem.get(itemId);
      if (status === 'desconocido') {
        // Fallo real de la consulta de status (no un 429 de cooldown, ya cortado arriba):
        // no se puede saber si está activa. Registrar en vez de saltear en silencio, para
        // que un problema persistente de esta publicación quede visible en el log de sync.
        logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: diff.cantidad_ml, cantNueva: cantidad, estado: 'error', error: 'No se pudo consultar el status de la publicación en ML' });
        continue;
      }
      if (status !== 'active') {
        // Publicación no activa (paused/closed/under_review): skip legítimo, sin error.
        continue;
      }
      if (status === 'active' && itemsBloqueados.has(itemId)) {
        // Ya se detectó en esta corrida que ML rechaza cualquier update de esta
        // publicación (ver más abajo). No repetir el intento por cada variación.
        continue;
      }

      const { path, body } = buildMlStockUpdate(itemId, variationId, cantidad);
      llamadasMl++;
      const resp = await mlFetch(db, mlCfg, 'put', path, body);

      if (resp.status === 429) {
        // Mismo cooldown detectado durante el PUT de stock (camino real: la mayoría de
        // los items ya tienen status en cache y llegan directo acá, nunca pasan por el
        // GET de arriba). Cortar igual que en el GET, sin loguear por clave: el diff no
        // se tocó (no hay error real, "no se intentó"), se retoma en el próximo ciclo.
        cortadoPor429 = true;
        break;
      }

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

  if (cortadoPor429) {
    // Un solo evento por corrida (no uno por clave pendiente): con cientos de diffs
    // encadenar cooldowns generaría cientos de filas de "error" que procesarReintentos
    // termina envejeciendo a 'agotado', perdiendo de pendientes diffs de stock válidos
    // por un rate limit transitorio. Esto es solo una traza informativa de la corte.
    logSync(db, { direccion: 'wc_ml', clave: null, sku: null, estado: 'info', error: 'Cooldown ML activo (429) — corte de corrida, se retoma en el próximo ciclo' });
  }
  if (cortadoPorTope) {
    // Traza informativa (B1, ronda 2 revisor): igual criterio que el corte por 429 — un solo
    // evento por corrida, no uno por diff restante. Distingue "cortó por tope normal (backlog
    // grande, se retoma la próxima corrida)" de "cortó por 429" en el log.
    logSync(db, { direccion: 'wc_ml', clave: null, sku: null, estado: 'info', error: `Tope de ${maxLlamadas} llamadas a ML alcanzado — corte de corrida, se retoma en el próximo ciclo` });
  }
}

// ─── reconciliarStockMl ──────────────────────────────────────────────────────
//
// Caso real que motivó esto (2026-08-06): syncWcToMl compara el stock deseado contra
// ml_stock_estado.cantidad_ml, que es lo que NOSOTROS recordamos haber empujado, no lo que
// ML tiene de verdad. La publicación MLA1117110786| (SKU FB-4501) quedó con cantidad_ml=0
// desde el 2026-07-17 mientras ML tenía 1 unidad activa y vendible: como deseado (0) ==
// recordado (0), el sync nunca la tocó. Tres semanas de sobreventa invisible, sin error ni
// log. Esta función abre los ojos: compara ml_stock_estado contra el valor REAL de ML y
// corrige el estado local en AMBOS sentidos (decisión del usuario 2026-08-06: si ML tiene de
// más se baja —sobreventa—, si tiene de menos se sube —recupera ventas perdidas por error—).
//
// CLAVE DEL DISEÑO: esta función NO escribe en ML. Solo corrige ml_stock_estado; la próxima
// corrida de syncWcToMl ve la diferencia contra el stock real de Woo y empuja la corrección
// por su camino ya probado (reintentos, 429, remapeo de variación muerta, etc. — todo eso
// sigue viviendo ahí, no se duplica acá). Esto mantiene el cambio acotado y reversible.

let _reconciliarStockEnCurso = false;

export async function reconciliarStockMl(db, cfg) {
  if (!mlCfgOk(cfg)) return { omitido: true, motivo: 'sin_config' };
  // Candado anti-solape en el mismo proceso, mismo patrón que _mlToWcEnCurso/_wcToMlEnCurso.
  if (_reconciliarStockEnCurso) return { omitido: true, motivo: 'en_curso' };
  _reconciliarStockEnCurso = true;
  try {
    return await _reconciliarStockMl(db, cfg);
  } finally {
    _reconciliarStockEnCurso = false;
  }
}

async function _reconciliarStockMl(db, cfg) {
  const { ml: mlCfg } = cfg;

  // Universo: TODAS las publicaciones con decisión de matcher (asignar/confirmar) que existan
  // en ml_publicaciones_cache. LEFT JOIN a ml_stock_estado (no INNER): una fila sin
  // ml_stock_estado todavía no tiene "recordado" contra qué comparar, pero igual entra al
  // universo para que el multiget de abajo la resuelva y la dé de alta con el valor REAL de ML
  // (ver más abajo el INSERT ON CONFLICT DO NOTHING). Orden estable por la clave de la decisión
  // (no por e.clave, que ahora puede venir NULL) para que el cursor tenga sentido entre corridas.
  //
  // IMPORTANTE 3 (revisor, reescrito 2026-08-07 — caso Starvos): el universo YA NO depende de
  // ml_publicaciones_cache.status. Esa columna solo se escribe a mano (cuando el usuario aprieta
  // "refrescar" en el matcher) o, desde este mismo cambio, la reescribe esta función con el dato
  // vivo del multiget — no hay ningún cron que la mantenga al día por su cuenta. Filtrar el
  // universo por ella era el bug real: cuatro publicaciones de Bontrager Starvos quedaron
  // 'paused_by_seller' en caché desde el 07-30 mientras estaban ACTIVAS y vendiendo en ML,
  // invisibles para la reconciliación hasta el próximo refresh manual que nunca llegó. El status
  // real de cada publicación lo resuelve el multiget de abajo (item.status !== 'active' → se
  // saltea sin tocar el stock, es lo correcto: una pausada de verdad no vende); acá arriba no se
  // filtra nada por status, se trae el universo entero de publicaciones mapeadas.
  const universo = db.prepare(`
    SELECT d.clave, COALESCE(e.sku, d.sku) AS sku, e.cantidad_ml
    FROM sku_matcher_decisiones d
    JOIN ml_publicaciones_cache p ON p.clave = d.clave
    LEFT JOIN ml_stock_estado e ON e.clave = d.clave
    WHERE d.accion IN ('asignar','confirmar')
    ORDER BY d.clave
  `).all();

  if (universo.length === 0) return { omitido: false, revisadas: 0, corregidas: 0, altas: 0, sinDato: 0, sinSku: 0, statusRefrescados: 0, esperasCooldown: 0 };

  // Cursor persistido en sync_estado. Si la clave guardada ya no está en el universo actual
  // (se desmapeó, se pausó y cayó del filtro, etc.) NO se reinicia a 0 en silencio: eso
  // dejaría el barrido dando vueltas eternas sobre las primeras posiciones si el universo
  // cambia seguido (hallazgo del revisor — pasa de verdad: el matcher recrea la caché y
  // reordena publicaciones a cada refresh). Como el universo está ordenado por clave, se
  // retoma en la primera clave lexicográficamente MAYOR a la del cursor; solo si no hay
  // ninguna (el cursor estaba al final del universo anterior) se cae a 0.
  const cursorRow = db.prepare("SELECT valor FROM sync_estado WHERE clave = 'cursor_reconciliacion_stock'").get();
  let desde = 0;
  if (cursorRow?.valor) {
    const idxExacto = universo.findIndex(r => r.clave === cursorRow.valor);
    if (idxExacto >= 0) {
      desde = idxExacto;
    } else {
      const idxSiguiente = universo.findIndex(r => r.clave > cursorRow.valor);
      desde = idxSiguiente >= 0 ? idxSiguiente : 0;
    }
  }

  // Lote circular: si el universo es más chico que RECONCILIACION_LOTE, el módulo hace que
  // el lote cubra el universo entero sin repetir de más (mismo criterio abajo al avanzar
  // el cursor). Da la vuelta solo al llegar al final, sin saltearse publicaciones.
  const tamanoLote = Math.min(RECONCILIACION_LOTE, universo.length);
  const lote = [];
  for (let i = 0; i < tamanoLote; i++) lote.push(universo[(desde + i) % universo.length]);

  // Multiget de los itemIds del lote, en chunks de a 20, EN SERIE con pausa explícita entre
  // chunks (ver RECONCILIACION_PAUSA_CHUNK_MS) — nunca en paralelo/ráfaga.
  const itemIdsUnicos = [...new Set(lote.map(r => partirClaveMl(r.clave).itemId))];
  const chunks = [];
  for (let i = 0; i < itemIdsUnicos.length; i += RECONCILIACION_MULTIGET_CHUNK) {
    chunks.push(itemIdsUnicos.slice(i, i + RECONCILIACION_MULTIGET_CHUNK));
  }

  // Snapshot de status/sub_status ANTES del multiget (M1, revisor): el multiget puede tardar
  // hasta ~12s (8 chunks x 1.5s) y en ese tiempo otro flujo (reactivarItems, el botón
  // "refrescar" del matcher) puede escribir un status más fresco en ml_publicaciones_cache.
  // Leer la caché recién al escribir (como antes) comparaba contra un dato potencialmente
  // stale y pisaba ese cambio más fresco con el status viejo del multiget — reintroducía el
  // punto ciego de Starvos vía el camino inverso (una recién reactivada podía volver a
  // marcarse 'paused'). El CAS de abajo usa ESTE snapshot, tomado antes de la primera llamada
  // a ML, como condición: si cambió desde entonces, el otro flujo ganó y no se pisa.
  // Snapshot POR CLAVE (m1, ronda 2 revisor), no un único snapshot por item_id con LIMIT 1 sin
  // ORDER BY: si dos filas del mismo item_id (variaciones) tienen status distinto entre sí
  // (refresh parcial, alta de variación posterior — no debería pasar en teoría, pero el CAS
  // tiene que sobrevivir si pasa), un solo snapshot arbitrario dejaba las filas divergentes del
  // snapshot elegido sin poder actualizarse NUNCA: el UPDATE por item_id con WHERE status IS
  // <snapshot único> nunca matchea esas filas, y la corrida siguiente vuelve a snapshotear la
  // misma fila "ganadora" de siempre (estado absorbente). Ahora se snapshotea cada fila
  // (clave) del item y el CAS de escritura de abajo también es por clave.
  const statusSnapshot = new Map(); // itemId -> [{ clave, status, sub_status }, ...]
  const snapshotStmt = db.prepare('SELECT clave, status, sub_status FROM ml_publicaciones_cache WHERE item_id = ?');
  for (const itemId of itemIdsUnicos) {
    statusSnapshot.set(itemId, snapshotStmt.all(itemId));
  }

  const porItem = new Map(); // itemId -> body del item devuelto por ML
  let cortadoPor429 = false;
  // Un solo reintento por CORRIDA (no por chunk) — ver comentario de
  // RECONCILIACION_ESPERA_MAX_COOLDOWN_MS más arriba.
  let esperasCooldown = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const path = `/items?ids=${chunk.join(',')}&attributes=id,status,sub_status,available_quantity,variations`;
    let resp;
    try {
      resp = await mlFetch(db, mlCfg, 'get', path);
      if (resp.status === 429 && esperasCooldown === 0) {
        const { hasta } = estadoCooldownMl();
        const esperaMs = hasta ? new Date(hasta).getTime() - Date.now() + RECONCILIACION_MARGEN_COOLDOWN_MS : null;
        if (esperaMs != null && esperaMs > 0 && esperaMs <= RECONCILIACION_ESPERA_MAX_COOLDOWN_MS) {
          esperasCooldown++;
          // Piso de RECONCILIACION_PAUSA_CHUNK_MS (revisor #4): si el cooldown está por
          // vencer, esperaMs puede quedar muy por debajo de la pausa mínima entre llamadas
          // (ej. ~600ms) y el reintento saldría en ráfaga contra ML — exactamente el patrón
          // que dispara el 429 al 2º/3er multiget (ver comentario de
          // RECONCILIACION_PAUSA_CHUNK_MS más arriba). El tope de 90s se sigue evaluando
          // sobre esperaMs sin este piso, así que no cambia la decisión de esperar o cortar.
          await sleep(Math.max(esperaMs, RECONCILIACION_PAUSA_CHUNK_MS));
          // Sin try/catch propio (revisor #1): una excepción acá (timeout/red, no un 429) no
          // es un fallo de cuota. Se deja caer al catch externo, que ya trata cualquier chunk
          // que lanza igual: ausente de porItem, fail-closed, se sigue con el resto del lote.
          // Envolverla acá y cortar la corrida entera además mentía en el warn de más abajo
          // atribuyendo a "cooldown 429" un fallo que fue de red.
          resp = await mlFetch(db, mlCfg, 'get', path);
        }
      }
      if (resp.status === 429) {
        // Mismo criterio que syncWcToMl (routes/sync.js, cortadoPor429): con 429 sostenido
        // TODOS los chunks que faltan van a devolver lo mismo. Seguir la ronda entera
        // pagando ~1.5s por chunk sin conseguir un solo dato real no aporta nada y retrasa
        // más la corrida siguiente. Cortar acá; los itemIds sin consultar quedan ausentes
        // de porItem y sus filas se saltean fail-closed más abajo, igual que un item
        // inaccesible por cualquier otro motivo. Llega acá tanto si no hubo reintento (tope
        // de espera superado o ya se gastó el único reintento de esta corrida) como si el
        // reintento post-cooldown también dio 429.
        cortadoPor429 = true;
        break;
      }
      if (resp.status === 200 && Array.isArray(resp.data)) {
        for (const e of resp.data) if (e.code === 200 && e.body) porItem.set(String(e.body.id), e.body);
      }
      // status !== 200 (no 429), o un elemento con code !== 200 dentro del array: ese/esos
      // itemIds quedan AUSENTES de porItem, tratado fail-closed más abajo (mismo criterio que
      // evaluarPreciosReactivables/reactivarItems: nunca se afirma nada sobre un item que no
      // se pudo consultar).
    } catch (e) {
      // mlFetch no lanza por status HTTP (usa validateStatus:()=>true), pero SÍ por
      // timeout/error de red de axios. Un chunk que lanza no debe tumbar el resto del lote:
      // sus itemIds quedan ausentes de porItem y cada clave de ese item se saltea fail-closed.
      console.error(`reconciliarStockMl: multiget falló para un chunk: ${e.message}`);
    }
    // No pagar la pausa tras el último chunk (M6, revisor): no hay otro chunk esperando.
    if (i < chunks.length - 1) await sleep(RECONCILIACION_PAUSA_CHUNK_MS);
  }

  // Contador de corridas CONSECUTIVAS con status ausente por clave (M3, ronda 2 revisor):
  // sin esto, una fila que cae al FINAL del lote con status ausente deja `ultimaIdxConDato`
  // antes de ella y el cursor no avanza — si la condición es PERMANENTE (una publicación que
  // sistemáticamente responde 200 sin `status`), el barrido toma el mismo lote, se clava en la
  // misma fila para siempre, y el resto del universo deja de reconciliarse. Persistido en
  // `sync_estado` como JSON (mismo patrón que el cursor, sin tabla/columna nueva: alternativa
  // más chica que evita una migración para un contador que no necesita ser relacional) bajo la
  // clave 'status_ausente_contador_reconciliacion'. Se lee una vez al arrancar la corrida y se
  // escribe una vez al final.
  const CONTADOR_STATUS_AUSENTE_CLAVE = 'status_ausente_contador_reconciliacion';
  const MAX_STATUS_AUSENTE_CONSECUTIVO = 3;
  let contadorStatusAusente = {};
  try {
    const row = db.prepare('SELECT valor FROM sync_estado WHERE clave = ?').get(CONTADOR_STATUS_AUSENTE_CLAVE);
    if (row?.valor) contadorStatusAusente = JSON.parse(row.valor);
  } catch (_) { contadorStatusAusente = {}; }

  // db.prepare() hoisteados fuera del bucle de 150 iteraciones (m1, revisor) — mismo criterio
  // que refrescar/marcarActivo más abajo en el archivo. CAS por CLAVE (m1, ronda 2 revisor,
  // ver comentario del snapshot más arriba), no por item_id.
  const stmtUpdateStatusYSub = db.prepare('UPDATE ml_publicaciones_cache SET status = ?, sub_status = ? WHERE clave = ? AND status IS ?');
  const stmtUpdateSoloStatus = db.prepare('UPDATE ml_publicaciones_cache SET status = ? WHERE clave = ? AND status IS ?');
  const stmtAltaStockEstado = db.prepare(`
    INSERT INTO ml_stock_estado (clave, sku, cantidad_ml, actualizado_en) VALUES (?, ?, ?, ?)
    ON CONFLICT(clave) DO NOTHING
  `);
  const stmtCasStockEstado = db.prepare(
    'UPDATE ml_stock_estado SET cantidad_ml = ?, actualizado_en = ? WHERE clave = ? AND cantidad_ml = ?'
  );

  let corregidas = 0;
  // Altas de ml_stock_estado (fila que no existía todavía) contadas aparte de `corregidas`
  // (m2, ronda 2 revisor): en el primer barrido tras sacar el filtro de status del universo
  // hay ~1061 filas sin ml_stock_estado — si sumaran a `corregidas`, ahogarían la señal real
  // (sobreventa corregida) detrás de un ruido de "puesta al día" que no es un problema.
  let altas = 0;
  let sinDato = 0;
  // Filas cuya decisión de matcher no tiene sku resuelto: no es un fallo de ML (que sí
  // contestó), es una condición estable del lado nuestro. Contador separado (m2, revisor):
  // mezclado con sinDato, el warn de fail-closed de más abajo gritaba en cada corrida por
  // filas que no tienen nada que ver con un 429 o un chunk caído, y nadie lo miraba.
  let sinSku = 0;
  let statusRefrescados = 0;
  // Items cuyo status/sub_status en ml_publicaciones_cache ya se refrescó en esta corrida
  // (una sola escritura por item_id, no por fila/variación del lote).
  const statusRefrescadoItemIds = new Set();
  // Última clave del lote (en orden) que sí tuvo dato real de ML, sea o no divergente.
  // El cursor solo puede avanzar hasta ahí (ver más abajo). Ojo (M2, revisor): esto solo
  // garantiza que las filas sin dato al FINAL del lote se reintenten en la corrida
  // siguiente. Las filas sin dato que quedan en el MEDIO del lote (ML no contestó ese
  // chunk puntual, pero sí contestó chunks posteriores) se saltean igual y no vuelven a
  // consultarse hasta que el cursor complete una vuelta entera y llegue de nuevo a ellas.
  let ultimaIdxConDato = -1;
  for (let i = 0; i < lote.length; i++) {
    const fila = lote[i];
    const { itemId, variationId } = partirClaveMl(fila.clave);
    const item = porItem.get(itemId);
    // Fail-closed: item ausente del multiget (chunk fallido, respuesta parcial, item
    // inaccesible, 429) → no se puede afirmar nada sobre su stock real. Se deja la fila de
    // ml_stock_estado tal cual está y se sigue con la próxima.
    if (!item) { sinDato++; continue; }

    // Refresco de status/sub_status en ml_publicaciones_cache con el dato vivo del multiget
    // (esto es lo que cierra el punto ciego de _syncWcToMl, que hoy lee esa columna sin
    // ningún cron que la mantenga al día). Fail-closed: solo se escribe si ML respondió 200
    // con un status presente; se hace UNA vez por item_id (no por fila/variación).
    //
    // CAS (M1, revisor): se condiciona contra `statusSnapshot`, tomado ANTES del multiget, no
    // contra una relectura de la caché al momento de escribir — si otro flujo (reactivarItems,
    // "refrescar" del matcher) cambió el status en el medio, su dato es más fresco y gana; el
    // UPDATE con WHERE status IS <snapshot> no matchea (changes===0) y no se pisa ni se cuenta.
    //
    // sub_status (M2, revisor): si ML respondió 200 pero omitió el atributo sub_status (no
    // está en el objeto), NO se escribe '' encima del valor guardado — eso borraría, por
    // ejemplo, 'out_of_stock' de una pausada por falta de stock y la sacaría en falso de
    // getReactivablesRows. Solo se pisa sub_status cuando el atributo vino presente.
    //
    // actualizado_en (B1, revisor): deliberadamente NO se toca acá. firmaCandidatos (matcher.js)
    // usa MAX(actualizado_en) de esta tabla como firma de invalidación del caché de candidatos
    // del matcher, asumiendo que nada la escribe fuera del refresh manual — si este UPDATE
    // tocara actualizado_en, cada corrida del barrido (cron 9-59/10) invalidaría ese caché
    // entero (recómputo de >120s) sin que título/sku/atributos hayan cambiado. El cruce de
    // candidatos en sí (candidatosDeItem, lib/matcherEngine.js) no usa status/sub_status, así
    // que dejar actualizado_en intacto mantiene la firma válida como invalidador. OJO (ronda 2,
    // M2 revisor): status SÍ viaja como `ml_status` en el payload cacheado por request (lo mete
    // construirMLdesdeApi) y alimenta el badge/filtro/orden del front — remarcarStockResueltos
    // (routes/matcher.js) re-lee el status vivo de esta tabla en cada request para que ese
    // write-back no quede stale hasta 3h; ver el comentario ahí y en firmaCandidatos.
    if (item.status != null && !statusRefrescadoItemIds.has(itemId)) {
      statusRefrescadoItemIds.add(itemId);
      const subStatusPresente = 'sub_status' in item;
      const subStatus = Array.isArray(item.sub_status) ? item.sub_status.join(',') : String(item.sub_status ?? '');
      // Filas snapshoteadas de este item_id (m1, ronda 2 revisor): una por CADA clave/variación
      // vista antes del multiget, no un único snapshot arbitrario del item. El UPDATE de abajo
      // condiciona por `clave`, con el valor de status QUE ESA FILA tenía en su propio
      // snapshot — así una fila cuyo status ya había divergido de las demás variaciones del
      // mismo item también puede actualizarse, en vez de quedar bloqueada para siempre por el
      // WHERE de un snapshot ajeno (estado absorbente que describía el hallazgo).
      const filasSnapshot = statusSnapshot.get(itemId) || [];
      let escribioAlgunaFila = false;
      for (const snap of filasSnapshot) {
        const cambia = snap.status !== item.status || (subStatusPresente && (snap.sub_status ?? '') !== subStatus);
        if (!cambia) continue;
        const res = subStatusPresente
          ? stmtUpdateStatusYSub.run(item.status, subStatus, snap.clave, snap.status)
          : stmtUpdateSoloStatus.run(item.status, snap.clave, snap.status);
        // changes === 1 acá sí es correcto: el UPDATE es por `clave` (única), no por item_id.
        if (res.changes === 1) escribioAlgunaFila = true;
      }
      // statusRefrescados sigue contando ITEMS, no filas/variaciones (mismo criterio previo,
      // documentado en docs/api-contrato.md): aunque ahora la escritura es por clave, una sola
      // publicación con 3 variaciones que cambiaron de status sigue sumando 1, no 3.
      if (escribioAlgunaFila) statusRefrescados++;
    }

    // No está activa en ML (puede haber cambiado desde el último refresh del cache local):
    // no es sobreventa real porque no vende. Se saltea sin tocar el estado. Sí hubo dato real
    // de ML para este item (confirmó que no está activa), así que el cursor puede avanzar.
    //
    // (m3, revisor) Distinción entre status AUSENTE (ML respondió 200 pero sin el atributo
    // status — no debería pasar pidiéndolo explícito en `attributes=`, pero no se descarta) y
    // status presente no-activo. Lo primero es fail-closed real (mismo criterio que
    // chequearNetoReactivar con item===undefined): no se puede afirmar que no está activa, así
    // que cuenta sinDato y el cursor NO avanza por esta fila, para reintentarla. Lo segundo es
    // una confirmación real de ML (no vende) y el cursor sí avanza.
    //
    // EXCEPCIÓN (M3, ronda 2 revisor): si la MISMA clave viene sin status en
    // MAX_STATUS_AUSENTE_CONSECUTIVO corridas seguidas, la condición dejó de ser transitoria —
    // es una publicación que sistemáticamente responde 200 sin el atributo. Sin cortar acá, si
    // esa fila cae al final del lote el cursor nunca avanza más allá de ella y el resto del
    // universo deja de reconciliarse para siempre (mismo modo de falla mudo que B1, por otra
    // puerta). Se avanza el cursor igual, se deja un sync_log 'error' accionable (requiere
    // mirada humana en ML, no se resuelve reintentando) y se resetea el contador.
    if (item.status == null) {
      sinDato++;
      const clave = fila.clave;
      const veces = (contadorStatusAusente[clave] || 0) + 1;
      if (veces >= MAX_STATUS_AUSENTE_CONSECUTIVO) {
        delete contadorStatusAusente[clave];
        ultimaIdxConDato = i;
        logSync(db, {
          direccion: 'wc_ml', clave, sku: fila.sku, estado: 'error',
          error: `Reconciliación: ML respondió 200 sin atributo 'status' para esta publicación en ${veces} corridas consecutivas — condición permanente, no transitoria. Requiere revisión manual en ML.`,
        });
      } else {
        contadorStatusAusente[clave] = veces;
      }
      continue;
    }
    delete contadorStatusAusente[fila.clave];
    if (item.status !== 'active') { ultimaIdxConDato = i; continue; }

    // Misma granularidad que ml_stock_estado.clave: variación si la fila tiene variationId,
    // si no la cantidad a nivel item.
    let cantidadReal;
    if (variationId) {
      const variacion = Array.isArray(item.variations)
        ? item.variations.find(v => String(v.id) === String(variationId))
        : null;
      cantidadReal = variacion?.available_quantity;
    } else {
      cantidadReal = item.available_quantity;
    }

    // Fail-closed: solo se corrige con una cantidad numérica finita. Escribir acá un valor
    // equivocado (null, NaN, undefined) haría que syncWcToMl empuje stock equivocado A ML —
    // el peor resultado posible de este cambio.
    // Distinción clave (M1, revisor): esto NO es "ML no contestó" — el item existe y ML
    // respondió 200, pero la variación puntual ya no está en item.variations (variación
    // muerta) o available_quantity vino undefined. Es una condición estable que no va a
    // cambiar por reintentar, a diferencia de un chunk caído o un 429 (transitorio). Si no
    // avanzara el cursor acá, un lote entero de variaciones muertas lo dejaría clavado para
    // siempre. Sigue sin escribir nada (fail-closed intacto) y sigue contando como sinDato
    // para el aviso de más abajo.
    if (!Number.isFinite(cantidadReal)) { sinDato++; ultimaIdxConDato = i; continue; }

    ultimaIdxConDato = i;

    // Fila sin ml_stock_estado todavía (universo con LEFT JOIN — ver arriba): no hay un
    // "recordado" contra el cual comparar. Se da de alta directamente con el valor REAL de
    // ML, no con un UPDATE condicional. ml_stock_estado.sku es NOT NULL: si no hay sku
    // resuelto (COALESCE(e.sku, d.sku) vino null/vacío), no se puede insertar — se cuenta
    // como sinSku (m2, revisor — no es "sin dato de ML", ML sí contestó; es una condición
    // estable: la decisión del matcher no tiene sku) y el cursor avanza igual, no tiene
    // sentido reintentarla en la próxima vuelta.
    if (fila.cantidad_ml == null) {
      if (!fila.sku) { sinSku++; continue; }
      const alta = stmtAltaStockEstado.run(fila.clave, fila.sku, cantidadReal, now());

      if (alta.changes === 1) {
        // Mismo criterio CAS que el UPDATE de abajo: si otro proceso ya creó la fila entre la
        // lectura del universo y este INSERT, no se pisa (su dato es más fresco) y no se cuenta.
        logSync(db, {
          direccion: 'wc_ml',
          clave: fila.clave,
          sku: fila.sku,
          cantAnterior: null,
          cantNueva: cantidadReal,
          estado: 'reconciliado',
          error: `Reconciliación: publicación sin ml_stock_estado registrado (punto ciego cerrado). ML tiene ${cantidadReal} unidades. Estado local dado de alta con ese valor; syncWcToMl empujará el stock real de Woo en la próxima corrida.`,
        });
        altas++;
      }
      continue;
    }

    if (cantidadReal !== fila.cantidad_ml) {
      // IMPORTANTE 4 (revisor): compare-and-swap contra el valor leído al armar el universo,
      // no un upsert incondicional. Entre esa lectura y este UPDATE pasan hasta ~7.5s (5
      // chunks x 1.5s) en los que syncWcToMl o procesarReintentos pueden haber escrito
      // ml_stock_estado con un dato más fresco; pisarlo con esta lectura vieja de ML
      // generaría una fila de sync_log engañosa y un push de más hacia ML. Si otro proceso
      // ya cambió la fila, este UPDATE no matchea (changes === 0) y no se cuenta como
      // corregida ni se loguea: no hay nada que corregir, ya está actualizada.
      //
      // (m4, revisor, no arreglado a propósito) Churn posible: si syncWcToMl empuja hacia ML
      // el mismo valor que reconciliarStockMl ya había leído acá, el CAS de esta corrida SÍ
      // matchea contra el `cantidad_ml` viejo y reescribe con la lectura de ML de este barrido;
      // el próximo syncWcToMl puede volver a empujar el mismo PUT. Converge solo (no queda
      // desincronizado) y cuesta como mucho un PUT de más por vuelta — no vale la complejidad
      // de resolverlo, se deja anotado.
      const cambio = stmtCasStockEstado.run(cantidadReal, now(), fila.clave, fila.cantidad_ml);

      if (cambio.changes === 1) {
        // direccion 'wc_ml' porque la corrección de estado es la misma vía por la que syncWcToMl
        // va a terminar empujando el valor real de Woo. Mensaje pensado para leerse sin contexto
        // (ver plan): deja explícito qué tenía ML y qué teníamos registrado.
        logSync(db, {
          direccion: 'wc_ml',
          clave: fila.clave,
          sku: fila.sku,
          cantAnterior: fila.cantidad_ml,
          cantNueva: cantidadReal,
          estado: 'reconciliado',
          error: `Reconciliación: ML tenía ${cantidadReal}, ml_stock_estado tenía ${fila.cantidad_ml}. Estado local corregido a ${cantidadReal}; syncWcToMl empujará el stock real de Woo en la próxima corrida.`,
        });
        corregidas++;
      }
    }
  }

  if (sinDato > 0) {
    // Modo de falla mudo (mismo criterio aplicado en reactivarAutomatico, server.js): sin
    // este aviso, un 429 sostenido hace que el cursor dé vueltas completas sin haber leído
    // un solo dato real de ML, indistinguible en el log de una corrida normal. Este contador
    // es SOLO transitorias/fail-closed (ML no contestó, o el status vino ausente pese a 200) —
    // ver sinSku abajo para lo permanente, que no es un problema de ML.
    console.warn(`reconciliarStockMl: ${sinDato} de ${lote.length} publicaciones del lote quedaron sin dato de ML (fail-closed)${cortadoPor429 ? ' — cooldown 429 activo' : ''}`);
  }
  if (sinSku > 0) {
    // (m2, revisor) Warn separado y accionable: estas filas SÍ tuvieron respuesta de ML, el
    // problema es que la decisión del matcher no tiene sku resuelto. No es un fallo transitorio
    // que se arregle solo reintentando — necesita que el usuario complete el sku en el matcher.
    console.warn(`reconciliarStockMl: ${sinSku} de ${lote.length} publicaciones del lote no tienen sku resuelto en la decisión del matcher (requiere completar el sku, no es fail transitorio de ML)`);
  }

  // Persistir el contador de status-ausente-consecutivo (M3, ronda 2 revisor) — una escritura
  // por corrida, no por fila. Filas fuera del lote de esta corrida conservan su contador previo
  // (no se tocan). db vacío (`{}`) se persiste igual para no dejar un valor stale si todo se
  // resolvió esta vuelta.
  //
  // Poda de claves fuera del universo actual (menor 4, revisor): una clave que sale del
  // universo (matcher desvinculado, publicación borrada) con 1 o 2 fallos acumulados nunca
  // llega a MAX_STATUS_AUSENTE_CONSECUTIVO ni se resetea (delete solo corre cuando la clave
  // vuelve a aparecer en un lote) — quedaría en el JSON para siempre. Se poda acá, barato
  // (un Set + filter sobre un objeto ya chico), en vez de dejar crecer el archivo en silencio.
  const clavesUniverso = new Set(universo.map(r => r.clave));
  for (const clave of Object.keys(contadorStatusAusente)) {
    if (!clavesUniverso.has(clave)) delete contadorStatusAusente[clave];
  }
  db.prepare(`
    INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
  `).run(CONTADOR_STATUS_AUSENTE_CLAVE, JSON.stringify(contadorStatusAusente), now());

  // Avanzar el cursor solo hasta la última clave del lote que sí tuvo dato real de ML
  // (revisor, bloqueante 2): si el multiget no devolvió nada útil para ninguna fila del
  // lote, el cursor NO avanza, para que la corrida siguiente vuelva a intentar exactamente
  // las mismas publicaciones en vez de darlas por revisadas y perderlas de vista ~1h40m.
  if (ultimaIdxConDato >= 0) {
    const siguienteIdx = (desde + ultimaIdxConDato + 1) % universo.length;
    const siguienteClave = universo[siguienteIdx].clave;
    db.prepare(`
      INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES ('cursor_reconciliacion_stock', ?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
    `).run(siguienteClave, now());
  }

  return { omitido: false, revisadas: lote.length, corregidas, altas, sinDato, sinSku, statusRefrescados, esperasCooldown };
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
    try {
      const resp = await mlFetch(
        db, mlCfg, 'get',
        `/items?ids=${chunk.join(',')}&attributes=id,price,category_id,listing_type_id,shipping,variations`
      );
      if (resp.status === 200 && Array.isArray(resp.data)) {
        for (const e of resp.data) if (e.code === 200 && e.body) items.set(String(e.body.id), e.body);
      }
    } catch (e) {
      // mlFetch no lanza por status HTTP, pero SÍ por timeout/error de red de axios (ver
      // convención en la nota de más arriba). Si un chunk lanza, no debe tumbar el
      // Promise.all del pool: los ítems de este chunk quedan ausentes de `items` y el
      // fail-closed por ítem ausente (peor = 'sin_precio') ya los cubre más abajo.
      console.error(`evaluarPreciosReactivables: multiget falló para un chunk: ${e.message}`);
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
 * Evalúa el neto de TODAS las variaciones mapeadas de un item contra su precio web y
 * devuelve la lista de bloqueos por margen (una entrada por variación con veredicto 'bajo').
 *
 * A diferencia de una versión anterior que hacía `return` en la PRIMERA variación con neto
 * bajo: acá se evalúan TODAS. Cortar en la primera dejaba sin evaluar (y sin fila en
 * `ml_reactivacion_frenada`) al resto de las variaciones de un item multi-variación, y como
 * el recheck de `necesitaRecheck` es a nivel item, esas variaciones nunca frenadas hacían que
 * el item entero volviera a re-consultarse en CADA corrida, para siempre (hallazgo del
 * revisor, IMPORTANTE 3). Persistir una frenada por cada variación que bloquea es además el
 * dato correcto para el badge del home.
 *
 * Devuelve:
 *  - null → ninguna variación bloquea, seguir adelante.
 *  - { error, clave, ... } → bloqueo fail-closed que no es "neto bajo" (sin precio web
 *    mapeado o comisión no calculable): corta ahí mismo, porque sin ese dato no se puede
 *    seguir evaluando esa variación ni tiene sentido persistir frenada (deficitPct null).
 *  - { bloqueos: [...] } → una o más variaciones con veredicto 'bajo' (ninguna de las
 *    anteriores saltó fail-closed antes).
 */
// Persiste en ml_publicaciones_cache.precio (+ precio_actualizado_en) el precio de ML ya
// resuelto por el multiget de reactivarItems (ver evaluarNetoVariaciones). NO agrega ninguna
// llamada a ML: el dato ya vino en la respuesta del /items?ids= que igual se hace para el
// screening/revalidación. Cierra el bug medido 2026-08-06: las 30 filas de
// ml_reactivacion_frenada tenían precio_ml_evaluado no nulo pero
// ml_publicaciones_cache.precio en NULL (esa columna solo se llenaba desde el refresco MANUAL
// del matcher o el fix puntual de /actualizar-precio), así que necesitaRecheck() forzaba
// recheck SIEMPRE por la guarda `precioMlActual == null` y el ahorro del paso 4 nunca se
// materializaba para ellas. Solo escribe si el precio es un número válido — si ML no lo
// devolvió, se deja la columna como está (NULL o el valor previo), que es lo conservador:
// necesitaRecheck sigue re-consultando esa clave hasta tener un dato confiable.
function persistirPrecioMlCache(db, clave, precio) {
  if (!(typeof precio === 'number') || !Number.isFinite(precio)) return;
  try {
    db.prepare('UPDATE ml_publicaciones_cache SET precio = ?, precio_actualizado_en = ? WHERE clave = ?')
      .run(precio, now(), clave);
  } catch (e) {
    // Best-effort: si falla la escritura del caché, no se aborta la evaluación de neto (que
    // ya tiene el precio en la mano) — solo se pierde el ahorro de la próxima corrida.
    console.error(`persistirPrecioMlCache: no se pudo refrescar ${clave}:`, e.message);
  }
}

async function evaluarNetoVariaciones(db, mlCfg, itemId, item, variaciones, opts = {}) {
  const freeShipping = !!item.shipping?.free_shipping;
  const caches = { fee: new Map(), envio: new Map() };
  const bloqueos = [];

  for (const v of variaciones) {
    let precio = item.price ?? null;
    if (v.variation_id) {
      const vv = (item.variations || []).find(x => String(x.id) === String(v.variation_id));
      if (vv && vv.price != null) precio = vv.price;
    }
    // Se persiste ANTES del chequeo de precio web y sin importar el veredicto de neto: el
    // dato ya está resuelto acá y hay que guardarlo aunque la publicación termine bloqueada
    // por neto bajo (es justo el caso de las 30 frenadas del bug) o falte el precio web.
    persistirPrecioMlCache(db, v.clave, precio);

    const precioWeb = precioWebClave(db, v.clave);
    if (!(precioWeb > 0)) {
      return { error: MOTIVO_SIN_PRECIO_WEB, clave: v.clave, neto: null, precio_web: null, deficitPct: null };
    }
    const { neto } = await netoMl(db, mlCfg, {
      itemId, price: precio, categoryId: item.category_id,
      listingTypeId: item.listing_type_id, freeShipping,
    }, caches, opts);
    if (neto == null) {
      return { error: 'No se pudo calcular la comisión en ML — reintentá', clave: v.clave, neto: null, precio_web: precioWeb, deficitPct: null };
    }
    const { estado, deficitPct } = veredictoNeto(neto, precioWeb);
    if (estado === 'bajo') {
      // precio_ml viaja en el bloqueo para que reactivarAutomatico lo persista en
      // ml_reactivacion_frenada.precio_ml_evaluado (paso 4: insumo para decidir localmente,
      // sin ML, si una frenada sigue vigente en el próximo ciclo).
      bloqueos.push({ error: 'El neto de ML queda por debajo del precio web', clave: v.clave, neto, precio_web: precioWeb, deficitPct, precio_ml: precio });
    }
  }
  return bloqueos.length ? { bloqueos } : null;
}

/**
 * Revalida en vivo el item antes de reactivar y verifica el neto del vendedor. Trae en un solo GET
 * status/sub_status + precio/categoría/listing/envío del item y:
 *  1) Revalida el estado real en ML: la lista de "reactivables" sale del caché local, y entre que
 *     se arma y el usuario confirma el lote el vendedor pudo reactivar o pausar manualmente la
 *     publicación. Si ya no está pausada, o si quedó pausada por el vendedor (paused_by_seller),
 *     se omite (no es un error ni un bloqueo por margen: es un skip por dato fresco).
 *  2) Por cada variación mapeada compara el neto contra el precio web (evaluarNetoVariaciones,
 *     evalúa TODAS, no corta en la primera). Si alguna queda >5% por debajo (veredicto 'bajo')
 *     devuelve el detalle del bloqueo de cada una.
 *
 * Devuelve:
 *  - null  → seguir adelante con la reactivación (todavía falta la revalidación previa al PUT,
 *    ver reactivarItems).
 *  - { omitido: true, motivo } → omitir sin error (revalidación de estado en vivo).
 *  - { error, ... } → bloqueo fail-closed puntual (sin precio web / sin comisión).
 *  - { bloqueos: [...] } → una o más variaciones con neto bajo.
 *
 * Bloquea también (fail-closed) si no se pudo consultar el item en ML, si falta el precio web
 * mapeado o si no se pudo calcular la comisión: sin esos datos no hay forma de verificar el
 * margen, y dejar pasar la reactivación en ese caso anularía la protección en silencio. La
 * revalidación de estado es igual de fail-closed: si el GET falla, no reactivamos.
 *
 * `item` llega YA RESUELTO por el multiget de `reactivarItems` (paso 3 del plan
 * ahorro-llamadas-ml: antes era un GET /items/{itemId} por publicación, ahora un solo
 * /items?ids= en chunks de 20 para todo el lote). `item` es `undefined` si esa publicación
 * quedó AUSENTE de la respuesta del multiget (chunk fallido o item inaccesible): se trata
 * fail-closed, igual que un GET individual que hubiera fallado.
 *
 * Screening con caché (FOCO, decisión del orquestador 2026-08-06): esta función es el
 * "cribado" barato que corre para TODO el lote (incluidas publicaciones que van a quedar
 * bloqueadas o que ni siquiera se van a reactivar), así que llama a evaluarNetoVariaciones
 * usando `ml_precios_cache` normalmente (SIN `saltarCachePersistente`), salvo una excepción
 * puntual: si `opts.saltarCachePersistenteItems` (armado por reactivarAutomatico) incluye este
 * itemId — la publicación entró al lote porque venció la ventana de 2h de la red de seguridad,
 * ver VENTANA_REVALIDACION_FRENADA_MS — reactivarItems le fuerza `saltarCachePersistente: true`
 * ahí mismo. La revalidación en vivo del RESTO de las publicaciones (las que sí usaron caché
 * acá) queda acotada a `reactivarItems`, JUSTO ANTES del PUT de activación, y solo para las que
 * de verdad van a reactivarse (ver ahí). Antes esta misma función forzaba
 * `saltarCachePersistente: true` para el lote entero, así que la caché persistente solo se
 * ESCRIBÍA y nunca se LEÍA en este camino — desviación del plan original (que acotaba el
 * salteo a "las que van a reactivarse de verdad").
 */
// Mensaje exacto del bloqueo "sin precio web mapeado" (precioWebClave devolvió null: SKU sin
// regular_price, típicamente el catálogo todavía no se refrescó tras un reinicio). Constante
// compartida con reactivarAutomatico, que cuenta cuántas reactivaciones cayeron en este motivo
// puntual para que el operador pueda distinguirlo de "no había nada que hacer" (ver server.js).
const MOTIVO_SIN_PRECIO_WEB = 'Sin precio web mapeado para esta variación — no se puede verificar el margen';
async function chequearNetoReactivar(db, mlCfg, itemId, variaciones, item, opts = {}) {
  if (!item) {
    return { error: 'No se pudo consultar el precio en ML — reintentá', clave: null, neto: null, precio_web: null, deficitPct: null };
  }

  // 0) Revalidación de estado en vivo (mismo multiget, sin llamada extra a ML).
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

  // Screening: usa la caché persistente de comisión/envío si está fresca (sin forzar
  // saltarCachePersistente). La revalidación en vivo va en reactivarItems, justo antes del PUT.
  return evaluarNetoVariaciones(db, mlCfg, itemId, item, variaciones, opts);
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
export async function reactivarItems(db, mlCfg, itemIds, opts = {}) {
  const LOTE_MAX = 50;
  const aProcesar = itemIds.slice(0, LOTE_MAX);
  const rows = getReactivablesRows(db, aProcesar);

  // Agrupar variaciones válidas por item
  const porItem = new Map();
  for (const r of rows) {
    if (!porItem.has(r.item_id)) porItem.set(r.item_id, []);
    porItem.get(r.item_id).push(r);
  }

  // Multiget de todos los items del lote de a MULTIGET_CHUNK (paso 3 del plan
  // ahorro-llamadas-ml: antes era un GET /items/{itemId} por publicación dentro de
  // chequearNetoReactivar; mismo patrón que evaluarPreciosReactivables). Un itemId AUSENTE
  // de `items` (chunk fallido o item inaccesible) queda fail-closed dentro de
  // chequearNetoReactivar, que trata `item === undefined` como "no se pudo consultar".
  const MULTIGET_CHUNK = 20;
  const itemIdsLote = [...porItem.keys()];
  const items = new Map();
  const chunks = [];
  for (let i = 0; i < itemIdsLote.length; i += MULTIGET_CHUNK) chunks.push(itemIdsLote.slice(i, i + MULTIGET_CHUNK));
  await mapConLimite(chunks, ML_CONCURRENCIA_MAX, async (chunk) => {
    try {
      const resp = await mlFetch(
        db, mlCfg, 'get',
        `/items?ids=${chunk.join(',')}&attributes=id,status,sub_status,price,category_id,listing_type_id,shipping,variations`,
        null, opts
      );
      if (resp.status === 200 && Array.isArray(resp.data)) {
        for (const e of resp.data) if (e.code === 200 && e.body) items.set(String(e.body.id), e.body);
      }
    } catch (e) {
      // Igual criterio que evaluarPreciosReactivables: mlFetch puede lanzar por timeout/error
      // de red de axios (no por status HTTP). Si UN chunk lanza, no debe tumbar el lote
      // completo — los itemIds de este chunk quedan ausentes de `items` y
      // chequearNetoReactivar los trata fail-closed (item === undefined).
      console.error(`reactivarItems: multiget falló para un chunk: ${e.message}`);
    }
  });

  // Se procesan varias publicaciones EN PARALELO con concurrencia acotada (antes: una a una
  //  con sleep fijo entre requests). La paralelización es ENTRE publicaciones distintas: dentro
  //  de una misma publicación los PUTs de stock siguen yendo en orden y la activación va DESPUÉS
  //  de que todos terminen. Cada publicación resuelve independiente (éxito/omitida/bloqueada/
  //  error): un fallo en una no frena ni afecta a las demás (fn captura su propio error).
  const resultados = await mapConLimite([...porItem], ML_CONCURRENCIA_MAX, async ([itemId, variaciones]) => {
    try {
      // 0) Revalidación en vivo + bloqueo por neto (dato del multiget de arriba, ninguna
      //    llamada extra). Omite si ya no está pausada o si el vendedor la pausó manualmente;
      //    bloquea si el neto queda >5% por debajo del precio web de alguna variación mapeada.
      //    Server-side (no confía en el cliente).
      //
      // Red de seguridad de 2h (hallazgo del revisor, IMPORTANTE): si esta publicación entró
      // al lote PORQUE venció la ventana de 2h (opts.saltarCachePersistenteItems, armado por
      // reactivarAutomatico), el screening tiene que ir en vivo contra ML — si usara
      // ml_precios_cache normal, releería el MISMO valor de comisión/envío que produjo la
      // frenada original (TTL de 7 días) y la red de seguridad sería ciega exactamente a lo
      // que la motivó. Las demás publicaciones del lote (frenadas por otro motivo, o
      // candidatas nuevas) siguen usando la caché persistente sin cambios.
      const opsScreening = opts.saltarCachePersistenteItems?.has(itemId)
        ? { ...opts, saltarCachePersistente: true }
        : opts;
      const bloqueo = await chequearNetoReactivar(db, mlCfg, itemId, variaciones, items.get(itemId), opsScreening);
      if (bloqueo) {
        if (bloqueo.omitido) {
          // Refrescar el caché local con el estado real de ML para sacarla de reactivables y
          // que el usuario no la reintente en loop (siempre "omitida") en la próxima carga.
          const refrescar = db.prepare('UPDATE ml_publicaciones_cache SET status=?, sub_status=? WHERE clave = ?');
          for (const v of variaciones) refrescar.run(bloqueo.cacheStatus, bloqueo.cacheSubStatus, v.clave);
          return { item_id: itemId, ok: false, omitido: true, motivo: bloqueo.motivo };
        }
        if (bloqueo.bloqueos) {
          // Compat: los campos del PRIMER bloqueo se aplanan igual que antes (clave/neto/
          // precio_web/deficitPct/precio_ml, consumidos por la UI y por tests existentes),
          // más `bloqueos` con el detalle completo de TODAS las variaciones bloqueadas —
          // reactivarAutomatico persiste frenada por cada una (IMPORTANTE 3).
          return { item_id: itemId, ok: false, bloqueado: true, ...bloqueo.bloqueos[0], bloqueos: bloqueo.bloqueos };
        }
        return { item_id: itemId, ok: false, bloqueado: true, ...bloqueo };
      }

      // 0.5) Revalidación en vivo JUSTO ANTES del PUT de activación (FOCO, separación
      //      screening/revalidación): el screening de arriba (chequearNetoReactivar) pudo usar
      //      la caché persistente de comisión/envío. Acá, para la publicación que de verdad va
      //      a reactivarse, se recalcula el neto de TODAS sus variaciones con
      //      `saltarCachePersistente: true` — dato lo más nuevo posible, fail-closed: si la
      //      consulta falla o el veredicto ahora da 'bajo', NO se activa. Son pocas
      //      publicaciones (solo las que pasan el screening), así que el costo (+2 llamadas
      //      por publicación reactivada) es despreciable frente a la protección de no vender
      //      por debajo del margen con datos de minutos atrás.
      const revalidacion = await evaluarNetoVariaciones(db, mlCfg, itemId, items.get(itemId), variaciones, { ...opts, saltarCachePersistente: true });
      if (revalidacion) {
        if (revalidacion.bloqueos) {
          return { item_id: itemId, ok: false, bloqueado: true, ...revalidacion.bloqueos[0], bloqueos: revalidacion.bloqueos };
        }
        return { item_id: itemId, ok: false, bloqueado: true, ...revalidacion };
      }

      // 1) Empujar stock de cada variación con stock web disponible (en orden dentro del item)
      for (const v of variaciones) {
        const cantidad = Math.max(0, Math.round(v.stock_disponible_ml));
        const { path, body } = buildMlStockUpdate(itemId, v.variation_id || '', cantidad);
        const resp = await mlFetch(db, mlCfg, 'put', path, body, opts);
        if (resp.status !== 200) {
          throw new Error(`stock ${v.clave}: ${extraerErrorMl(resp)}`);
        }
      }

      // 2) Reactivar la publicación — DESPUÉS de que todos los PUTs de stock de ESTA
      //    publicación terminaron (dependencia intra-publicación, no se paraleliza).
      const act = await mlFetch(db, mlCfg, 'put', `/items/${itemId}`, { status: 'active' }, opts);
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
      // Una fila por variación con la clave CANÓNICA (item_id|variation_id), igual que el
      // camino de éxito de arriba. Loguear con `itemId` pelado (sin el pipe) era un bug: la
      // clave no matcheaba ml_stock_estado, así que el filtro de auto-curado del dashboard
      // ("ya sincronizó después → dejá de mostrarlo") nunca la limpiaba y el error quedaba
      // pegado para siempre; tampoco joineaba ml_publicaciones_cache, así que aparecía sin
      // título ni miniatura. 34 publicaciones cayeron en esto entre julio y agosto 2026.
      for (const v of variaciones) {
        logSync(db, { direccion: 'wc_ml', clave: v.clave, sku: v.sku, estado: 'error', error: `reactivar: ${error}`.slice(0, 500) });
      }
      return { item_id: itemId, ok: false, error };
    }
  });

  return { procesados: porItem.size, resultados };
}

/**
 * Reactivación AUTOMÁTICA (cron): reactiva sola toda publicación pausada por out_of_stock
 * que recuperó stock y cuyo neto de ML pasa el chequeo contra el precio de contado.
 *
 * Las que NO pasan el chequeo de precio quedan pausadas y se registran en
 * ml_reactivacion_frenada para que el usuario las vea y corrija el precio en ML. La tabla se
 * limpia sola: si en un ciclo posterior el precio pasa, se reactiva y se borra la fila.
 *
 * FAIL-CLOSED: un bloqueo por ML caído (no se pudo consultar el precio o la comisión) NO se
 * registra como frenada — no es un problema de precio y el usuario no puede hacer nada con
 * él. Se reintenta solo en el próximo ciclo. El discriminador es deficitPct != null: solo el
 * bloqueo por neto bajo calcula un déficit.
 *
 * Anti-starvation: reactivarItems trunca a LOTE_MAX y getReactivablesRows ordena siempre
 * igual (por título), así que sin reordenar, un conjunto grande de frenadas crónicas con
 * títulos alfabéticamente tempranos ocuparía el lote entero en cada corrida y una publicación
 * nueva con stock recién repuesto (título tardío) nunca entraría a procesarse. Por eso acá se
 * antepone lo que NO tiene frenada registrada: eso es lo que puede reactivarse de verdad, y
 * las frenadas crónicas quedan relegadas a los lugares que sobren (se siguen reintentando,
 * pero sin bloquear a nadie). No se implementa backoff temporal: el usuario tiene un botón de
 * reintento inmediato tras corregir el precio, así que una ventana de tiempo solo agregaría
 * demora sin resolver nada.
 *
 * Barrido de huérfanas: al final se borran las frenadas cuya clave ya no está en la lista de
 * reactivables vigente (leída al inicio de ESTA corrida) — cubre reactivación manual,
 * pausado manual, pérdida de stock o de mapeo por cualquier vía que no sea este cron. Si no
 * hay reactivables, todas las frenadas existentes son huérfanas por definición (una frenada
 * solo tiene sentido para algo reactivable) y se limpian todas.
 *
 * Comparte el candado _reactivarEnCurso con la reactivación manual: nunca corren a la vez
 * (se pisarían contra ML y competirían por el rate limit). El candado es en memoria de UN
 * proceso: alcanza con una sola instancia corriendo el cron; con varias instancias en paralelo
 * no protege (no hay lock distribuido). Antes esto era un detalle menor de la acción manual;
 * ahora que es un cron periódico y no un click de usuario, es un supuesto que sostiene la
 * corrección de esta función.
 */
// Red de seguridad del paso 4: aunque nada haya cambiado en las dos columnas locales, una
// frenada se re-evalúa igual pasadas 2h desde detectado_en (puede haber cambiado la comisión
// o el envío de ML, que no viven en esta tabla — solo se conocen pegándole a ML).
//
// Mecanismo real (hallazgo del revisor, IMPORTANTE, 2026-08-05): que la fila entre por esta
// ventana NO alcanza por sí solo — si el screening de esa publicación en reactivarItems
// siguiera usando ml_precios_cache (TTL 7 días), releería el MISMO valor de comisión/envío
// que produjo la frenada original y la ventana sería ciega exactamente a lo que la motivó.
// Por eso reactivarAutomatico marca en `itemsPorVentana` los item_id cuya ÚNICA razón de
// recheck es el vencimiento de esta ventana (ni precio_ml ni precio_web local cambiaron) y
// reactivarItems, al recibirlos en opts.saltarCachePersistenteItems, les fuerza
// saltarCachePersistente:true en el screening — o sea, ML en vivo para esas publicaciones
// puntuales aunque ml_precios_cache tenga una fila fresca. El resto del lote (frenadas por
// otro motivo, o candidatas nuevas) sigue usando la caché persistente sin cambios.
//
// Bajada de 24h a 2h (hallazgo del revisor, BLOQUEANTE 1 de la pasada anterior): la premisa
// original de que `ml_publicaciones_cache.precio` "se refresca por crons que corren igual" es
// falsa — la única escritura de esa columna es el refresco MANUAL del matcher, más el fix
// puntual que ahora hace POST /api/precios/actualizar-precio al corregir un precio (ver
// routes/precios.js). Sin la ventana corta, una frenada por precio de ML desactualizado por
// cualquier otra vía podía quedar bloqueada hasta 24h sin ningún rastro en el log. Con ~24
// publicaciones frenadas hoy y screening en vivo solo para las que entran por acá, el costo
// estimado es ~24 × 2 llamadas cada 2h ≈ 576/día en el peor caso — un orden de magnitud por
// debajo de las 5.000-8.000 llamadas/día que motivaron este cambio, y el presupuesto de
// lib/mlLimites.js lo aguanta de sobra.
const VENTANA_REVALIDACION_FRENADA_MS = 2 * 60 * 60 * 1000;

export async function reactivarAutomatico(db, cfg) {
  if (!mlCfgOk(cfg)) return { omitido: true };
  if (_reactivarEnCurso) return { omitido: true };
  _reactivarEnCurso = true;
  try {
    const rows = getReactivablesRows(db);

    const guardarFrenada = db.prepare(`
      INSERT INTO ml_reactivacion_frenada
        (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en, precio_ml_evaluado, precio_web_evaluado)
      VALUES (@clave, @sku, @motivo, @neto, @precio_contado, @deficit_pct, @detectado_en, @precio_ml_evaluado, @precio_web_evaluado)
      ON CONFLICT(clave) DO UPDATE SET
        motivo=excluded.motivo, neto=excluded.neto, precio_contado=excluded.precio_contado,
        deficit_pct=excluded.deficit_pct, detectado_en=excluded.detectado_en,
        precio_ml_evaluado=excluded.precio_ml_evaluado, precio_web_evaluado=excluded.precio_web_evaluado
    `);
    const borrarFrenada = db.prepare('DELETE FROM ml_reactivacion_frenada WHERE clave = ?');
    const skuDeClave = db.prepare('SELECT sku FROM sku_matcher_decisiones WHERE clave = ?');

    if (rows.length === 0) {
      // No hay ningún reactivable: cualquier frenada existente quedó huérfana (ya no
      // corresponde a nada de la lista vigente) — limpieza total.
      db.prepare('DELETE FROM ml_reactivacion_frenada').run();
      return { omitido: false, reactivadas: 0, frenadas: 0, sin_precio_web: 0 };
    }

    const frenadasPorClave = new Map(
      db.prepare(`
        SELECT clave, precio_ml_evaluado, precio_web_evaluado, detectado_en
        FROM ml_reactivacion_frenada
      `).all().map(f => [f.clave, f])
    );
    const clavesFrenadas = new Set(frenadasPorClave.keys());
    const precioMlDeClave = db.prepare('SELECT precio FROM ml_publicaciones_cache WHERE clave = ?');
    const ahoraMs = Date.now();

    // Paso 4 (ahorro-llamadas-ml): decidir SIN pegarle a ML si una fila reactivable necesita
    // re-consultarse. Precio ML y precio web ya están en la base local — no hace falta gastar
    // una llamada para saber si el veredicto de una frenada pudo haber cambiado.
    //
    // OJO (hallazgo del revisor, BLOQUEANTE 1): `ml_publicaciones_cache.precio` NO se refresca
    // por ningún cron — solo por el refresco manual del matcher y, ahora, por el fix puntual
    // en POST /actualizar-precio (routes/precios.js) que la actualiza en el momento en que el
    // operador corrige el precio en ML. Sin ese fix esta columna podía quedar desactualizada
    // en masa y la comparación de abajo perdía sentido; con él, más la ventana de red de
    // seguridad bajada a 2h, el riesgo de frenada fantasma queda acotado.
    //
    // ACOPLAMIENTO IMPLÍCITO A VIGILAR (hallazgo del revisor, MENOR, 2026-08-06): hoy la única
    // vía que mantiene `ml_publicaciones_cache.precio` fresco es ese POST puntual. Si el día de
    // mañana se agrega OTRA vía de cambio de precio de ML (push masivo, integración nueva,
    // script de carga), esa vía tiene que sumarle el mismo par
    // actualizar-caché/borrar-frenada que hoy tiene POST /actualizar-precio — si no, esta
    // comparación local vuelve a comparar contra un valor viejo y la red de seguridad de 2h
    // queda como único mecanismo real (correcto, pero mucho más lento: hasta 2h de demora en
    // vez de instantáneo). No hay ningún chequeo automático que detecte esta desviación: es
    // responsabilidad de quien agregue esa vía nueva acordarse de este comentario.
    // Devuelve { recheck, porVentana }. `porVentana` distingue el caso puntual en que la
    // ÚNICA razón para re-consultar es que venció la ventana de 2h (red de seguridad) sin que
    // haya cambiado nada de lo que vemos localmente — ese es el caso en que el screening tiene
    // que ir en vivo (ver reactivarItems, opts.saltarCachePersistenteItems), porque si no
    // releería el mismo precio_ml/comisión/envío cacheado que ya produjo la frenada.
    function necesitaRecheck(row) {
      const frenada = frenadasPorClave.get(row.clave);
      if (!frenada) return { recheck: true, porVentana: false }; // candidata nueva, o ya no tiene frenada vigente
      const edadMs = ahoraMs - new Date(frenada.detectado_en).getTime();
      if (!(edadMs >= 0) || edadMs > VENTANA_REVALIDACION_FRENADA_MS) return { recheck: true, porVentana: true }; // red de seguridad 2h
      // Precio web nulo (regular_price vacío, ej. tras reinicio antes del refresco de
      // catálogo): AMBIGUO, no se puede afirmar "cambió" ni "no cambió" — se reevalúa contra
      // ML, que cae sola en MOTIVO_SIN_PRECIO_WEB sin persistir frenada (fail-closed, no
      // contamina la comparación ni bloquea en silencio para siempre).
      const precioWebActual = precioWebClave(db, row.clave);
      if (precioWebActual == null) return { recheck: true, porVentana: false };
      if (precioWebActual !== frenada.precio_web_evaluado) return { recheck: true, porVentana: false };
      // Mismo criterio que el precio web (hallazgo del revisor, BLOQUEANTE 2): `null !== null`
      // da `false` en JS, así que sin esta guarda un precio ML "no sé" (columna NULL) se leía
      // como "no cambió" y saltaba el recheck sin ninguna base real para esa decisión — la
      // columna puede estar NULL en masa por el motivo de arriba, así que sin esto toda la
      // protección del paso 4 se apoyaba en comparar una columna vacía contra sí misma.
      const precioMlActual = precioMlDeClave.get(row.clave)?.precio ?? null;
      if (precioMlActual == null || frenada.precio_ml_evaluado == null) return { recheck: true, porVentana: false };
      if (precioMlActual !== frenada.precio_ml_evaluado) return { recheck: true, porVentana: false };
      return { recheck: false, porVentana: false };
    }

    const itemsConRecheck = new Set();
    // FOCO (hallazgo del revisor, IMPORTANTE): item_id cuya ÚNICA razón de recheck es la
    // ventana de 2h — a esos hay que forzarles screening en vivo en reactivarItems, ver ahí.
    const itemsPorVentana = new Set();
    for (const r of rows) {
      const { recheck, porVentana } = necesitaRecheck(r);
      if (recheck) itemsConRecheck.add(r.item_id);
      if (porVentana) itemsPorVentana.add(r.item_id);
    }

    // Primero los items SIN ninguna frenada registrada (candidatos reales a reactivarse),
    // después los que ya vienen frenados: así el lote (LOTE_MAX en reactivarItems) siempre
    // avanza sobre publicaciones nuevas en vez de reprocesar por siempre el mismo bloque.
    const itemIds = [...new Set(rows.map(r => r.item_id))].filter(id => itemsConRecheck.has(id));
    const itemTieneFrenada = new Map();
    for (const r of rows) {
      if (clavesFrenadas.has(r.clave)) itemTieneFrenada.set(r.item_id, true);
    }
    itemIds.sort((a, b) => (itemTieneFrenada.get(a) ? 1 : 0) - (itemTieneFrenada.get(b) ? 1 : 0));

    // Sin nada que re-consultar: 0 llamadas a ML, todas las frenadas vigentes siguen igual.
    // saltarCachePersistenteItems viaja para que reactivarItems fuerce screening en vivo SOLO
    // en las publicaciones que entraron por la ventana de 2h (ver ahí).
    const { resultados } = itemIds.length
      ? await reactivarItems(db, cfg.ml, itemIds, { saltarCachePersistenteItems: itemsPorVentana })
      : { resultados: [] };

    let reactivadas = 0;
    let frenadas = 0;
    // Cuenta aparte del bloqueo puntual "sin precio web mapeado" (precioWebClave devolvió
    // null): NO se persiste en ml_reactivacion_frenada a propósito (no es una frenada de
    // precio, se reintenta sola en el próximo ciclo), así que sin este contador ese modo de
    // falla es indistinguible de "no había nada que hacer" en el log del cron (ver server.js,
    // hallazgo del revisor 2026-08-03: puede pasar entero el catálogo tras un reinicio, si
    // este cron corre antes que el de catálogo). No cambia ninguna decisión de reactivar/
    // bloquear, solo la visibilidad.
    let sinPrecioWeb = 0;
    const ts = now();

    for (const r of resultados) {
      if (r.ok) {
        reactivadas++;
        // Reactivada: si venía frenada por precio, ya no lo está.
        for (const v of rows.filter(x => x.item_id === r.item_id)) borrarFrenada.run(v.clave);
        continue;
      }
      if (r.error === MOTIVO_SIN_PRECIO_WEB) sinPrecioWeb++;
      // IMPORTANTE 3 (hallazgo del revisor): un item multi-variación puede traer varios
      // bloqueos por neto bajo (uno por variación), no uno solo — evaluarNetoVariaciones ya
      // no corta en la primera. Persistir frenada por CADA variación bloqueada es lo que
      // evita que el item entero vuelva a re-consultarse en cada corrida para siempre (la
      // variación sin frenada nunca satisfacía necesitaRecheck).
      if (r.bloqueado && Array.isArray(r.bloqueos)) {
        for (const b of r.bloqueos) {
          if (b.deficitPct == null || !b.clave) continue;
          frenadas++;
          guardarFrenada.run({
            clave: b.clave,
            sku: skuDeClave.get(b.clave)?.sku ?? null,
            motivo: b.error,
            neto: b.neto ?? null,
            precio_contado: b.precio_web ?? null,
            deficit_pct: b.deficitPct,
            detectado_en: ts,
            precio_ml_evaluado: b.precio_ml ?? null,
            precio_web_evaluado: b.precio_web ?? null,
          });
        }
      } else if (r.bloqueado && r.deficitPct != null && r.clave) {
        // Solo el bloqueo por neto bajo trae deficitPct. Los demás (ML caído, sin precio web)
        // no son frenadas de precio: se reintentan solos, sin ensuciar la lista.
        frenadas++;
        guardarFrenada.run({
          clave: r.clave,
          sku: skuDeClave.get(r.clave)?.sku ?? null,
          motivo: r.error,
          neto: r.neto ?? null,
          precio_contado: r.precio_web ?? null,
          deficit_pct: r.deficitPct,
          detectado_en: ts,
          // Insumos de la decisión (paso 4): permiten al próximo ciclo saltear la re-consulta
          // a ML si ninguno de los dos cambió desde acá.
          precio_ml_evaluado: r.precio_ml ?? null,
          precio_web_evaluado: r.precio_web ?? null,
        });
      }
    }

    // Barrido de huérfanas: cualquier frenada cuya clave ya no esté entre los reactivables
    // leídos al inicio de esta corrida (la publicación se reactivó a mano, se pausó por otra
    // razón, se quedó sin stock o perdió el mapeo) deja de tener sentido y se borra.
    const clavesVigentes = new Set(rows.map(r => r.clave));
    for (const clave of clavesFrenadas) {
      if (!clavesVigentes.has(clave)) borrarFrenada.run(clave);
    }

    return { omitido: false, reactivadas, frenadas, sin_precio_web: sinPrecioWeb };
  } finally {
    _reactivarEnCurso = false;
  }
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

/**
 * Filas crudas de vínculos WC↔ML (publicación mapeada + su producto de WC), listas para
 * pasarle a senalesDeVinculo. Si se pasa `sku`, se acota a ese producto.
 *
 * El dedup por SKU es el mismo criterio que COMPUTED_STOCK_CTE: si un SKU está cargado en
 * más de un producto de WC, se toma uno solo (el de menor stock) para no multiplicar filas.
 */
// Exportado: routes/cobertura.js reusa este motor para sus rutas GET /vinculos/:sku y
// GET /vinculos-sospechosos (Matcher unificado, entrega 1) — la superficie se movió, el
// cálculo se comparte (también lo usa GET /dashboard de este mismo archivo, más abajo).
export function filasDeVinculos(db, { sku = null, ordenar = true } = {}) {
  const params = [];
  let filtro = '';
  if (sku) { filtro = 'AND d.sku = ?'; params.push(sku); }
  // El ORDER BY es trabajo puro al pedo cuando solo se cuenta (contarVinculosSospechosos):
  // se puede saltear sin ensuciar la firma ni el resto de los usos.
  const orden = ordenar ? 'ORDER BY c.nombre, p.titulo, d.clave' : '';
  return db.prepare(`
    WITH catalogo_dedup AS (
      SELECT sku, nombre, stock, precio, atributos_json, img,
        ROW_NUMBER() OVER (PARTITION BY sku ORDER BY stock ASC, id_woo ASC) AS rn
      FROM catalogo_cache
      WHERE sku IS NOT NULL AND sku <> ''
    )
    SELECT d.clave, d.sku,
           p.item_id, p.variation_id, p.titulo, p.status, p.sub_status, p.color, p.talle,
           p.seller_sku, p.variations_texto, p.thumbnail, p.permalink, p.precio,
           p.available_quantity, p.precio_actualizado_en,
           c.nombre AS wc_nombre, c.stock AS stock_wc, c.precio AS precio_wc,
           c.atributos_json, c.img AS wc_img,
           e.cantidad_ml
    FROM sku_matcher_decisiones d
    JOIN catalogo_dedup c ON c.sku = d.sku AND c.rn = 1
    JOIN ml_publicaciones_cache p ON p.clave = d.clave
    LEFT JOIN ml_stock_estado e ON e.clave = d.clave
    WHERE d.accion IN ('asignar','confirmar') AND d.sku IS NOT NULL AND d.sku <> '' ${filtro}
    ${orden}
  `).all(...params);
}

/**
 * Señales vigentes de una fila: las que dispara senalesDeVinculo menos las que el usuario
 * marcó como revisadas CON EL MISMO VALOR. Si el valor cambió, el descarte no aplica y la
 * señal vuelve a aparecer — descartar significa "esta discrepancia concreta está bien".
 *
 * Igualdad ESTRICTA a propósito: `senal.valor` ya viene normalizado (compuesto, ambos lados
 * de la comparación) desde `senalesDeVinculo`, así que comparar por contención/substring
 * reintroduciría el bug que ese diseño evita — un descarte viejo taparía en silencio una
 * discrepancia nueva y distinta con un SKU/precio que casualmente sea substring del actual.
 * El cliente debe reenviar el `valor` tal cual lo recibió en la señal, sin editarlo.
 */
export function senalesVigentes(fila, descartesPorClave) {
  const descartes = descartesPorClave.get(fila.clave) || new Map();
  return senalesDeVinculo(fila).filter(s => descartes.get(s.senal) !== s.valor);
}

/** Mapa clave → Map(senal → valor_revisado), para no consultar por fila. */
export function cargarDescartes(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT clave, senal, valor_revisado FROM ml_vinculos_revisados').all()) {
    if (!m.has(r.clave)) m.set(r.clave, new Map());
    m.get(r.clave).set(r.senal, r.valor_revisado);
  }
  return m;
}

/** Cantidad de vínculos con al menos una señal vigente (para el chip del home). */
function contarVinculosSospechosos(db) {
  const descartes = cargarDescartes(db);
  let n = 0;
  for (const fila of filasDeVinculos(db, { ordenar: false })) {
    if (senalesVigentes(fila, descartes).length > 0) n++;
  }
  return n;
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
    const tieneClaveSync = db.prepare('PRAGMA table_info(sync_log)').all().some(c => c.name === 'clave');
    const errores = tieneClaveSync
      ? db.prepare(`
          SELECT COUNT(*) as n FROM sync_log s
          WHERE s.estado IN ('error','agotado','sin_mapeo','remapeo_requerido','requiere_atencion_ml')
            AND NOT EXISTS (
              SELECT 1 FROM sync_log newer
              WHERE newer.direccion IS s.direccion AND newer.clave IS s.clave
                AND (newer.creado_en > s.creado_en OR (newer.creado_en = s.creado_en AND newer.id > s.id))
            )
        `).get()
      : db.prepare("SELECT COUNT(*) as n FROM sync_log WHERE estado IN ('error','agotado','sin_mapeo','remapeo_requerido','requiere_atencion_ml')").get();

    res.json({
      ok: true,
      cursores,
      token: tokenRow
        ? { configurado: true, vence: tokenRow.expires_at, vigente: new Date(tokenRow.expires_at) > new Date() }
        : { configurado: false },
      ultimasSyncsOk: ultimosOk,
      erroresPendientes: errores?.n ?? 0,
      cooldownMl: estadoCooldownMl(),
      // Contadores de 429 sintéticos (nuestro propio freno, no rechazo de ML)
      // acumulativos desde el arranque, globales y por recurso. Vía para
      // diagnosticar sin gastar una sola llamada a ML — ver lib/mlClient.js.
      erroresMl: estadoErroresMl(),
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

  router.post('/reconciliar-stock', async (req, res) => {
    try {
      const r = await reconciliarStockMl(db, cfg);
      // omitido:true cuando ya había una corrida en curso (candado) o falta config de ML;
      // motivo distingue cuál de los dos casos fue (M8, revisor). Cada POST efectivo cuesta
      // ~5 llamadas a ML (multiget en chunks de 20) y bloquea ~7.5s (pausa entre chunks).
      res.json({
        ok: true,
        omitido: r?.omitido === true,
        motivo: r?.motivo,
        revisadas: r?.revisadas ?? 0,
        corregidas: r?.corregidas ?? 0,
        altas: r?.altas ?? 0,
        sinDato: r?.sinDato ?? 0,
        sinSku: r?.sinSku ?? 0,
        statusRefrescados: r?.statusRefrescados ?? 0,
        esperasCooldown: r?.esperasCooldown ?? 0,
      });
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
      FROM sync_log s
      WHERE s.estado IN ('error','agotado','sin_mapeo','remapeo_requerido','requiere_atencion_ml')
        AND NOT EXISTS (
          SELECT 1 FROM sync_log newer
          WHERE newer.direccion IS s.direccion AND newer.clave IS s.clave
            AND (newer.creado_en > s.creado_en OR (newer.creado_en = s.creado_en AND newer.id > s.id))
        )
      ORDER BY s.creado_en DESC, s.id DESC LIMIT 200
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

    // Reservas RETENIDAS por fail-closed: el POST a Woo fallo y no se pudo verificar si el
    // pedido llego a crearse. No se reintentan solas a proposito (reintentar puede duplicar
    // el pedido), asi que tienen que ser visibles en el panel: sin esto, la venta de ML
    // quedaria frenada sin que nadie se entere hasta revisar sync_log a mano.
    const retenidas = db.prepare(
      "SELECT ml_order_id, creado_en, retenido_en FROM ordenes_ml_wc_pedidos WHERE wc_order_id = 0 AND retenido_en IS NOT NULL ORDER BY retenido_en DESC LIMIT 20"
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
       WHERE estado='requiere_atencion_ml'
         AND NOT EXISTS (SELECT 1 FROM ml_stock_estado m WHERE m.clave = sync_log.clave AND m.actualizado_en >= sync_log.creado_en)`
    ).get().n;
    const erroresReales = db.prepare(
      `SELECT COUNT(*) n FROM sync_log s
       WHERE s.estado IN ('error','agotado')
         AND NOT EXISTS (SELECT 1 FROM errores_descartados d WHERE d.clave IS s.clave)
         AND NOT EXISTS (SELECT 1 FROM ml_stock_estado m WHERE m.clave = s.clave AND m.actualizado_en >= s.creado_en)
         AND NOT EXISTS (SELECT 1 FROM sync_log newer WHERE newer.direccion IS s.direccion AND newer.clave IS s.clave AND (newer.creado_en > s.creado_en OR (newer.creado_en = s.creado_en AND newer.id > s.id)))`
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

    // Publicaciones que la reactivación automática frenó por precio (ver /frenadas).
    const frenadas = db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n;

    res.json({
      ok: true,
      token: tokenRow
        ? { configurado: true, vence: tokenRow.expires_at, vigente: new Date(tokenRow.expires_at) > new Date() }
        : { configurado: false },
      ultimasSyncsOk: ultimasOk,
      // maxLlamadasPorCorrida (m3, ronda 2 revisor): el panel puede mostrar `pendientes` en
      // cientos con el sync funcionando bien (drena de a `maxLlamadasPorCorrida` cada 10 min);
      // sin este dato el usuario no puede distinguir "hay backlog, drena de a tope" de "el sync
      // está roto y no procesa nada". No requiere tocar public/: el front decide si lo muestra.
      stock: { sincronizadas, pendientes, pendientesPausadas, maxLlamadasPorCorrida: SYNC_WC_ML_MAX_LLAMADAS_ML_POR_CORRIDA },
      reactivables,
      pedidos: {
        total: pedidos.total ?? 0,
        cancelados: pedidos.cancelados ?? 0,
        ultimos: ultimosPedidos,
        reservasRetenidas: { total: retenidas.length, ordenes: retenidas },
      },
      atencion: {
        sin_mapeo: catMap.sin_mapeo ?? 0,
        remapeo_requerido: catMap.remapeo_requerido ?? 0,
        requiere_atencion_ml: catMap.requiere_atencion_ml ?? 0,
        errores_reales: erroresReales,
      },
      skus,
      frenadas,
      vinculos_sospechosos: contarVinculosSospechosos(db),
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
      // manual: true — reactivación disparada a mano por el usuario (acción explícita).
      const r = await reactivarItems(db, mlCfg, itemIds.map(String), { manual: true });
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

  // Publicaciones que la reactivación automática frenó por precio (neto por debajo del contado).
  router.get('/frenadas', (req, res) => {
    const data = db.prepare(`
      SELECT f.clave, f.sku, f.motivo, f.neto, f.precio_contado, f.deficit_pct, f.detectado_en,
             p.item_id, p.titulo, p.thumbnail, p.permalink, p.variations_texto
      FROM ml_reactivacion_frenada f
      LEFT JOIN ml_publicaciones_cache p ON p.clave = f.clave
      ORDER BY f.deficit_pct DESC, f.detectado_en DESC
    `).all();
    res.json({ ok: true, data });
  });

  // Override: reintentar la reactivación de publicaciones frenadas (típicamente después de
  // corregir el precio en ML, sin esperar al próximo ciclo del cron). NO saltea el chequeo de
  // neto — reactivarItems aplica chequearNetoReactivar siempre. Si el precio sigue mal, la
  // publicación vuelve a quedar frenada (fail-closed: nunca se vende a pérdida por apuro).
  router.post('/frenadas/forzar', async (req, res) => {
    if (!mlCfgOk(cfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(String).filter(Boolean) : [];
    if (itemIds.length === 0) return res.status(400).json({ ok: false, error: 'itemIds requerido' });

    // reactivarItems trunca a LOTE_MAX (50) internamente y NO avisa por sí solo: hay que
    // decírselo al cliente explícitamente, si no "forzar 80 frenadas" parece haber procesado
    // las 80 cuando en realidad solo tocó 50 y las 30 restantes quedaron intactas sin rastro.
    // manual: true — override disparado a mano por el usuario tras corregir el precio.
    const { procesados, resultados } = await reactivarItems(db, mlCfg, itemIds, { manual: true });
    // Borra las frenadas de las claves que pertenecen a las publicaciones que salieron OK.
    // La subconsulta trae TODAS las claves cacheadas de ese item_id (una publicación con
    // variaciones tiene varias claves): correcto, porque chequearNetoReactivar evalúa el
    // precio a nivel publicación (todas sus variaciones juntas), así que si el item quedó
    // ok=true todas sus frenadas pendientes quedaron resueltas y corresponde borrarlas todas.
    const borrar = db.prepare('DELETE FROM ml_reactivacion_frenada WHERE clave IN (SELECT clave FROM ml_publicaciones_cache WHERE item_id = ?)');
    for (const r of resultados) {
      if (r.ok) borrar.run(r.item_id);
    }
    res.json({
      ok: true,
      pedidos: itemIds.length,
      procesados,
      truncado: itemIds.length > procesados,
      resultados,
    });
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
      exclude: "NOT EXISTS (SELECT 1 FROM ml_stock_estado m WHERE m.clave IS s.clave AND m.actualizado_en >= s.creado_en) AND NOT EXISTS (SELECT 1 FROM sync_log newer WHERE newer.direccion IS s.direccion AND newer.clave IS s.clave AND (newer.creado_en > s.creado_en OR (newer.creado_en = s.creado_en AND newer.id > s.id)))",
    },
    errores: {
      estados: "'error','agotado'",
      exclude: "NOT EXISTS (SELECT 1 FROM ml_stock_estado m WHERE m.clave = s.clave AND m.actualizado_en >= s.creado_en) AND NOT EXISTS (SELECT 1 FROM errores_descartados d WHERE d.clave IS s.clave) AND NOT EXISTS (SELECT 1 FROM sync_log newer WHERE newer.direccion IS s.direccion AND newer.clave IS s.clave AND (newer.creado_en > s.creado_en OR (newer.creado_en = s.creado_en AND newer.id > s.id)))",
    },
  };

  router.get('/atencion/:cat', async (req, res) => {
    const def = ATENCION_DEFS[req.params.cat];
    if (!def) return res.status(400).json({ ok: false, error: 'categoría inválida' });
    const incluyeClaveNula = req.params.cat === 'errores';
    const filtroClave = incluyeClaveNula ? '' : 'AND s.clave IS NOT NULL';
    const agrupacion = incluyeClaveNula ? 's.direccion, s.clave' : 's.clave';
    // Total real (sin LIMIT), para no reportar el tope de la query como si fuera el total.
    const totalReal = db.prepare(`
      SELECT COUNT(*) n FROM (
        SELECT s.clave
        FROM sync_log s
        WHERE s.estado IN (${def.estados})
          ${filtroClave}
          AND ${def.exclude}
        GROUP BY ${agrupacion}
      )
    `).get().n;
    // GROUP BY clave con MAX(creado_en): SQLite toma sku/error de la fila más reciente.
    const rows = db.prepare(`
      SELECT s.clave, s.sku, s.error, s.estado, s.creado_en,
             p.item_id, p.variation_id, p.titulo, p.variations_texto, p.status AS ml_status, p.thumbnail
      FROM sync_log s
      LEFT JOIN ml_publicaciones_cache p ON p.clave = s.clave
      WHERE s.estado IN (${def.estados})
        ${filtroClave}
        AND ${def.exclude}
      ${incluyeClaveNula ? '' : 'GROUP BY s.clave'}
      ORDER BY s.creado_en DESC, s.id DESC
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

    // total = COUNT real (no el LIMIT); truncado avisa cuando rows quedó recortado.
    res.json({ ok: true, cat: req.params.cat, total: totalReal, truncado: totalReal > rows.length, data: rows });
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
    // Atómico: si el borrado de descartes fallara a mitad de camino, la clave quedaría
    // reasignable pero con descartes del vínculo anterior todavía vivos, tapando en silencio
    // señales legítimas del vínculo que la remapee después.
    const info = db.transaction(() => {
      const r = db.prepare('DELETE FROM sku_matcher_decisiones WHERE clave = ?').run(clave);
      // Los descartes de sospechosos valían para el vínculo anterior, no para el que le toque después.
      db.prepare('DELETE FROM ml_vinculos_revisados WHERE clave = ?').run(clave);
      return r;
    })();
    logSync(db, { direccion: 'wc_ml', clave, estado: 'remapeo_requerido', error: 'desvinculada manualmente para re-mapear' });
    res.json({ ok: true, borradas: info.changes });
  });

  // GET /vinculos/:sku, GET /vinculos-sospechosos, POST /vinculos/revisado y
  // POST /vinculos/reasignar se MOVIERON a routes/cobertura.js (Matcher unificado, entrega 1,
  // 2026-08-14): eran la única superficie de public/vinculos/index.html, que se retira (ver
  // el redirect de /vinculos en server.js). El motor que usaban (filasDeVinculos,
  // cargarDescartes, senalesVigentes, logSync, arriba en este archivo) se exporta y se sigue
  // usando desde acá también (GET /dashboard, más abajo, para `vinculos_sospechosos`).
  //
  // POST /desvincular (arriba) NO se movió — sigue siendo el que usa
  // public/sync-detalle/index.html (otra herramienta, otro permiso). routes/cobertura.js
  // agregó su propio POST /vinculos/:clave/desvincular (admin-only) para la superficie del
  // Matcher, en vez de reusar este endpoint compartido.

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
      // manual: true — reintento puntual disparado a mano desde el panel.
      const resp = await mlFetch(db, mlCfg, 'put', path, body, { manual: true });
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
    const like = armarLike(q);
    const soloVar = req.query.tipo !== 'all';
    const rows = db.prepare(`
      SELECT sku, nombre, stock, tipo FROM catalogo_cache
      WHERE (sku LIKE ? ESCAPE '\\' OR nombre LIKE ? ESCAPE '\\') AND sku <> ''
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

  // ── Config ML masiva ────────────────────────────────────────────────────────
  // Reutiliza el mismo criterio de dedup por SKU que /config-ml y COMPUTED_STOCK_CTE
  // (menor stock, menor id_woo): un SKU repetido en catalogo_cache es siempre dato sucio,
  // nunca un caso de negocio legítimo, y elegir el mínimo es fail-closed (no sobrevende).
  const CATALOGO_DEDUP_CTE = `
    WITH catalogo_dedup AS (
      SELECT sku, nombre, marca, stock, categorias_json,
        ROW_NUMBER() OVER (PARTITION BY sku ORDER BY stock ASC, id_woo ASC) AS rn
      FROM catalogo_cache
      WHERE sku IS NOT NULL AND sku <> ''
    )
  `;

  const ESTADOS_VALIDOS = ['sin_config', 'solo_local', 'reserva'];

  // Arma el WHERE + params del filtro (q/marca/estado/categoria), compartido por el GET y
  // el resolver de "todo el filtro" del POST /lote — evita mantener dos SQLs en paralelo.
  // orden/dir/estado NUNCA se interpolan crudos: siempre pasan por whitelist antes de esto.
  // Escapa los comodines propios de LIKE (%, _) y la barra de escape misma, para que un `q`
  // con esos caracteres literales (ej. "50%" o "A_B") no traiga de más — sin esto, ese "más"
  // se arrastra tal cual al lote si el operador después aplica "todo el filtro".
  // Usa armarLike (lib/busqueda.js), el mismo helper que /buscar-sku: misma semántica de
  // escape (ya viene envuelto en %...%), evita mantener dos implementaciones equivalentes.
  function construirFiltroCatalogo({ q, marca, estado, categoria }) {
    const clausulas = [];
    const params = [];
    if (q) {
      const qLike = armarLike(q);
      clausulas.push("(c.sku LIKE ? ESCAPE '\\' OR c.nombre LIKE ? ESCAPE '\\')");
      params.push(qLike, qLike);
    }
    if (marca) {
      clausulas.push('c.marca = ?');
      params.push(marca);
    }
    if (categoria) {
      // categorias_json es un array JSON embebido (ej. ["Cascos","Indumentaria"]), no una
      // columna propia — se resuelve con json_each de sqlite (extensión JSON1, siempre
      // disponible en better-sqlite3) en vez de traer todo a JS y filtrar ahí: así el
      // filtro sigue viviendo en el WHERE de SQL y no rompe la paginación/el total ni
      // obliga a escanear el catálogo entero en Node en cada request. json_valid() cubre
      // el caso NULL/JSON corrupto sin que json_each tire error y rompa la consulta.
      clausulas.push('(c.categorias_json IS NOT NULL AND json_valid(c.categorias_json) AND EXISTS (SELECT 1 FROM json_each(c.categorias_json) WHERE value = ?))');
      params.push(categoria);
    }
    if (estado === 'sin_config') clausulas.push('s.sku IS NULL');
    else if (estado === 'solo_local') clausulas.push("s.modo = 'solo_local'");
    else if (estado === 'reserva') clausulas.push("s.modo = 'reserva'");
    return { where: clausulas.length ? 'AND ' + clausulas.join(' AND ') : '', params };
  }

  // Catálogo completo (todas las variaciones/simples con SKU) + config ML de cada uno,
  // haya o no fila en skus_config_ml. Base para elegir SKUs a granel desde el frontend.
  router.get('/catalogo-config', (req, res) => {
    const q = String(req.query.q || '').trim();
    const marca = String(req.query.marca || '').trim();
    const categoria = String(req.query.categoria || '').trim();
    const estado = String(req.query.estado || '').trim();
    if (estado && !ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({ ok: false, error: `estado debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}` });
    }

    // Whitelist de orden/dir: nunca se interpola el valor del usuario en el SQL.
    const ORDEN_MAP = { nombre: 'c.nombre', stock: 'c.stock', sku: 'c.sku', marca: 'c.marca' };
    const ordenParam = String(req.query.orden || 'nombre');
    if (!ORDEN_MAP[ordenParam]) {
      return res.status(400).json({ ok: false, error: `orden debe ser uno de: ${Object.keys(ORDEN_MAP).join(', ')}` });
    }
    const dirParam = String(req.query.dir || 'asc').toLowerCase();
    if (!['asc', 'desc'].includes(dirParam)) {
      return res.status(400).json({ ok: false, error: 'dir debe ser asc o desc' });
    }

    let limite = parseInt(req.query.limite, 10);
    if (!Number.isFinite(limite) || limite <= 0) limite = 100;
    limite = Math.min(limite, 500);
    let offset = parseInt(req.query.offset, 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const { where, params } = construirFiltroCatalogo({ q, marca, estado, categoria });

    const baseFrom = `
      ${CATALOGO_DEDUP_CTE}
      SELECT c.sku, c.nombre, c.marca, COALESCE(c.stock, 0) AS stock_wc, s.modo,
        COALESCE(s.reserva, 0) AS reserva,
        CASE
          WHEN s.modo = 'solo_local' THEN 0
          WHEN s.modo = 'reserva' THEN MAX(COALESCE(c.stock, 0) - COALESCE(s.reserva, 0), 0)
          ELSE MAX(COALESCE(c.stock, 0), 0)
        END AS stock_disponible_ml
      FROM catalogo_dedup c
      LEFT JOIN skus_config_ml s ON s.sku = c.sku
      WHERE c.rn = 1 ${where}
    `;

    const total = db.prepare(`SELECT COUNT(*) AS n FROM (${baseFrom})`).get(...params).n;
    const data = db.prepare(`${baseFrom} ORDER BY ${ORDEN_MAP[ordenParam]} ${dirParam.toUpperCase()} LIMIT ? OFFSET ?`)
      .all(...params, limite, offset);

    const respuesta = { ok: true, data, total };

    // marcas/categorias no cambian con el filtro ni con la página — armarlas es un full scan
    // de catalogo_cache con parseo JSON en JS (medido ~3-4ms) que no vale la pena pagar en
    // cada tecleo del buscador ni en cada cambio de página. Solo se calculan cuando el
    // frontend las pide explícitamente (primera carga de la pantalla), con ?facetas=1.
    if (String(req.query.facetas || '') === '1') {
      // Marcas del catálogo completo (no del filtro) para poblar el desplegable.
      respuesta.marcas = db.prepare(`
        SELECT DISTINCT marca FROM catalogo_cache WHERE marca IS NOT NULL AND marca <> '' ORDER BY marca ASC
      `).all().map(r => r.marca);
      // Categorías distintas de TODO el catálogo (no del filtro), igual criterio que marcas.
      // categorias_json es un array por fila, así que el DISTINCT no sirve a nivel columna:
      // se parsea en JS con el mismo helper que ya usa cobertura (tolera NULL/JSON inválido)
      // y se deduplica con un Set — el catálogo completo es chico (miles de filas, no
      // millones), así que un solo recorrido en Node es más simple que json_each + GROUP BY
      // en SQL acá.
      const categoriasSet = new Set();
      for (const row of db.prepare('SELECT categorias_json FROM catalogo_cache').all()) {
        for (const cat of parseCategorias(row.categorias_json)) {
          const limpio = String(cat ?? '').trim();
          if (limpio) categoriasSet.add(limpio);
        }
      }
      respuesta.categorias = [...categoriasSet].sort((a, b) => a.localeCompare(b));
    }

    res.json(respuesta);
  });

  // Resuelve los SKUs (existentes en catalogo_cache) que matchean un filtro, sin paginar —
  // usado por el POST /lote cuando viene { filtro } en vez de { skus }.
  function resolverSkusPorFiltro({ q, marca, estado, categoria }) {
    const { where, params } = construirFiltroCatalogo({ q, marca, estado, categoria });
    const rows = db.prepare(`
      ${CATALOGO_DEDUP_CTE}
      SELECT c.sku FROM catalogo_dedup c
      LEFT JOIN skus_config_ml s ON s.sku = c.sku
      WHERE c.rn = 1 ${where}
    `).all(...params);
    return rows.map(r => r.sku);
  }

  // Trae { sku -> nombre } (mismo dedup) para los SKUs de una lista, en chunks para no pisar
  // el límite de parámetros de sqlite (~999) con lotes grandes.
  const CHUNK_SQLITE = 400;
  function nombresPorSku(skus) {
    const mapa = new Map();
    for (let i = 0; i < skus.length; i += CHUNK_SQLITE) {
      const chunk = skus.slice(i, i + CHUNK_SQLITE);
      if (!chunk.length) continue;
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT sku, nombre FROM (
          SELECT sku, nombre, stock, id_woo,
            ROW_NUMBER() OVER (PARTITION BY sku ORDER BY stock ASC, id_woo ASC) AS rn
          FROM catalogo_cache
          WHERE sku IN (${placeholders})
        ) WHERE rn = 1
      `).all(...chunk);
      for (const r of rows) mapa.set(r.sku, r.nombre);
    }
    return mapa;
  }

  // De una lista de SKUs, cuáles ya tienen fila en skus_config_ml (para pisados/sin_cambio).
  function tienenConfigPrevia(skus) {
    const set = new Set();
    for (let i = 0; i < skus.length; i += CHUNK_SQLITE) {
      const chunk = skus.slice(i, i + CHUNK_SQLITE);
      if (!chunk.length) continue;
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`SELECT sku FROM skus_config_ml WHERE sku IN (${placeholders})`).all(...chunk);
      for (const r of rows) set.add(r.sku);
    }
    return set;
  }

  // Config ML masiva: aplica reserva/solo_local/quitar a muchos SKUs de una, ya sea una lista
  // pegada a mano o "todo lo que matchea el filtro actual". No llama a ML ni a Woo (es
  // operación 100% local sobre skus_config_ml) — no aplica la política fail-closed/fail-open
  // de reintentos hacia servicios externos, solo la transaccionalidad local.
  router.post('/config-ml/lote', (req, res) => {
    const body = req.body || {};
    const { accion, reserva, vista_previa } = body;

    if (!['reserva', 'solo_local', 'quitar'].includes(accion)) {
      return res.status(400).json({ ok: false, error: 'accion debe ser reserva|solo_local|quitar' });
    }

    let reservaVal = 0;
    if (accion === 'reserva') {
      // Chequeo estricto de tipo: Number("") === 0 y Number(null) === 0 harían pasar una
      // reserva "vacía" disfrazada de reserva 0 real. Solo se acepta un number JS genuino.
      if (typeof reserva !== 'number' || !Number.isInteger(reserva) || reserva < 0) {
        return res.status(400).json({ ok: false, error: 'reserva debe ser un entero >= 0' });
      }
      reservaVal = reserva;
    }

    // skus y filtro son excluyentes: se valida por presencia de la clave, no por su verdad,
    // para poder distinguir { skus: [] } (lista vacía explícita, igual 400 más abajo) de
    // "no vino nada".
    const tieneSkus = Object.prototype.hasOwnProperty.call(body, 'skus');
    const tieneFiltro = Object.prototype.hasOwnProperty.call(body, 'filtro');
    if (tieneSkus === tieneFiltro) {
      return res.status(400).json({ ok: false, error: 'Debe indicarse exactamente uno: skus o filtro' });
    }

    let skusList;
    if (tieneSkus) {
      if (!Array.isArray(body.skus)) {
        return res.status(400).json({ ok: false, error: 'skus debe ser un array' });
      }
      const vistos = new Set();
      skusList = [];
      for (const s of body.skus) {
        const t = String(s ?? '').trim();
        if (!t || vistos.has(t)) continue;
        vistos.add(t);
        skusList.push(t);
      }
    } else {
      const filtro = body.filtro;
      if (!filtro || typeof filtro !== 'object' || Array.isArray(filtro)) {
        return res.status(400).json({ ok: false, error: 'filtro debe ser un objeto' });
      }
      const estado = String(filtro.estado || '').trim();
      if (estado && !ESTADOS_VALIDOS.includes(estado)) {
        return res.status(400).json({ ok: false, error: `filtro.estado debe ser uno de: ${ESTADOS_VALIDOS.join(', ')}` });
      }
      skusList = resolverSkusPorFiltro({
        q: String(filtro.q || '').trim(),
        marca: String(filtro.marca || '').trim(),
        categoria: String(filtro.categoria || '').trim(),
        estado,
      });
    }

    if (skusList.length > 5000) {
      return res.status(400).json({ ok: false, error: `Máximo 5000 SKUs por request (se recibieron ${skusList.length})` });
    }

    // Guard fail-closed contra doble resolución del filtro: entre la vista previa y la
    // confirmación puede correr un refresco de catálogo (Woo) o los crons y el universo
    // resuelto cambiar — el operador confirmó "812" pero se aplicarían "850". Si viene
    // `esperados` (lo que devolvió la vista previa) y no coincide con lo resuelto AHORA,
    // se corta antes de escribir nada y se pide re-previsualizar.
    if (Object.prototype.hasOwnProperty.call(body, 'esperados') && body.esperados !== skusList.length) {
      return res.status(409).json({
        ok: false,
        error: `El catálogo cambió desde la vista previa (esperados=${body.esperados}, ahora=${skusList.length}); volvé a previsualizar antes de aplicar.`,
      });
    }

    // Los SKUs que no existen en catalogo_cache no se aplican (fail-closed: no crear config
    // "huérfana" con un nombre inventado) — se informan aparte para que el operador vea
    // qué tipeó mal si pegó una lista a mano.
    const catalogoMap = nombresPorSku(skusList);
    const aplicadosSkus = skusList.filter(s => catalogoMap.has(s));
    const inexistentes = skusList.filter(s => !catalogoMap.has(s));

    const configPrevia = tienenConfigPrevia(aplicadosSkus);
    const pisados = accion !== 'quitar' ? aplicadosSkus.filter(s => configPrevia.has(s)).length : 0;
    const sinCambio = accion === 'quitar' ? aplicadosSkus.filter(s => !configPrevia.has(s)).length : 0;

    const resumen = {
      solicitados: skusList.length,
      aplicados: aplicadosSkus.length,
      pisados,
      sin_cambio: sinCambio,
      inexistentes,
    };

    // Guard de una operación destructiva: se exige el booleano explícito, no truthiness —
    // un `"false"` string o un `0` no deben colarse como "aplicar de verdad".
    if (vista_previa === true) {
      return res.json({ ok: true, vista_previa: true, resumen, esperados: skusList.length });
    }

    // Todo el lote en una transacción: si algo falla a mitad de camino, no queda la mitad de
    // los SKUs con config nueva y la otra mitad sin tocar.
    const aplicarLote = db.transaction((lista) => {
      if (accion === 'quitar') {
        const del = db.prepare('DELETE FROM skus_config_ml WHERE sku = ?');
        for (const sku of lista) del.run(sku);
      } else {
        const ts = now();
        const upsert = db.prepare(`
          INSERT INTO skus_config_ml (sku, nombre, modo, reserva, actualizado_en)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(sku) DO UPDATE SET
            nombre = excluded.nombre,
            modo = excluded.modo,
            reserva = excluded.reserva,
            actualizado_en = excluded.actualizado_en
        `);
        for (const sku of lista) {
          const nombre = catalogoMap.get(sku) || sku;
          upsert.run(sku, nombre, accion, accion === 'reserva' ? reservaVal : 0, ts);
        }
      }
    });
    aplicarLote(aplicadosSkus);

    res.json({ ok: true, vista_previa: false, resumen });
  });

  return router;
}
