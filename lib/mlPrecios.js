/**
 * Cálculo del "neto que recibe el vendedor" en MercadoLibre y su veredicto contra
 * el precio web, para la herramienta de auditoría de precios y el bloqueo al reactivar.
 *
 *   neto = precio_ML − comisión (sale_fee) − costo de envío a cargo del vendedor
 *
 * - comisión: GET /sites/MLA/listing_prices?price=&category_id=&listing_type_id= → sale_fee_amount
 * - envío del vendedor (solo si envío gratis): GET /users/{userId}/shipping_options/free?item_id=
 *     → coverage.all_country.list_cost (ya con el descuento obligatorio aplicado)
 */

import { mlFetch } from './mlClient.js';

const SITE = 'MLA';

// Vigencia de la caché persistente de comisión/envío (ml_precios_cache, migrations/004_*.sql):
// decisión del usuario 2026-08-05, 7 días. Vencida, se re-consulta a ML y se reescribe.
const TTL_CACHE_PERSISTENTE_MS = 7 * 24 * 60 * 60 * 1000;

function ahoraIso() {
  return new Date().toISOString();
}

/** Lee la caché persistente. Devuelve undefined si no existe o si venció (nunca null: null lo usan los callers para "no hay dato"). */
function leerCachePersistente(db, clave) {
  const row = db.prepare('SELECT valor, actualizado_en FROM ml_precios_cache WHERE clave = ?').get(clave);
  if (!row) return undefined;
  const edadMs = Date.now() - new Date(row.actualizado_en).getTime();
  if (!(edadMs >= 0) || edadMs > TTL_CACHE_PERSISTENTE_MS) return undefined;
  return row.valor;
}

/** Escribe/actualiza la caché persistente. Solo se llama con valores numéricos válidos (nunca ante error de ML: no envenenar la caché). */
function guardarCachePersistente(db, clave, valor) {
  db.prepare(`
    INSERT INTO ml_precios_cache (clave, valor, actualizado_en) VALUES (?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
  `).run(clave, valor, ahoraIso());
}

/**
 * Borra la caché persistente de comisión/envío. Sin argumentos, borra todo; con `prefijo`
 * ('fee:' o 'envio:'), solo esas filas. Para cuando ML cambia comisiones antes del vencimiento.
 */
export function invalidarCachePreciosMl(db, prefijo = null) {
  if (prefijo) {
    db.prepare('DELETE FROM ml_precios_cache WHERE clave LIKE ?').run(`${prefijo}%`);
  } else {
    db.prepare('DELETE FROM ml_precios_cache').run();
  }
}

/**
 * Comisión de venta para un precio/categoría/listing. Devuelve número o null si ML no responde.
 * opts.saltarCachePersistente: true para revalidar SIEMPRE en vivo (paso 5, justo antes del PUT
 * de activación) aunque haya una fila fresca en sqlite — el Map en memoria (`cache`) sigue
 * activo dentro de la misma corrida.
 */
export async function saleFeeMl(db, mlCfg, price, categoryId, listingTypeId, cache = null, opts = {}) {
  if (!(price > 0) || !categoryId || !listingTypeId) return null;
  const key = `${categoryId}|${listingTypeId}|${price}`;
  if (cache && cache.has(key)) return cache.get(key);

  const claveCache = `fee:${price}:${categoryId}:${listingTypeId}`;
  if (!opts.saltarCachePersistente) {
    const persistido = leerCachePersistente(db, claveCache);
    if (persistido !== undefined) {
      if (cache) cache.set(key, persistido);
      return persistido;
    }
  }

  const resp = await mlFetch(
    db, mlCfg, 'get',
    `/sites/${SITE}/listing_prices?price=${price}&category_id=${encodeURIComponent(categoryId)}&listing_type_id=${encodeURIComponent(listingTypeId)}`,
    null, opts
  );
  const fee = resp.status === 200 && typeof resp.data?.sale_fee_amount === 'number'
    ? resp.data.sale_fee_amount
    : null;
  if (cache) cache.set(key, fee);
  // Solo se persiste un valor numérico válido (status 200 con sale_fee_amount numérico) —
  // nunca un error, para no envenenar la caché con un margen falso.
  if (fee != null) guardarCachePersistente(db, claveCache, fee);
  return fee;
}

/**
 * Costo de envío a cargo del vendedor (0 si no hay envío gratis o si ML no da el dato).
 * La clave de caché incluye el PRECIO (el costo depende de él, no solo del item_id) — ver
 * plan ahorro-llamadas-ml, paso 2: indexar solo por item_id sería un bug si se persiste así.
 */
