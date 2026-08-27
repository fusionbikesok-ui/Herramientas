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
/**
 * Auto-vincula publicaciones de ML que ya traen `seller_sku` cargado (típicamente porque se
 * crearon en ML con el SKU puesto desde el vamos) contra un SKU real y SIN AMBIGÜEDAD de
 * `catalogo_cache`, sin pasar por el Matcher a mano.
 *
 * Root cause (2026-08-27): una publicación creada en ML con seller_sku=FB-68055 (y otras 83
 * en el mismo estado) quedaba invisible para `reconciliarStockMl`/`syncWcToMl` — ambos
 * exigen una fila en `sku_matcher_decisiones` con accion 'asignar'/'confirmar', y nada la
 * creaba si nadie abría el Matcher para esa publicación puntual. El dato para vincular ya
 * estaba en `seller_sku`: exigirle a un humano que lo reconfirme a mano no agrega
 * certeza, solo demora.
 *
 * Reglas de seguridad (para no auto-vincular un caso ambiguo o dudoso):
 *  - Solo si esa clave NO tiene NINGUNA decisión todavía, sea cual sea la acción — incluye
 *    'omitir' (hallazgo del revisor: filtrar solo por 'asignar'/'confirmar' dejaba pasar
 *    claves con 'omitir', que ES una decisión humana explícita de "no vincular esto", y
 *    además la PK de `clave` hacía explotar el INSERT y abortaba toda la corrida por la
 *    transacción). Tampoco si está en `errores_descartados` (un descarte deliberado de
 *    `descartarVariacionMuerta` no debe resucitarse solo).
 *  - Solo si el `seller_sku` existe EXACTO y UNA SOLA VEZ en `catalogo_cache` (evita vincular
 *    a un SKU duplicado/fantasma — mismo criterio de seguridad que ya usa `COMPUTED_STOCK_CTE`
 *    en routes/sync.js para el dedup de catalogo_cache).
 *  - Solo si ese SKU no está YA vinculado a otra clave activa, NI comparte seller_sku con OTRA
 *    candidata de esta misma corrida (hallazgo del revisor: un SKU con N publicaciones activas
 *    es la ambigüedad que el Matcher existe para resolver — vincular una sola al azar deja a
 *    las demás mudas, el mismo síntoma del incidente que este fix busca cerrar).
 *
 * Se llama en el cron periódico de reconciliación (server.js, cada 10 min) — no depende de
 * que nadie abra el Matcher. Devuelve cuántas vinculó.
 */
export function autoVincularPorSellerSku(db) {
  const candidatos = db.prepare(`
    SELECT p.clave, p.seller_sku AS sku
    FROM ml_publicaciones_cache p
    WHERE p.seller_sku IS NOT NULL AND p.seller_sku <> ''
      AND p.clave NOT IN (SELECT clave FROM sku_matcher_decisiones)
      AND p.clave NOT IN (SELECT clave FROM errores_descartados)
  `).all();
  if (candidatos.length === 0) return 0;

  // Ambigüedad DENTRO de esta misma corrida: si dos o más candidatas comparten seller_sku,
  // ninguna se vincula (no "una al azar") — se cuenta antes de tocar la DB.
  const porSku = new Map();
  for (const c of candidatos) porSku.set(c.sku, (porSku.get(c.sku) || 0) + 1);

  const skuUnicoEnCatalogo = db.prepare(
    "SELECT COUNT(*) n FROM catalogo_cache WHERE sku = ? AND sku IS NOT NULL AND sku <> ''"
  );
  const skuYaVinculado = db.prepare(
    "SELECT 1 FROM sku_matcher_decisiones WHERE sku = ? AND accion IN ('asignar','confirmar') LIMIT 1"
  );
  const nombreDeSku = db.prepare('SELECT nombre FROM catalogo_cache WHERE sku = ? LIMIT 1');
  const insertar = db.prepare(`
    INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en, origen)
    VALUES (?, ?, ?, 'asignar', ?, 'auto_seller_sku')
    ON CONFLICT(clave) DO NOTHING
  `);

  const now = new Date().toISOString();
  let vinculadas = 0;
  const tx = db.transaction(() => {
    for (const c of candidatos) {
      if (porSku.get(c.sku) > 1) continue; // ambiguo dentro de esta corrida: ninguna, no "una al azar"
      if (skuUnicoEnCatalogo.get(c.sku).n !== 1) continue;
      if (skuYaVinculado.get(c.sku)) continue;
      const nombre = nombreDeSku.get(c.sku)?.nombre ?? null;
      insertar.run(c.clave, c.sku, nombre, now);
      vinculadas++;
    }
  });
  tx();
  return vinculadas;
}

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
