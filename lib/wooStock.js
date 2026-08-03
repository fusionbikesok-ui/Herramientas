/**
 * Actualiza el stock de un producto en WooCommerce dado su SKU.
 * Después de cada PUT exitoso, sincroniza catalogo_cache para evitar
 * la condición de carrera con el cron WC→ML.
 */

import { wooFetch } from '../routes/woo.js';

/**
 * Busca en catalogo_cache el producto activo para el SKU dado.
 */
export function buscarEnCache(db, sku) {
  return db.prepare(
    "SELECT id_woo, id_padre, tipo, precio, regular_price FROM catalogo_cache WHERE sku = ? AND sku <> '' LIMIT 1"
  ).get(sku);
}

/**
 * Construye el path de la API de WC para un producto o variación.
 * Para variaciones: /products/{id_padre}/variations/{id_woo}
 * Para simples:     /products/{id_woo}
 */
export function buildWooPath(prod) {
  if (prod.tipo === 'variation' && prod.id_padre) {
    return `/products/${prod.id_padre}/variations/${prod.id_woo}`;
  }
  return `/products/${prod.id_woo}`;
}

/**
 * Actualiza el stock del producto en WooCommerce y luego en catalogo_cache.
 * cfg: wooCfg { url, ck, cs }
 * Lanza error si el SKU no existe en el cache o si la API falla.
 */
export async function setStockWc(cfg, db, sku, nuevaCantidad) {
  const prod = buscarEnCache(db, sku);
  if (!prod) throw new Error(`SKU "${sku}" no encontrado en catalogo_cache`);

  const cantidad = Math.max(0, Math.round(nuevaCantidad));
  const apiPath = buildWooPath(prod);

  await wooFetch(cfg, apiPath, 'put', {
    stock_quantity: cantidad,
    manage_stock: true,
  });

  // Actualiza el cache local para mantener consistencia con el cron WC→ML
  db.prepare('UPDATE catalogo_cache SET stock = ?, actualizado_en = ? WHERE id_woo = ?')
    .run(cantidad, new Date().toISOString(), prod.id_woo);
}

/**
 * Lee el stock live de un producto desde la API de WC (no el cache).
 * Útil antes de descontar por una venta ML para tener el valor más actualizado.
 * Devuelve null si el SKU no está en cache.
 */
export async function getStockLiveWc(cfg, db, sku) {
  const prod = buscarEnCache(db, sku);
  if (!prod) return null;

  const apiPath = buildWooPath(prod);
  const resp = await wooFetch(cfg, apiPath);
  return resp.data.stock_quantity ?? 0;
}
