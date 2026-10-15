/**
 * Sincronización bidireccional WooCommerce ↔ MercadoLibre.
 *
 * syncMlToWc: pull de órdenes pagadas ML → descuenta stock en WC
 * syncWcToMl: push de diffs de stock WC → actualiza available_quantity en ML
 * procesarReintentos: reprocesa sync_log con estado='error' (máx MAX_RETRIES intentos)
 * syncRouter: Express Router con endpoints manuales de control
 */

import { Router } from 'express';
import { compararProductos } from '../lib/comparacionProductos.js';
import { mlFetch, bootstrapToken, estadoCooldownMl, estadoErroresMl } from '../lib/mlClient.js';
import { requireAdmin } from '../lib/auth.js';
import { abrirOActualizarIncidente, confirmarCicloSano } from '../lib/incidentes.js';
import { descontarOrdenVieja, destinoActual, fechaOrdenMs, avisarCancelacionDescontada, avisarCanceladaLuegoPagada } from '../lib/descuentoOrdenVieja.js';
import { encolarProductoWoo, encolarTrabajo, reclamarTrabajos, cerrarTrabajo, reencolarTrabajo, diferirTrabajo, guardarContextoTrabajo, ordenMlAfectaASkus } from '../lib/trabajosRecurso.js';
import { registrarCorrida } from '../lib/barridoCorridas.js';
import { skuDesdeMl, publicacionesDesdeWc, descartarVariacionMuerta, autoVincularPorSellerSku } from '../lib/mlMapeo.js';
import { buscarEnCache } from '../lib/wooStock.js';
import { wooFetch, refrescarProductoPuntual } from './woo.js';
import { skusConBajaWoo, levantarBajasReaparecidas } from '../lib/wooBajas.js';
import { FILTRO_MARKETPLACE } from '../lib/identidadProductos.js';
import { netoMl, veredictoNeto, precioWebClave, precioContado, totalContado } from '../lib/mlPrecios.js';
import { senalesDeVinculo } from '../lib/vinculosSenales.js';
import { norm, tsr } from '../lib/matcherEngine.js';
import { partirClaveMl, extraerErrorMl, tipoLogisticaMl } from '../lib/mlUtil.js';
import { normalizarOrdenMl, billingWcDesdeOrdenMl } from '../lib/modelos/ordenVenta.js';
import { mapConLimite } from '../lib/concurrencia.js';
import { armarLike } from '../lib/busqueda.js';
import { parseCategorias } from '../lib/modelos/producto.js';
import { retenerPedidoMl, pedidoMlRetenido, claveFrenadaParaVenta, claveCubiertaParaVenta, ignoraVentas, esNoSincronizar, skuUnicoEnCatalogo } from '../lib/guardiaMl.js';
import { modoProteccion, sqlFrenaIdentidad, frenaIdentidad, clavesSinVinculoAFrenar, CLASIFICACIONES_SIN_VINCULO, planR4, R4_MAX_POR_CORRIDA } from '../lib/proteccionIdentidad.js';
import { espera } from '../lib/esperas.js';
import { skusConocidosOrdenWoo } from '../lib/wooOrdenSkus.js';
import { listarPausadasConStock, resumenSoloLocal, CAUSAS as CAUSAS_PAUSA } from '../lib/pausadasConStock.js';
import { encoladasSinEjecutar } from '../lib/identidadAlarmas.js';
import { contradiccionDeClave } from '../lib/contradiccionTitulo.js';
import {
  buildMlStockUpdate, escribirStockMl, ACCIONES_VINCULO, resolverBolsa, conCandados, insertarBarrera, borrarBarreraDeOrden, confirmarBarreraConPedido,
  intentarLiberarFila, filasBarrera, idBarrera, releerStockGestores, gestoresDeFilas, verificarManageStockWoo, stockWooPausado,
  leerEstado, guardarEstado, confirmarDescuentoLinea,
} from '../lib/stockBarrera.js';

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
const VERIF_INEXISTENCIA_MAX_PAGINAS = 20;
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

/**
 * ¿Este SKU resuelve a exactamente un producto del catálogo WC?
 *
 * Deliberadamente NO usa `buscarEnCache`, que ante un SKU repetido elige el de menor stock:
 * ese desempate sirve para elegir entre variaciones ya vinculadas, no para aceptar como
 * identidad un SKU que nadie verificó. Acá la ambigüedad tiene que decir "no".
 */
// Ventas pagas retenidas por Guardia ML, para el chip de "Requiere tu atención" del inicio
// (plan 2026-09-13-guardia-ventas-retenidas.md). Fail-open: sin tabla (bases de test mínimas) → 0.
function contarVentasRetenidasGuardia(db) {
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM guardia_ml_pedidos_retenidos WHERE estado = 'retenido'").get().n;
  } catch (e) {
    if (!/no such table/i.test(e.message)) console.error('dashboard: no se pudo contar ventas retenidas de Guardia ML:', e.message);
    return 0;
  }
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

// buildMlStockUpdate vive en lib/stockBarrera.js (puerta única de escritura de stock); se re-exporta para los callers existentes.
export { buildMlStockUpdate };

