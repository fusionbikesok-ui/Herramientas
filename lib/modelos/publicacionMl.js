/**
 * Modelo canónico de una publicación/variación de MercadoLibre.
 * Función pura: no toca DB ni red.
 */

import { armarClaveMl } from '../mlUtil.js';

/**
 * @typedef {Object} PublicacionMl  Fila canónica de una publicación/variación de ML.
 * @property {string} clave          "itemId|variationId" ('' de variación para simples)
 * @property {string} item_id
 * @property {string} variation_id
 * @property {string} titulo
 * @property {string} status
 * @property {string} sub_status
 * @property {0|1} es_variante
 * @property {string} color
 * @property {string} talle
 * @property {string} seller_sku
 * @property {string} variations_texto
 * @property {string} thumbnail
 * @property {string} permalink
 * @property {0|1} catalogo
 */

/**
 * Extrae de un array de attribute_combinations (o attributes) el value_name del
 * primer atributo cuyo id esté en la lista `ids`.
 */
export function attrValor(attrs, ids) {
  if (!Array.isArray(attrs)) return '';
  for (const id of ids) {
    const a = attrs.find(x => x.id === id);
    if (a && a.value_name) return String(a.value_name).trim();
  }
  return '';
}

/** SKU de un item/variación: SELLER_SKU en attributes, o seller_custom_field como fallback. */
export function skuDesdeAtributosMl(attrs, sellerCustomField) {
  return attrValor(attrs, ['SELLER_SKU']) || (sellerCustomField ? String(sellerCustomField).trim() : '');
}

/**
 * Convierte un item de ML (con o sin variaciones) en filas canónicas.
 * Una fila por variación; para simples, una sola fila con variation_id = ''.
 * @returns {PublicacionMl[]}
 */
export function aplanarItemMl(body) {
  const itemId = String(body.id);
  const titulo = body.title || '';
  const thumbnail = body.secure_thumbnail || body.thumbnail || '';
  const status = body.status || '';
  // sub_status es a nivel item (array, ej. ["out_of_stock"]); se denormaliza en cada fila.
  const subStatus = Array.isArray(body.sub_status) ? body.sub_status.join(',') : (body.sub_status || '');
  // permalink y catalog_listing son a nivel item; se denormalizan en cada variación.
  const permalink = body.permalink || '';
  const catalogo = body.catalog_listing ? 1 : 0;
  const vars = Array.isArray(body.variations) ? body.variations : [];

  if (vars.length === 0) {
    // Producto simple — SKU en attributes (SELLER_SKU) o seller_custom_field
    const sku = skuDesdeAtributosMl(body.attributes, body.seller_custom_field);
    return [{
      clave: armarClaveMl(itemId, ''),
      item_id: itemId,
      variation_id: '',
      titulo,
      status,
      sub_status: subStatus,
      es_variante: 0,
      color: '',
      talle: '',
      seller_sku: sku,
      variations_texto: '',
      thumbnail,
      permalink,
      catalogo,
    }];
  }

  return vars.map(v => {
    const varId = String(v.id);
    const color = attrValor(v.attribute_combinations, ['COLOR', 'MAIN_COLOR']);
    const talle = attrValor(v.attribute_combinations, ['SIZE', 'FRAME_SIZE', 'FILTRABLE_SIZE']);
    const sku = skuDesdeAtributosMl(v.attributes, v.seller_custom_field);
    const combo = (v.attribute_combinations || [])
      .map(a => a.value_name).filter(Boolean).join(' / ');
    return {
      clave: armarClaveMl(itemId, varId),
      item_id: itemId,
      variation_id: varId,
      titulo,
      status,
      sub_status: subStatus,
      es_variante: 1,
      color,
      talle,
      seller_sku: sku,
      variations_texto: combo,
      thumbnail,
      permalink,
      catalogo,
    };
  });
}
