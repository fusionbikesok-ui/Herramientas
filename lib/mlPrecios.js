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

/** Precio web del SKU mapeado a una clave (o null si no hay mapeo/precio). */
export function precioWebClave(db, clave) {
  const row = db.prepare(`
    SELECT c.precio
    FROM sku_matcher_decisiones d
    JOIN catalogo_cache c ON c.sku = d.sku AND c.sku <> ''
    WHERE d.clave = ? AND d.accion IN ('asignar','confirmar')
    LIMIT 1
  `).get(clave);
  return row && row.precio != null ? row.precio : null;
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
