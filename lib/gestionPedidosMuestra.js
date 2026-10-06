/** Reconciliación determinista de una muestra previa a una jornada controlada. */
export function reconciliarMuestra(db, esperados = []) {
  const claves = esperados.map(item => ({ fuente: String(item.fuente), external_id: String(item.external_id) }));
  const encontrados = claves.map(clave => ({ ...clave, filas: db.prepare('SELECT id, estado_comercial, estado_operativo FROM gestion_pedidos WHERE fuente=? AND external_id=?').all(clave.fuente, clave.external_id) }));
  const faltantes = encontrados.filter(item => item.filas.length === 0);
  const duplicados = encontrados.filter(item => item.filas.length > 1);
  return { ok: faltantes.length === 0 && duplicados.length === 0, total_esperados: claves.length,
    encontrados: encontrados.filter(item => item.filas.length === 1).length, faltantes, duplicados,
    estados: encontrados.filter(item => item.filas.length === 1).map(item => ({ ...item, ...item.filas[0] })) };
}
