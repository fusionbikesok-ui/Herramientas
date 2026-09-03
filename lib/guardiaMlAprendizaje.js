// Aprendizaje acotado y auditable: ayuda a ordenar candidatos, nunca decide por sí solo.
export function perfilPublicacionMl({ titulo = '', variations_texto = '', color = '', talle = '' } = {}) {
  return [titulo, variations_texto, color, talle]
    .join(' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((t) => t.length >= 3).slice(0, 24).join(' ');
}

export function registrarAprendizajeGuardia(db, perfil, sku, ts) {
  if (!perfil || !sku) return;
  db.prepare(`INSERT INTO guardia_ml_aprendizajes (perfil,sku,confirmaciones,ultima_confirmacion)
    VALUES (?,?,1,?)
    ON CONFLICT(perfil,sku) DO UPDATE SET confirmaciones=confirmaciones+1, ultima_confirmacion=excluded.ultima_confirmacion`)
    .run(perfil, sku, ts);
}
