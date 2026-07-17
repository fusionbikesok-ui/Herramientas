/**
 * Mapeo bidireccional entre publicaciones de MercadoLibre y SKUs de WooCommerce.
 * Lee de sku_matcher_decisiones (generado por el SKU Matcher).
 *
 * Formato de clave: "item_id|variation_id" donde variation_id puede ser "" para simples.
 * Ejemplo simple:  "MLA123456|"
 * Ejemplo variante: "MLA123456|123456789"
 */

/**
 * Normaliza variation_id al mismo formato que usa el SKU Matcher:
 * quita el sufijo ".0" que a veces viene en los floats de JSON de ML.
 */
function normVariationId(varId) {
  if (varId == null || varId === '') return '';
  return String(varId).replace(/\.0$/, '');
}

/**
 * ML → WC: dado un item_id y variation_id de una orden ML,
 * devuelve el SKU de WooCommerce si existe un mapeo activo, o null.
 */
export function skuDesdeMl(db, itemId, variationId) {
  const clave = String(itemId) + '|' + normVariationId(variationId);
  const row = db.prepare(
    "SELECT sku FROM sku_matcher_decisiones WHERE clave = ? AND accion IN ('asignar','confirmar') AND sku IS NOT NULL AND sku <> ''"
  ).get(clave);
  return row ? row.sku : null;
}

/**
 * WC → ML: dado un SKU de WooCommerce, devuelve todas las publicaciones ML
 * mapeadas activamente. Un SKU puede tener varias publicaciones.
 * Retorna array de { clave, itemId, variationId }.
 */
export function publicacionesDesdeWc(db, sku) {
  if (!sku || !sku.trim()) return [];
  const rows = db.prepare(
    "SELECT clave FROM sku_matcher_decisiones WHERE sku = ? AND accion IN ('asignar','confirmar')"
  ).all(sku);
  return rows.map(r => {
    const [itemId, variationId] = r.clave.split('|');
    return { clave: r.clave, itemId, variationId: variationId ?? '' };
  });
}

/**
 * Claves de publicaciones que "necesitan atención" en el sync: ventas que llegaron
 * sin mapeo (sin_mapeo) o mapeos que ML rechazó y hay que rehacer (remapeo_requerido),
 * excluyendo las que ya se resolvieron. Misma noción de "no resuelto" que usa el
 * dashboard de sync (ATENCION_DEFS en routes/sync.js): úsala para cargar en el matcher
 * SOLO ese subconjunto en vez de todo el catálogo.
 */
export function clavesNecesitanAtencion(db) {
  const rows = db.prepare(`
    SELECT DISTINCT clave FROM sync_log
    WHERE clave IS NOT NULL AND (
      (estado = 'sin_mapeo'
        AND clave NOT IN (SELECT clave FROM sku_matcher_decisiones WHERE accion IN ('asignar','confirmar')))
      OR
      (estado = 'remapeo_requerido'
        AND clave NOT IN (SELECT clave FROM sku_matcher_decisiones))
    )
  `).all();
  return rows.map(r => r.clave);
}