/** Puerta única antes de cualquier PUT de available_quantity hacia ML. */
export function bloquearStockPorContradiccion(db, { clave, sku, cantidad, cantAnterior = null, cache = null } = {}) {
  if (Number(cantidad) <= 0) return { bloqueado: false };
  let contradiccion = cache?.get(clave);
  if (contradiccion === undefined) {
    contradiccion = contradiccionDeClave(db, clave, sku);
    cache?.set(clave, contradiccion);
  }
  if (!contradiccion.contradice) return { bloqueado: false, contradiccion };
  logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior, cantNueva: cantidad,
    estado: 'bloqueado_contradiccion', error: JSON.stringify(contradiccion.motivos) });
  return { bloqueado: true, contradiccion, cantidad };
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
const COMPUTED_STOCK_CTE_ACTUAL = `
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

// Fase C (spec 2026-10-07-fase-c-una-proteccion.md, R2): una sola protección. En modo `activo` la CTE ya no mira
// Guardia: las claves que frena Identidad (`sqlFrenaIdentidad`) no se excluyen, se mandan con stock 0 (el sync
// pone available_quantity=0, no pausa) y vuelven solas con el stock de Woo cuando el caso se resuelve. En `sombra`
// y `apagado` la CTE es exactamente la de hoy (COMPUTED_STOCK_CTE_ACTUAL): lo que se manda a ML no cambia.
const COMPUTED_STOCK_CTE_ACTIVO = `
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
        WHEN ${sqlFrenaIdentidad('d.clave', 'd.sku')} THEN 0
        WHEN cfg.modo = 'solo_local' THEN 0
        WHEN cfg.modo = 'reserva' THEN MAX(c.stock - COALESCE(cfg.reserva, 0), 0)
        ELSE MAX(c.stock, 0)
      END AS stock_disponible_ml,
      e.cantidad_ml, e.actualizado_en AS ml_stock_actualizado_en,
      CASE WHEN ${sqlFrenaIdentidad('d.clave', 'd.sku')} THEN 1 ELSE 0 END AS frena_identidad
    FROM sku_matcher_decisiones d
    JOIN catalogo_dedup c ON c.sku = d.sku AND c.rn = 1
    LEFT JOIN ml_stock_estado e ON e.clave = d.clave
      LEFT JOIN skus_config_ml cfg ON cfg.sku = d.sku
      WHERE d.accion IN ('asignar','confirmar')
      AND d.sku IS NOT NULL AND d.sku <> ''
  )`;


/**
 * Fase C, paso 5: reporte de sombra. Compara lo que el sync manda hoy (CTE actual) con lo que mandaría en `activo`,
 * sin escribir nada: el autovínculo se simula dentro de un SAVEPOINT que se revierte.
 */
export function reporteSombraFaseC(db) {
  const leer = (cte) => new Map(db.prepare(`${cte} SELECT clave, sku, stock_disponible_ml AS s, cantidad_ml FROM computed`).all().map((r) => [r.clave, r]));
  const actual = leer(COMPUTED_STOCK_CTE_ACTUAL);
  const activo = leer(COMPUTED_STOCK_CTE_ACTIVO);
  const cambian = [];
  let sinCambio = 0;
  for (const [clave, r] of activo) {
    const antes = actual.has(clave) ? actual.get(clave).s : null;
    if (antes === r.s) { sinCambio++; continue; }
    const f = frenaIdentidad(db, clave);
    cambian.push({ clave, sku: r.sku, antes, despues: r.s, regla: f.frena ? f.motivo : (antes === null ? 'guardia_deja_de_bloquear' : 'otra') });
  }
  const antesDecisiones = new Set(db.prepare('SELECT clave FROM sku_matcher_decisiones').all().map((r) => r.clave));
  db.exec('SAVEPOINT fase_c_sombra');
  let seVincularian = [];
  try {
    autoVincularPorSellerSku(db);
    seVincularian = db.prepare("SELECT clave, sku FROM sku_matcher_decisiones WHERE origen='auto_seller_sku'").all().filter((r) => !antesDecisiones.has(r.clave));
  } finally {
    db.exec('ROLLBACK TO fase_c_sombra; RELEASE fase_c_sombra');
  }
  const vinculables = new Set(seVincularian.map((x) => x.clave));
  const r4 = clavesSinVinculoAFrenar(db).filter((x) => !vinculables.has(x.clave));
  const porClasif = (filas) => filas.reduce((a, x) => { a[x.clasificacion] = (a[x.clasificacion] || 0) + 1; return a; }, {});
  const resto = db.prepare(`SELECT p.clave, ic.clasificacion FROM ml_publicaciones_cache p
    JOIN identidad_casos ic ON ic.direccion='ml_fusion' AND ic.ml_key=p.clave AND ic.estado IN ('urgente','tomado','pendiente','intervencion')
    WHERE p.status='active' AND COALESCE(p.available_quantity,0)>0
      AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave=p.clave)`).all()
    .filter((x) => !CLASIFICACIONES_SIN_VINCULO.includes(x.clasificacion));
  return {
    modo: modoProteccion(),
    sin_cambio: sinCambio,
    cambian,
    se_vincularian: seVincularian,
    a_cero_por_r4: { total: r4.length, se_aplicaria: planR4(db).omitido ? false : true, omitido: planR4(db).omitido, tope: R4_MAX_POR_CORRIDA, por_clasificacion: porClasif(r4), claves: r4.map((x) => ({ clave: x.clave, clasificacion: x.clasificacion, cantidad_ml: x.cantidad_ml })) },
    sin_decision_sin_frenar: { total: resto.length, por_clasificacion: porClasif(resto) },
  };
}

/** La CTE de stock según el modo de protección (IDENTIDAD_PROTECCION). Se evalúa en cada uso: pm2 restart la cambia. */
export function computedStockCte(env = process.env) {
  return modoProteccion(env) === 'activo' ? COMPUTED_STOCK_CTE_ACTIVO : COMPUTED_STOCK_CTE_ACTUAL;
}

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

/**
 * Barrido de respaldo por `order.date_last_updated` (doc oficial de ML). Pagar una orden cambia su `date_last_updated`, así que
 * una creada hace 30 días y pagada hoy aparece sin retroceder días fijos.
 *
 * Ventana FIJA por corrida: from = cursor − solape (`ML_POLLING_SOLAPE_MIN`, 60 min), to = ahora; ambos constantes durante todo
 * el recorrido (ML ordena por creación, no por actualización, y pagina por offset: sin ventana fija el cursor podía avanzar
 * sin haber visto todo). Se recorren TODAS las páginas; el cursor propio (`ml_polling_actualizadas_hasta`) avanza a `to` (no al
 * máximo visto) y SOLO si el recorrido completo terminó sin error: una página fallida lo deja intacto. Si el offset llega al
 * tope de ML la ventana se parte en dos; si no se puede partir más, incidente crítico y el cursor no se mueve. Como ML puede
 * mover una orden fuera de la ventana mientras se pagina (se actualiza de nuevo → `date_last_updated` > to) y eso corre los
 * offsets, se compara `paging.total` antes y después: si cambió se repite el recorrido (hasta 3 veces) y, si sigue inestable,
 * el cursor no avanza. Las repetidas por el solape o el desplazamiento se cubren con la idempotencia de siempre (selladas,
 * reserva, fila de descuento).
 */
const POLLING_CURSOR = 'ml_polling_actualizadas_hasta';
const POLLING_PAGINA = 50;
const maxOffsetMl = () => { const n = Number(process.env.ML_BUSQUEDA_MAX_OFFSET); return Number.isFinite(n) && n >= 100 ? n : 10000; }; // tope de offset de /orders/search
const POLLING_REINTENTOS_INESTABLE = 3;
const POLLING_VENTANA_MINIMA_MS = 60 * 1000;

export function desdePollingMl(base) {
  const m = Number(process.env.ML_POLLING_SOLAPE_MIN);
  const solape = (Number.isFinite(m) && m >= 0 ? m : 60) * 60 * 1000;
  const t = Date.parse(base);
  return new Date((Number.isFinite(t) ? t : Date.now() - 30 * 24 * 3600 * 1000) - solape).toISOString();
}

async function paginarVentanaMl(db, mlCfg, desdeMs, hastaMs, procesar) {
  const f = encodeURIComponent(new Date(desdeMs).toISOString());
  const t = encodeURIComponent(new Date(hastaMs).toISOString());
  const base = `/orders/search?seller=${mlCfg.userId}&order.status=paid&sort=date_asc&order.date_last_updated.from=${f}&order.date_last_updated.to=${t}`;
  for (let intento = 0; intento < POLLING_REINTENTOS_INESTABLE; intento++) {
    let offset = 0;
    let total = null;
    for (;;) {
      if (offset + POLLING_PAGINA > maxOffsetMl()) {
        if (hastaMs - desdeMs <= POLLING_VENTANA_MINIMA_MS) throw new Error(`ventana de ${hastaMs - desdeMs} ms con más de ${maxOffsetMl()} órdenes: no se puede partir más`);
        const mitad = Math.floor((desdeMs + hastaMs) / 2);
        await paginarVentanaMl(db, mlCfg, desdeMs, mitad, procesar);
        await paginarVentanaMl(db, mlCfg, mitad, hastaMs, procesar);
        return;
      }
      const resp = await mlFetch(db, mlCfg, 'get', `${base}&offset=${offset}&limit=${POLLING_PAGINA}`);
      if (resp.status !== 200) throw new Error(`error API ML ${resp.status} en la página offset=${offset}`);
      if (total === null && Number.isFinite(resp.data?.paging?.total)) total = resp.data.paging.total;
      const ordenes = resp.data?.results ?? [];
      for (const orden of ordenes) await procesar(orden);
      offset += ordenes.length;
      if (ordenes.length < POLLING_PAGINA) break;
    }
    if (total === null) return; // ML no informa paging.total: no hay forma de comprobar estabilidad
    const fin = await mlFetch(db, mlCfg, 'get', `${base}&offset=0&limit=1`);
    if (fin.status !== 200) throw new Error(`error API ML ${fin.status} al comprobar la estabilidad de la ventana`);
    // Invariante: `to` es fijo y está en el pasado, y `date_last_updated` solo crece. Ninguna orden puede ENTRAR a la ventana durante
    // el recorrido (tendría que bajar su fecha); una que se actualiza de nuevo SALE (pasa a > to) y el total baja. Por eso comparar el
    // total antes/después detecta todo corrimiento de offsets (no existe un "una entra y otra sale" que deje el total igual).
    if (!Number.isFinite(fin.data?.paging?.total) || fin.data.paging.total === total) return;
  }
  throw new Error('la ventana cambió durante el recorrido en cada intento (órdenes que entran o salen): no se avanza el cursor');
}

/** ¿Sellada, o con una fila de descuento / reserva / retención de la Guardia que la retoma otro camino? (una sola consulta) */
function ordenRetomada(db, id) {
  const r = db.prepare(`SELECT
      EXISTS(SELECT 1 FROM ordenes_ml_procesadas WHERE order_id = @id)
      OR EXISTS(SELECT 1 FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = @id)
      OR EXISTS(SELECT 1 FROM ordenes_ml_wc_pedidos WHERE ml_order_id = @id)
      OR EXISTS(SELECT 1 FROM guardia_ml_pedidos_retenidos WHERE ml_order_id = @id AND estado = 'retenido') AS ok`).get({ id });
  return Boolean(r?.ok);
}

const PENDIENTE_PREFIJO = 'ml_pendiente:';
const RESULTADOS_TERMINALES_DESCUENTO = ['descontada', 'ya_descontada', 'no_aplica', 'cancelada'];
/** Lista blanca: solo estos resultados de `descontarOrdenVieja` cierran el pendiente; cualquier otro (desconocido, nuevo, `sin_fecha`) lo conserva. */
export const esResultadoTerminalDescuento = (estado) => RESULTADOS_TERMINALES_DESCUENTO.includes(estado);
/** Saca la orden del registro de pendientes y, si estaba en cuarentena, resuelve su incidente dejando el motivo en el historial. */
function limpiarPendienteMl(db, id, motivo = 'orden_retomada') {
  const borrado = db.prepare('DELETE FROM sync_estado WHERE clave = ?').run(`${PENDIENTE_PREFIJO}${id}`).changes;
  const tipoError = `orden_ml_en_cuarentena_${id}`.slice(0, 120);
  try { // el incidente es informativo: que no pueda resolverse nunca cambia el resultado del trabajo
    const inc = db.prepare("SELECT id FROM incidentes_operativos WHERE tipo_error = ? AND estado = 'activo'").get(tipoError);
    if (!inc) return borrado;
    const r = confirmarCicloSano(db, { integracion: 'mercadolibre', proceso: 'polling_ordenes', tipoError });
    if (r.resueltos) {
      db.prepare("UPDATE incidentes_operativos_historial SET detalle_json = ? WHERE incidente_id = ? AND evento = 'resuelto' AND detalle_json IS NULL")
        .run(JSON.stringify({ nota: `La venta ${id} salió de cuarentena sola: ${motivo}.` }), inc.id);
    }
  } catch { /* fail-open */ }
  return borrado;
}
const umbralCuarentenaMs = () => { const h = Number(process.env.ML_POLLING_CUARENTENA_HORAS); return (Number.isFinite(h) && h >= 0 ? h : 3) * 3600 * 1000; };

/**
 * Orden pagada que `_procesarOrden` no pudo sellar ni dejar en manos de otro camino. Se registra su primera vez (`sync_estado`
 * `ml_pendiente:<id>`) y se encola un `order.ml` (reintento con backoff, visible). Pasado `ML_POLLING_CUARENTENA_HORAS` (3) pasa a
 * cuarentena: cuenta como retomada (el cursor avanza), abre un incidente crítico por orden (dedupe) y el barrido de pendientes
 * (`barrerPendientesMl`) sigue reintentándola; nunca se descuenta mientras siga dudosa. Devuelve true si está en cuarentena.
 */
async function ponerEnCuarentenaSiCorresponde(db, id, orden) {
  const clave = `${PENDIENTE_PREFIJO}${id}`;
  const ahoraIso = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO sync_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)').run(clave, ahoraIso, ahoraIso);
  try { encolarTrabajo(db, { tipo: 'order.ml', recurso: id }); } catch { /* el reintento es una ayuda: el cursor ya decide */ }
  const desde = Date.parse(db.prepare('SELECT valor FROM sync_estado WHERE clave = ?').get(clave)?.valor);
  if (!(Number.isFinite(desde) && Date.now() - desde >= umbralCuarentenaMs())) return false;
  const txt = `La venta de MercadoLibre ${id} no se pudo sellar desde ${new Date(desde).toISOString()} (sin fecha legible o con un posible pedido manual por confirmar) y quedó en CUARENTENA: NO se descontó stock ni se creó pedido; sigue reintentándose. Para cerrarla: si ya existe su pedido Woo, agregale el campo personalizado _ml_order_id = ${id} (la próxima pasada la sella sola); si NO es la misma venta, descontala a mano con scripts/ops/descontar-ordenes-viejas.mjs --omitir-conciliacion ${id}.`;
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre', proceso: 'polling_ordenes', tipoError: `orden_ml_en_cuarentena_${id}`.slice(0, 120), severidad: 'critico',
    mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: id, desde: new Date(desde).toISOString(), estado: orden?.status ?? null },
  });
  return true;
}

/** Reintenta las órdenes pendientes/en cuarentena: las ya retomadas salen del registro; el resto vuelve a encolar su `order.ml`. */
export function barrerPendientesMl(db) {
  // Rotación con progreso garantizado: las 200 más viejas por `actualizado_en`; al re-encolar una se le actualiza, así pasa al final
  // y la próxima pasada toma las siguientes (sin ORDER BY, SQLite devolvía siempre el mismo subconjunto y el resto nunca se tocaba).
  const filas = db.prepare("SELECT clave FROM sync_estado WHERE clave LIKE 'ml_pendiente:%' ORDER BY actualizado_en, clave LIMIT 200").all();
  const tocar = db.prepare('UPDATE sync_estado SET actualizado_en = ? WHERE clave = ?');
  for (const { clave } of filas) {
    const id = clave.slice(PENDIENTE_PREFIJO.length);
    if (ordenRetomada(db, id)) { limpiarPendienteMl(db, id); continue; }
    try { encolarTrabajo(db, { tipo: 'order.ml', recurso: id }); } catch { /* se reintenta en la próxima pasada */ }
    try { tocar.run(new Date().toISOString(), clave); } catch { /* la rotación es una ayuda: se reintenta en la próxima pasada */ }
  }
  return filas.length;
}

async function _syncMlToWc(db, cfg) {
  const { ml: mlCfg, woo: wooCfg } = cfg;
  const leer = (clave) => db.prepare('SELECT valor FROM sync_estado WHERE clave = ?').get(clave)?.valor ?? null;
  // Primer arranque (sin cursor propio): max(ultima_orden_ml − 60 min, ahora − 3 días). El barrido anterior por `date_created` (con piso de
  // 14 días) ya cubrió todo lo anterior; más atrás solo hay órdenes viejas que, sin sellar, caerían en el descuento sin pedido. Sin
  // ningún cursor histórico: ahora − 3 días. Los 3 días se escalonan por el tope de ventana por corrida (abajo).
  const tresDias = Date.now() - 3 * 24 * 3600 * 1000;
  const historico = Date.parse(leer('ultima_orden_ml'));
  const semilla = new Date(Number.isFinite(historico) ? Math.max(historico - 60 * 60 * 1000, tresDias) : tresDias).toISOString();
  const baseDesde = leer(POLLING_CURSOR) ?? semilla;
  const desdeMs = Date.parse(desdePollingMl(baseDesde));
  // Tope de ventana por corrida (`ML_POLLING_VENTANA_MAX_HORAS`, 24): un cursor atrasado se pone al día en varias corridas.
  const h = Number(process.env.ML_POLLING_VENTANA_MAX_HORAS);
  const hastaMs = Math.min(Date.now(), Date.parse(baseDesde) + (Number.isFinite(h) && h > 0 ? h : 24) * 3600 * 1000);
  let incompletas = 0;
  barrerPendientesMl(db);

  try {
    await paginarVentanaMl(db, mlCfg, desdeMs, hastaMs, async (orden) => {
      const id = String(orden.id);
      // Idempotencia: saltar si ya fue procesada
      if (db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id = ?').get(id)) return;
      await _procesarOrden(db, wooCfg, mlCfg, orden);
      // Si no quedó sellada ni la retoma otro camino (fila de descuento, reserva, retención de la Guardia) la corrida está
      // incompleta: pasada la hora de solape la orden saldría de la ventana y se perdería en silencio. Una orden que nunca sella (sin
      // fecha legible, posible pedido manual) no puede trabar el cursor para siempre: pasado el umbral va a CUARENTENA.
      if (!ordenRetomada(db, id)) {
        if (!(await ponerEnCuarentenaSiCorresponde(db, id, orden))) incompletas++;
      } else limpiarPendienteMl(db, id);
    });
    if (incompletas) throw Object.assign(new Error(`${incompletas} orden(es) quedaron sin sellar ni retomar por otro camino`), { incompleta: true });
  } catch (e) {
    console.error(`syncMlToWc: ${e.message}; el cursor no avanza`);
    if (e.incompleta && Date.now() - Date.parse(baseDesde) > 24 * 3600 * 1000) {
      abrirOActualizarIncidente(db, {
        integracion: 'mercadolibre', proceso: 'polling_ordenes', tipoError: 'polling_ml_cursor_detenido', severidad: 'advertencia',
        mensajeTecnico: e.message, mensajeHumano: `El barrido de órdenes de MercadoLibre lleva más de un día sin avanzar su cursor: ${e.message}.`,
        contexto: { cursor: baseDesde },
      });
    }
    if (/no se puede partir más|cambió durante el recorrido/.test(e.message)) {
      abrirOActualizarIncidente(db, {
        integracion: 'mercadolibre', proceso: 'polling_ordenes', tipoError: 'polling_ml_ventana_no_recorrible', severidad: 'critico',
        mensajeTecnico: e.message, mensajeHumano: `El barrido de órdenes de MercadoLibre no pudo recorrer la ventana completa (${e.message}). El cursor no avanza; revisá.`,
        contexto: { desde: new Date(desdeMs).toISOString(), hasta: new Date(hastaMs).toISOString() },
      });
    }
    return;
  }

  // Avanzar a `to` (no al máximo visto), monótono en SQL: syncOrdenMlPuntual o una corrida paralela no pueden hacerlo retroceder.
  db.prepare(`
    INSERT INTO sync_estado (clave, valor, actualizado_en) VALUES (?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
      WHERE excluded.valor > sync_estado.valor
  `).run(POLLING_CURSOR, new Date(hastaMs).toISOString(), now());
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
export async function syncOrdenMlPuntual(db, cfg, mlOrderId, { orden: ordenLeida = null } = {}) {
  const { ml: mlCfg, woo: wooCfg } = cfg;
  if (!mlCfgOk(cfg)) return { omitido: true };
  if (!mlOrderId) return { omitido: true, motivo: 'sin_order_id' };

  const yaProc = db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id = ?').get(String(mlOrderId));
  if (yaProc) return { omitido: true, motivo: 'ya_procesada' };

  try {
    let orden = ordenLeida;
    if (!orden) {
      const resp = await mlFetch(db, mlCfg, 'get', `/orders/${mlOrderId}`);
      if (resp.status !== 200) {
        console.error(`syncOrdenMlPuntual: error API ML ${resp.status} para orden ${mlOrderId} — la retoma el cron`);
        return { omitido: true, motivo: `http_${resp.status}` };
      }
      orden = resp.data;
    }
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
async function _confirmarInexistenciaEnWc(wooCfg, orderId, desdeIso = null) {
  // E-0: se pagina por fecha descendente hasta AGOTAR el rango (una página con pedidos anteriores a la reserva menos 24 h,
  // o sin más páginas). Con 20 páginas sin agotarlo NO se confirma: se lanza y el llamador conserva todo.
  const limiteMs = desdeIso ? new Date(desdeIso).getTime() - 24 * 3600 * 1000 : null;
  const fechaMs = (p) => {
    const g = p?.date_created_gmt;
    const t = g ? new Date(/Z|[+-]\d\d:?\d\d$/.test(g) ? g : `${g}Z`).getTime() : new Date(p?.date_created).getTime();
    return Number.isFinite(t) ? t : null;
  };
  for (const status of ['any', 'trash']) {
    let agotado = false;
    for (let page = 1; page <= VERIF_INEXISTENCIA_MAX_PAGINAS; page++) {
      const resp = await wooFetch(
        wooCfg,
        `/orders?per_page=100&status=${status}&orderby=date&order=desc&page=${page}`
      );
      if (!Array.isArray(resp?.data)) {
        throw new Error('respuesta de Woo con forma inesperada al reverificar sin filtro de fecha');
      }
      const match = _matchMlOrderId(resp.data, orderId);
      if (match) return match.id;
      if (resp.data.length < 100) { agotado = true; break; }
      if (limiteMs != null) {
        const fechas = resp.data.map(fechaMs);
        const validas = fechas.filter((t) => t != null);
        // Un pedido sin fecha legible no se puede descartar como anterior al umbral: la página no corta el recorrido. Si por eso se
        // llega al tope de páginas, se lanza (inconcluso), nunca se afirma "inexistente".
        if (validas.length === fechas.length && validas.length && Math.min(...validas) < limiteMs) { agotado = true; break; }
      } else {
        agotado = true; break; // sin fecha de referencia: comportamiento histórico (primera página)
      }
    }
    if (!agotado) throw new Error(`inexistencia no concluyente: ${VERIF_INEXISTENCIA_MAX_PAGINAS} páginas de pedidos (${status}) sin agotar el rango`);
  }
  return null;
}

const VERIF_TEXTO_MAX_PAGINAS = 5;
/**
 * Segunda red para pedidos cargados A MANO sin la meta `_ml_order_id`: `GET /orders?search=<término>` (status any y trash). Woo busca
 * en sus campos indexados (datos de facturación/envío, ítems, etc.); lo que devuelva se re-verifica localmente buscando el término en
 * `customer_note`, `number` y valores de meta, como token exacto (`mencionaTokenExacto`). Coincidencia → id del pedido, que NO es
 * concluyente: el llamador no sella y abre un incidente crítico para que una persona confirme. Resultados que no contienen el término
 * (coincidencia dudosa) o cualquier falla/forma inesperada → LANZA (inconcluso: nadie descuenta). Sin resultados → null.
 * Riesgo residual: un pedido manual que no menciona el número de ML en ningún campo que Woo devuelva/indexe no se detecta.
 */
/**
 * ¿El pedido menciona el token EXACTO? Solo en `customer_note`, `number` y el valor de `meta_data`, con límites que no sean
 * alfanuméricos: el número NUNCA cuenta como subcadena de uno más largo (un teléfono, otro ID).
 */
function mencionaTokenExacto(pedido, token) {
  const re = new RegExp(`(?<![A-Za-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`);
  const campos = [pedido?.customer_note, pedido?.number, ...(Array.isArray(pedido?.meta_data) ? pedido.meta_data.map((m) => (typeof m?.value === 'object' ? JSON.stringify(m.value) : m?.value)) : [])];
  return campos.some((c) => c != null && re.test(String(c)));
}

async function buscarPedidoWcPorTexto(wooCfg, termino) {
  const t = String(termino ?? '').trim();
  if (!t) return null;
  let dudoso = false;
  for (const status of ['any', 'trash']) {
    for (let page = 1; ; page++) {
      const resp = await wooFetch(wooCfg, `/orders?per_page=100&status=${status}&page=${page}&search=${encodeURIComponent(t)}`);
      if (!Array.isArray(resp?.data)) throw new Error('respuesta de Woo con forma inesperada en la búsqueda por texto');
      for (const p of resp.data) if (mencionaTokenExacto(p, t)) return p.id;
      if (resp.data.length) dudoso = true;
      if (resp.data.length < 100) break;
      if (page >= VERIF_TEXTO_MAX_PAGINAS) throw new Error(`búsqueda por texto de "${t}": ${VERIF_TEXTO_MAX_PAGINAS} páginas sin agotar, no concluyente`);
    }
  }
  if (dudoso) throw new Error(`búsqueda por texto de "${t}": Woo devolvió pedidos que no se pueden descartar como ajenos (coincidencia dudosa)`);
  return null;
}

async function buscarPedidoWcPorMlOrderId(wooCfg, orderId, desdeIso) {
  const after = new Date(new Date(desdeIso).getTime() - VERIF_WC_MARGEN_MS).toISOString();
  let ultimoError;

  for (let intento = 0; intento <= VERIF_WC_BACKOFF_MS.length; intento++) {
    if (intento > 0) await sleep(espera(VERIF_WC_BACKOFF_MS[intento - 1]));
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
          const idReverificado = await _confirmarInexistenciaEnWc(wooCfg, orderId, desdeIso);
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
  // E-0: solo 400/401/403/404/422 con cuerpo de error de Woo son un rechazo seguro. 408, 409, 423, 425, 429 y 5xx
  // dejan dudas (el POST pudo haberse procesado). Un cuerpo que no es JSON de Woo (HTML de WAF/proxy) tampoco es certeza.
  if (![400, 401, 403, 404, 422].includes(status)) return true;
  if (e?.cuerpo === undefined) return false; // errores sin cuerpo capturado (tests / contratos viejos)
  return !/"code"\s*:\s*"/.test(String(e.cuerpo)); // cuerpo de error de Woo (REST API): {"code":"...","message":"..."}
}

async function _procesarOrden(db, wooCfg, mlCfg, orden) {
  const orderId = String(orden.id);
  const items = orden.order_items ?? [];
  // La Guardia ya conserva esta venta; esperar una liberación humana evita
  // reintentos, reservas o efectos laterales en Woo en cada ciclo.
  if (pedidoMlRetenido(db, orderId)) return;
  // E-1a: una orden vieja con descuento de stock registrado (cualquier estado, también `parcial`) NO puede terminar con
  // pedido Woo: Woo descontaría otra vez. Vale para el polling legacy, el sync puntual y el manual (todos pasan por acá).
  const filaDescuento = db.prepare('SELECT estado, origen, cancelada_en FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').get(orderId);
  if (filaDescuento) {
    // Descuento a medias (p. ej. el proceso cayó tras persistir la línea y antes de encolar): este camino no reintenta, lo hace el job.
    if (orden.status === 'paid') { // lápida + 'paid': revisión manual; una falla del aviso no corta el flujo
      try { avisarCanceladaLuegoPagada(db, orden, filaDescuento); } catch (e) { logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'aviso_cancelada_luego_pagada_fallo', error: String(e.message).slice(0, 300) }); }
    }
    if (filaDescuento.estado !== 'completo') encolarTrabajo(db, { tipo: 'order.ml', recurso: orderId });
    // El polling pasa por acá en cada ciclo: se registra una sola vez por orden.
    if (!db.prepare("SELECT 1 FROM sync_log WHERE clave = ? AND estado = 'omitida_descuento_sin_pedido'").get(orderId)) {
      logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'omitida_descuento_sin_pedido', error: 'orden vieja ya descontada sin pedido: no se crea el pedido Woo' });
    }
    return;
  }
  // La ventana rige para TODOS los orígenes (job, polling legacy, puntual, manual): una orden vieja sin tratar no crea pedido.
  if ((await tratarOrdenFueraDeVentana(db, { woo: wooCfg, ml: mlCfg }, orden, { reencolarSiPendiente: true })).tratada) return;
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
      AND NOT EXISTS (SELECT 1 FROM stock_refresco_pendiente b WHERE b.ml_order_id = ordenes_ml_wc_pedidos.ml_order_id)
  `).run(orderId, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  // E-0: una reserva con filas de barrera NO es abandonada: la barrera prueba que el POST pudo haber salido. La resuelve
  // el chequeo periódico (procesarBarreraVentas), nunca la limpieza de 60 min ni un segundo POST.

  // Idempotencia: si ya se creó el pedido en WC para esta orden ML, no reprocesar.
  // OJO con `retenido_en`: una reserva retenida por fail-closed (wc_order_id=0) NO cuenta
  // como "ya creado". Si contara, la orden se sellaria abajo como 'ok' en
  // ordenes_ml_procesadas y, si el pedido en realidad nunca se creo en Woo, la venta de ML
  // se perderia en silencio (el panel filtra wc_order_id<>0 y procesarCancelacionesMl la
  // saltea). Excluida acá, cae en el INSERT de reserva de más abajo, que falla por PK y
  // corta sin sellar nada: la orden queda visible como reserva retenida hasta que un
  // humano la resuelva.
  const yaCreado = db.prepare(
    `SELECT 1 FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND (wc_order_id <> 0 OR retenido_en IS NULL)
       AND NOT (wc_order_id = 0 AND EXISTS (SELECT 1 FROM stock_refresco_pendiente b WHERE b.ml_order_id = ordenes_ml_wc_pedidos.ml_order_id))`
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
      const shipResp = await mlFetch(db, mlCfg, 'get', `/shipments/${orden.shipping.id}`, null, { headers: { 'x-format-new': 'true' } });
      // mlFetch usa validateStatus: () => true (nunca lanza por HTTP status) — un
      // 403/404/500 de ML llega acá como respuesta normal, no como excepción. Hay que
      // chequear el status a mano (mismo patrón que routes/preparacion.js) o un error de
      // ML pasaría desapercibido: el pedido se crearía sin destinatario y sin ningún rastro.
      if (shipResp.status !== 200) {
        throw new Error(`ML respondió ${shipResp.status} al consultar /shipments/${orden.shipping.id}`);
      }
      const ship = shipResp.data;
      // En formato nuevo ML separa el nombre del receptor y la dirección dentro de
      // destination. Solo el formato viejo usa receiver_address en la raíz.
      const direccionNueva = ship?.destination?.shipping_address;
      const addr = direccionNueva
        ? { ...direccionNueva, receiver_name: direccionNueva.receiver_name || ship.destination.receiver_name }
        : (!ship?.destination ? ship?.receiver_address : null);
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
      metodoEnvio = ship?.lead_time?.shipping_method?.name
        || ship?.lead_time?.shipping_method?.type
        || tipoLogisticaMl(ship)
        || ship?.shipping_option?.name || null;
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
  // Destino excluyente (pedido vs descuento): la reserva se inserta en una transacción IMMEDIATE que mira el reclamo 'descuento'.
  // El lado pedido ES la reserva, así que borrarla (fallo definitivo, abandono) libera el destino sin estado extra.
  const reservaCreadaEn = now();
  const REPARTO_DESCUENTO = Symbol('descuento');
  try {
    db.transaction(() => {
      if (db.prepare("SELECT 1 FROM ordenes_ml_destino WHERE ml_order_id = ? AND destino = 'descuento'").get(orderId)) throw REPARTO_DESCUENTO;
      db.prepare(`
        INSERT INTO ordenes_ml_wc_pedidos (ml_order_id, wc_order_id, comprador_json, creado_en)
        VALUES (?, 0, NULL, ?)
      `).run(orderId, reservaCreadaEn);
    }).immediate();
  } catch (e) {
    if (e === REPARTO_DESCUENTO) return; // la orden se resuelve por descuento, nunca por pedido
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
  const clavesBloqueadas = [];
  for (const item of ov.items) {
    // Fase C R5: en activo, un link de pago (`omitir`) no se sincroniza ni retiene la venta.
    // OJO: este `continue` depende de que `ignoraVentas` EXCLUYA los `omitir` con origen `no_sincronizar_*`
    // (Fase D): esas ventas se retienen siempre. Si cambia `ignoraVentas`, revisar el test
    // sync-no-sincronizar-retiene.test.js.
    if (modoProteccion() === 'activo' && ignoraVentas(db, item.clave)) continue;
    const skuVinculado = skuDesdeMl(db, item.item_id_ml, item.variation_id_ml);
    // "No sincronizar" (Fase D): la venta se retiene siempre; no vale el vínculo ni el fallback por seller_sku.
    const noSincroniza = esNoSincronizar(db, item.clave);
    const cubiertaPorVinculo = !noSincroniza && !!skuVinculado && !!buscarEnCache(db, skuVinculado) && claveCubiertaParaVenta(db, item.clave);
    // Decisión del usuario (2026-09-05). Esta guarda y el fallback anti-sobreventa de más
    // abajo (~línea 700) venían del commit base conflictivo y se contradecían: la guarda
    // retenía la orden entera antes de que el fallback pudiera usar el `seller_sku` que trae
    // la propia venta, dejándolo inalcanzable. El fallback se había escrito con datos
    // medidos —83 ventas sin mapear en 60 días, 54 con un SKU que SÍ existía en el catálogo—
    // así que anularlo reabría esa fábrica de sobreventas; pero aceptar cualquier seller_sku
    // podía descontar el producto equivocado.
    //
    // Reconciliación: el `seller_sku` de la venta cuenta como cobertura SOLO si resuelve a
    // EXACTAMENTE un producto del catálogo WC. Con cero coincidencias no sabemos qué
    // descontar; con dos o más, `buscarEnCache` desempata por menor stock —bien para elegir
    // entre hermanas ya vinculadas, pero no para decidir una identidad que nadie verificó.
    // En ambos casos se retiene, que es lo que ya hacía.
    const cubiertaPorSellerSku = !noSincroniza && !cubiertaPorVinculo && skuUnicoEnCatalogo(db, item.seller_sku);
    if (!cubiertaPorVinculo && !cubiertaPorSellerSku) clavesSinCobertura.push(item.clave);
    // GUARDIA: verificar también si la clave está bloqueada (seller_sku divergente o sin
    // resolver). Esto NO lo levanta la cobertura por seller_sku: una clave que Guardia marcó
    // como divergente se retiene igual, porque ahí el seller_sku es justamente el dato en duda.
    if (claveFrenadaParaVenta(db, item.clave)) clavesBloqueadas.push(item.clave);
  }
  if (clavesSinCobertura.length || clavesBloqueadas.length) {
    retenerPedidoMl(db, { orderId, items, claves: [...new Set([...clavesSinCobertura, ...clavesBloqueadas])] });
    const motivos = [];
    if (clavesSinCobertura.length) motivos.push(`sin vínculo exacto (${clavesSinCobertura.join(', ')})`);
    if (clavesBloqueadas.length) motivos.push(`${modoProteccion() === 'activo' ? 'frenada por Identidad' : 'bloqueada por Guardia'} (${clavesBloqueadas.join(', ')})`);
    logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'retenido_guardia_ml', error: motivos.join('; ') });
    return;
  }
  const lineItems = [];
  const skusProcesados = new Set(); // Capturar SKUs para resincronizar hermanas después
  const lineasBarrera = []; // E-0: una entrada por línea del pedido Woo, para la barrera de venta
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
    skusProcesados.add(sku); // Registrar SKU para resincronizar hermanas después
    lineasBarrera.push({ idx: lineItems.length, sku, product_id: li.product_id, variation_id: li.variation_id || 0, cantidad: qty });
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

  // E-0 barrera de venta: antes del POST se guardan las obligaciones (una fila por SKU y venta) bajo los candados de la
  // bolsa. Si no se pueden tomar los candados o la bolsa no se resuelve, NO se envía nada y se libera la reserva.
  try {
    await enriquecerLineasBarrera(db, wooCfg, lineasBarrera);
    const bolsa = resolverBolsa(db, { skus: [...skusProcesados] });
    const r = await conCandados(db, bolsa.skus, () => insertarBarrera(db, { mlOrderId: orderId, vendidoEn: orden.date_created ?? now(), lineas: lineasBarrera }));
    if (r.ocupado) throw new Error('candados de stock ocupados');
  } catch (eBarrera) {
    db.prepare('DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND wc_order_id = 0').run(orderId);
    borrarBarreraDeOrden(db, orderId);
    logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'error', error: `barrera de venta no pudo armarse, se reintenta en el próximo ciclo: ${eBarrera.message}`.slice(0, 400) });
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
    db.transaction(() => {
      db.prepare(`
        UPDATE ordenes_ml_wc_pedidos SET wc_order_id = ?, comprador_json = ?
        WHERE ml_order_id = ?
      `).run(wcOrderId, JSON.stringify(orden.buyer ?? null), orderId);
      confirmarBarreraConPedido(db, orderId, resp.data); // woo_confirmado=1 + line_item_id/name
    })();

    logSync(db, { direccion: 'ml_wc', clave: orderId, cantNueva: wcOrderId, estado: 'ok' });

    db.prepare(`
      INSERT OR IGNORE INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en)
      VALUES (?, ?, ?, ?, ?)
    `).run(orderId, orden.date_created ?? now(), JSON.stringify(items), algunSinMapeo ? 'parcial' : 'ok', now());

    // E-0: el stock NO se empuja acá. Hasta que haya evidencia de que Woo descontó ESTE pedido, la barrera bloquea toda
    // escritura de la bolsa; el job libera (con reintento) y hace la corrección dueña. Si no alcanza, lo retoma el cron
    // de procesarBarreraVentas. FAIL-OPEN: nunca bloquea la orden.
    void liberarYCorregirTrasVenta(db, { ml: mlCfg, woo: wooCfg }, [...skusProcesados], orderId);

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
      // Woo rechazo la request (400/401/403/404/422 con cuerpo de validación): no hay pedido creado. Se libera la
      // reserva y se borran las filas de barrera en la misma transacción.
      db.transaction(() => {
        db.prepare('DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND wc_order_id = 0').run(orderId);
        borrarBarreraDeOrden(db, orderId);
      })();
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
      let pedidoExistente = null;
      try { pedidoExistente = (await wooFetch(wooCfg, `/orders/${wcExistente}`))?.data ?? null; } catch (eLect) {
        // Las líneas se completan después (intentarLiberarFila); queda registro.
        logSync(db, { direccion: 'ml_wc', clave: orderId, estado: 'error', error: `No se pudo releer el pedido ${wcExistente} para completar la barrera (se completa en el próximo ciclo): ${eLect.message}`.slice(0, 400) });
      }
      db.transaction(() => {
        db.prepare(`
          UPDATE ordenes_ml_wc_pedidos SET wc_order_id = ?, comprador_json = ?, retenido_en = NULL
          WHERE ml_order_id = ?
        `).run(wcExistente, JSON.stringify(orden.buyer ?? null), orderId);
        confirmarBarreraConPedido(db, orderId, pedidoExistente ?? { id: wcExistente, line_items: [] });
      })();
      void liberarYCorregirTrasVenta(db, { ml: mlCfg, woo: wooCfg }, [...skusProcesados], orderId);
      console.warn(`syncMlToWc: orden ML ${orderId}: el POST a Woo fallo (${e.message}) pero el pedido ${wcExistente} SI existe - reserva completada, sin duplicado.`);
      logSync(db, { direccion: 'ml_wc', clave: orderId, cantNueva: wcExistente, estado: 'ok', error: `respuesta perdida (${e.message}), pedido verificado en Woo` });
      db.prepare(`
        INSERT OR IGNORE INTO ordenes_ml_procesadas (order_id, fecha_orden, items_json, estado, procesado_en)
        VALUES (?, ?, ?, ?, ?)
      `).run(orderId, orden.date_created ?? now(), JSON.stringify(items), algunSinMapeo ? 'parcial' : 'ok', now());
      return;
    }

    // Verificacion concluyente: el pedido NO existe en Woo -> falla real. Se libera la
    // reserva y el proximo ciclo puede reintentar sin riesgo de duplicado. Se borran también las filas de barrera.
    db.transaction(() => {
      db.prepare('DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND wc_order_id = 0').run(orderId);
      borrarBarreraDeOrden(db, orderId);
    })();
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
/**
 * Cancelación PUNTUAL e idempotente del pedido Woo de una orden ML cancelada (misma lógica que el barrido, por orden).
 * - sin pedido nuestro → nada que cancelar; reserva en curso (`wc_order_id=0`) → no se toca nada y el llamador reencola;
 * - ya cancelado → no se vuelve a tocar el pedido;
 * - devuelve los SKUs del pedido (Woo devolvió el stock) para refrescar sus bolsas.
 * Lanza ante un fallo de Woo: el llamador reencola, nunca da la cancelación por hecha.
 */
export async function cancelarPedidoWooDeOrden(db, wooCfg, orderId) {
  const registro = db.prepare('SELECT wc_order_id, cancelado_en FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(String(orderId));
  if (!registro) return { estado: 'sin_pedido', skus: [] };
  if (registro.wc_order_id === 0) return { estado: 'reserva_en_curso', skus: [] };
  const pedido = (await wooFetch(wooCfg, `/orders/${registro.wc_order_id}`))?.data;
  const skus = [...new Set((pedido?.line_items || []).map((l) => l.sku).filter(Boolean))];
  if (registro.cancelado_en) return { estado: 'ya_cancelado', skus };
  if (pedido?.status !== 'cancelled') await wooFetch(wooCfg, `/orders/${registro.wc_order_id}`, 'put', { status: 'cancelled' });
  db.prepare('UPDATE ordenes_ml_wc_pedidos SET cancelado_en = ? WHERE ml_order_id = ?').run(now(), String(orderId));
  logSync(db, { direccion: 'ml_wc', clave: String(orderId), cantNueva: registro.wc_order_id, estado: 'ok' });
  return { estado: 'cancelado', skus };
}

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
        const r = await cancelarPedidoWooDeOrden(db, wooCfg, orderId);
        if (r.skus?.length) encolarBolsasDeSkus(db, r.skus);
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
async function _empujarClaveMl(db, mlCfg, sku, diff, { barreraId = null, candadoToken = null } = {}) {
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
        await sleep(espera(ML_CALL_DELAY_MS));
      }
      if (status === 'desconocido') {
        logSync(db, { direccion: 'wc_ml', clave, sku, cantAnterior: cantidad_ml, cantNueva: cantidad, estado: 'error', error: 'No se pudo consultar el status de la publicación en ML' });
        return { clave, estado: 'error', detalle: 'No se pudo consultar el status de la publicación' };
      }
      if (status !== 'active') {
        return { clave, estado: 'sin_cambios', detalle: `Publicación ${status}, no se sincroniza` };
      }

      const bloqueo = bloquearStockPorContradiccion(db, { clave, sku, cantidad, cantAnterior: cantidad_ml });
      if (bloqueo.bloqueado) return { clave, estado: 'bloqueado_contradiccion', bloqueado: true, motivos: bloqueo.contradiccion.motivos };
      const esc = await escribirStockMl(db, mlCfg, { clave, sku, cantidad, barreraId, candadoToken });
      if (esc.omitido) return { clave, estado: 'omitido', detalle: `Escritura de stock omitida (${esc.motivo}), la retoma el cron`, barrera: true };
      const resp = esc.resp;

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
export async function syncSkuPuntual(db, cfg, sku, { barrera_id: barreraId = null } = {}) {
  const { ml: mlCfg } = cfg;
  // E-0: la llamada que lleva el barrera_id de una fila `liberable` es la corrección dueña (única escritura permitida
  // con la barrera liberada): relee Woo y ML, empuja lo que difiera y cierra las filas de la bolsa.
  if (barreraId) return _corregirBolsaDuena(db, cfg, sku, barreraId);

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
    ${computedStockCte()}
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

  const bloqueados = resultados.filter(r => r.bloqueado);
  if (bloqueados.length > 0) return { sku, estado: 'bloqueado_contradiccion', bloqueado: true, resultados };
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

// ─── E-0: barrera de venta ───────────────────────────────────────────────────

/** Completa manage_stock y el gestor de stock de cada línea leyendo Woo (antes del POST). Fail-safe: si no se lee, 'desconocido'. */
async function enriquecerLineasBarrera(db, wooCfg, lineas) {
  for (const l of lineas) {
    let ms = 'desconocido';
    try {
      const path = l.variation_id ? `/products/${l.product_id}/variations/${l.variation_id}` : `/products/${l.product_id}`;
      const d = (await wooFetch(wooCfg, path))?.data;
      if (d?.manage_stock === 'parent') ms = 'parent';
      else if (d?.manage_stock === true) ms = 'true';
      else if (d?.manage_stock === false) ms = 'false';
    } catch { /* queda 'desconocido': exige la nota como cualquier otra línea */ }
    l.manage_stock = ms;
    if (ms === 'parent') { l.stock_gestor_id = l.product_id; l.stock_gestor_padre = null; }
    else if (ms === 'false') { l.stock_gestor_id = null; l.stock_gestor_padre = null; }
    else { l.stock_gestor_id = l.variation_id || l.product_id; l.stock_gestor_padre = l.variation_id ? l.product_id : null; }
  }
}

/** Relee de ML (`/items/bulk`) la cantidad publicada de cada clave. Lanza si algún elemento no se pudo leer (5xx / respuesta rota). */
async function leerCantidadesMl(db, mlCfg, claves) {
  const porItem = new Map();
  for (const c of claves) {
    const { itemId } = partirClaveMl(c);
    if (!porItem.has(itemId)) porItem.set(itemId, []);
    porItem.get(itemId).push(c);
  }
  const out = new Map();
  const ids = [...porItem.keys()];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const resp = await mlFetch(db, mlCfg, 'get', `/items/bulk?ids=${chunk.join(',')}&attributes=status_code,id,body.id,body.status,body.available_quantity,body.variations`, null, { manual: true });
    if (resp.status !== 200 || !Array.isArray(resp.data)) throw new Error(`ML /items/bulk respondió ${resp.status}`);
    const porId = new Map(resp.data.map((e) => [e?.body?.id ?? e?.id, e]));
    for (const itemId of chunk) {
      const e = porId.get(itemId);
      const code = e ? (e.status_code ?? e.code) : null;
      if (code === 404) { for (const c of porItem.get(itemId)) out.set(c, { status: 'inexistente', cantidad: null }); continue; }
      if (code !== 200 || !e?.body) throw new Error(`ML no devolvió ${itemId} (${code ?? 'sin elemento'})`);
      for (const c of porItem.get(itemId)) {
        const { variationId } = partirClaveMl(c);
        if (!variationId) { out.set(c, { status: e.body.status, cantidad: Number(e.body.available_quantity) }); continue; }
        const v = (e.body.variations || []).find((x) => String(x.id) === String(variationId));
        out.set(c, v ? { status: e.body.status, cantidad: Number(v.available_quantity) } : { status: 'variacion_inexistente', cantidad: null });
      }
    }
  }
  return out;
}

function persistirCantidadMl(db, clave, sku, cantidad) {
  db.prepare('UPDATE ml_publicaciones_cache SET available_quantity = ? WHERE clave = ?').run(cantidad, clave);
  if (sku && cantidad != null) upsertMlStockEstado(db, clave, sku, cantidad);
}

/** E-1c: cuando la baja de un SKU ya no está vigente (restaurado o levantada a mano), cierra el incidente de sus publicaciones sin vínculo. */
function cerrarAvisosBajaLevantada(db, skus) {
  for (const sku of skus) {
    const tipoError = `baja_woo_publicacion_sin_vinculo_${sku}`.slice(0, 120);
    try {
      if (db.prepare("SELECT 1 FROM incidentes_operativos WHERE tipo_error = ? AND estado = 'activo'").get(tipoError)) {
        confirmarCicloSano(db, { integracion: 'mercadolibre', proceso: 'baja_woo_sin_vinculo', tipoError });
      }
    } catch { /* informativo */ }
  }
}

/** E-1c: por cada SKU con baja confirmada, abre (idempotente por SKU) un incidente con los item_ids activos que lo usan como `seller_sku` sin vínculo. Informativo: nunca falla el trabajo. */
function avisarPublicacionesSinVinculoPorBaja(db, skus, clavesVinculadas) {
  try {
    const filas = db.prepare(`SELECT clave, item_id, TRIM(seller_sku) AS sku FROM ml_publicaciones_cache
      WHERE TRIM(COALESCE(seller_sku, '')) IN (${skus.map(() => '?').join(',')}) AND status = 'active' AND ${FILTRO_MARKETPLACE}`).all(...skus);
    const porSku = new Map();
    for (const f of filas) {
      if (clavesVinculadas.has(f.clave)) continue;
      if (!porSku.has(f.sku)) porSku.set(f.sku, []);
      porSku.get(f.sku).push(f.item_id ?? f.clave);
    }
    for (const [sku, items] of porSku) {
      const txt = `El producto de Woo con SKU ${sku} fue dado de baja y hay ${items.length} publicación(es) activa(s) de MercadoLibre con ese seller_sku SIN vínculo confirmado (${items.join(', ')}). No se tocó su stock: vinculalas (para que queden en 0) o pausalas a mano.`;
      abrirOActualizarIncidente(db, {
        integracion: 'mercadolibre', proceso: 'baja_woo_sin_vinculo', tipoError: `baja_woo_publicacion_sin_vinculo_${sku}`.slice(0, 120), severidad: 'critico',
        mensajeTecnico: txt, mensajeHumano: txt, contexto: { sku, item_ids: items },
      });
    }
  } catch { /* informativo */ }
}

/**
 * Conciliación de una bolsa BAJO SUS CANDADOS (los toma el llamador): relee Woo (gestores) y ML (todas las claves), empuja
 * cada clave activa cuyo remoto difiera del deseado y relee ML para confirmar que TODAS publican lo deseado. No usa el
 * `sin_cambios` del caché. `{ok:true, empujadas}` o `{ok:false, motivo, bloqueado?}` (reintentar; nunca da nada por hecho).
 */
async function _conciliarClavesDeBolsa(db, cfg, bolsa, candado, { barreraId = null, gestoresExtra = [] } = {}) {
  const { woo: wooCfg, ml: mlCfg } = cfg;
  // 1) Woo: stock actual de todos los gestores de la bolsa → catalogo_cache
  const cat = db.prepare(`SELECT id_woo, tipo, id_padre FROM catalogo_cache WHERE sku IN (${bolsa.skus.map(() => '?').join(',')})`).all(...bolsa.skus);
  await releerStockGestores(db, wooCfg, [...cat.map((c) => ({ id: c.id_woo, padre: c.tipo === 'variation' ? c.id_padre : null })), ...gestoresExtra], { estricto: false });
  // 2) ML: lectura de toda la bolsa; 3) empuje de lo que difiera del deseado
  // E-1c: un SKU con baja de Woo CONFIRMADA por relectura va a 0 aunque ya no esté en `catalogo_cache` (el CTE de stock no tiene
  // fila para él) y aunque haya un caso de identidad abierto. La baja se levanta sola si el SKU reaparece en el catálogo.
  levantarBajasReaparecidas(db);
  const bajas = skusConBajaWoo(db, bolsa.skus);
  cerrarAvisosBajaLevantada(db, bolsa.skus.filter((s) => !bajas.has(s)));
  // Las publicaciones que solo coinciden por `seller_sku` (sin decisión asignar/confirmar) NO se escriben: una identidad no probada
  // no justifica tocar ML. Con baja confirmada abren un incidente operativo (idempotente por SKU) para que alguien las vincule o pause.
  // Supuesto: cuenta de ML única (el `seller_sku` de `ml_publicaciones_cache` pertenece a nuestra cuenta).
  const claves = [...bolsa.claves];
  if (bajas.size) avisarPublicacionesSinVinculoPorBaja(db, [...bajas], new Set(claves));
  const remoto = await leerCantidadesMl(db, mlCfg, claves);
  const computada = (clave) => {
    const row = db.prepare(`${computedStockCte()} SELECT * FROM computed WHERE clave = ?`).get(clave);
    if (!bajas.size) return row;
    const sku = row?.sku
      ?? db.prepare(`SELECT sku FROM sku_matcher_decisiones WHERE clave = ? AND accion IN ('asignar','confirmar') AND sku IS NOT NULL AND sku <> ''`).get(clave)?.sku;
    // El SKU sale SOLO del CTE o de una decisión: el `seller_sku` de una hermana sin decisión no prueba identidad.
    if (!sku || !bajas.has(sku)) return row;
    return { ...(row || {}), clave, sku, stock_disponible_ml: 0, baja_woo: true };
  };
  // E-2: las publicaciones HERMANAS (mismo `user_product_id`) comparten UNA cantidad en ML. Se escribe UNA vez por user_product,
  // con el valor deseado más restrictivo del grupo (reservas o modos distintos con el mismo SKU: gana el menor); las demás hermanas
  // se confirman por la relectura. Sin `user_product_id` cada clave es su propio grupo. (SKUs distintos en la bolsa ya se cortaron arriba.)
  const upDe = db.prepare('SELECT user_product_id FROM ml_publicaciones_cache WHERE clave = ?');
  const filasClaves = [];
  for (const clave of claves) {
    const row = computada(clave);
    if (!row) continue;
    const up = String(upDe.get(clave)?.user_product_id ?? '').trim();
    filasClaves.push({ clave, row, grupo: up ? `up:${up}` : `solo:${clave}` });
  }
  const deseadoDeGrupo = new Map();
  for (const f of filasClaves) {
    const d = Math.max(0, Math.round(f.row.stock_disponible_ml));
    deseadoDeGrupo.set(f.grupo, Math.min(deseadoDeGrupo.get(f.grupo) ?? Infinity, d));
  }
  const pendientes = [];
  const escritosGrupo = new Set();
  for (const f of filasClaves) {
    const rem = remoto.get(f.clave);
    if (!rem) continue; // fuera del conjunto que nuestro sync escribe
    persistirCantidadMl(db, f.clave, f.row.sku, rem.cantidad);
    if (rem.status !== 'active' || rem.cantidad == null) continue;
    // Eco: si lo que ML publica ya es lo deseado (p. ej. el cambio observado es el que escribimos nosotros) no se escribe.
    if (rem.cantidad !== deseadoDeGrupo.get(f.grupo) && !escritosGrupo.has(f.grupo)) { escritosGrupo.add(f.grupo); pendientes.push({ row: f.row, rem, deseado: deseadoDeGrupo.get(f.grupo) }); }
  }
  for (const { row, rem, deseado } of pendientes) {
    const res = await _empujarClaveMl(db, mlCfg, row.sku, { clave: row.clave, stock_disponible_ml: deseado, cantidad_ml: rem.cantidad }, { barreraId, candadoToken: candado.token });
    if (res.estado !== 'sincronizado') return { ok: false, motivo: `${row.clave}: ${res.detalle}`, bloqueado: Boolean(res.bloqueado) };
  }
  // 4) Relectura de confirmación: TODAS las claves deben publicar lo deseado de su grupo
  const remoto2 = await leerCantidadesMl(db, mlCfg, claves);
  for (const f of filasClaves) {
    const rem = remoto2.get(f.clave);
    if (!rem) return { ok: false, motivo: `${f.clave}: sin lectura de ML` };
    if (rem.status !== 'active' || rem.cantidad == null) continue;
    if (rem.cantidad !== deseadoDeGrupo.get(f.grupo)) return { ok: false, motivo: `${f.clave}: ML publica ${rem.cantidad}` };
  }
  const instantanea = {};
  for (const f of filasClaves) {
    const rem = remoto2.get(f.clave);
    if (rem?.status === 'active' && rem.cantidad != null) instantanea[f.clave] = { deseado: deseadoDeGrupo.get(f.grupo), remoto: rem.cantidad };
  }
  return { ok: true, empujadas: pendientes.length, instantanea };
}

/**
 * Corrección dueña (spec E-0): bajo los candados de TODA la bolsa, relee Woo (gestores) y ML (todas las claves), empuja
 * cada clave cuyo remoto difiera del deseado y cierra juntas las filas `liberable` de la bolsa solo si una relectura
 * remota confirma que todas publican lo deseado. No usa el `sin_cambios` del caché. Si algo falla, reintenta (no cierra).
 */
async function _corregirBolsaDuena(db, cfg, sku, barreraId) {
  const { woo: wooCfg } = cfg;
  const mlCfg = cfg.ml;
  if (!mlCfgOk(cfg) || !wooCfg) return { sku, estado: 'omitido', detalle: 'ML/Woo no configurado' };
  let bolsa;
  try { bolsa = resolverBolsa(db, { skus: [sku] }); } catch (e) { return { sku, estado: 'error', detalle: `bolsa no resuelta: ${e.message}` }; }
  const r = await conCandados(db, bolsa.skus, async (candado) => {
    const filas = filasBarrera(db, bolsa.skus);
    if (filas.some((f) => f.estado === 'bloqueante')) return { sku, estado: 'omitido', detalle: 'la bolsa tiene una venta sin confirmar el descuento' };
    const liberables = filas.filter((f) => f.estado === 'liberable');
    if (!liberables.length) return { sku, estado: 'sin_cambios', detalle: 'no hay barrera liberable' };
    if (!liberables.some((f) => idBarrera(f.sku, f.ml_order_id) === barreraId)) return { sku, estado: 'omitido', detalle: 'barrera_id no corresponde a una fila liberable de la bolsa' };
    try {
      const c = await _conciliarClavesDeBolsa(db, cfg, bolsa, candado, { barreraId, gestoresExtra: gestoresDeFilas(liberables) });
      if (!c.ok) return { sku, estado: 'reintentar', detalle: c.motivo };
      const del = db.prepare('DELETE FROM stock_refresco_pendiente WHERE sku = ? AND ml_order_id = ? AND estado = ?');
      db.transaction(() => { for (const f of liberables) del.run(f.sku, f.ml_order_id, 'liberable'); })();
      return { sku, estado: 'sincronizado', detalle: `barrera cerrada (${liberables.length} fila(s))` };
    } catch (e) {
      return { sku, estado: 'reintentar', detalle: String(e.message).slice(0, 300) };
    }
  });
  if (r.ocupado) return { sku, estado: 'omitido', detalle: 'candados de stock ocupados' };
  return r.valor;
}

/** Tras crear el pedido: intenta liberar las filas de la venta (con reintentos) y corregir. Lo que no alcance lo retoma el cron. */
async function liberarYCorregirTrasVenta(db, cfg, skus, orderId) {
  // Intentos tras la venta (ms de espera previa); el cron de procesarBarreraVentas retoma lo que no alcance. Configurable para tests.
  const esperas = String(process.env.STOCK_BARRERA_REINTENTOS_MS || '0,10000,30000').split(',').map(Number).filter(Number.isFinite);
  for (const ms of esperas) {
    if (ms) await sleep(ms);
    try {
      const pend = db.prepare('SELECT * FROM stock_refresco_pendiente WHERE ml_order_id = ?').all(String(orderId));
      if (!pend.length) return;
      for (const f of pend.filter((x) => x.estado === 'bloqueante')) await intentarLiberarFila(db, cfg.woo, f);
      const lib = db.prepare("SELECT * FROM stock_refresco_pendiente WHERE ml_order_id = ? AND estado = 'liberable'").all(String(orderId));
      for (const f of lib) await _corregirBolsaDuena(db, cfg, f.sku, idBarrera(f.sku, f.ml_order_id));
      if (!db.prepare('SELECT 1 FROM stock_refresco_pendiente WHERE ml_order_id = ?').get(String(orderId))) return;
    } catch (e) {
      // Corre en segundo plano: con la base ya cerrada (reinicio/tests) el log no puede convertirse en un rechazo sin manejar.
      try { logSync(db, { direccion: 'wc_ml', sku: skus[0], estado: 'error', error: `Barrera tras venta ML ${orderId}: ${e.message}`.slice(0, 400) }); } catch { /* sin base: lo retoma el cron */ }
    }
  }
}

/**
 * Chequeo periódico (cada 10 min): reservas wc_order_id=0 con barrera de más de 15 min. Busca el pedido por el Nº de orden
 * ML: si existe completa reserva y barrera; si se confirma que no existe borra ambas; si Woo no responde no toca nada.
 */
export async function chequearReservasConBarrera(db, wooCfg) {
  const corte = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const reservas = db.prepare(`SELECT ml_order_id, creado_en FROM ordenes_ml_wc_pedidos p
    WHERE wc_order_id = 0 AND creado_en < ? AND EXISTS (SELECT 1 FROM stock_refresco_pendiente b WHERE b.ml_order_id = p.ml_order_id)`).all(corte);
  const out = { encontradas: 0, borradas: 0, pendientes: 0 };
  for (const r of reservas) {
    try {
      const wcId = await buscarPedidoWcPorMlOrderId(wooCfg, r.ml_order_id, r.creado_en);
      if (wcId) {
        const pedido = (await wooFetch(wooCfg, `/orders/${wcId}`))?.data ?? { id: wcId, line_items: [] };
        db.transaction(() => {
          db.prepare('UPDATE ordenes_ml_wc_pedidos SET wc_order_id = ?, retenido_en = NULL WHERE ml_order_id = ? AND wc_order_id = 0').run(wcId, r.ml_order_id);
          confirmarBarreraConPedido(db, r.ml_order_id, pedido);
        })();
        out.encontradas++;
      } else {
        db.transaction(() => {
          db.prepare('DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ? AND wc_order_id = 0').run(r.ml_order_id);
          borrarBarreraDeOrden(db, r.ml_order_id);
        })();
        out.borradas++;
      }
    } catch (e) {
      out.pendientes++; // Woo no respondió o la verificación no fue concluyente: no se toca nada
    }
  }
  return out;
}

// ─── E-1a: trabajos durables por recurso (order.ml, stock.bolsa) ─────────────

/** Encola el `stock.bolsa` de la bolsa de cada SKU (recurso = primer SKU de la bolsa, en orden alfabético). */
export function encolarBolsasDeSkus(db, skus, { demoraMs = 0 } = {}) {
  const recursos = new Set();
  for (const sku of [...new Set((skus || []).filter(Boolean))]) {
    let canon = sku;
    try { canon = resolverBolsa(db, { skus: [sku] }).skus[0] || sku; } catch { /* bolsa no resuelta: se encola por el propio SKU */ }
    recursos.add(`sku:${canon}`);
  }
  for (const recurso of recursos) encolarTrabajo(db, { tipo: 'stock.bolsa', recurso, demoraMs });
  return [...recursos];
}

/** SKUs vinculados a las publicaciones de una orden ML (clave `item|variación`); las que no se resuelven se omiten. */
function skusDeOrdenMl(db, orden) {
  const skus = new Set();
  for (const it of orden?.order_items || []) {
    const clave = `${it?.item?.id}|${it?.item?.variation_id || ''}`;
    const sku = db.prepare(`SELECT sku FROM sku_matcher_decisiones WHERE clave = ? AND accion IN ${ACCIONES_VINCULO} AND sku IS NOT NULL AND sku <> ''`).get(clave)?.sku
      || db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = ?').get(clave)?.seller_sku;
    if (sku) skus.add(sku);
  }
  return [...skus];
}

/** Ventana (días) dentro de la cual el camino webhook/job puede crear el pedido Woo de una orden ML. Configurable. */
export function ventanaOrdenMlMs() {
  const d = Number(process.env.ML_ORDEN_VENTANA_DIAS);
  return (Number.isFinite(d) && d > 0 ? d : 3) * 24 * 3600 * 1000;
}
/** 'dentro' | 'fuera' | 'sin_fecha'. Fecha en UTC (sin offset se asume UTC). Sin fecha legible es fail-safe: no se crea pedido. */
function estadoVentana(orden) {
  const t = fechaOrdenMs(orden);
  if (t === null) return 'sin_fecha';
  return Date.now() - t > ventanaOrdenMlMs() ? 'fuera' : 'dentro';
}
/** Orden ya sellada, con reserva o con destino 'pedido' reclamado: sigue su camino de siempre (no crea nada nuevo). */
const ordenYaTratada = (db, id) => destinoActual(db, id) === 'pedido';

/**
 * Corte por fecha común a todos los orígenes. Orden pagada, no tratada y fuera de ventana → descuento sin pedido + aviso;
 * sin fecha legible → ni pedido ni descuento, solo incidente. `{tratada:true}` = el llamador NO debe crear pedido.
 */
async function tratarOrdenFueraDeVentana(db, cfg, orden, { reencolarSiPendiente = false } = {}) {
  if (orden?.status !== 'paid' || ordenYaTratada(db, orden.id)) return { tratada: false };
  // Con fila de descuento (cualquiera, no completa) la orden sigue por el descuento sin importar la ventana: si no, un `parcial`
  // cuya fecha de pago cae dentro iría al camino del pedido y el job cerraría 'hecho' sin completar el descuento.
  const hayFila = Boolean(db.prepare('SELECT 1 FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').get(String(orden.id)));
  const v = hayFila ? 'fuera' : estadoVentana(orden);
  if (v === 'dentro') return { tratada: false };
  if (v === 'sin_fecha') {
    const txt = `La venta de MercadoLibre ${orden.id} no trae ninguna fecha legible (pago, cierre ni creación; creación: ${JSON.stringify(orden.date_created ?? null)}): no se creó el pedido ni se descontó stock. Revisala a mano.`;
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError: `orden_ml_sin_fecha_${orden.id}`.slice(0, 120), severidad: 'critico',
      mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: String(orden.id), fecha: orden.date_created ?? null },
    });
    return { tratada: true, d: { estado: 'sin_fecha' } };
  }
  const d = await descontarOrdenViejaSinPedido(db, cfg, orden, { origen: 'job' });
  // Polling/puntual no reintentan: si quedó a medias, un job order.ml (con su backoff) lo termina.
  if (reencolarSiPendiente && d.estado === 'reintentar') encolarTrabajo(db, { tipo: 'order.ml', recurso: String(orden.id) });
  return { tratada: true, d };
}

