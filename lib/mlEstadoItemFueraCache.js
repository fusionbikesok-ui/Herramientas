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
    if (!f || !f.status) return null;
    const edad = ahoraMs - Date.parse(f.actualizado_en);
    return Number.isFinite(edad) && edad >= 0 && edad < TTL_ESTADO_FUERA_CACHE_MS ? f.status : null;
  } catch { return null; }
}

/**
 * Recuerda el status resuelto por un GET exitoso (un status no consultable NO se guarda). `consultadoEn` es el instante de INICIO del GET:
 * si un aviso invalidó la fila después (o en el mismo instante), la respuesta es vieja y no se guarda.
 */
export function recordarEstadoFueraDeCache(db, itemId, status, consultadoEn, ahora = new Date().toISOString()) {
  if (!itemId || !status || status === 'desconocido' || !consultadoEn) return;
  try {
    db.prepare(`INSERT INTO ml_estado_item_fuera_cache (item_id, status, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, actualizado_en = excluded.actualizado_en
      WHERE ml_estado_item_fuera_cache.invalidada_en IS NULL OR ml_estado_item_fuera_cache.invalidada_en < ?`).run(String(itemId), String(status), ahora, consultadoEn);
  } catch { /* sin tabla (base vieja): el barrido sigue consultando */ }
}

/** Un aviso de ML para el ítem: su estado pudo cambiar. Deja una lápida (status NULL + invalidada_en) para que un GET en vuelo no la repueble. */
export function invalidarEstadoFueraDeCache(db, itemId, ahora = new Date().toISOString()) {
  try {
    db.prepare(`INSERT INTO ml_estado_item_fuera_cache (item_id, status, actualizado_en, invalidada_en) VALUES (?, NULL, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET status = NULL, invalidada_en = excluded.invalidada_en`).run(String(itemId), ahora, ahora);
  } catch { /* sin tabla */ }
}
