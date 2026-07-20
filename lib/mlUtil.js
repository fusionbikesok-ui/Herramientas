/**
 * Helpers transversales para hablar con MercadoLibre: clave canónica de
 * publicación y extracción de mensajes de error de la API.
 *
 * Formato de clave: "item_id|variation_id" donde variation_id puede ser ""
 * para publicaciones simples.
 * Ejemplo simple:   "MLA123456|"
 * Ejemplo variante: "MLA123456|123456789"
 */

/**
 * Normaliza variation_id al mismo formato que usa el SKU Matcher:
 * quita el sufijo ".0" que a veces viene en los floats de JSON de ML.
 */
export function normVariationId(varId) {
  if (varId == null || varId === '') return '';
  return String(varId).replace(/\.0$/, '');
}

/** Arma la clave canónica "itemId|variationId" (variation_id normalizado). */
export function armarClaveMl(itemId, variationId) {
  return String(itemId ?? '') + '|' + normVariationId(variationId);
}

/** Parte una clave en sus componentes. Sin "|", variationId queda ''. */
export function partirClaveMl(clave) {
  const [itemId, variationId] = String(clave ?? '').split('|');
  return { itemId: itemId ?? '', variationId: variationId ?? '' };
}

/**
 * Extrae la causa de error de una respuesta de la API de ML:
 * cause[].message|code unidas con " | " → data.message → fallback.
 */
export function extraerErrorMl(resp, fallback = `HTTP ${resp?.status}`) {
  const data = resp?.data;
  const causas = (data?.cause || []).map(c => c.message || c.code).filter(Boolean);
  if (causas.length) return causas.join(' | ');
  return data?.message || fallback;
}