/**
 * Orden ML pagada y vieja sin pedido: descuenta en Woo la cantidad vendida (idempotente por orden, bajo los candados de
 * E-0), encola `stock.bolsa` y avisa (incidente crítico → mail + push). `dryRun` no escribe nada. Lo usa el job y el script
 * `scripts/ops/descontar-ordenes-viejas.mjs`.
 */
export function descontarOrdenViejaSinPedido(db, cfg, orden, opts = {}) {
  return descontarOrdenVieja(db, cfg, orden, {
    enriquecer: enriquecerLineasBarrera, encolarBolsas: encolarBolsasDeSkus,
    log: (msg, id) => logSync(db, { direccion: 'ml_wc', clave: id, estado: 'aviso_cancelada_luego_pagada_fallo', error: String(msg).slice(0, 300) }), vinculos: ACCIONES_VINCULO, diasVentana: ventanaOrdenMlMs() / 86400000,
    // Mismo identificador que escribe el POST de creación (meta `_ml_order_id`). Lanza si la lectura no es concluyente.
    // Después, búsqueda por texto del número de orden y del pack (pedidos manuales sin la meta). Devuelve {id, via} o null; lanza si no concluye.
    conciliarConWoo: async (_db, c, o) => {
      const t = Date.parse(o?.date_created);
      const viaMeta = await buscarPedidoWcPorMlOrderId(c.woo, String(o.id), new Date(Number.isFinite(t) ? t : Date.now() - 30 * 86400000).toISOString());
      if (viaMeta) return { id: viaMeta, via: 'meta' };
      for (const [termino, via] of [[String(o.id), 'texto'], [o?.pack_id != null && String(o.pack_id) !== String(o.id) ? String(o.pack_id) : null, 'texto_pack']]) {
        const w = termino ? await buscarPedidoWcPorTexto(c.woo, termino) : null;
        if (w) return { id: w, via };
      }
      return null;
    },
  }, opts);
}

