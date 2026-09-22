import { norm } from './matcherEngine.js';

export function normalizarProveedor(texto) { return norm(texto || ''); }
export function claveAlias(input = {}) {
  return { proveedorNorm: normalizarProveedor(input.proveedor), codigoNorm: norm(input.codigo_proveedor || input.codigo || ''), descripcionNorm: norm(input.nombre_doc || input.descripcion || ''), variacionNorm: norm(input.variacion || '') };
}
export function buscarAliasVigente(db, input) {
  const k = claveAlias(input); if (!k.proveedorNorm) return null;
  let row;
  try {
    row = k.codigoNorm
      ? db.prepare('SELECT * FROM recepcion_aliases_proveedor WHERE proveedor_norm=? AND codigo_norm=? AND vigente_hasta IS NULL').get(k.proveedorNorm, k.codigoNorm)
      : db.prepare('SELECT * FROM recepcion_aliases_proveedor WHERE proveedor_norm=? AND codigo_norm=\'\' AND descripcion_norm=? AND variacion_norm=? AND vigente_hasta IS NULL').get(k.proveedorNorm, k.descripcionNorm, k.variacionNorm);
  } catch (error) {
    if (error.code === 'SQLITE_ERROR' && /no such table/.test(error.message)) return null;
    throw error;
  }
  if (!row || !db.prepare('SELECT 1 FROM catalogo_cache WHERE id_woo=?').get(row.id_woo)) return null;
  return row;
}
// Busca la fila que hoy ocupa el slot del índice único (proveedor+codigo, o proveedor+descripcion+variacion),
// SIN filtrar por si su id_woo sigue existiendo en catalogo_cache. buscarAliasVigente sí filtra eso (trata una
// fila huérfana como "no vigente" para efectos de matching), pero la fila huérfana sigue ocupando el slot
// físico protegido por el índice: si confirmarAlias no la ve y no la cierra, el INSERT de reemplazo revienta
// con SQLITE_CONSTRAINT_UNIQUE.
function buscarFilaEnSlot(db, input) {
  const k = claveAlias(input); if (!k.proveedorNorm) return null;
  try {
    return k.codigoNorm
      ? db.prepare('SELECT * FROM recepcion_aliases_proveedor WHERE proveedor_norm=? AND codigo_norm=? AND vigente_hasta IS NULL').get(k.proveedorNorm, k.codigoNorm)
      : db.prepare('SELECT * FROM recepcion_aliases_proveedor WHERE proveedor_norm=? AND codigo_norm=\'\' AND descripcion_norm=? AND variacion_norm=? AND vigente_hasta IS NULL').get(k.proveedorNorm, k.descripcionNorm, k.variacionNorm);
  } catch (error) {
    if (error.code === 'SQLITE_ERROR' && /no such table/.test(error.message)) return null;
    throw error;
  }
}
export function confirmarAlias(db, input) {
  const k = claveAlias(input); if (!k.proveedorNorm || (!k.codigoNorm && !k.descripcionNorm)) throw new Error('alias incompleto');
  const now = input.ahora || new Date().toISOString(); const actor = input.actor || input.creado_por;
  if (!actor) throw new Error('actor requerido');
  return db.transaction(() => {
    const vigente = buscarAliasVigente(db, input);
    if (vigente && vigente.id_woo === input.id_woo) return vigente;
    if (vigente && !input.motivo) throw new Error('motivo requerido para reasignar alias');
    // La fila que ocupa el slot puede ser "vigente" (válida) o huérfana (su id_woo ya no está en
    // catalogo_cache, así que buscarAliasVigente la ignoró arriba). En cualquiera de los dos casos hay
    // que cerrarla para poder insertar el reemplazo sin chocar con el índice único; una huérfana no
    // exige motivo porque no hay ningún alias válido que se esté pisando.
    const enSlot = vigente || buscarFilaEnSlot(db, input);
    if (enSlot) db.prepare('UPDATE recepcion_aliases_proveedor SET vigente_hasta=?,motivo_cierre=? WHERE id=?').run(now, input.motivo || 'alias huérfano reemplazado (producto ya no está en catálogo)', enSlot.id);
    const id = db.prepare(`INSERT INTO recepcion_aliases_proveedor (proveedor_norm,codigo_norm,descripcion_norm,variacion_norm,id_woo,sku,recepcion_item_id,creado_por,vigente_desde) VALUES (?,?,?,?,?,?,?,?,?)`).run(k.proveedorNorm,k.codigoNorm,k.descripcionNorm,k.variacionNorm,input.id_woo,input.sku||null,input.recepcion_item_id||null,actor,now).lastInsertRowid;
    return db.prepare('SELECT * FROM recepcion_aliases_proveedor WHERE id=?').get(id);
  })();
}
export function revocarAlias(db, id, { motivo, actor, ahora = new Date().toISOString() } = {}) {
  if (!motivo || !actor) throw new Error('motivo y actor requeridos');
  return db.prepare('UPDATE recepcion_aliases_proveedor SET vigente_hasta=?,motivo_cierre=? WHERE id=? AND vigente_hasta IS NULL').run(ahora,motivo,id).changes === 1;
}
