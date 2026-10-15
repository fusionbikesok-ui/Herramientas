/**
 * Status de publicaciones ML fuera de `ml_publicaciones_cache` (cerradas, en revisión...), recordado con TTL para no hacer un
 * GET /items/{id}?attributes=status por corrida de `wc_a_ml`. Solo lo consulta quien YA comprobó que el ítem no está en la caché de
 * publicaciones (esa tabla manda siempre). Medición, no escritura de negocio: nunca lanza.
 */
export const TTL_ESTADO_FUERA_CACHE_MS = 24 * 3600 * 1000;

/** Status recordado y vigente (< TTL) del ítem, o null. */
export function estadoFueraDeCache(db, itemId, ahoraMs = Date.now()) {
  try {
    const f = db.prepare('SELECT status, actualizado_en FROM ml_estado_item_fuera_cache WHERE item_id = ?').get(String(itemId));
    if (!f) return null;
    const edad = ahoraMs - Date.parse(f.actualizado_en);
    return Number.isFinite(edad) && edad >= 0 && edad < TTL_ESTADO_FUERA_CACHE_MS ? f.status : null;
  } catch { return null; }
}

/** Recuerda el status resuelto por un GET exitoso (un status no consultable NO se guarda). */
export function recordarEstadoFueraDeCache(db, itemId, status, ahora = new Date().toISOString()) {
  if (!itemId || !status || status === 'desconocido') return;
  try {
    db.prepare(`INSERT INTO ml_estado_item_fuera_cache (item_id, status, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, actualizado_en = excluded.actualizado_en`).run(String(itemId), String(status), ahora);
  } catch { /* sin tabla (base vieja): el barrido sigue consultando */ }
}

/** Un aviso de ML para el ítem: su estado pudo cambiar, la fila deja de valer. */
export function invalidarEstadoFueraDeCache(db, itemId) {
  try { db.prepare('DELETE FROM ml_estado_item_fuera_cache WHERE item_id = ?').run(String(itemId)); } catch { /* sin tabla */ }
}