/**
 * Trabajo `order.ml` (un job por orden, llegue por `orders` u `orders_v2`). Relee la orden y:
 *  - cancelada → cancelación puntual idempotente del pedido Woo (reserva en curso → reencola sin tocar nada) y refresco de bolsas;
 *  - pagada → pedido Woo (nunca un segundo POST: la reserva persiste mientras sea incierta) + Preparación, y encola las bolsas;
 *  - otro estado → solo Preparación (invalida su caché).
 * @returns {{estado:'hecho'}|{estado:'reencolar', motivo:string}}
 */
export async function procesarOrdenMl(db, cfg, mlOrderId) {
  if (!mlCfgOk(cfg) || !cfg.woo) return { estado: 'reencolar', motivo: 'ml_o_woo_sin_configurar' };
  const resp = await mlFetch(db, cfg.ml, 'get', `/orders/${mlOrderId}`);
  if (resp.status !== 200 || !resp.data) return { estado: 'reencolar', motivo: `ml_orders_http_${resp.status}` };
  const orden = resp.data;
  // SKUs de la orden: permiten que stock.bolsa bloquee solo las bolsas que esta venta toca.
  try { guardarContextoTrabajo(db, 'order.ml', String(mlOrderId), { skus: skusDeOrdenMl(db, orden) }); } catch { /* el contexto es una optimización */ }
  const { syncPedidoMlPuntual } = await import('./preparacion.js');
  const skusDelPedido = async () => {
    const reg = db.prepare('SELECT wc_order_id FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(String(mlOrderId));
    if (!reg || !reg.wc_order_id) return [];
    const p = (await wooFetch(cfg.woo, `/orders/${reg.wc_order_id}`))?.data;
    if (!p || !Array.isArray(p.line_items)) throw new Error(`Woo no devolvió las líneas del pedido ${reg.wc_order_id}`);
    return [...new Set(p.line_items.map((l) => l.sku).filter(Boolean))];
  };
  if (orden.status === 'cancelled') {
    // Si ya se había descontado sin pedido: aviso para reponer a mano (no se repone solo). Toma los candados del descuento.
    if (await avisarCancelacionDescontada(db, orden) === 'ocupado') return { estado: 'reencolar', diferido: true, motivo: 'descuento_en_curso' };
    const c = await cancelarPedidoWooDeOrden(db, cfg.woo, mlOrderId);
    if (c.estado === 'reserva_en_curso') return { estado: 'reencolar', diferido: true, motivo: 'reserva_en_curso' };
    await syncPedidoMlPuntual(db, cfg.ml, mlOrderId); // saca la orden de la cola de Preparación
    encolarBolsasDeSkus(db, c.skus);
    limpiarPendienteMl(db, mlOrderId, 'la orden pasó a cancelled');
    return { estado: 'hecho' };
  }
  if (orden.status !== 'paid') {
    await syncPedidoMlPuntual(db, cfg.ml, mlOrderId);
    limpiarPendienteMl(db, mlOrderId, `la orden ya no está paid (${orden.status})`);
    return { estado: 'hecho' };
  }
  // Corte por fecha: un aviso tardío (calificación, reclamo, mediación) de una orden vieja que nunca se selló NO crea el
  // pedido Woo semanas después (descontaría stock de algo ya despachado). Sin POST ni reserva: incidente para revisión humana.
  // Una orden ya sellada o con reserva en curso sigue su camino de siempre (no crea nada nuevo).
  const corte = await tratarOrdenFueraDeVentana(db, cfg, orden);
  if (corte.tratada) {
    // Decisión de José: no se crea el pedido, pero sí se descuenta lo vendido (una vez por orden) y se avisa.
    await syncPedidoMlPuntual(db, cfg.ml, mlOrderId); // Preparación sigue igual
    if (corte.d?.estado === 'reintentar') return { estado: 'reencolar', motivo: corte.d.motivo };
    // Lista blanca de resultados terminales: `sin_fecha` (la fecha puede aparecer en una relectura) y cualquier estado desconocido
    // o nuevo conservan el pendiente (fail-closed); cuando por fin selle, se limpia por el camino normal.
    if (esResultadoTerminalDescuento(corte.d?.estado)) limpiarPendienteMl(db, mlOrderId, 'la orden se resolvió por el descuento sin pedido');
    return { estado: 'hecho', motivo: corte.d?.estado === 'sin_fecha' ? 'orden_sin_fecha' : 'orden_vieja_sin_pedido' };
  }
  // Efecto 1: pedido Woo. `syncOrdenMlPuntual` no duplica: la reserva atómica de `_procesarOrden` impide un segundo POST.
  await syncOrdenMlPuntual(db, cfg, mlOrderId, { orden });
  const sellada = db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id = ?').get(String(mlOrderId));
  // Efecto 2: Preparación (corre aunque el pedido Woo todavía esté pendiente: son independientes).
  await syncPedidoMlPuntual(db, cfg.ml, mlOrderId);
  if (!sellada) return { estado: 'reencolar', diferido: true, motivo: 'pedido_woo_sin_confirmar' };
  encolarBolsasDeSkus(db, await skusDelPedido());
  limpiarPendienteMl(db, mlOrderId, 'la orden se selló');
  return { estado: 'hecho' };
}

/**
 * Trabajo `stock.bolsa`: ÚNICO camino de escritura de stock desde eventos. No escribe (y reencola, sin cerrarse como
 * hecho) si hay una venta ML en vuelo, una barrera de E-0 o un fallo de lectura; SKUs distintos en una bolsa son una
 * contradicción (no escribe y abre un incidente). Todo push pasa por `escribirStockMl`.
 */
export async function procesarStockBolsa(db, cfg, sku) {
  if (!mlCfgOk(cfg) || !cfg.woo) return { estado: 'reencolar', motivo: 'ml_o_woo_sin_configurar' };
  let bolsa;
  try { bolsa = resolverBolsa(db, { skus: [sku] }); } catch (e) { return { estado: 'reencolar', motivo: `bolsa_no_resuelta: ${e.message}` }; }
  if (!bolsa.skus.length) bolsa.skus = [sku];
  // Una venta ML que todavía no impactó en Woo: empujar ahora devolvería a ML la unidad vendida. Solo frena si esa
  // venta toca esta bolsa (SKUs de la orden) o si todavía no se la leyó; una orden ajena en backoff no bloquea.
  if (ordenMlAfectaASkus(db, bolsa.skus)) return { estado: 'reencolar', diferido: true, motivo: 'orden_ml_pendiente' };
  if (bolsa.skus.length > 1) {
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'stock_bolsa', tipoError: `bolsa_con_skus_distintos_${bolsa.skus[0]}`.slice(0, 120), severidad: 'critico',
      mensajeTecnico: `Bolsa con SKUs distintos: ${bolsa.skus.join(', ')}`,
      mensajeHumano: `Publicaciones hermanas (mismo producto de catálogo de ML) están vinculadas a SKUs distintos (${bolsa.skus.join(', ')}). No se les escribe stock hasta corregir el vínculo en Catálogo/Vínculos.`,
      contexto: { skus: bolsa.skus, claves: bolsa.claves },
    });
    return { estado: 'hecho', motivo: 'contradiccion_skus' };
  }
  const r = await conCandados(db, bolsa.skus, async (candado) => {
    if (filasBarrera(db, bolsa.skus).length) return { estado: 'reencolar', diferido: true, motivo: 'barrera' };
    const c = await _conciliarClavesDeBolsa(db, cfg, bolsa, candado, {});
    if (c.ok) return { estado: 'hecho', empujadas: c.empujadas, instantanea: c.instantanea };
    return c.bloqueado ? { estado: 'hecho', motivo: 'bloqueado_por_identidad' } : { estado: 'reencolar', motivo: c.motivo };
  });
  if (r.ocupado) return { estado: 'reencolar', diferido: true, motivo: 'candados_ocupados' };
  return r.valor;
}

