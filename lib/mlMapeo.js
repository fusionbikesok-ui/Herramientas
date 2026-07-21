/**
 * Mapeo bidireccional entre publicaciones de MercadoLibre y SKUs de WooCommerce.
 * Lee de sku_matcher_decisiones (generado por el SKU Matcher).
 *
 * Formato de clave: "item_id|variation_id" donde variation_id puede ser "" para simples.
 * Ejemplo simple:  "MLA123456|"
 * Ejemplo variante: "MLA123456|123456789"
 */

import { armarClaveMl, partirClaveMl } from './mlUtil.js';

/**
 * ML → WC: dado un item_id y variation_id de una orden ML,
 * devuelve el SKU de WooCommerce si existe un mapeo activo, o null.
 */
export function skuDesdeMl(db, itemId, variationId) {
  const clave = armarClaveMl(itemId, variationId);
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
    const { itemId, variationId } = partirClaveMl(r.clave);
    return { clave: r.clave, itemId, variationId };
  });
}

/**
 * Descarta una variación muerta (un variation_id que ML confirma que ya no existe).
 * Como ML nunca reutiliza variation_id, una variación ausente está muerta para siempre:
 *  - borra su mapeo activo (si lo hubiera), para que el sync deje de reintentarla; y
 *  - la marca en errores_descartados, lo que la excluye a la vez de sin_mapeo,
 *    remapeo_requerido y errores (todas las vistas de atención filtran por esa tabla).
 * Idempotente (ON CONFLICT actualiza el motivo). No consulta ML: el llamador ya
 * verificó que la variación no existe.
 */
export function descartarVariacionMuerta(db, clave, motivo) {
  const now = new Date().toISOString();
  const m = typeof motivo === 'string' ? motivo.slice(0, 200) : null;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM sku_matcher_decisiones WHERE clave = ?').run(clave);
    db.prepare(`INSERT INTO errores_descartados (clave, motivo, creado_en) VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET motivo = excluded.motivo, creado_en = excluded.creado_en`)
      .run(clave, m, now);
  });
  tx();
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
