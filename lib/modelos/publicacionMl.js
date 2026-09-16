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
 * @property {number|null} precio              precio de la variación, o del ítem si la variación no tiene propio
 * @property {number|null} available_quantity  stock disponible en ML
 * @property {string|null} category_id         categoría ML del ítem (comisión)
 * @property {string|null} listing_type_id     tipo de publicación del ítem (comisión)
 * @property {0|1|null} free_shipping          envío gratis a cargo del vendedor; null si ML no lo informó
 */

/** Envío gratis como entero explícito; null si el ítem no trae `shipping` (no se inventa un 0). */
function envioGratis(body) {
  const v = body?.shipping?.free_shipping;
  return typeof v === 'boolean' ? (v ? 1 : 0) : null;
}

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

/**
 * SKU de un item/variación. Solo SELLER_SKU tiene semántica de identidad: el campo legacy
 * seller_custom_field se preserva aparte como evidencia auxiliar y nunca da cobertura.
 */
export function skuDesdeAtributosMl(attrs, _sellerCustomField) {
  return attrValor(attrs, ['SELLER_SKU']);
}

function tieneAtributo(attrs, id) {
  return Array.isArray(attrs) && attrs.some((attr) => attr?.id === id);
}

/** `channels` sin "marketplace" = link de pago de Mercado Pago, no publicación del marketplace. */
export function canalesMl(body) {
  const ch = Array.isArray(body?.channels) ? body.channels.filter(Boolean).map(String) : [];
  return ch.length ? JSON.stringify(ch) : null;
}

function evidenciaIdentificadores(attrs, sellerCustomField, fallbackAttrs = []) {
  const sellerSkuPresente = tieneAtributo(attrs, 'SELLER_SKU');
  const combinados = [...(Array.isArray(attrs) ? attrs : []), ...(Array.isArray(fallbackAttrs) ? fallbackAttrs : [])];
  return {
    seller_sku_presente: sellerSkuPresente ? 1 : 0,
    seller_custom_field: sellerCustomField == null ? null : String(sellerCustomField),
    atributos_json: JSON.stringify(Array.isArray(attrs) ? attrs : []),
    gtin: attrValor(combinados, ['GTIN', 'EAN', 'UPC']),
  };
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
  // El id del producto de CATÁLOGO al que está atada la publicación. `catalogo` (booleano) no
  // alcanza: una publicación puede seguir siendo de catálogo y saltar de un producto a otro,
  // que es exactamente lo que pasó con el GP5000 el 2026-09-11.
  const catalogProductId = body.catalog_product_id ?? null;
  // Datos de comisión/envío a nivel ítem (la auditoría de precios los lee del cache, sin /items).
  const comercial = {
    category_id: body.category_id ?? null,
    listing_type_id: body.listing_type_id ?? null,
    free_shipping: envioGratis(body),
  };
  const vars = Array.isArray(body.variations) ? body.variations : [];

  if (vars.length === 0) {
    const sku = skuDesdeAtributosMl(body.attributes, body.seller_custom_field);
    const evidencia = evidenciaIdentificadores(body.attributes, body.seller_custom_field);
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
      precio: body.price ?? null,
      available_quantity: body.available_quantity ?? null,
      canales_json: canalesMl(body),
      ...evidencia,
      catalog_product_id: catalogProductId,
      // Campo de primer nivel del ítem, no un atributo. Importa porque un `user_product` es
      // UNA bolsa de stock: si dos publicaciones lo comparten y apuntan a productos Woo
      // distintos, se pisan la cantidad para siempre y una vende sin existencia.
      user_product_id: body.user_product_id ?? null,
      ...comercial,
    }];
  }

  return vars.map(v => {
    const varId = String(v.id);
    const color = attrValor(v.attribute_combinations, ['COLOR', 'MAIN_COLOR']);
    const talle = attrValor(v.attribute_combinations, ['SIZE', 'FRAME_SIZE', 'FILTRABLE_SIZE']);
    const sku = skuDesdeAtributosMl(v.attributes, v.seller_custom_field);
    const evidencia = evidenciaIdentificadores(v.attributes, v.seller_custom_field, body.attributes);
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
      // ML puede poner el precio a nivel variación o solo a nivel ítem. Misma regla que usa
      // chequearNetoReactivar en routes/sync.js — si divergen, la vista mostraría un precio
      // distinto del que decide la reactivación.
      precio: v.price ?? body.price ?? null,
      available_quantity: v.available_quantity ?? null,
      canales_json: canalesMl(body),
      ...evidencia,
      catalog_product_id: catalogProductId,
      user_product_id: v.user_product_id ?? body.user_product_id ?? null,
      ...comercial,
    };
  });
}