// ─── E-1b: trabajo `order.woo` (pedido Woo creado/modificado/borrado/restaurado) ────────────────────────────────────

const skusDeLineasWoo = (orden) => [...new Set((orden?.line_items || []).map((l) => String(l?.sku || '').trim()).filter(Boolean))];

/** Conjunto de SKUs persistido de la orden (vacío si nunca se cerró un trabajo para ella). */
export function skusPersistidosOrdenWoo(db, orderId) {
  const f = db.prepare('SELECT skus_json FROM woo_orden_skus WHERE order_id = ?').get(String(orderId));
  try { const v = JSON.parse(f?.skus_json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Trabajo `order.woo` (un job por orden Woo, lo dispara cualquier topic `order.*`: el topic solo dispara, la relectura vigente
 * decide). Relee la orden y:
 *  - 404 confirmado o `status=trash`: el conjunto actual es vacío; Preparación retira la orden y anula su fila;
 *  - vigente: Preparación (incluida la restauración de una anulada);
 *  - en ambos casos refresca (stock.bolsa relee Woo) y encola las bolsas de la UNIÓN (persistido ∪ actual), de modo que
 *    un SKU quitado de la orden, o toda la orden enviada a la papelera, libera su stock.
 * Reemplaza al `syncWcToMl` general para este disparador. No escribe en Woo ni en ML directamente.
 * @returns {{estado:'hecho', skusActuales:string[]}|{estado:'reencolar', motivo:string}}
 */
export async function procesarOrdenWoo(db, cfg, orderId) {
  if (!cfg.woo) return { estado: 'reencolar', motivo: 'woo_sin_configurar' };
  const { syncPedidoWebPuntual, esOrdenWooInexistente } = await import('./preparacion.js');
  let orden = null;
  let inexistente = false;
  try {
    orden = (await wooFetch(cfg.woo, `/orders/${orderId}`)).data;
  } catch (e) {
    if (!esOrdenWooInexistente(e)) return { estado: 'reencolar', motivo: `woo_orders_${e.status || 'error'}: ${String(e.message).slice(0, 120)}` };
    inexistente = true;
  }
  if (!inexistente && (!orden || typeof orden !== 'object')) return { estado: 'reencolar', motivo: 'woo_orden_ilegible' };
  const fuera = inexistente || orden.status === 'trash';
  const actuales = fuera ? [] : skusDeLineasWoo(orden);
  // Fuentes para la UNIÓN: lo persistido por un trabajo verificado, las líneas que Woo devuelve aun en la papelera, y — si la
  // orden es anterior al deploy y nunca cerró un trabajo — lo que Preparación ya conoce (cola y preparaciones).
  const persistidos = skusPersistidosOrdenWoo(db, orderId);
  const lineasEnPapelera = fuera && orden ? skusDeLineasWoo(orden) : [];
  const conocidos = skusConocidosOrdenWoo(db, orderId); // siempre: una fila sembrada desactualizada perdería un SKU agregado después
  const union = [...new Set([...persistidos, ...actuales, ...lineasEnPapelera, ...conocidos])];
  if (inexistente && !union.length) {
    // 404 sin ninguna fuente: no se puede saber qué stock liberar. No se cierra en silencio.
    // Riesgo residual aceptado: una orden creada DESPUÉS de la siembra y borrada para siempre antes de cualquier aviso nunca tuvo
    // SKUs registrados. Este incidente lo hace visible y la reconciliación periódica de stock (`reconciliarStockMl`) corrige la diferencia.
    const txt = `El pedido Woo ${orderId} ya no existe (404) y no hay ningún SKU registrado para él (ni en el trabajo, ni en la cola de Preparación, ni en preparaciones): no se pudo liberar su stock reservado. Revisá a mano si ese pedido tenía productos con stock gestionado.`;
    abrirOActualizarIncidente(db, {
      integracion: 'woocommerce', proceso: 'order_woo', tipoError: `order_woo_sin_skus_${orderId}`.slice(0, 120), severidad: 'advertencia',
      mensajeTecnico: txt, mensajeHumano: txt, contexto: { wc_order_id: String(orderId) },
    });
  }
  // Preparación: una falla acá cuenta como fallo real del trabajo (reintenta con backoff); el cron de 10 min es el respaldo.
  await syncPedidoWebPuntual(db, {
    woo: cfg.woo,
    andreaniStatus: process.env.ANDREANI_ORDER_STATUS || 'lpaandreani',
    enviadoAndreaniStatus: process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani',
  }, orderId, { orden, inexistente });
  encolarBolsasDeSkus(db, union);
  return { estado: 'hecho', skusActuales: actuales };
}

/** Topics de pedido que dispara el trabajo `order.woo`. Todos se tratan igual: el topic solo dispara, la relectura decide. */
export const TOPICS_ORDEN_WOO = new Set(['order.created', 'order.updated', 'order.deleted', 'order.restored']);

/** Encola (o reprograma) el `order.woo` de una orden. Lo llama el handler del webhook ANTES del ACK. */
export function encolarOrdenWoo(db, orderId) {
  return encolarTrabajo(db, { tipo: 'order.woo', recurso: String(orderId) });
}

// ─── E-1c: trabajo `catalog.woo_product_sync` (producto Woo creado/modificado/borrado/restaurado) ──────────────────────

/** Topics de producto que dispara el trabajo `catalog.woo_product_sync`. El topic solo dispara; decide la relectura vigente. */
export { encolarProductoWoo };
export const TOPICS_PRODUCTO_WOO = new Set(['product.created', 'product.updated', 'product.deleted', 'product.restored']);

/**
 * Trabajo `catalog.woo_product_sync` (un job por producto padre). Relee el producto (o su padre) con `refrescarProductoPuntual`:
 *  - vigente: refresca el caché y encola las bolsas de sus SKUs (padre, variaciones y SKUs anteriores); una variación que
 *    desapareció del padre recibe la baja confirmada (protección + ML a 0) aunque el aviso haya sido un `product.updated`;
 *  - 404 `invalid_id` o `status=trash`: baja confirmada del producto y sus variaciones;
 *  - 5xx / error de red / ilegible: se reencola y NO se baja ni se lleva nada a 0.
 * Las bolsas se encolan dentro de la transacción del caché. No escribe en Woo; el único efecto remoto es el de `stock.bolsa`.
 */
export async function procesarProductoWoo(db, cfg, recurso) {
  if (!cfg.woo) return { estado: 'reencolar', motivo: 'woo_sin_configurar' };
  try {
    const r = await refrescarProductoPuntual(db, cfg.woo, { productoId: Number(recurso), alEscribir: (d, skus) => encolarBolsasDeSkus(d, skus) });
    if (r.ignorado) {
      const txt = `Llegó un aviso de producto Woo con el id ${recurso}, que no existe (404) y nunca estuvo en el catálogo local (ni como producto ni como padre): no se dio de baja nada. Puede ser una variación nueva cuyo aviso no trajo el padre; si falta en el catálogo, refrescá el producto padre.`;
      try {
        abrirOActualizarIncidente(db, {
          integracion: 'woocommerce', proceso: 'producto_woo', tipoError: `producto_woo_id_desconocido_${recurso}`.slice(0, 120), severidad: 'advertencia',
          mensajeTecnico: txt, mensajeHumano: txt, contexto: { id: String(recurso) },
        });
      } catch { /* informativo */ }
      return { estado: 'hecho', motivo: 'id_nunca_visto' };
    }
    return { estado: 'hecho', eliminado: r.eliminado, skus: r.skus };
  } catch (e) {
    if (e?.code === 'woo_product_invalid_id') return { estado: 'hecho', motivo: 'id_invalido' }; // nunca vuelve a servir: no se reintenta
    return { estado: 'reencolar', motivo: `woo_products_${e.status || 'error'}: ${String(e.message).slice(0, 120)}` };
  }
}

// ─── E-2: trabajo `item.project` (publicación de ML creada/modificada, o su user_product cambió de stock) ───────────────

/** Cuántos `item.project` se releen juntos: ML permite 20 ids por /items/bulk. */
export const LOTE_ITEMS_ML = 20;
const CAMPOS_ITEM_QUE_ENCOLAN_BOLSA = ['available_quantity', 'status', 'user_product_id'];

function fotoItemsMl(db, ids) {
  const marcas = ids.map(() => '?').join(',');
  const filas = db.prepare(`SELECT clave,item_id,seller_sku,available_quantity,status,sub_status,precio,user_product_id,gtin
    FROM ml_publicaciones_cache WHERE item_id IN (${marcas})`).all(...ids);
  const dec = new Map();
  if (filas.length) {
    for (const d of db.prepare(`SELECT clave, sku FROM sku_matcher_decisiones WHERE accion IN ${ACCIONES_VINCULO} AND sku IS NOT NULL AND sku <> ''
      AND clave IN (${filas.map(() => '?').join(',')})`).all(...filas.map((f) => f.clave))) dec.set(d.clave, d.sku);
  }
  return { filas, dec };
}

/** SKUs vinculados (decisión asignar/confirmar) de todas las claves de unos ítems, leídos del estado actual de las decisiones. */
function skusVinculadosDeItems(db, ids) {
  const marcas = ids.map(() => '?').join(',');
  return db.prepare(`SELECT DISTINCT d.sku FROM sku_matcher_decisiones d
    WHERE d.accion IN ${ACCIONES_VINCULO} AND d.sku IS NOT NULL AND d.sku <> ''
      AND substr(d.clave, 1, instr(d.clave || '|', '|') - 1) IN (${marcas})`).all(...ids).map((r) => r.sku);
}

/**
 * Carrera con el scan u otro refresco: si el caché ya estaba al día, el diff `antes/después` sale vacío aunque el remoto no sea lo
 * deseado (el scan corrige `ml_stock_estado`, no encola bolsas). Se compara también contra el deseado calculado LOCAL (sin llamar
 * a ML): una publicación activa y vinculada cuya cantidad difiere de `stock_disponible_ml` encola su bolsa.
 */
function remotoDifiereDelDeseado(db, f, skuVinculado, deseados) {
  if (!skuVinculado || f.status !== 'active' || f.available_quantity == null) return false;
  // Si la última bolsa de este SKU terminó SIN escribir hace poco, una diferencia local no la vuelve a disparar (evita lecturas
  // a ML en cada aviso por un falso positivo persistente). Un cambio real de cantidad/estado/vínculo sí dispara (otra rama del diff).
  const deseado = deseados.get(f.clave);
  if (deseado == null) return false;
  if (Number(f.available_quantity) === deseado) return false;
  // La supresión vale SOLO si el deseado efectivo y la cantidad remota de esta clave son IGUALES a los que verificó esa bolsa:
  // cualquier cambio (Woo o ML), aunque el scan ya haya actualizado el caché, dispara la bolsa.
  const marca = leerEstado(db, `bolsa_sin_escritura:${skuVinculado}`);
  if (!marca || Date.now() - new Date(marca.actualizado_en).getTime() >= VENTANA_SIN_ESCRITURA_MS) return true;
  let verificado = null;
  try { verificado = JSON.parse(marca.valor)?.claves?.[f.clave] ?? null; } catch { /* marca vieja o ilegible: no suprime */ }
  return !(verificado && verificado.deseado === deseado && verificado.remoto === Number(f.available_quantity));
}

/** Recuerda, por clave, el deseado efectivo y la cantidad remota que verificó una bolsa que terminó sin escribir. */
function marcarBolsaSinEscritura(db, sku, instantanea) {
  // Se guarda la instantánea VERIFICADA por la bolsa (deseado y remoto con que confirmó), sin releer nada: si Woo cambió entre la
  // confirmación y el cierre, la marca conserva el valor viejo y el próximo item.project ve la diferencia y dispara.
  guardarEstado(db, `bolsa_sin_escritura:${sku}`, JSON.stringify({ claves: instantanea || {} }));
}

/**
 * Deseado EFECTIVO por clave para un lote, calculado UNA vez con `computedStockCte() ... IN (...)` (no una consulta por clave).
 * Las hermanas (mismo `user_product_id`) comparten una cantidad en ML: el deseado de cada una es el MÍNIMO del grupo, igual que
 * en la bolsa, así que dos hermanas con deseados distintos no generan un falso positivo persistente.
 */
function deseadosEfectivosDeItems(db, ids) {
  const out = new Map();
  const base = fotoItemsMl(db, ids).filas;
  if (!base.length) return out;
  const ups = [...new Set(base.map((f) => String(f.user_product_id ?? '').trim()).filter(Boolean))];
  const hermanas = ups.length
    ? db.prepare(`SELECT clave, user_product_id FROM ml_publicaciones_cache WHERE user_product_id IN (${ups.map(() => '?').join(',')})`).all(...ups)
    : [];
  const upDe = new Map(base.map((f) => [f.clave, String(f.user_product_id ?? '').trim()]));
  for (const h of hermanas) upDe.set(h.clave, String(h.user_product_id ?? '').trim());
  const claves = [...upDe.keys()];
  const calc = new Map();
  for (const r of db.prepare(`${computedStockCte()} SELECT clave, stock_disponible_ml FROM computed WHERE clave IN (${claves.map(() => '?').join(',')})`).all(...claves)) {
    if (r.stock_disponible_ml != null) calc.set(r.clave, Math.max(0, Math.round(r.stock_disponible_ml)));
  }
  const minGrupo = new Map();
  for (const [clave, d] of calc) {
    const up = upDe.get(clave);
    if (up) minGrupo.set(up, Math.min(minGrupo.get(up) ?? Infinity, d));
  }
  for (const f of base) {
    const up = upDe.get(f.clave);
    const d = up ? minGrupo.get(up) : calc.get(f.clave);
    if (d != null && d !== Infinity) out.set(f.clave, d);
  }
  return out;
}

/** Compara la foto previa con el estado actual de un ítem: ¿cambió cantidad, estado, user_product o vínculo? Devuelve los SKUs a conciliar. */
function skusAfectadosPorItem(db, itemId, antes, deseados) {
  const despues = fotoItemsMl(db, [itemId]);
  const previas = new Map(antes.filas.filter((f) => f.item_id === itemId).map((f) => [f.clave, f]));
  let cambio = false;
  const skus = new Set();
  for (const f of despues.filas) {
    const a = previas.get(f.clave);
    const skuAntes = antes.dec.get(f.clave) ?? null;
    const skuAhora = despues.dec.get(f.clave) ?? null;
    if (!a || skuAntes !== skuAhora || CAMPOS_ITEM_QUE_ENCOLAN_BOLSA.some((c) => String(a[c] ?? '') !== String(f[c] ?? '')) || remotoDifiereDelDeseado(db, f, skuAhora, deseados)) {
      cambio = true;
      if (skuAntes) skus.add(skuAntes);
      if (skuAhora) skus.add(skuAhora);
    }
  }
  for (const [clave, a] of previas) { // clave que desapareció
    if (!despues.filas.some((f) => f.clave === clave)) { cambio = true; const s = antes.dec.get(clave); if (s) skus.add(s); }
  }
  return cambio ? [...skus] : [];
}

const VENTANA_SIN_ESCRITURA_MS = 10 * 60 * 1000; // tras una bolsa sin escritura, no se re-dispara por diferencia local
/**
 * Un solo incidente `item_ml_403` con la lista VIGENTE de ids: une los de antes con los de este lote y saca los que ya dieron
 * 200 (o 404 confirmado). Si la lista queda vacía, el incidente se cierra.
 */
function actualizarIncidente403(db, ids403, idsResueltos) {
  try {
    const previo = db.prepare("SELECT contexto_json FROM incidentes_operativos WHERE tipo_error = 'item_ml_403' AND estado = 'activo'").get();
    let previos = [];
    try { previos = JSON.parse(previo?.contexto_json || 'null')?.item_ids || []; } catch { /* sin contexto */ }
    const resueltos = new Set(idsResueltos);
    const vigentes = [...new Set([...previos, ...ids403])].filter((id) => !resueltos.has(id) || ids403.includes(id));
    if (!vigentes.length) {
      if (previo) confirmarCicloSano(db, { integracion: 'mercadolibre', proceso: 'item_project', tipoError: 'item_ml_403' });
      return;
    }
    const txt = `MercadoLibre respondió 403 al leer ${vigentes.length} ítem(s): ${vigentes.join(', ')} (ítem ajeno o token sin permiso). No se tocó el caché; se reintenta cada 30 min.`;
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'item_project', tipoError: 'item_ml_403', severidad: 'advertencia',
      mensajeTecnico: txt, mensajeHumano: txt, contexto: { item_ids: vigentes },
    });
  } catch { /* informativo */ }
}

const TOPE_GET_404_POR_PASE = 5; // GET individuales de confirmación por pase; el resto se reencola

/**
 * Lote de trabajos `item.project`: UNA relectura `/items/bulk` (hasta 20 ids) por lote, con el Vigía, el autovínculo y la
 * auditoría de precios que ya incluye `refrescarPublicacionesMlAcotado`. Encola `stock.bolsa` de las claves del ítem SOLO si
 * cambió `available_quantity`, `status`, `user_product_id` o el vínculo. Cada elemento se trata por su status_code:
 *  - 200: se proyecta; 404: baja solo si `GET /items/{id}` también da 404 (retira el caché y encola la bolsa);
 *  - 403: incidente, sin tocar el caché, y se reencola; 429, 5xx u otro (o ausente): se reencola ese id con backoff.
 * Un elemento no-200 nunca cierra su trabajo como hecho. No escribe stock: solo `stock.bolsa` escribe.
 * @returns {Map<string, {estado:'hecho'}|{estado:'reencolar', motivo:string, diferido?:boolean, demoraMs?:number}>} por recurso
 */
export async function procesarLoteItemsMl(db, cfg, recursos) {
  const res = new Map();
  const ids = [...new Set(recursos.map(String))];
  if (!mlCfgOk(cfg)) { for (const id of ids) res.set(id, { estado: 'reencolar', motivo: 'ml_sin_configurar' }); return res; }
  const antes = fotoItemsMl(db, ids);
  const { refrescarPublicacionesMlAcotado } = await import('./matcher.js');
  let r;
  try {
    r = await refrescarPublicacionesMlAcotado(db, cfg.ml, ids);
  } catch (e) {
    // Todo el lote falló (5xx, cooldown, red): se reencola cada id. El cooldown propio es una espera, no un fallo.
    const espera = e.__cooldownSintetico || e.__sinCupo || e.status === 429;
    for (const id of ids) res.set(id, { estado: 'reencolar', diferido: Boolean(espera), motivo: `ml_items_bulk_${e.status || 'error'}: ${String(e.message).slice(0, 120)}` });
    return res;
  }
  const noOk = new Map((r.noOk || []).map((x) => [x.id, x.status_code]));
  const skusAEncolar = new Set();
  // Un corte entre el refresco del caché y el encolado dejaría el diff invisible en el reintento (el caché ya está al día):
  // los SKUs pendientes se anotan en el contexto del trabajo ANTES de encolar y se retoman al releerlo.
  const previosPorItem = new Map();
  for (const id of ids) {
    try {
      const c = JSON.parse(db.prepare("SELECT contexto_json FROM trabajos_recurso WHERE tipo = 'item.project' AND recurso = ?").get(id)?.contexto_json || 'null');
      const previos = c?.skus_pendientes || [];
      previosPorItem.set(id, previos);
      for (const s of previos) skusAEncolar.add(s);
    } catch { /* sin contexto */ }
  }
  let deseados = new Map();
  try { deseados = deseadosEfectivosDeItems(db, ids.filter((id) => !noOk.has(id))); } catch { /* sin deseado local: solo dispara el diff de campos */ }
  const ids403 = [];
  let getsIndividuales = 0;
  for (const id of ids) {
    try { // un fallo en un ítem no pierde lo ya calculado de los otros (sus skus_pendientes ya están en el contexto)
      if (!noOk.has(id)) {
        const sk = skusAfectadosPorItem(db, id, antes, deseados);
        for (const s of sk) skusAEncolar.add(s);
        // ANTES de encolar: un corte no pierde el diff. Es la UNIÓN con los pendientes de intentos anteriores (dos cortes seguidos
        // no pisan el SKU del primero); solo se limpian cuando la bolsa de TODOS ellos quedó encolada (abajo).
        if (sk.length) guardarContextoTrabajo(db, 'item.project', id, { skus_pendientes: [...new Set([...(previosPorItem.get(id) || []), ...sk])] });
        try { // telemetría (no decide nada): fail-open
          const { registrarCambiosObservados } = await import('../lib/workerIntegrationJobs.js');
          registrarCambiosObservados(db, id, antes.filas.filter((f) => f.item_id === id), 'webhook');
        } catch { /* fail-open */ }
        res.set(id, { estado: 'hecho' });
        continue;
      }
      const code = noOk.get(id);
      if (code === 404) {
        if (getsIndividuales >= TOPE_GET_404_POR_PASE) { // presupuesto: no se multiplican las llamadas a ML por un lote de 404
          res.set(id, { estado: 'reencolar', motivo: 'item_404_presupuesto', diferido: true, demoraMs: 2 * 60 * 1000 });
          continue;
        }
        getsIndividuales++;
        const ind = await mlFetch(db, cfg.ml, 'get', `/items/${id}?attributes=id,status`);
        if (ind.status === 404) {
          const skus = skusVinculadosDeItems(db, [id]);
          db.transaction(() => {
            db.prepare('DELETE FROM ml_publicaciones_cache WHERE item_id = ?').run(id);
            if (skus.length) encolarBolsasDeSkus(db, skus);
          })();
          res.set(id, { estado: 'hecho', motivo: 'item_404_confirmado' });
        } else {
          res.set(id, { estado: 'reencolar', motivo: ind.status === 200 ? 'item_404_en_bulk_pero_existe' : `item_404_sin_confirmar_http_${ind.status}`, diferido: ind.status === 429 });
        }
        continue;
      }
      if (code === 403) {
        ids403.push(id);
        res.set(id, { estado: 'reencolar', motivo: 'item_403', demoraMs: 30 * 60 * 1000 });
        continue;
      }
      res.set(id, { estado: 'reencolar', motivo: `item_bulk_${code ?? 'ausente'}`, diferido: code === 429 });
    } catch (e) {
      res.set(id, { estado: 'reencolar', motivo: `item_error: ${String(e.message).slice(0, 120)}`, diferido: Boolean(e.__cooldownSintetico || e.__sinCupo || e.status === 429) });
    }
  }
  actualizarIncidente403(db, ids403, ids.filter((id) => res.get(id)?.estado === 'hecho'));
  if (skusAEncolar.size) {
    encolarBolsasDeSkus(db, [...skusAEncolar]);
    for (const id of ids) { try { db.prepare("UPDATE trabajos_recurso SET contexto_json = NULL WHERE tipo = 'item.project' AND recurso = ?").run(id); } catch { /* ya encolado */ } }
  }
  return res;
}

// ─── E-4: trabajo `shipment.project` (envío de ML creado/modificado) ───────────────────────────────────────────────────
/** Veces que se difiere un envío cerrado por `closed_by_user` (cambio de tipo de envío) esperando que ML asigne el nuevo. */
const ESPERAS_CAMBIO_ENVIO = 5;
/** Veces que se difiere un envío cuya orden no se puede identificar antes de cerrarlo con un aviso. */
const ESPERAS_ENVIO_SIN_ORDEN = 12;

/**
 * Órdenes ML de un envío: primero `gestion_pedidos.ml_shipment_id`; si no está (orden aún no importada), `/shipments/{id}/items`.
 * Un 404 de `/items` equivale a "sin orden conocida" (el envío no existe o no es nuestro).
 */
async function ordenesDeEnvioMl(db, mlCfg, sid) {
  const filas = db.prepare("SELECT external_id FROM gestion_pedidos WHERE fuente = 'mercadolibre' AND ml_shipment_id = ?").all(sid);
  if (filas.length) return { ids: [...new Set(filas.map((f) => String(f.external_id)))] };
  const r = await mlFetch(db, mlCfg, 'get', `/shipments/${encodeURIComponent(sid)}/items`, null, { headers: { 'x-format-new': 'true' } });
  if (r.status === 429) return { error: 'ml_429', diferido: true };
  if (r.status === 404) return { ids: [] };
  if (r.status !== 200 || !Array.isArray(r.data)) return { error: `shipment_items_http_${r.status}` };
  return { ids: [...new Set(r.data.map((i) => String(i?.order_id ?? '')).filter(Boolean))] };
}

/**
 * Efecto del aviso `shipments`: relee el envío (x-format-new) y lo aplica a Preparación SOLO si es el `shipping.id` vigente de su
 * orden (un envío obsoleto por cambio de logística no cancela nada; se encola el vigente). Decisiones de José (2026-10-15):
 *  - envío `cancelled` con la preparación en curso → misma ruta que la cancelación de la orden (devolución pendiente si hay ítems
 *    levantados, si no "cancelada sin retiro") + incidente de aviso;
 *  - `closed_by_user` (cambio de tipo de envío) NUNCA cancela por tiempo: solo cancela la orden ML cancelada (ruta de orden). Tras
 *    ${ESPERAS_CAMBIO_ENVIO} esperas con el mismo `shipping.id` se abre `envio_cerrado_sin_resolver_<orden>` y la preparación no se toca;
 *  - la logística cambia y sigue siendo local → se actualizan tipo y horario límite sin frenar; pasa a Full → sale de la cola + aviso
 *    (haya o no preparación en curso);
 *  - `printed` / `stale` / `delayed` solo viajan en `pedidos_cache.substatus` (chips "Etiqueta lista" / "Demorado").
 * Volumen: sin orden conocida no se relee el envío; un aviso repetido (misma firma status+substatus+logística ya aplicada) no relee la orden.
 * @returns {Promise<{estado:'hecho'}|{estado:'reencolar', motivo:string, diferido?:boolean, demoraMs?:number}>}
 */
export async function procesarEnvioMl(db, cfg, shipmentId) {
  if (!mlCfgOk(cfg)) return { estado: 'reencolar', motivo: 'ml_sin_configurar' };
  const sid = String(shipmentId);
  const prepa = await import('./preparacion.js');
  prepa.ensureTables(db);
  const dif = db.prepare("SELECT diferidos FROM trabajos_recurso WHERE tipo = 'shipment.project' AND recurso = ?").get(sid)?.diferidos || 0;

  // 1) Mapeo a órdenes ANTES de releer el envío: sin orden conocida alcanza con /items (no se gasta otro GET por reintento).
  const mapa = await ordenesDeEnvioMl(db, cfg.ml, sid);
  if (mapa.error) return { estado: 'reencolar', motivo: mapa.error, diferido: Boolean(mapa.diferido) };
  if (!mapa.ids.length) {
    if (dif < ESPERAS_ENVIO_SIN_ORDEN) return { estado: 'reencolar', diferido: true, demoraMs: 2 * 60 * 1000, motivo: 'envio_sin_orden_conocida' };
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'shipment_project', tipoError: `envio_sin_orden_${sid}`.slice(0, 120), severidad: 'advertencia',
      mensajeTecnico: `shipment ${sid}: sin orden conocida tras ${dif} esperas`,
      mensajeHumano: `El envío ML ${sid} avisó un cambio pero no se pudo identificar su orden. Revisalo a mano si hay una venta sin reflejar.`,
      contexto: { shipment_id: sid },
    });
    return { estado: 'hecho', motivo: 'envio_sin_orden' };
  }

  // 2) Relectura del envío.
  const resp = await mlFetch(db, cfg.ml, 'get', `/shipments/${encodeURIComponent(sid)}`, null, { headers: { 'x-format-new': 'true' } });
  if (resp.status === 429) return { estado: 'reencolar', diferido: true, motivo: 'ml_429' };
  if (resp.status === 404) return { estado: 'hecho', motivo: 'envio_inexistente' };
  if (resp.status !== 200 || !resp.data?.status) return { estado: 'reencolar', motivo: `ml_shipments_http_${resp.status}${resp.status === 200 ? '_sin_status' : ''}` };
  const envio = resp.data;
  const logisticType = tipoLogisticaMl(envio);
  const firma = `${envio.status}|${envio.substatus || ''}|${logisticType || ''}`;
  if (db.prepare('SELECT firma FROM ml_envio_visto WHERE shipment_id = ?').get(sid)?.firma === firma) return { estado: 'hecho', motivo: 'sin_cambios' };

  // 3) Cada orden del envío.
  let esperar = false;
  for (const oid of mapa.ids) {
    const ordResp = await mlFetch(db, cfg.ml, 'get', `/orders/${encodeURIComponent(oid)}`);
    if (ordResp.status === 429) return { estado: 'reencolar', diferido: true, motivo: 'ml_429' };
    if (ordResp.status !== 200 || !ordResp.data) return { estado: 'reencolar', motivo: `ml_orders_http_${ordResp.status}` };
    const orden = ordResp.data;
    const vigente = orden.shipping?.id != null ? String(orden.shipping.id) : null;
    if (vigente !== sid) {
      // Aviso de un envío que ya no es el de la orden (cambio de logística): no se aplica, y se asegura el vigente.
      if (vigente) encolarTrabajo(db, { tipo: 'shipment.project', recurso: vigente });
      continue;
    }
    const clave = `ml:${orden.id}`;
    const prep = db.prepare('SELECT * FROM preparaciones WHERE clave = ?').get(clave);
    if (envio.status === 'cancelled' && envio.substatus === 'closed_by_user') {
      // Cambio de tipo de envío: ML cierra el viejo y asigna otro. Nunca se cancela por tiempo; solo la orden cancelada (otra ruta).
      if (orden.status === 'cancelled') continue;
      if (dif < ESPERAS_CAMBIO_ENVIO) { esperar = true; continue; } // se sigue con las demás órdenes del envío; el reintento es del conjunto
      abrirOActualizarIncidente(db, {
        integracion: 'mercadolibre', proceso: 'preparacion', tipoError: `envio_cerrado_sin_resolver_${orden.id}`.slice(0, 120), severidad: 'advertencia',
        mensajeTecnico: `shipment ${sid} cerrado por el usuario y la orden ${orden.id} sigue apuntando a él tras ${dif} esperas`,
        mensajeHumano: `El envío ML del pedido #${orden.id} quedó cerrado (cambio de tipo de envío) y ML todavía no asignó el nuevo. La preparación no se tocó: revisalo en ML.`,
        contexto: { ml_order_id: String(orden.id), shipment_id: sid, esperas: dif },
      });
      continue;
    }
    if (envio.status === 'cancelled') {
      db.prepare(`INSERT INTO ml_shipment_estado (shipment_id, status, substatus, logistic_type, actualizado_en) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(shipment_id) DO UPDATE SET status=excluded.status, substatus=excluded.substatus, logistic_type=excluded.logistic_type, actualizado_en=excluded.actualizado_en`)
        .run(sid, envio.status, envio.substatus || null, logisticType || null, new Date().toISOString());
      prepa.invalidarCacheMlNoElegible(db, orden.id, orden.status, envio.status, logisticType);
      if (prep?.estado === 'en_preparacion' && prepa.aplicarCancelacionReconciliada(db, prep, `envio:cancelled/${envio.substatus || '-'}`)) {
        const despues = db.prepare('SELECT estado FROM preparaciones WHERE id = ?').get(prep.id)?.estado;
        const texto = `El envío ML del pedido #${orden.id} se canceló (${envio.substatus || 'sin detalle'}) con la preparación en curso. `
          + (despues === 'cancelada_pendiente_devolucion' ? 'Quedó "devolución pendiente": hay productos levantados que volver a su lugar.' : 'Quedó "cancelada sin retiro": no había productos levantados.');
        abrirOActualizarIncidente(db, {
          integracion: 'mercadolibre', proceso: 'preparacion', tipoError: `envio_cancelado_${orden.id}`.slice(0, 120), severidad: 'advertencia',
          mensajeTecnico: texto, mensajeHumano: texto, contexto: { ml_order_id: String(orden.id), shipment_id: sid, substatus: envio.substatus || null, estado: despues },
        });
      }
      continue;
    }
    const enCola = Boolean(db.prepare("SELECT 1 FROM pedidos_cache WHERE clave = ? AND estado_envio = 'pendiente'").get(clave)) || prep?.estado === 'en_preparacion';
    const r = await prepa.aplicarEnvioOrdenMl(db, cfg.ml, orden, envio, { marcarSalida: true });
    if (r.accion === 'invalidada' && r.motivo === 'logistica_externa' && enCola) {
      const texto = `El pedido #${orden.id} pasó a logística Full (${logisticType}) y salió de la cola de Preparación.`
        + (prep?.estado === 'en_preparacion' ? ' Tenía la preparación en curso: revisá si ya está armado.' : '');
      abrirOActualizarIncidente(db, {
        integracion: 'mercadolibre', proceso: 'preparacion', tipoError: `envio_pasa_a_full_${orden.id}`.slice(0, 120), severidad: 'advertencia',
        mensajeTecnico: texto, mensajeHumano: texto, contexto: { ml_order_id: String(orden.id), shipment_id: sid, logistic_type: logisticType },
      });
    }
  }
  if (esperar) return { estado: 'reencolar', diferido: true, demoraMs: 3 * 60 * 1000, motivo: 'envio_cerrado_por_cambio_de_tipo' };
  db.prepare(`INSERT INTO ml_envio_visto (shipment_id, firma, actualizado_en) VALUES (?, ?, ?)
    ON CONFLICT(shipment_id) DO UPDATE SET firma = excluded.firma, actualizado_en = excluded.actualizado_en`).run(sid, firma, new Date().toISOString());
  return { estado: 'hecho' };
}

