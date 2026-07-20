/**
 * Reglas de cobertura de catálogo: qué producto de WooCommerce está "descubierto"
 * (faltante), es decir, con stock vendible pero sin publicación en MercadoLibre.
 *
 * Regla de negocio: toda publicación web con stock > 0 debe estar sincronizada con
 * al menos una publicación de ML, SALVO que sea un servicio o esté marcada como
 * "solo para venta en local".
 */

import { parseCategorias } from './modelos/producto.js';

export { parseCategorias };

// Categorías de WooCommerce que NO son productos vendibles por ML:
// - SERVICES: servicios que presta el negocio (armado, mantenimiento, etc.).
// - QR PAGOS: placeholders de pago tipo "parte de pago", no productos reales.
export const CATEGORIAS_NO_VENDIBLES = ['SERVICES', 'QR PAGOS'];

/**
 * true si el producto pertenece a alguna categoría no-vendible (servicio / QR pagos).
 */
export function esNoVendible(prod) {
  const cats = parseCategorias(prod.categorias_json);
  return cats.some((c) => CATEGORIAS_NO_VENDIBLES.includes(String(c).trim().toUpperCase()));
}

/**
 * Decide si un producto de WooCommerce es un "faltante" de cobertura ML.
 *
 * @param {object}  prod       fila de catalogo_cache: { id_woo, sku, tipo, stock, categorias_json }
 * @param {Set<string>} skusEnML   SKUs presentes en las publicaciones ML en vivo
 * @param {Set<number>} excluidos  id_woo marcados manualmente como "solo local"
 * @returns {boolean}
 */
export function esFaltante(prod, skusEnML, excluidos) {
  const stock = Number(prod.stock);
  if (!(stock > 0)) return false;                       // sin stock vendible
  if (prod.tipo === 'variable') return false;           // padre variable: placeholder
  const sku = String(prod.sku || '').trim();
  if (!sku) return false;                               // sin SKU no se puede mapear
  if (skusEnML.has(sku)) return false;                  // ya cubierto en ML
  if (excluidos && excluidos.has(prod.id_woo)) return false; // solo local
  if (esNoVendible(prod)) return false;                 // servicio / QR pagos
  return true;
}

/**
 * Filtra un catálogo completo devolviendo solo los faltantes.
 */
export function calcularFaltantes(catalogo, skusEnML, excluidos) {
  return catalogo.filter((p) => esFaltante(p, skusEnML, excluidos));
}