export async function costoEnvioMl(db, mlCfg, itemId, price, freeShipping, cache = null, opts = {}) {
  if (!freeShipping) return 0;
  if (cache && cache.has(itemId)) return cache.get(itemId);

  const claveCache = `envio:${itemId}:${price}`;
  if (!opts.saltarCachePersistente) {
    const persistido = leerCachePersistente(db, claveCache);
    if (persistido !== undefined) {
      if (cache) cache.set(itemId, persistido);
      return persistido;
    }
  }

  const resp = await mlFetch(
    db, mlCfg, 'get',
    `/users/${mlCfg.userId}/shipping_options/free?item_id=${encodeURIComponent(itemId)}&verbose=true`,
    null, opts
  );
  const cost = resp.status === 200
    ? (resp.data?.coverage?.all_country?.list_cost ?? 0)
    : 0;
  if (cache) cache.set(itemId, cost);
  // Igual criterio que saleFeeMl: solo se persiste ante status 200 (valor confiable,
  // incluido 0 si ML no trae list_cost pero respondió bien).
  if (resp.status === 200) guardarCachePersistente(db, claveCache, cost);
  return cost;
}

/**
 * Neto del vendedor para una publicación.
 * caches (opcional): { fee: Map, envio: Map } para no repetir llamadas en una corrida.
 * opts.saltarCachePersistente: ver saleFeeMl/costoEnvioMl — revalidación en vivo del paso 5.
 * Devuelve { price, sale_fee, envio, neto }; sale_fee/neto = null si no se pudo obtener la comisión.
 */
export async function netoMl(db, mlCfg, { itemId, price, categoryId, listingTypeId, freeShipping }, caches = {}, opts = {}) {
  const sale_fee = await saleFeeMl(db, mlCfg, price, categoryId, listingTypeId, caches.fee, opts);
  const envio = await costoEnvioMl(db, mlCfg, itemId, price, freeShipping, caches.envio, opts);
  const neto = sale_fee == null ? null : +(price - sale_fee - envio).toFixed(2);
  return { price: price ?? null, sale_fee, envio, neto };
}

/**
 * Veredicto del neto contra el precio web.
 *  - sin_precio: falta el precio web o no se pudo calcular el neto (no hay comparación posible)
 *  - bajo: el neto queda > tolUnder por debajo del web (perdés margen) → se bloquea la reactivación
 *  - alto: el neto supera al web por > tolOver (posible sobreprecio)
 *  - ok: dentro de tolerancia
 * deficitPct = (precioWeb − neto) / precioWeb   (>0 = neto por debajo del web)
 */
export function veredictoNeto(neto, precioWeb, { tolUnder = 0.05, tolOver = 0.20 } = {}) {
  if (neto == null || !(precioWeb > 0)) return { estado: 'sin_precio', deficitPct: null };
  const deficitPct = (precioWeb - neto) / precioWeb;
  if (deficitPct > tolUnder) return { estado: 'bajo', deficitPct };
  if (-deficitPct > tolOver) return { estado: 'alto', deficitPct };
  return { estado: 'ok', deficitPct };
}

/**
 * Descuento de contado/transferencia que aplica la web sobre el precio de lista
 * (catalogo_cache.precio = precio de LISTA, el que devuelve la API de WooCommerce en
 * `price`/`regular_price`). Verificado en vivo el 2026-07-20 contra el `price_html` real
 * de 33 productos (simples, variables y variaciones, de $14mil a más de $5M): el precio
 * "Contado/Transf." que muestra la web es siempre exactamente 2/3 del precio de lista,
 * sin una sola excepción — es una regla pareja de todo el catálogo, no por producto.
 *
 * Comparar el neto de ML contra el precio de LISTA (como hacía esta herramienta antes)
 * sobreestima el "déficit" en un 50%: con precio de lista, ~98% del catálogo daba "bajo";
 * contra el precio de contado real, baja a ~25%. El neto de una venta ML es plata en mano
 * (como una venta de contado), así que el precio de contado es la comparación correcta.
 */
export const DESCUENTO_CONTADO = 1 / 3;

/** Precio de contado a partir del precio de lista (o null si no hay precio). */
export function precioContado(precioLista) {
  return precioLista != null ? +(precioLista * (1 - DESCUENTO_CONTADO)).toFixed(2) : null;
}

