/*
 * lib/pausasMl.js — registro de quién pausó una publicación y desde dónde.
 *
 * El log sólo agrega filas (ml_pausas_log, migración 119). Lo escriben los caminos de esta app que pausan en ML
 * (vigía, pantalla de Matcher/Cobertura, Guardia). Una pausa hecha en MercadoLibre no pasa por acá.
 */
const now = () => new Date().toISOString();

export function registrarPausaMl(db, { itemId, actor = 'desconocido', origen = 'desconocido', detalle = null } = {}) {
  if (!itemId) return;
  db.prepare('INSERT INTO ml_pausas_log (item_id, actor, origen, detalle, creado_en) VALUES (?,?,?,?,?)')
    .run(itemId, String(actor || 'desconocido'), String(origen || 'desconocido'), detalle, now());
}

/** Última pausa registrada de una publicación, o undefined. */
export function ultimaPausaMl(db, itemId) {
  return db.prepare('SELECT actor, origen, detalle, creado_en FROM ml_pausas_log WHERE item_id=? ORDER BY id DESC LIMIT 1').get(itemId);
}
