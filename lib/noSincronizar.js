import { marcarClaveNoSincroniza } from './identidadProductos.js';
import { cancelarPausaSiNoEmpezo } from './pausasIdentidad.js';

/**
 * "No sincronizar" (Fase D). Modelo: sigue siendo un `omitir` en `sku_matcher_decisiones` —así todos los
 * consumidores que ya saltean el stock de un `omitir` siguen funcionando— y se distingue por `origen`:
 *   no_sincronizar_a|b|c  → el sistema no toca el stock, pero las ventas SE RETIENEN (decisión de José);
 *   link_de_pago          → ignora stock y ventas, como el `omitir` de la Fase C.
 * La variante (b) pausa además en ML con una operación durable (ver `pausarNoSincronizar`).
 */
const VARIANTES = ['a', 'b', 'c'];
const ORIGEN_MARCA = /^no_sincronizar_([abc])$/;

const invalido = (error) => ({ ok: false, code: 'INVALID_INPUT', status: 422, error });
const prohibido = () => ({ ok: false, code: 'FORBIDDEN', status: 403, error: 'Acceso no autorizado' });

function historial(db, evento, actor, detalle, ts) {
  db.prepare(`INSERT INTO identidad_historial (entidad_tipo,entidad_id,evento,actor,detalle_json,creado_en)
    VALUES ('clave',NULL,?,?,?,?)`).run(evento, actor || null, JSON.stringify(detalle), ts);
}

export function marcarNoSincronizar(db, { clave, variante, motivo, actor, expectedSku, expectedSkuProvided } = {}) {
  if (!VARIANTES.includes(variante)) return invalido('variante inválida: a, b o c');
  if (variante === 'b') return invalido('la variante b pausa en ML: usá solicitarNoSincronizarPausa');
  if (!String(motivo || '').trim()) return invalido('motivo requerido');
  const r = marcarClaveNoSincroniza(db, { clave, actor, expectedSku, expectedSkuProvided, origen: `no_sincronizar_${variante}` });
  if (!r.ok) return r;
  historial(db, 'no_sincronizar', actor, { clave, variante, motivo: String(motivo).trim(), sku_anterior: r.sku_anterior }, new Date().toISOString());
  return { ...r, variante };
}

export function marcarLinkDePago(db, { clave, motivo, actor, esAdmin, expectedSku, expectedSkuProvided } = {}) {
  if (!esAdmin) return prohibido();
  if (!String(motivo || '').trim()) return invalido('motivo requerido');
  const r = marcarClaveNoSincroniza(db, { clave, actor, expectedSku, expectedSkuProvided, origen: 'link_de_pago' });
  if (!r.ok) return r;
  historial(db, 'link_de_pago', actor, { clave, motivo: String(motivo).trim(), sku_anterior: r.sku_anterior }, new Date().toISOString());
  return r;
}

/**
 * Deshacer es una decisión compensatoria: se quita la marca y queda el evento. Solo para marcas de esta fase;
 * un link de pago o un `omitir` previo no se tocan. En (c) revertir es solo de administración.
 */
export function deshacerNoSincronizar(db, { clave, motivo, actor, esAdmin } = {}) {
  const d = db.prepare("SELECT origen FROM sku_matcher_decisiones WHERE clave=? AND accion='omitir'").get(clave);
  const variante = ORIGEN_MARCA.exec(d?.origen || '')?.[1];
  if (!variante) return { ok: false, code: 'INVALID_STATE', status: 409, error: 'no hay una marca "no sincronizar" para deshacer' };
  if (variante === 'c' && !esAdmin) return prohibido();
  if (!String(motivo || '').trim()) return invalido('motivo requerido');
  let noSePuede = false;
  db.transaction(() => {
    // (b): solo se deshace con la pausa pendiente o en shadow; si ya empezó o terminó, la pausa en ML es real.
    if (variante === 'b' && !cancelarPausaSiNoEmpezo(db, clave)) { noSePuede = true; return; }
    db.prepare("DELETE FROM sku_matcher_decisiones WHERE clave=? AND accion='omitir'").run(clave);
    historial(db, 'no_sincronizar_deshecho', actor, { clave, variante, motivo: String(motivo).trim() }, new Date().toISOString());
  })();
  if (noSePuede) return { ok: false, code: 'INVALID_STATE', status: 409, error: 'la pausa ya empezó o terminó; no se puede deshacer desde acá' };
  return { ok: true, clave, variante };
}