let _trabajosRecursoEnCurso = false;

const tipoErrorTrabajo = (prefijo, t) => `${prefijo}_${t.tipo}_${t.recurso}`.slice(0, 120);

/** Cierra los incidentes del trabajo (muerto / espera larga) cuando el recurso por fin se completa. */
function cerrarIncidentesDeTrabajo(db, t) {
  for (const prefijo of ['trabajo_muerto', 'trabajo_diferido_largo', 'trabajo_falla_persistente']) {
    confirmarCicloSano(db, { integracion: 'mercadolibre', proceso: 'trabajos_recurso', tipoError: tipoErrorTrabajo(prefijo, t) });
  }
}

/** Incidente crítico de un trabajo que agotó sus reintentos (por resultado o por excepción): la venta no queda muerta en silencio. */
function incidenteTrabajoMuerto(db, t, motivo) {
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre', proceso: 'trabajos_recurso', tipoError: tipoErrorTrabajo('trabajo_muerto', t), severidad: 'critico',
    mensajeTecnico: `${t.tipo} ${t.recurso}: ${motivo}`,
    mensajeHumano: `El trabajo ${t.tipo} del recurso ${t.recurso} agotó sus reintentos (${motivo}). Hay que revisarlo a mano.`,
    contexto: { tipo: t.tipo, recurso: t.recurso },
  });
}

