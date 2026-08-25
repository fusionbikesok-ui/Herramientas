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
  const homonimos = db.prepare(
    "SELECT COUNT(*) AS n FROM catalogo_cache WHERE sku = ? AND sku <> ''"
  ).get(sku).n;
  if (homonimos > 1) {
    throw new Error(`SKU "${sku}" ambiguo: hay ${homonimos} productos en catalogo_cache`);
  }
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

/**
 * Actualiza el stock del producto en WooCommerce ajustando por delta contra el
 * stock inicial que se leyó al momento de comenzar el conteo.
 * cfg: wooCfg { url, ck, cs }
 * db: instancia de base de datos
 * sku: SKU del producto
 * cantidadContada: cantidad física contada en el inventario
 * stockInicial: stock que se leyó de WC al crear la sesión del conteo
 *
 * Devuelve { stockFinal, huboVentaDurante, stockLive } si es exitoso.
 * Lanza error explícito si stockInicial es null/undefined, si getStockLiveWc
 * falla o devuelve null (fail-closed: no hace PUT).
 *
 * Semántica: calcula delta = cantidadContada - stockInicial, luego aplica
 * ese delta al stock actual de WC para evitar pisar ventas que ocurrieron
 * durante el conteo. Si el delta es negativo y el stock actual es bajo,
 * devuelve 0 (nunca negativo).
 */
export async function setStockWcDelta(cfg, db, sku, cantidadContada, stockInicial) {
  // Fail-closed: si no tenemos el stock inicial de referencia, no hacemos nada.
  if (stockInicial === null || stockInicial === undefined) {
    throw new Error(`stockInicial requerido para SKU "${sku}": no se puede calcular delta sin punto de referencia`);
  }

  // Validar que el SKU existe y no es homónimo (antes de leer stock live).
  const homonimos = db.prepare(
    "SELECT COUNT(*) AS n FROM catalogo_cache WHERE sku = ? AND sku <> ''"
  ).get(sku).n;
  if (homonimos > 1) {
    throw new Error(`SKU "${sku}" ambiguo: hay ${homonimos} productos en catalogo_cache`);
  }
  const prod = buscarEnCache(db, sku);
  if (!prod) throw new Error(`SKU "${sku}" no encontrado en catalogo_cache`);

  // Lee el stock actual en WC para comparar si hubo venta durante el conteo.
  let stockLive;
  try {
    stockLive = await getStockLiveWc(cfg, db, sku);
  } catch (e) {
    // Fail-closed: si no podemos leer el stock live, no hacemos el ajuste.
    throw new Error(`No se pudo leer stock live de WC para SKU "${sku}": ${e.message}`);
  }
  if (stockLive === null) {
    throw new Error(`Stock live de WC es null para SKU "${sku}": no se puede aplicar delta`);
  }

  // Calcula el delta: cuánto cambió lo que contamos vs. lo que había al inicio.
  // Luego lo suma al stock actual de WC.
  const delta = cantidadContada - stockInicial;
  const stockFinal = Math.max(0, stockLive + delta);
  const huboVentaDurante = stockLive !== stockInicial;

  // Hace el PUT a WC con el stock final ajustado.
  const apiPath = buildWooPath(prod);
  await wooFetch(cfg, apiPath, 'put', {
    stock_quantity: stockFinal,
    manage_stock: true,
  });

  // Actualiza el cache local para mantener consistencia con el cron WC→ML
  db.prepare('UPDATE catalogo_cache SET stock = ?, actualizado_en = ? WHERE id_woo = ?')
    .run(stockFinal, new Date().toISOString(), prod.id_woo);

  return { stockFinal, huboVentaDurante, stockLive };
}
