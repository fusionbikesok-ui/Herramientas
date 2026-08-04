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
import { netoMl, veredictoNeto, precioWebClave, precioContado, totalContado } from '../lib/mlPrecios.js';
import { senalesDeVinculo } from '../lib/vinculosSenales.js';
import { partirClaveMl, extraerErrorMl } from '../lib/mlUtil.js';
import { normalizarOrdenMl, billingWcDesdeOrdenMl } from '../lib/modelos/ordenVenta.js';
import { mapConLimite } from '../lib/concurrencia.js';
import { armarLike } from '../lib/busqueda.js';
import { parseCategorias } from '../lib/modelos/producto.js';

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

  const billing = billingWcDesdeOrdenMl(orden);

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
        if (est.status === 429) {
          // Cooldown global activo (real o sintético): TODAS las consultas de status que
          // falten en esta corrida van a devolver el mismo 429 — cortar el bucle entero en
          // vez de seguir recorriendo cientos de diffs haciendo `continue` en silencio, que
          // dejaba el stock de ML desincronizado sin ningún rastro. El próximo ciclo del
          // cron retoma desde el mismo `diffs` (no se pierde nada, solo se pospone).
          logSync(db, { direccion: 'wc_ml', clave, sku, estado: 'error', error: 'Cooldown ML activo (429) — corte de corrida, se retoma en el próximo ciclo' });
          break;
        }
        estadoItem.set(itemId, est.status === 200 ? est.data.status : 'desconocido');
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
// Mensaje exacto del bloqueo "sin precio web mapeado" (precioWebClave devolvió null: SKU sin
// regular_price, típicamente el catálogo todavía no se refrescó tras un reinicio). Constante
// compartida con reactivarAutomatico, que cuenta cuántas reactivaciones cayeron en este motivo
// puntual para que el operador pueda distinguirlo de "no había nada que hacer" (ver server.js).
const MOTIVO_SIN_PRECIO_WEB = 'Sin precio web mapeado para esta variación — no se puede verificar el margen';
async function chequearNetoReactivar(db, mlCfg, itemId, variaciones, opts = {}) {
  const resp = await mlFetch(db, mlCfg, 'get',
    `/items/${itemId}?attributes=id,status,sub_status,price,category_id,listing_type_id,shipping,variations`,
    null, opts);
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
      return { error: MOTIVO_SIN_PRECIO_WEB, clave: v.clave, neto: null, precio_web: null, deficitPct: null };
    }
    let precio = item.price ?? null;
    if (v.variation_id) {
      const vv = (item.variations || []).find(x => String(x.id) === String(v.variation_id));
      if (vv && vv.price != null) precio = vv.price;
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
      const bloqueo = await chequearNetoReactivar(db, mlCfg, itemId, variaciones, opts);
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
      logSync(db, { direccion: 'wc_ml', clave: itemId, estado: 'error', error: `reactivar: ${error}`.slice(0, 500) });
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
export async function reactivarAutomatico(db, cfg) {
  if (!mlCfgOk(cfg)) return { omitido: true };
  if (_reactivarEnCurso) return { omitido: true };
  _reactivarEnCurso = true;
  try {
    const rows = getReactivablesRows(db);

    const guardarFrenada = db.prepare(`
      INSERT INTO ml_reactivacion_frenada (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES (@clave, @sku, @motivo, @neto, @precio_contado, @deficit_pct, @detectado_en)
      ON CONFLICT(clave) DO UPDATE SET
        motivo=excluded.motivo, neto=excluded.neto, precio_contado=excluded.precio_contado,
        deficit_pct=excluded.deficit_pct, detectado_en=excluded.detectado_en
    `);
    const borrarFrenada = db.prepare('DELETE FROM ml_reactivacion_frenada WHERE clave = ?');
    const skuDeClave = db.prepare('SELECT sku FROM sku_matcher_decisiones WHERE clave = ?');

    if (rows.length === 0) {
      // No hay ningún reactivable: cualquier frenada existente quedó huérfana (ya no
      // corresponde a nada de la lista vigente) — limpieza total.
      db.prepare('DELETE FROM ml_reactivacion_frenada').run();
      return { omitido: false, reactivadas: 0, frenadas: 0, sin_precio_web: 0 };
    }

    const clavesFrenadas = new Set(
      db.prepare('SELECT clave FROM ml_reactivacion_frenada').all().map(f => f.clave)
    );
    // Primero los items SIN ninguna frenada registrada (candidatos reales a reactivarse),
    // después los que ya vienen frenados: así el lote (LOTE_MAX en reactivarItems) siempre
    // avanza sobre publicaciones nuevas en vez de reprocesar por siempre el mismo bloque.
    const itemIds = [...new Set(rows.map(r => r.item_id))];
    const itemTieneFrenada = new Map();
    for (const r of rows) {
      if (clavesFrenadas.has(r.clave)) itemTieneFrenada.set(r.item_id, true);
    }
    itemIds.sort((a, b) => (itemTieneFrenada.get(a) ? 1 : 0) - (itemTieneFrenada.get(b) ? 1 : 0));

    const { resultados } = await reactivarItems(db, cfg.ml, itemIds);

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
      // Solo el bloqueo por neto bajo trae deficitPct. Los demás (ML caído, sin precio web)
      // no son frenadas de precio: se reintentan solos, sin ensuciar la lista.
      if (r.bloqueado && r.deficitPct != null && r.clave) {
        frenadas++;
        guardarFrenada.run({
          clave: r.clave,
          sku: skuDeClave.get(r.clave)?.sku ?? null,
          motivo: r.error,
          neto: r.neto ?? null,
          precio_contado: r.precio_web ?? null,
          deficit_pct: r.deficitPct,
          detectado_en: ts,
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
function filasDeVinculos(db, { sku = null, ordenar = true } = {}) {
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
function senalesVigentes(fila, descartesPorClave) {
  const descartes = descartesPorClave.get(fila.clave) || new Map();
  return senalesDeVinculo(fila).filter(s => descartes.get(s.senal) !== s.valor);
}

/** Mapa clave → Map(senal → valor_revisado), para no consultar por fila. */
function cargarDescartes(db) {
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

    // Publicaciones que la reactivación automática frenó por precio (ver /frenadas).
    const frenadas = db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n;

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
    // Total real (sin LIMIT), para no reportar el tope de la query como si fuera el total.
    const totalReal = db.prepare(`
      SELECT COUNT(*) n FROM (
        SELECT s.clave
        FROM sync_log s
        WHERE s.estado IN (${def.estados})
          AND s.clave IS NOT NULL
          AND ${def.exclude}
        GROUP BY s.clave
      )
    `).get().n;
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

  // Detalle de un producto de WC y TODAS las publicaciones de ML mapeadas a su SKU.
  router.get('/vinculos/:sku', (req, res) => {
    const sku = String(req.params.sku || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'sku requerido' });

    // El 404 se resuelve ANTES de pagar las dos consultas pesadas (CTE con window function
    // sobre todo el catálogo + carga de descartes) cuando el SKU ni siquiera existe.
    const prod = db.prepare(`
      SELECT sku, nombre, stock, regular_price, img FROM catalogo_cache
      WHERE sku = ? AND sku <> '' ORDER BY stock ASC, id_woo ASC LIMIT 1
    `).get(sku);
    if (!prod) return res.status(404).json({ ok: false, error: 'SKU no encontrado en el catálogo' });

    const filas = filasDeVinculos(db, { sku });
    const descartes = cargarDescartes(db);

    const publicaciones = filas.map(f => ({
      clave: f.clave, item_id: f.item_id, variation_id: f.variation_id,
      titulo: f.titulo, status: f.status, sub_status: f.sub_status,
      color: f.color, talle: f.talle, variations_texto: f.variations_texto,
      seller_sku: f.seller_sku, thumbnail: f.thumbnail, permalink: f.permalink,
      precio_ml: f.precio, precio_actualizado_en: f.precio_actualizado_en,
      stock_ml: f.available_quantity, stock_sincronizado: f.cantidad_ml,
      senales: senalesVigentes(f, descartes),
    }));

    res.json({
      ok: true,
      producto: {
        sku: prod.sku, nombre: prod.nombre, stock: prod.stock, img: prod.img,
        // precio_lista sale de regular_price (LISTA real), no de precio (VIGENTE) — mismo
        // criterio que precio_contado, y evita el contrasentido de mostrar "Lista" con el
        // precio de oferta en la misma respuesta que ya calcula "Contado" sobre la lista real
        // (hallazgo del coordinador, 2026-08-03). Puede ser null (50 filas hoy sin
        // regular_price, ver comentario en precioWebClave); el frontend (public/vinculos/
        // index.html, vía money()) ya muestra "—" para null, no hace falta tocarlo.
        precio_lista: prod.regular_price,
        precio_contado: prod.regular_price > 0 ? precioContado(prod.regular_price) : null,
      },
      publicaciones,
    });
  });

  // Listado de vínculos con señales vigentes, ordenado por severidad (alta primero).
  router.get('/vinculos-sospechosos', (req, res) => {
    const descartes = cargarDescartes(db);
    const data = [];
    for (const f of filasDeVinculos(db)) {
      const senales = senalesVigentes(f, descartes);
      if (senales.length === 0) continue;
      data.push({
        clave: f.clave, sku: f.sku, item_id: f.item_id,
        titulo: f.titulo, wc_nombre: f.wc_nombre, thumbnail: f.thumbnail, permalink: f.permalink,
        precio_ml: f.precio, precio_wc: f.precio_wc, senales,
      });
    }
    data.sort((a, b) => {
      const peor = (x) => (x.senales.some(s => s.peso === 'alta') ? 0 : 1);
      return peor(a) - peor(b) || b.senales.length - a.senales.length;
    });
    res.json({ ok: true, data });
  });

  // Marcar una señal como revisada y correcta. Guarda el VALOR: si el dato cambia, reaparece.
  router.post('/vinculos/revisado', (req, res) => {
    const { clave, senal, valor } = req.body || {};
    if (!clave || typeof clave !== 'string') return res.status(400).json({ ok: false, error: 'clave requerida' });
    if (!senal || typeof senal !== 'string') return res.status(400).json({ ok: false, error: 'senal requerida' });
    // El contrato es "reenviá el valor tal cual lo recibiste": sin valor, se guardaría `null`,
    // que nunca coincide con ningún valor real y el cliente creería que descartó sin lograrlo.
    if (valor == null || typeof valor !== 'string') return res.status(400).json({ ok: false, error: 'valor requerido' });
    // Sin esto, un typo de clave crea un descarte huérfano que nadie limpia nunca (no aparece
    // en ningún listado porque filasDeVinculos hace JOIN con ml_publicaciones_cache).
    const pub = db.prepare('SELECT 1 FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
    if (!pub) return res.status(400).json({ ok: false, error: 'La clave no existe en el caché de publicaciones' });

    db.prepare(`
      INSERT INTO ml_vinculos_revisados (clave, senal, valor_revisado, revisado_por, revisado_en)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(clave, senal) DO UPDATE SET
        valor_revisado=excluded.valor_revisado, revisado_por=excluded.revisado_por, revisado_en=excluded.revisado_en
    `).run(clave, senal, valor, req.user?.username ?? null, now());
    res.json({ ok: true });
  });

  // Reasignar el vínculo a otro SKU. Mismo statement que usa el matcher para sus decisiones.
  router.post('/vinculos/reasignar', (req, res) => {
    const { clave, sku } = req.body || {};
    if (!clave || typeof clave !== 'string') return res.status(400).json({ ok: false, error: 'clave requerida' });
    if (!sku || typeof sku !== 'string') return res.status(400).json({ ok: false, error: 'sku requerido' });
    // Sin esto, una clave inexistente (typo, publicación borrada de ML entre el render y el
    // click) crea un vínculo fantasma en sku_matcher_decisiones: no aparece en ningún listado
    // (filasDeVinculos hace JOIN con el caché) pero ensucia para siempre el contador de
    // "necesitan atención" del home, sin ninguna pantalla desde la que limpiarlo.
    const pub = db.prepare('SELECT 1 FROM ml_publicaciones_cache WHERE clave = ?').get(clave);
    if (!pub) return res.status(400).json({ ok: false, error: 'La clave no existe en el caché de publicaciones' });
    const prod = db.prepare("SELECT nombre FROM catalogo_cache WHERE sku = ? AND sku <> '' LIMIT 1").get(sku);
    if (!prod) return res.status(400).json({ ok: false, error: 'El SKU no existe en el catálogo' });

    // Atómico: si el borrado de descartes fallara a mitad de camino, quedarían vivos los
    // descartes del vínculo VIEJO tapando en silencio señales legítimas del vínculo nuevo.
    db.transaction(() => {
      db.prepare('INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)')
        .run(clave, sku, prod.nombre, 'asignar', now());
      // Los descartes valían para el vínculo anterior, no para el nuevo.
      db.prepare('DELETE FROM ml_vinculos_revisados WHERE clave = ?').run(clave);
    })();
    logSync(db, { direccion: 'wc_ml', clave, sku, estado: 'remapeo_requerido', error: 'reasignada manualmente desde Vínculos' });
    res.json({ ok: true });
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