/** Un trabajo que sigue fallando (con avisos nuevos que impiden matarlo) no queda en silencio: incidente crítico con dedupe. */
function incidenteTrabajoFallaPersistente(db, t, motivo, fallos) {
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre', proceso: 'trabajos_recurso', tipoError: tipoErrorTrabajo('trabajo_falla_persistente', t), severidad: 'critico',
    mensajeTecnico: `${t.tipo} ${t.recurso} falla hace ${fallos} intentos seguidos (último: ${motivo})`,
    mensajeHumano: `El trabajo ${t.tipo} del recurso ${t.recurso} sigue fallando (${fallos} veces seguidas): ${motivo}. Revisalo a mano: puede ser una venta sin pedido en la web.`,
    contexto: { tipo: t.tipo, recurso: t.recurso, fallos },
  });
}

/** Una espera legítima que dura demasiado no mata el trabajo: abre un incidente visible. */
function incidenteTrabajoDiferidoLargo(db, t, motivo, desde) {
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre', proceso: 'trabajos_recurso', tipoError: tipoErrorTrabajo('trabajo_diferido_largo', t), severidad: 'critico',
    mensajeTecnico: `${t.tipo} ${t.recurso} espera hace más de 2 h (${motivo}) desde ${desde}`,
    mensajeHumano: `El trabajo ${t.tipo} del recurso ${t.recurso} lleva más de 2 horas esperando (${motivo}). Revisalo: puede ser una venta sin pedido en la web.`,
    contexto: { tipo: t.tipo, recurso: t.recurso, desde },
  });
}

/** Cierra un intento no exitoso: diferimiento (no cuenta) o fallo real (cuenta y puede dejar el trabajo muerto). */
function resolverReintento(db, t, { diferido = false, motivo, demoraMs = null }) {
  if (diferido) {
    const q = diferirTrabajo(db, t, { motivo, demoraMs });
    if (q.alerta) incidenteTrabajoDiferidoLargo(db, t, motivo, q.desde);
    return;
  }
  const q = reencolarTrabajo(db, t, { demoraMs, motivo });
  if (q.muerto) incidenteTrabajoMuerto(db, t, motivo);
  else if (q.persistente) incidenteTrabajoFallaPersistente(db, t, motivo, q.fallos);
}

/** Worker de los trabajos por recurso. Lo llaman el cron (cada minuto) y, como acelerador no durable, el handler del aviso. */
export async function procesarTrabajosRecurso(db, cfg, { limit = 10 } = {}) {
  if (_trabajosRecursoEnCurso) return { omitido: true };
  _trabajosRecursoEnCurso = true;
  let procesados = 0;
  try {
    for (const tipo of ['order.ml', 'order.woo', 'catalog.woo_product_sync', 'shipment.project', 'item.project', 'stock.bolsa']) {
      if (tipo === 'item.project') {
        // E-2: lote de hasta 20 ítems = UNA llamada /items/bulk (no una por aviso). Va antes de stock.bolsa para que, en la
        // misma pasada, las bolsas que encola se concilien.
        const lote = reclamarTrabajos(db, [tipo], { limit: LOTE_ITEMS_ML });
        if (!lote.length) continue;
        let resultados;
        try { resultados = await procesarLoteItemsMl(db, cfg, lote.map((t) => t.recurso)); }
        catch (e) { resultados = new Map(lote.map((t) => [t.recurso, { estado: 'reencolar', motivo: String(e.message).slice(0, 200) }])); }
        for (const t of lote) {
          const r = resultados.get(t.recurso) || { estado: 'reencolar', motivo: 'sin_resultado' };
          if (r.estado === 'reencolar') resolverReintento(db, t, r);
          else if (cerrarTrabajo(db, t).cerrado) cerrarIncidentesDeTrabajo(db, t);
          procesados++;
        }
        continue;
      }
      for (const t of reclamarTrabajos(db, [tipo], { limit })) {
        try {
          const r = tipo === 'order.ml' ? await procesarOrdenMl(db, cfg, t.recurso)
            : tipo === 'order.woo' ? await procesarOrdenWoo(db, cfg, t.recurso)
              : tipo === 'catalog.woo_product_sync' ? await procesarProductoWoo(db, cfg, t.recurso)
                : tipo === 'shipment.project' ? await procesarEnvioMl(db, cfg, t.recurso)
                : await procesarStockBolsa(db, cfg, t.recurso.replace(/^sku:/, ''));
          if (r.estado === 'reencolar') resolverReintento(db, t, r);
          else {
            // order.woo: el conjunto de SKUs se reemplaza SOLO si el cierre procede (misma transacción, generación vigente).
            const enCierre = tipo === 'order.woo' ? (d) => {
              d.prepare(`INSERT INTO woo_orden_skus (order_id, skus_json, actualizado_en) VALUES (?, ?, ?)
                ON CONFLICT(order_id) DO UPDATE SET skus_json = excluded.skus_json, actualizado_en = excluded.actualizado_en`)
                .run(t.recurso, JSON.stringify(r.skusActuales || []), new Date().toISOString());
            } : null;
            const cierre = cerrarTrabajo(db, t, { enCierre });
            if (cierre.cerrado) cerrarIncidentesDeTrabajo(db, t);
            // E-2: recuerda si esta bolsa terminó sin escribir (ver remotoDifiereDelDeseado); una escritura real lo borra.
            // Solo si el trabajo cerró como hecho, y con la instantánea que la propia bolsa verificó.
            if (tipo === 'stock.bolsa' && r.estado === 'hecho' && r.empujadas !== undefined) {
              const skuB = t.recurso.replace(/^sku:/, '');
              try {
                if (r.empujadas > 0) guardarEstado(db, `bolsa_sin_escritura:${skuB}`, 'escribio');
                else if (cierre.cerrado && r.instantanea) marcarBolsaSinEscritura(db, skuB, r.instantanea);
                else guardarEstado(db, `bolsa_sin_escritura:${skuB}`, 'sin_marca');
              } catch { /* optimización */ }
            }
          }
          procesados++;
        } catch (e) {
          // Una excepción es un fallo real: cuenta como intento y, al agotarse, abre el mismo incidente crítico.
          resolverReintento(db, t, { motivo: String(e.message).slice(0, 200) });
        }
      }
    }
    return { omitido: false, procesados };
  } finally {
    _trabajosRecursoEnCurso = false;
  }
}

let _barreraEnCurso = false;
/** Job de la barrera (cron cada 2 min): manage_stock diario, chequeo periódico de reservas, liberación y corrección dueña. */
export async function procesarBarreraVentas(db, cfg) {
  if (_barreraEnCurso) return { omitido: true };
  _barreraEnCurso = true;
  try {
    const wooCfg = cfg.woo;
    if (!wooCfg) return { omitido: true };
    try { await verificarManageStockWoo(db, wooCfg); } catch (e) { console.error('[barrera] manage_stock:', e.message); }
    if (!db.prepare('SELECT 1 FROM stock_refresco_pendiente LIMIT 1').get()) return { omitido: false, filas: 0 };
    const ultimo = leerEstado(db, 'chequeo_reservas');
    if (!ultimo || Date.now() - new Date(ultimo.actualizado_en).getTime() >= 10 * 60 * 1000) {
      await chequearReservasConBarrera(db, wooCfg);
      guardarEstado(db, 'chequeo_reservas', 'ok');
    }
    const bloqueantes = db.prepare("SELECT * FROM stock_refresco_pendiente WHERE estado = 'bloqueante' AND woo_confirmado = 1 ORDER BY creado_en LIMIT 50").all();
    for (const f of bloqueantes) await intentarLiberarFila(db, wooCfg, f);
    const liberables = db.prepare("SELECT * FROM stock_refresco_pendiente WHERE estado = 'liberable' ORDER BY creado_en").all();
    const hechas = new Set();
    for (const f of liberables) {
      if (hechas.has(idBarrera(f.sku, f.ml_order_id))) continue;
      const res = await _corregirBolsaDuena(db, cfg, f.sku, idBarrera(f.sku, f.ml_order_id));
      if (res.estado === 'sincronizado') for (const g of liberables) hechas.add(idBarrera(g.sku, g.ml_order_id));
    }
    return { omitido: false, filas: bloqueantes.length + liberables.length };
  } finally {
    _barreraEnCurso = false;
  }
}

