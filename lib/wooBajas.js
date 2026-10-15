// E-1c: bajas de Woo confirmadas por relectura (tabla `woo_bajas_confirmadas`). Ver migrations/130.
// Una baja vigente hace que `stock.bolsa` empuje 0 a las publicaciones de ML vinculadas al SKU, esté o no el producto en el caché.

const norm = (v) => String(v ?? '').trim();

/** Registra (idempotente) la baja confirmada de cada SKU. Sin SKU no hay nada que llevar a 0. Devuelve los SKUs registrados. */
export function registrarBajasWoo(db, bajas, motivo = 'baja_woo') {
  const ts = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO woo_bajas_confirmadas (sku, id_woo, motivo, confirmada_en) VALUES (?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET id_woo = excluded.id_woo, motivo = excluded.motivo, confirmada_en = excluded.confirmada_en`);
  const skus = [];
  for (const b of bajas) {
    const sku = norm(b.sku);
    if (!sku) continue;
    ins.run(sku, b.id_woo ?? null, motivo, ts);
    skus.push(sku);
  }
  return skus;
}

/**
 * Levanta (una sola query) las bajas cuyo SKU volvió a figurar en el catálogo (producto restaurado o recreado). Escribe.
 * Devuelve los SKUs levantados.
 */
export function levantarBajasReaparecidas(db) {
  const filas = db.prepare(`SELECT sku FROM woo_bajas_confirmadas
    WHERE sku IN (SELECT sku FROM catalogo_cache WHERE COALESCE(sku, '') <> '')`).all();
  if (!filas.length) return [];
  db.prepare(`DELETE FROM woo_bajas_confirmadas
    WHERE sku IN (SELECT sku FROM catalogo_cache WHERE COALESCE(sku, '') <> '')`).run();
  return filas.map((f) => f.sku);
}

/** Lectura pura: de `skus`, los que tienen una baja registrada (una query). Llamar antes `levantarBajasReaparecidas`. */
export function skusConBajaWoo(db, skus) {
  const lista = [...new Set((skus || []).map(norm).filter(Boolean))];
  if (!lista.length) return new Set();
  return new Set(db.prepare(`SELECT sku FROM woo_bajas_confirmadas WHERE sku IN (${lista.map(() => '?').join(',')})`).all(...lista).map((r) => r.sku));
}

/** Todas las bajas registradas (para el script de operación). */
export function listarBajasWoo(db) {
  return db.prepare('SELECT sku, id_woo, motivo, confirmada_en FROM woo_bajas_confirmadas ORDER BY confirmada_en, sku').all();
}

/** Levanta a mano las bajas de `skus` (o todas con `skus = null`). Devuelve los SKUs levantados. */
export function levantarBajasWoo(db, skus = null) {
  const lista = skus ? [...new Set(skus.map(norm).filter(Boolean))] : listarBajasWoo(db).map((b) => b.sku);
  const del = db.prepare('DELETE FROM woo_bajas_confirmadas WHERE sku = ?');
  return db.transaction(() => lista.filter((sku) => del.run(sku).changes > 0))();
}