/**
 * Total de contado de una línea (precio de lista × cantidad, con el descuento de contado),
 * redondeado a 2 decimales UNA SOLA VEZ, sobre el total — no sobre el unitario.
 *
 * `precioContado(precioLista)` ya redondea el unitario a 2 decimales; multiplicar ese
 * resultado redondeado por la cantidad y volver a redondear (`(contado * qty).toFixed(2)`)
 * es un DOBLE redondeo que puede desviar el total real hasta un centavo por unidad extra
 * (ej.: precioLista=1000, contado=666.67 (redondeado), ×3 = 2000.01, cuando el total exacto
 * de 3 unidades a contado es 2000.00). En el registro contable de la tienda ese centavo por
 * venta multi-unidad importa — por eso este helper NO reusa precioContado() para el cálculo
 * de la línea, calcula sobre el precio de lista sin redondear y recién redondea el total.
 *
 * Devuelve `null` si no hay precio de lista (mismo criterio fail-open que precioContado()).
 */
export function totalContado(precioLista, cantidad) {
  return precioLista != null ? +(precioLista * (1 - DESCUENTO_CONTADO) * cantidad).toFixed(2) : null;
}

/**
 * Precio de contado del SKU mapeado a una clave (o null si no hay mapeo/precio de LISTA),
 * a partir de `catalogo_cache.regular_price` (precio de LISTA), NUNCA de `precio` (vigente,
 * que ya trae el sale_price si el producto está en oferta y acumularía dos descuentos).
 *
 * Alimenta el bloqueo de reactivación por precio (chequearNetoReactivar/
 * evaluarPreciosReactivables en routes/sync.js): decisión del usuario (2026-08-03), la
 * oferta de la web NO baja la vara que una publicación de ML tiene que superar.
 *
 * Fail-closed a propósito: si `regular_price` es NULL (SKU sin mapeo, o catálogo aún sin
 * ese campo poblado), devuelve null y la reactivación queda BLOQUEADA. Prohibido agregar
 * un fallback `regular_price ?? precio` — es exactamente el bug que el revisor encontró en
 * el cambio anterior (descuento sobre descuento, en silencio).
 */
export function precioWebClave(db, clave) {
  const row = db.prepare(`
    SELECT c.regular_price
    FROM sku_matcher_decisiones d
    JOIN catalogo_cache c ON c.sku = d.sku AND c.sku <> ''
    WHERE d.clave = ? AND d.accion IN ('asignar','confirmar')
    LIMIT 1
  `).get(clave);
  return row && row.regular_price != null ? precioContado(row.regular_price) : null;
}

/**
 * Precio ML sugerido para que el neto iguale el precio web, a partir del % de comisión
 * implícito en la última auditoría (sale_fee / precio_ml). El envío no depende del precio
 * (se calcula por peso/dimensiones), así que no hace falta iterar contra ML para esta cuenta.
 * Es un punto de partida editable, no exacto: cerca del corte de costo fijo por publicación
 * barata la comisión real no escala de forma perfectamente proporcional al precio.
 */
export function precioSugerido(precioMl, saleFee, envio, precioWeb) {
  if (!(precioMl > 0) || saleFee == null || !(precioWeb > 0)) return null;
  const pct = saleFee / precioMl;
  if (!(pct < 1)) return null;
  return Math.ceil((precioWeb + (envio || 0)) / (1 - pct));
}

/** Upsert de una fila auditada en ml_precio_auditoria. Comparte statement el scan completo y el refresco puntual tras corregir un precio. */
export function upsertAuditoria(db, fila) {
  db.prepare(`
    INSERT INTO ml_precio_auditoria
      (clave, item_id, titulo, sku, precio_ml, sale_fee, envio, neto, precio_web, deficit_pct, estado, actualizado_en)
    VALUES (@clave, @item_id, @titulo, @sku, @precio_ml, @sale_fee, @envio, @neto, @precio_web, @deficit_pct, @estado, @actualizado_en)
    ON CONFLICT(clave) DO UPDATE SET
      item_id=excluded.item_id, titulo=excluded.titulo, sku=excluded.sku, precio_ml=excluded.precio_ml,
      sale_fee=excluded.sale_fee, envio=excluded.envio, neto=excluded.neto, precio_web=excluded.precio_web,
      deficit_pct=excluded.deficit_pct, estado=excluded.estado, actualizado_en=excluded.actualizado_en
  `).run(fila);
}