/** Acción admin "Confirmar descuento" de UNA línea (ver lib/stockBarrera.js). */
export { confirmarDescuentoLinea };

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
  const med = { inicio: new Date().toISOString(), diffs: null, error: null };
  try {
    const bloqueos = await _syncWcToMl(db, cfg, { ...opts, __med: med });
    return { omitido: false, bloqueados_contradiccion: bloqueos };
  } catch (e) {
    med.error = e.message;
    throw e;
  } finally {
    _wcToMlEnCurso = false;
    // E-3: diferencias del barrido: lo que el barrido PUEDE corregir. Una clave recorrida cuenta si su publicación está activa o su estado no
    // se pudo consultar; una pausada/cerrada recorrida se descarta sin escribir y no cuenta (en prod eran 1176, todas no activas). Las claves
    // que el tope de llamadas, un 429 o un error dejaron SIN recorrer cuentan siempre (su estado todavía no se resolvió en esta corrida).
    if (med.todas) {
      med.diffs = med.todas
        .filter((d) => { if (!med.recorridas.has(d.clave)) return true; const st = med.estadoItem.get(partirClaveMl(d.clave).itemId); return st === 'active' || st === 'desconocido'; })
        .map((d) => ({ clave: d.clave, sku: d.sku }));
    }
    if (med.diffs) {
      let revisados = 0;
      try { revisados = db.prepare('SELECT COUNT(*) n FROM ml_stock_estado').get().n; } catch { /* medición, no bloquea */ }
      registrarCorrida(db, { proceso: 'wc_a_ml', inicio: med.inicio, revisados, claves: med.diffs, error: med.error });
    }
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
    ${computedStockCte()}
    SELECT * FROM computed
    WHERE cantidad_ml IS NULL OR cantidad_ml <> stock_disponible_ml
    ORDER BY ml_stock_actualizado_en IS NOT NULL, ml_stock_actualizado_en ASC
  `).all();

  // Fase C, R4 (sólo en modo `activo`): una publicación activa SIN decisión a la que el audit de Identidad no pudo
  // vincular (sin SKU, SKU inexistente o ambiguo, contradicción) queda en stock 0 hasta que alguien la vincule o la
  // marque `omitir`. Es la misma escritura y el mismo log que el resto; no pausa. `ml_stock_estado` recuerda el 0 ya
  // enviado (sku '' porque no hay vínculo), así no se repite el PUT mientras el cache de ML se refresca.
  if (modoProteccion() === 'activo') {
    const plan = planR4(db);
    if (plan.omitido) {
      console.error(`[fase-c] R4 no aplicada (${plan.omitido}): ${plan.total} clave(s) sin vínculo`);
      if (plan.omitido === 'tope') {
        abrirOActualizarIncidente(db, {
          integracion: 'mercadolibre', proceso: 'fase_c_r4', tipoError: 'tope_r4', severidad: 'critico',
          mensajeTecnico: `R4 supera el tope de ${R4_MAX_POR_CORRIDA} claves por corrida: ${plan.total}`,
          mensajeHumano: `Identidad quiere poner en stock 0 ${plan.total} publicaciones sin vincular, más del tope de ${R4_MAX_POR_CORRIDA}. No se aplicó ninguna: revisá si el catálogo o la auditoría de Identidad fallaron.`,
          contexto: { total: plan.total, tope: R4_MAX_POR_CORRIDA },
        });
      }
    }
    const estadoStock = db.prepare('SELECT cantidad_ml, actualizado_en FROM ml_stock_estado WHERE clave=?');
    for (const r of plan.aplicar) {
      const e = estadoStock.get(r.clave);
      // ml_stock_estado.sku es NOT NULL: sin vínculo se guarda el seller_sku de ML (o la clave).
      diffs.push({ clave: r.clave, sku: String(r.seller_sku ?? '').trim() || r.clave, stock_disponible_ml: 0, cantidad_ml: e?.cantidad_ml ?? r.cantidad_ml,
        ml_stock_actualizado_en: e?.actualizado_en ?? null, sin_vinculo: r.clasificacion });
    }
    // Los frenos (R4 y R2 con stock 0) van primero: el tope de llamadas por corrida no puede dejarlos sin ejecutar.
    const esFreno = (d) => d.sin_vinculo || (d.frena_identidad && d.stock_disponible_ml === 0);
    diffs.sort((x, y) => Number(!!esFreno(y)) - Number(!!esFreno(x)));
  }

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
  let bloqueadosContradiccion = 0;
  const contradicciones = new Map();
  try {
    const cacheStatus = db.prepare('SELECT DISTINCT item_id, status FROM ml_publicaciones_cache').all();
    for (const r of cacheStatus) {
      if (r.status && !estadoItem.has(r.item_id)) estadoItem.set(r.item_id, r.status);
    }
  } catch (_) { /* cache puede no existir todavía */ }

  // E-3 (fix): claves cuyo estado de publicación se resolvió en ESTA corrida. El wrapper mide con esto (también si el bucle corta o lanza).
  const recorridas = new Set();
  if (opts.__med) Object.assign(opts.__med, { todas: diffs, recorridas, estadoItem });

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
      const bloqueoStock = bloquearStockPorContradiccion(db, { clave, sku, cantidad, cantAnterior: diff.cantidad_ml, cache: contradicciones });
      if (bloqueoStock.bloqueado) { bloqueadosContradiccion++; continue; }
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
        await sleep(espera(ML_CALL_DELAY_MS));
      }
      const status = estadoItem.get(itemId);
      recorridas.add(clave);
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

      const esc = await escribirStockMl(db, mlCfg, { clave, sku, cantidad });
      if (esc.omitido) continue; // barrera de venta / Woo sin gestión de stock: no es un error, lo retoma el próximo ciclo
      llamadasMl++;
      const resp = esc.resp;

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
    await sleep(espera(ML_CALL_DELAY_MS));
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
  return bloqueadosContradiccion;
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
  const med = { inicio: new Date().toISOString(), claves: [], error: null };
  let res = null;
  try {
    res = await _reconciliarStockMl(db, cfg, med);
    return res;
  } catch (e) {
    med.error = e.message;
    throw e;
  } finally {
    _reconciliarStockEnCurso = false;
    // E-3: diferencias del barrido de reconciliación (las altas de ml_stock_estado no cuentan: no son diferencias).
    if (res || med.error) registrarCorrida(db, { proceso: 'reconciliacion_stock_ml', inicio: med.inicio, revisados: res?.revisadas ?? 0, claves: med.claves, error: med.error });
  }
}

async function _reconciliarStockMl(db, cfg, med = null) {
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
    const path = `/items/bulk?ids=${chunk.join(',')}&attributes=status_code,id,body.id,body.status,body.sub_status,body.available_quantity,body.variations`;
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
        for (const e of resp.data) if ((e.status_code ?? e.code) === 200 && e.body) porItem.set(String(e.body.id), e.body);
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
        med?.claves.push({ clave: fila.clave, sku: fila.sku });
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

// El vigía de formato pausa publicaciones que pasaron a describir otra cosa (ver
// docs/superpowers/specs/2026-09-12-vigia-formato-publicaciones-design.md). Si el reactivador
// las levantara, el arreglo se anularía solo y en silencio: se saltean hasta que una persona
// revise el cambio, igual que se hace con las pausadas manualmente por el vendedor.
/**
 * Lista las publicaciones ML pausadas por out_of_stock que ya tienen stock
 * disponible en la web y están mapeadas. Devuelve filas por variación.
 * (El agrupado por publicación lo hace el router para el display.)
 */
export function reabrirAvisosSinStock(db) {
  const rows = db.prepare(`${computedStockCte()}
    SELECT c.id FROM ml_publicacion_cambios c JOIN computed x ON x.clave=c.clave
    WHERE c.bloquea_reactivador=1 AND c.revisado_en IS NOT NULL AND x.stock_disponible_ml > 0`).all();
  const upd = db.prepare("UPDATE ml_publicacion_cambios SET revisado_en=NULL, revisado_por=NULL, bloquea_reactivador=0, pausa_error=COALESCE(pausa_error,'') || ' | reabierto: volvió el stock' WHERE id=?");
  db.transaction(() => rows.forEach(r => upd.run(r.id)))();
  return rows.length;
}

/**
 * `incluirPausasManuales` (sólo la reactivación manual de "Pausadas con stock en Woo"): además de las pausadas por
 * out_of_stock, trae las que quedaron pausadas por el vendedor o sin sub_status. Los avisos del vigía sin revisar
 * SIGUEN bloqueando: una pausa del vigía sólo se revierte revisando el cambio.
 */
export function getReactivablesRows(db, itemIds = null, { incluirPausasManuales = false } = {}) {
  reabrirAvisosSinStock(db);
  const filtroSub = incluirPausasManuales ? '' : `
      AND p.sub_status LIKE '%out_of_stock%'
      AND p.sub_status NOT LIKE '%paused_by_seller%'`;
  let sql = `
    ${computedStockCte()}
    SELECT cm.clave, cm.sku, cm.stock_disponible_ml,
           p.item_id, p.variation_id, p.titulo, p.variations_texto, p.thumbnail
    FROM computed cm
    JOIN ml_publicaciones_cache p ON p.clave = cm.clave
    WHERE p.status = 'paused'${filtroSub}
      AND cm.stock_disponible_ml > 0
      AND NOT EXISTS (
        SELECT 1 FROM ml_publicacion_cambios vc
        WHERE vc.clave = p.clave AND vc.solo_aviso = 0 AND (vc.revisado_en IS NULL OR vc.bloquea_reactivador = 1)
      )`;
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
        `/items/bulk?ids=${chunk.join(',')}&attributes=status_code,id,body.id,body.price,body.category_id,body.listing_type_id,body.shipping,body.variations`
      );
      if (resp.status === 200 && Array.isArray(resp.data)) {
        for (const e of resp.data) if ((e.status_code ?? e.code) === 200 && e.body) items.set(String(e.body.id), e.body);
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
// llamada a ML: el dato ya vino en la respuesta del /items/bulk?ids= que igual se hace para el
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
 * /items/bulk?ids= en chunks de 20 para todo el lote). `item` es `undefined` si esa publicación
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
  if (subStatus.includes('paused_by_seller') && !opts.incluirPausasManuales) {
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
  const rows = getReactivablesRows(db, aProcesar, { incluirPausasManuales: opts.incluirPausasManuales === true });

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
        `/items/bulk?ids=${chunk.join(',')}&attributes=status_code,id,body.id,body.status,body.sub_status,body.price,body.category_id,body.listing_type_id,body.shipping,body.variations`,
        null, opts
      );
      if (resp.status === 200 && Array.isArray(resp.data)) {
        for (const e of resp.data) if ((e.status_code ?? e.code) === 200 && e.body) items.set(String(e.body.id), e.body);
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

      const bloqueosContradiccion = variaciones.map((v) => ({
        variacion: v,
        bloqueo: bloquearStockPorContradiccion(db, { clave: v.clave, sku: v.sku,
          cantidad: Math.max(0, Math.round(v.stock_disponible_ml)), cantAnterior: v.cantidad_ml }),
      })).filter((x) => x.bloqueo.bloqueado);
      if (bloqueosContradiccion.length) {
        return { item_id: itemId, ok: false, bloqueado: true, motivo: 'contradiccion_titulo',
          bloqueos: bloqueosContradiccion.map((x) => ({ clave: x.variacion.clave, motivos: x.bloqueo.contradiccion.motivos })) };
      }

      // 1) Empujar stock de cada variación con stock web disponible (en orden dentro del item)
      for (const v of variaciones) {
        const cantidad = Math.max(0, Math.round(v.stock_disponible_ml));
        const esc = await escribirStockMl(db, mlCfg, { clave: v.clave, sku: v.sku, cantidad, opts });
        if (esc.omitido) throw new Error(`stock ${v.clave}: escritura omitida por la barrera de venta (${esc.motivo})`);
        const resp = esc.resp;
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
    // ACOPLAMIENTO IMPLÍCITO A VIGILAR (hallazgo del revisor, MENOR, 2026-08-06). ACTUALIZADO
    // 2026-09-05: ya NO es la única vía. El webhook de `items` de ML proyecta y refresca el
    // cache —precio incluido— por multiget acotado (`item.project` en workerIntegrationJobs).
    // Se evaluó contra este comentario antes de habilitarlo, que es lo que pedía:
    //   · Refresca el caché, que es la mitad que importa para esta comparación. Un precio más
    //     fresco hace que `necesitaRecheck` DETECTE la diferencia contra `precio_ml_evaluado`
    //     y re-consulte, en vez de saltearla — o sea que fortalece esta red, no la degrada.
    //   · No borra la frenada, y no hace falta: la fila se sobrescribe (ON CONFLICT DO UPDATE)
    //     cuando la re-evaluación la vuelve a producir, y el recheck ya se disparó por el
    //     precio distinto. Borrarla sería sólo un atajo para forzar la re-evaluación.
    //   · No reactiva nada por su cuenta: `reactivarAutomatico` sigue con su propio cron y
    //     `chequearNetoReactivar` revalida en vivo contra ML antes de escribir. Lo que cambia
    //     es CUÁNDO se evalúa, no si se reactiva.
    // Exposición medida el 2026-09-05: 7 frenadas vigentes y 12 filas realmente reactivables
    // (de 4621 pausadas por out_of_stock, el resto sin stock en Woo), así que el costo en
    // llamadas está acotado por esos 12 y no por el volumen de webhooks.
    //
    // Historia: hasta 2026-09-05 la única vía que mantenía el precio fresco era el POST puntual. Si el día de
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
    const resp = await mlFetch(db, mlCfg, 'get', `/items/bulk?ids=${chunk.join(',')}&attributes=status_code,id,body.id,body.status,body.variations`);
    await sleep(espera(ML_CALL_DELAY_MS));
    if (resp.status !== 200 || !Array.isArray(resp.data)) continue; // chunk fallido → fail-closed
    for (const entry of resp.data) {
      if ((entry.status_code ?? entry.code) !== 200 || !entry.body) continue;
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
      `/items/bulk?ids=${chunk.join(',')}&attributes=status_code,id,body.id,body.title,body.secure_thumbnail,body.thumbnail`);
    if (resp.status !== 200 || !Array.isArray(resp.data)) continue;
    for (const entry of resp.data) {
      if ((entry.status_code ?? entry.code) !== 200 || !entry.body) continue;
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
    for (const r of db.prepare(`${computedStockCte()} SELECT clave, stock_disponible_ml FROM computed`).all()) {
      stockMap.set(r.clave, r.stock_disponible_ml);
    }
  } catch (_) { /* sin catálogo/mapeo todavía */ }

  const itemIds = [...new Set(rows.map(r => r.item_id || partirClaveMl(r.clave).itemId).filter(Boolean))].slice(0, ENRICH_MAX_ITEMS);
  const info = new Map();
  for (let i = 0; i < itemIds.length; i += MULTIGET_CHUNK) {
    const chunk = itemIds.slice(i, i + MULTIGET_CHUNK);
    const resp = await mlFetch(db, mlCfg, 'get',
      `/items/bulk?ids=${chunk.join(',')}&attributes=status_code,id,body.id,body.title,body.status,body.sub_status,body.variations,body.secure_thumbnail,body.thumbnail`);
    if (resp.status !== 200 || !Array.isArray(resp.data)) continue;
    for (const entry of resp.data) {
      if ((entry.status_code ?? entry.code) === 200 && entry.body) info.set(String(entry.body.id), entry.body);
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
    const computedCte = computedStockCte();

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
      // Pausadas con stock en Woo (cualquier causa) y SKUs en solo_local: visibles en Sincronización.
      pausadas_con_stock: (() => { try { return listarPausadasConStock(db).resumen; } catch (_) { return null; } })(),
      identidad_encoladas: (() => { try { return encoladasSinEjecutar(db); } catch (_) { return null; } })(),
      solo_local: (() => { try { return resumenSoloLocal(db); } catch (_) { return null; } })(),
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
        ventas_retenidas_guardia: contarVentasRetenidasGuardia(db),
      },
      skus,
      frenadas,
      vinculos_sospechosos: contarVinculosSospechosos(db),
    });
  });

  // Cambios de formato detectados por el vigía, sin revisar. El JOIN con el cache trae el
  // título para que la pantalla no muestre sólo un MLA.
  router.get('/cambios-formato', (_req, res) => {
    const data = db.prepare(`
      SELECT MIN(c.id) id, json_group_array(c.id) ids, COUNT(DISTINCT c.clave) variaciones, MIN(c.clave) clave, c.item_id, MIN(c.sku) sku, c.campo, c.valor_anterior, c.valor_nuevo,
             MAX(c.pausada) pausada, MAX(c.pausa_error) pausa_error, MAX(c.nota) nota, MAX(c.detectado_en) detectado_en, p.titulo, p.thumbnail, p.permalink
      FROM ml_publicacion_cambios c
      LEFT JOIN ml_publicaciones_cache p ON p.clave = c.clave
      WHERE c.revisado_en IS NULL
      GROUP BY c.item_id, c.campo, c.valor_nuevo
      ORDER BY detectado_en DESC, id DESC
    `).all().map(r => ({ ...r, ids: JSON.parse(r.ids) }));
    res.json({ ok: true, data, total: data.length });
  });

  // Comparación de los dos productos de un aviso de migración. Se pide al abrir la tarjeta, no por render;
  // las lecturas a ML quedan cacheadas en sqlite (lib/comparacionProductos.js).
  router.get('/cambios-formato/:id/comparacion', async (req, res) => {
    const c = db.prepare('SELECT * FROM ml_publicacion_cambios WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Cambio no encontrado' });
    if (c.campo !== 'catalog_product_id') return res.json({ ok: false, error: 'Sólo aplica a cambios de producto de catálogo' });
    const pub = db.prepare('SELECT atributos_json FROM ml_publicaciones_cache WHERE clave=?').get(c.clave);
    res.json(await compararProductos(db, cfg?.ml, c, pub));
  });

  // Revisar cierra el aviso. Con `reactivar: true` además despausa: es el ÚNICO camino por el
  // que una pausa del vigía se revierte, y siempre lo dispara una persona.
  router.post('/cambios-formato/:id/revisar', async (req, res) => {
    const fila = db.prepare('SELECT * FROM ml_publicacion_cambios WHERE id=?').get(req.params.id);
    if (!fila) return res.status(404).json({ ok: false, error: 'Cambio no encontrado' });
    if (fila.revisado_en) return res.json({ ok: true, ya_revisado: true, reactivada: false });

    // Los rechazos se responden con 409, nunca 502: Cloudflare reemplaza los 502 por su página
    // HTML y la pantalla mostraba "Unexpected token '<'" en vez del motivo (2026-09-14).
    let reactivada = false;
    let pendienteStock = false;
    let motivoPend = null; // por qué quedó pendiente: sin_stock_woo | otro_aviso | solo_local | sin_vinculo (null = ML sin stock)
    if (req.body?.reactivar === true) {
      // Convención de este router: mlCfgOk valida el CONTENEDOR (`cfg`, con cfg.ml adentro) y
      // mlFetch recibe el cliente ya desestructurado. Ver el patrón de la línea 276.
      if (!mlCfgOk(cfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
      // Antes del PUT: si la publicación sigue pausada pero ya no hay stock en Woo, o el reactivador la tiene
      // trabada por otra razón (otro aviso abierto, solo_local, sin vínculo), el aviso se cierra sin reactivar.
      let noCorresponde = false;
      let motivoPendiente = null;
      try {
        const pausada = db.prepare("SELECT 1 FROM ml_publicaciones_cache WHERE item_id = ? AND status = 'paused' LIMIT 1").get(fila.item_id);
        if (pausada) {
          const p = listarPausadasConStock(db).data.find((x) => x.item_id === fila.item_id);
          const otroAviso = db.prepare(`SELECT 1 FROM ml_publicacion_cambios WHERE item_id = ? AND revisado_en IS NULL AND solo_aviso = 0
            AND bloquea_reactivador = 1 AND NOT (campo = ? AND valor_nuevo IS ?) LIMIT 1`).get(fila.item_id, fila.campo, fila.valor_nuevo);
          motivoPendiente = !p || !(p.stock_woo > 0) ? 'sin_stock_woo' : otroAviso ? 'otro_aviso'
            : (p.motivo_no_reactivable === 'solo_local' || p.motivo_no_reactivable === 'sin_vinculo') ? p.motivo_no_reactivable : null;
          noCorresponde = !!motivoPendiente;
        }
      } catch (_) { /* si la verificación falla, se sigue con el camino de siempre (ML rechaza lo que no se puede) */ }
      if (noCorresponde) { pendienteStock = true; motivoPend = motivoPendiente; }
      else try {
        const r = await mlFetch(db, cfg.ml, 'put', `/items/${fila.item_id}`, { status: 'active' });
        if (r.status >= 200 && r.status < 300) {
          reactivada = true;
        } else {
          // ML no activa una publicación sin stock. Si ese es el motivo, el formato quedó
          // aprobado igual: se cierra el aviso y el reactivador la activa cuando haya stock.
          const item = await mlFetch(db, cfg.ml, 'get', `/items/${fila.item_id}?attributes=status,sub_status,available_quantity`);
          const subStatus = Array.isArray(item?.data?.sub_status) ? item.data.sub_status : [];
          if (item?.status === 200 && item.data?.status === 'paused' && subStatus.includes('out_of_stock')) {
            pendienteStock = true;
          } else {
            // Fail-closed: si no se pudo reactivar por otro motivo, el aviso sigue vivo.
            const detalle = r.data?.message || r.data?.error || `status ${r.status}`;
            return res.status(409).json({ ok: false, error: `MercadoLibre no la reactivó: ${detalle}` });
          }
        }
      } catch (e) {
        return res.status(409).json({ ok: false, error: `No se pudo reactivar: ${e?.message || 'error de conexión con MercadoLibre'}` });
      }
    }
    // El vigía abre un aviso por variación: se cierran las variaciones del MISMO cambio (campo y
    // valor nuevo). Un cambio de otro campo en la misma publicación sigue abierto para decidirlo aparte.
    const cerrados = db.prepare(`UPDATE ml_publicacion_cambios SET revisado_en=?, revisado_por=?, bloquea_reactivador=0
      WHERE item_id=? AND campo=? AND valor_nuevo IS ? AND revisado_en IS NULL`)
      .run(new Date().toISOString(), req.user?.username || null, fila.item_id, fila.campo, fila.valor_nuevo).changes;
    // Cerrado el aviso sin reactivar: si la publicación sigue pausada con stock en Woo, se ofrece reactivarla
    // (un clic, siempre manual). Es sólo una oferta: no se reactiva nada acá.
    let ofertaReactivar = null;
    if (!reactivada && !pendienteStock) {
      try {
        const p = listarPausadasConStock(db).data.find((x) => x.item_id === fila.item_id && x.reactivable);
        if (p) ofertaReactivar = { item_id: p.item_id, stock_woo: p.stock_woo };
      } catch (_) { /* la oferta es opcional */ }
    }
    res.json({ ok: true, reactivada, pendiente_stock: pendienteStock, motivo_pendiente: pendienteStock ? (motivoPend || 'ml_sin_stock') : null, cerrados, oferta_reactivar: ofertaReactivar });
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

  // Publicaciones pausadas en ML con stock en Woo, con la causa de la pausa (Fase A de pausas con sentido).
  // Sólo lectura sobre la caché local. `?causa=` filtra por una causa.
  router.get('/pausadas-con-stock', (req, res) => {
    try {
      const causa = req.query.causa ? String(req.query.causa) : null;
      if (causa && !CAUSAS_PAUSA.includes(causa)) {
        return res.status(400).json({ ok: false, error: `causa debe ser una de: ${CAUSAS_PAUSA.join(', ')}` });
      }
      res.json({ ok: true, ...listarPausadasConStock(db, { causa }), solo_local: resumenSoloLocal(db) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Reactivación MANUAL de pausadas con stock: siempre la dispara una persona (nunca el sistema). Incluye las que
  // pausó el vendedor o quedaron sin sub_status; las pausas del vigía sin revisar y las solo_local/sin vínculo no
  // se reactivan por acá (se devuelven en `no_reactivables`). Comparte candado con /reactivar.
  router.post('/pausadas-con-stock/reactivar', async (req, res) => {
    if (!mlCfgOk(cfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    const { itemIds } = req.body || {};
    if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 50 || itemIds.some((x) => typeof x !== 'string' || !x)) {
      return res.status(400).json({ ok: false, error: 'itemIds requerido (1 a 50 ids de publicación)' });
    }
    if (_reactivarEnCurso) return res.status(409).json({ ok: false, error: 'Ya hay una reactivación en curso' });
    _reactivarEnCurso = true;
    try {
      const reactivables = new Set(listarPausadasConStock(db).data.filter((p) => p.reactivable).map((p) => p.item_id));
      const pedidos = [...new Set(itemIds)];
      const validos = pedidos.filter((id) => reactivables.has(id));
      const noReactivables = pedidos.filter((id) => !reactivables.has(id));
      const actor = req.user?.username || 'desconocido';
      const r = validos.length
        ? await reactivarItems(db, mlCfg, validos, { manual: true, incluirPausasManuales: true })
        : { procesados: 0, resultados: [] };
      console.log(`[pausadas-con-stock] reactivación manual por ${actor}: ${validos.length} publicaciones`);
      if (!res.writableEnded) res.json({ ok: true, actor, no_reactivables: noReactivables, ...r });
    } catch (e) {
      if (!res.writableEnded) res.status(500).json({ ok: false, error: e.message });
    } finally {
      _reactivarEnCurso = false;
    }
  });

  // E-0: "Confirmar descuento" (solo admin): evidencia de UNA línea cuando Woo la descontó (`_reduced_stock` igual a la cantidad
  // vendida) pero la nota no se reconoce. No libera por sí sola: la fila pasa a liberable cuando todas sus líneas tienen evidencia.
  router.post('/barrera/confirmar-descuento', requireAdmin, async (req, res) => {
    try {
      const { sku, ml_order_id: mlOrderId, linea, motivo } = req.body || {};
      if (!sku || !mlOrderId || linea === undefined) return res.status(400).json({ ok: false, error: 'sku, ml_order_id y linea requeridos' });
      const r = await confirmarDescuentoLinea(db, cfg.woo, { sku, mlOrderId, idx: Number(linea), motivo, actor: req.user?.username || 'desconocido' });
      return res.status(r.ok ? 200 : r.code).json(r.ok ? { ok: true } : { ok: false, error: r.error });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Barreras activas con su estado y motivo. Para las que tienen un incidente se relee el pedido en Woo y cada línea dice si
  // se puede ofrecer "Confirmar descuento" (`_reduced_stock` == cantidad y todavía sin confirmar).
  router.get('/barrera', requireAdmin, async (_req, res) => {
    try {
      const filas = db.prepare('SELECT sku, ml_order_id, estado, woo_confirmado, wc_order_id, incidente_motivo, lineas_json, confirmaciones_json, creado_en FROM stock_refresco_pendiente ORDER BY creado_en').all();
      const salida = [];
      for (const f of filas) {
        let lineas = [], confs = [];
        try { lineas = JSON.parse(f.lineas_json || '[]'); } catch { /* fila ilegible: se muestra sin líneas */ }
        try { confs = JSON.parse(f.confirmaciones_json || '[]'); } catch { /* sin confirmaciones */ }
        let orden = null, ordenError = null;
        if (f.incidente_motivo && f.woo_confirmado && f.wc_order_id) {
          try { orden = (await wooFetch(cfg.woo, `/orders/${f.wc_order_id}`))?.data ?? null; } catch (e) {
            // Al usuario, un mensaje humano; el detalle técnico queda solo en el log.
            ordenError = /\b404\b/.test(String(e.message)) ? 'El pedido ya no existe en la web.' : 'No se pudo consultar el pedido en la web ahora. Reintentá en unos minutos.';
            try { logSync(db, { direccion: 'ml_wc', sku: f.sku, clave: f.ml_order_id, estado: 'error', error: `Barrera: no se pudo leer el pedido ${f.wc_order_id}: ${e.message}`.slice(0, 400) }); } catch { /* solo log */ }
          }
        }
        const out = lineas.map((l) => {
          const confirmada = confs.some((c) => c.idx === l.idx);
          const m = ((orden?.line_items || []).find((x) => x.id === l.line_item_id)?.meta_data || []).find((x) => x.key === '_reduced_stock');
          return { idx: l.idx, nombre: l.name || null, cantidad: l.cantidad, reduced_stock: m ? Number(m.value) : null, confirmada,
            puede_confirmar: !confirmada && !!m && Number(m.value) === Number(l.cantidad) };
        });
        salida.push({ sku: f.sku, ml_order_id: f.ml_order_id, estado: f.estado, woo_confirmado: f.woo_confirmado, wc_order_id: f.wc_order_id,
          incidente_motivo: f.incidente_motivo, creado_en: f.creado_en, lineas: out, orden_error: ordenError });
      }
      res.json({ ok: true, filas: salida });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Fase C: reporte de sombra para José (solo admin). Solo lectura.
  router.get('/fase-c/sombra', requireAdmin, (_req, res) => {
    try { res.json({ ok: true, data: reporteSombraFaseC(db) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
    const info = db.transaction(() => {
      const r = db.prepare('DELETE FROM sku_matcher_decisiones WHERE clave = ?').run(clave);
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

    const row = db.prepare(`${computedStockCte()} SELECT * FROM computed WHERE clave = ?`).get(clave);
    if (!row) return res.json({ ok: false, error: 'La clave no tiene mapeo activo o SKU en el catálogo.' });

    const pub = db.prepare('SELECT status FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
    if (pub && pub.status && pub.status !== 'active') {
      return res.json({ ok: false, error: `La publicación está ${pub.status} — reactivala desde el panel.` });
    }

    const { itemId, variationId } = partirClaveMl(clave);
    const cantidad = Math.max(0, Math.round(row.stock_disponible_ml));
    try {
      const bloqueo = bloquearStockPorContradiccion(db, { clave, sku: row.sku, cantidad, cantAnterior: row.cantidad_ml });
      if (bloqueo.bloqueado) {
        return res.status(409).json({ ok: false, bloqueado: true, error: 'contradiccion_titulo', motivos: bloqueo.contradiccion.motivos });
      }
      // manual: true — reintento puntual disparado a mano desde el panel.
      const esc = await escribirStockMl(db, mlCfg, { clave, sku: row.sku, cantidad, opts: { manual: true } });
      if (esc.omitido) return res.status(409).json({ ok: false, error: `barrera de venta: ${esc.motivo}` });
      const resp = esc.resp;
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
