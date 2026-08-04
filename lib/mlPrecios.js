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

/** Comisión de venta para un precio/categoría/listing. Devuelve número o null si ML no responde. */
export async function saleFeeMl(db, mlCfg, price, categoryId, listingTypeId, cache = null) {
  if (!(price > 0) || !categoryId || !listingTypeId) return null;
  const key = `${categoryId}|${listingTypeId}|${price}`;
  if (cache && cache.has(key)) return cache.get(key);
  const resp = await mlFetch(
    db, mlCfg, 'get',
    `/sites/${SITE}/listing_prices?price=${price}&category_id=${encodeURIComponent(categoryId)}&listing_type_id=${encodeURIComponent(listingTypeId)}`
  );
  const fee = resp.status === 200 && typeof resp.data?.sale_fee_amount === 'number'
    ? resp.data.sale_fee_amount
    : null;
  if (cache) cache.set(key, fee);
  return fee;
}

/** Costo de envío a cargo del vendedor (0 si no hay envío gratis o si ML no da el dato). */
export async function costoEnvioMl(db, mlCfg, itemId, freeShipping, cache = null) {
  if (!freeShipping) return 0;
  if (cache && cache.has(itemId)) return cache.get(itemId);
  const resp = await mlFetch(
    db, mlCfg, 'get',
    `/users/${mlCfg.userId}/shipping_options/free?item_id=${encodeURIComponent(itemId)}&verbose=true`
  );
  const cost = resp.status === 200
    ? (resp.data?.coverage?.all_country?.list_cost ?? 0)
    : 0;
  if (cache) cache.set(itemId, cost);
  return cost;
}

/**
 * Neto del vendedor para una publicación.
 * caches (opcional): { fee: Map, envio: Map } para no repetir llamadas en una corrida.
 * Devuelve { price, sale_fee, envio, neto }; sale_fee/neto = null si no se pudo obtener la comisión.
 */
export async function netoMl(db, mlCfg, { itemId, price, categoryId, listingTypeId, freeShipping }, caches = {}) {
  const sale_fee = await saleFeeMl(db, mlCfg, price, categoryId, listingTypeId, caches.fee);
  const envio = await costoEnvioMl(db, mlCfg, itemId, freeShipping, caches.envio);
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
