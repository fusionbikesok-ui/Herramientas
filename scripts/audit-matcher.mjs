#!/usr/bin/env node
/**
 * Arnés de auditoría del matcher — invariantes de integridad read-only sobre la DB.
 *
 * Uso:  node scripts/audit-matcher.mjs [ruta_db]   (default ./data/fusion.sqlite)
 *       npm run audit
 *
 * No modifica nada (abre la DB en modo readonly). Pensado para correr tras cada refresh
 * o en un cron: da los mismos números de la auditoría QA y detecta regresiones sin tocar
 * la app. Ver el reporte para el detalle de cada hallazgo (F1…F16).
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2] || './data/fusion.sqlite';
const db = new Database(dbPath, { readonly: true });
const one = (sql, ...p) => db.prepare(sql).get(...p);
const many = (sql, ...p) => db.prepare(sql).all(...p);

const ACTIVAS_MAP = "accion IN ('asignar','confirmar')";

// Cada chequeo: { id, desc, n, ok } — ok=false marca algo a revisar.
const checks = [];
const add = (id, desc, n, esperado0 = true) => checks.push({ id, desc, n, ok: esperado0 ? n === 0 : true });

add('F1', 'decisiones activas con SKU inexistente en WC',
  one(`SELECT COUNT(*) n FROM sku_matcher_decisiones d WHERE ${ACTIVAS_MAP} AND d.sku IS NOT NULL AND d.sku<>'' AND NOT EXISTS(SELECT 1 FROM catalogo_cache c WHERE c.sku=d.sku)`).n);
add('F2', 'decisiones activas con SKU fuera de formato FB-<n>',
  one(`SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE ${ACTIVAS_MAP} AND sku IS NOT NULL AND sku<>'' AND sku NOT LIKE 'FB-%'`).n);
add('F3', 'decisiones activas con SKU NULL/vacío',
  one(`SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE ${ACTIVAS_MAP} AND (sku IS NULL OR sku='')`).n);
add('F4', 'mapeos huérfanos (clave decidida ausente del cache)',
  one(`SELECT COUNT(*) n FROM sku_matcher_decisiones d WHERE ${ACTIVAS_MAP} AND d.clave NOT IN (SELECT clave FROM ml_publicaciones_cache)`).n, false);
add('F5', 'SKUs WC en >1 publicación (multi-publicación, intencional)',
  one(`SELECT COUNT(*) n FROM (SELECT sku FROM sku_matcher_decisiones WHERE ${ACTIVAS_MAP} AND sku LIKE 'FB-%' GROUP BY sku HAVING COUNT(DISTINCT clave)>1)`).n, false);
add('F6', 'publicaciones ACTIVAS sin seller_sku (a mapear)',
  one(`SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE status='active' AND COALESCE(seller_sku,'')=''`).n, false);
add('F7', 'activas mapeadas con seller_sku ML != decidido (push pendiente)',
  one(`SELECT COUNT(*) n FROM sku_matcher_decisiones d JOIN ml_publicaciones_cache p ON p.clave=d.clave WHERE ${ACTIVAS_MAP} AND d.sku LIKE 'FB-%' AND p.status='active' AND COALESCE(p.seller_sku,'')<>d.sku`).n, false);
add('F8', 'permalink vacío en cache',
  one(`SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE COALESCE(permalink,'')=''`).n);
add('F9', 'publicaciones de catálogo (catalogo=1)',
  one(`SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE catalogo=1`).n, false);
add('F10', 'es_variante=1 con variation_id vacío',
  one(`SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE es_variante=1 AND COALESCE(variation_id,'')=''`).n);
add('F11', 'es_variante=0 con variation_id presente',
  one(`SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE es_variante=0 AND COALESCE(variation_id,'')<>''`).n);
add('F12', 'activas marcadas out_of_stock en sub_status',
  one(`SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE status='active' AND sub_status LIKE '%out_of_stock%'`).n);
add('F13', 'seller_sku repetido en varias publicaciones',
  one(`SELECT COUNT(*) n FROM (SELECT seller_sku FROM ml_publicaciones_cache WHERE COALESCE(seller_sku,'')<>'' GROUP BY seller_sku HAVING COUNT(DISTINCT item_id)>1)`).n, false);
add('F14', 'catalogo_cache con SKU vacío',
  one(`SELECT COUNT(*) n FROM catalogo_cache WHERE COALESCE(sku,'')=''`).n);
add('F15', 'catalogo_cache con stock negativo',
  one(`SELECT COUNT(*) n FROM catalogo_cache WHERE stock<0`).n);
add('F16', 'publicaciones con título vacío',
  one(`SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE COALESCE(titulo,'')=''`).n);

// Inventario de contexto
const inv = {
  cache: one('SELECT COUNT(*) n FROM ml_publicaciones_cache').n,
  items: one('SELECT COUNT(DISTINCT item_id) n FROM ml_publicaciones_cache').n,
  decisiones: one('SELECT COUNT(*) n FROM sku_matcher_decisiones').n,
  skusWc: one('SELECT COUNT(*) n FROM catalogo_cache').n,
};

console.log(`\nAuditoría del matcher · ${dbPath}`);
console.log(`Cache ${inv.cache} filas (${inv.items} pubs) · decisiones ${inv.decisiones} · SKUs WC ${inv.skusWc}\n`);
for (const c of checks) {
  const marca = c.ok ? '✓' : '⚠';
  console.log(`${marca} ${c.id.padEnd(4)} ${String(c.n).padStart(6)}  ${c.desc}`);
}
const alertas = checks.filter(c => !c.ok && c.n > 0).length;
console.log(`\n${alertas} invariante(s) de integridad con desvíos (los ⚠). F4–F7/F9/F13 son métricas informativas (no alertan).\n`);
db.close();
