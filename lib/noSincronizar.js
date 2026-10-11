import { decidirCasoIdentidad, marcarClaveNoSincroniza } from './identidadProductos.js';
import { cancelarPausaSiNoEmpezo, cancelarPausasBloqueadasPorMarca } from './pausasIdentidad.js';

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

/**
 * Marca (a/c/link de pago) en UNA transacción con el reemplazo de la pausa (b) bloqueada: si la marca cambia de origen,
 * la pausa `bloqueada_impacto` de la clave se cancela en el mismo commit. Re-marcar el MISMO origen no cancela nada.
 * `marcarClaveNoSincroniza` devuelve errores sin escribir, así que una falla no deja efectos parciales.
 */
function marcarYReemplazarPausa(db, { clave, origen, ...resto }) {
  let r;
  db.transaction(() => {
    const previa = db.prepare("SELECT origen FROM sku_matcher_decisiones WHERE clave=? AND accion='omitir'").get(clave);
    r = marcarClaveNoSincroniza(db, { clave, origen, ...resto });
    if (r.ok && previa?.origen !== origen) cancelarPausasBloqueadasPorMarca(db, clave, origen);
  })();
  return r;
}

export function marcarNoSincronizar(db, { clave, variante, motivo, actor, expectedSku, expectedSkuProvided, esAdmin = false } = {}) {
  if (!VARIANTES.includes(variante)) return invalido('variante inválida: a, b o c');
  if (variante === 'b') return invalido('la variante b pausa en ML: usá solicitarNoSincronizarPausa');
  if (!String(motivo || '').trim()) return invalido('motivo requerido');
  const r = marcarYReemplazarPausa(db, { clave, actor, expectedSku, expectedSkuProvided, origen: `no_sincronizar_${variante}`, esAdmin: esAdmin === true });
  if (!r.ok) return r;
  historial(db, 'no_sincronizar', actor, { clave, variante, motivo: String(motivo).trim(), sku_anterior: r.sku_anterior }, new Date().toISOString());
  return { ...r, variante };
}

export function marcarLinkDePago(db, { clave, motivo, actor, esAdmin, expectedSku, expectedSkuProvided } = {}) {
  if (!esAdmin) return prohibido();
  if (!String(motivo || '').trim()) return invalido('motivo requerido');
  const r = marcarYReemplazarPausa(db, { clave, actor, expectedSku, expectedSkuProvided, origen: 'link_de_pago', esAdmin: true });
  if (!r.ok) return r;
  historial(db, 'link_de_pago', actor, { clave, motivo: String(motivo).trim(), sku_anterior: r.sku_anterior }, new Date().toISOString());
  return r;
}

/** Invalida la excepción de la marca y reabre el caso si no queda otra excepción activa. Llamar dentro de una transacción. */
function reabrirCasoTrasDeshacer(db, clave, actor) {
  const caso = db.prepare("SELECT id,estado FROM identidad_casos WHERE direccion='ml_fusion' AND ml_key=?").get(clave);
  if (!caso || caso.estado !== 'exceptuado') return false;
  const ts = new Date().toISOString();
  db.prepare(`UPDATE identidad_excepciones SET activa=0,invalidada_en=?,invalidada_motivo='deshecho no sincronizar'
    WHERE caso_id=? AND activa=1 AND motivo LIKE 'No sincronizar por %'`).run(ts, caso.id);
  const otra = db.prepare('SELECT 1 FROM identidad_excepciones WHERE caso_id=? AND activa=1').get(caso.id);
  if (otra) return false;
  db.prepare(`UPDATE identidad_casos SET estado='urgente',expected_version=expected_version+1,resuelto_en=NULL,ultima_deteccion_en=?
    WHERE id=?`).run(ts, caso.id);
  db.prepare(`INSERT INTO identidad_historial (entidad_tipo,entidad_id,evento,actor,detalle_json,creado_en)
    VALUES ('caso',?,'caso_reabierto_por_deshacer',?,?,?)`).run(caso.id, actor || null, JSON.stringify({ clave }), ts);
  return true;
}

/** SKU que tenía la publicación antes de la última marca "no sincronizar" (historial `no_sincronizar`, sku_anterior). */
function skuAnteriorDeMarca(db, clave) {
  const filas = db.prepare("SELECT detalle_json FROM identidad_historial WHERE entidad_tipo='clave' AND evento='no_sincronizar' AND detalle_json LIKE ? ORDER BY id DESC")
    .all(`%"clave":${JSON.stringify(clave)}%`);
  for (const f of filas) {
    try { const d = JSON.parse(f.detalle_json); if (d?.clave === clave) return String(d.sku_anterior ?? '').trim() || null; } catch { /* fila ajena */ }
  }
  return null;
}

/**
 * Restaura el vínculo anterior por la saga de Identidad (`decidirCasoIdentidad` = mismas barreras que Vincular:
 * contradicción, hermanas, modo y escrituras). Solo si el SKU anterior sigue existiendo en Woo; si no, la
 * publicación queda sin vínculo y el resultado lo dice (`aviso`). Llamar DESPUÉS de la transacción de deshacer.
 */
function restaurarVinculoTrasDeshacer(db, clave, actor) {
  const sku = skuAnteriorDeMarca(db, clave);
  const sinVinculo = (motivo, aviso) => ({ restaurado: false, sku, motivo, aviso: `La publicación quedó sin vínculo: ${aviso}` });
  if (!sku) return sinVinculo('sin_vinculo_previo', 'no tenía un producto vinculado antes de marcarla. Vinculala desde la bandeja.');
  const producto = db.prepare("SELECT id FROM productos_fusion WHERE fusion_sku=? AND estado='activo'").get(sku);
  const enWoo = db.prepare('SELECT 1 FROM catalogo_cache WHERE sku=?').get(sku);
  if (!producto || !enWoo) return sinVinculo('sku_no_existe_en_woo', `${sku} ya no existe en Woo. Vinculala de nuevo desde la bandeja.`);
  const caso = db.prepare("SELECT * FROM identidad_casos WHERE direccion='ml_fusion' AND ml_key=?").get(clave);
  if (!caso) return sinVinculo('sin_caso', `no hay caso de Identidad para restaurar ${sku}. Vinculala de nuevo desde la bandeja.`);
  const r = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id,
    operation_id: `restaurar-vinculo-${clave}-${Date.now()}`, expected_version: caso.expected_version,
    evidence_fingerprint: caso.evidencia_fingerprint }, actor);
  if (!r.ok) return sinVinculo(r.code || 'rechazado', `no se pudo restaurar ${sku} (${r.error}). Vinculala de nuevo desde la bandeja.`);
  return { restaurado: true, sku, motivo: null, aviso: null, operacion_id: r.operacion?.id ?? null };
}

/**
 * Deshacer es una decisión compensatoria: se quita la marca y queda el evento. Solo para marcas de esta fase;
 * un link de pago o un `omitir` previo no se tocan. En (c) revertir es solo de administración.
 *
 * Reapertura (síncrona, misma transacción): la marca cerró el caso de Identidad como `exceptuado` con una
 * excepción `solo_ml` ("No sincronizar por …"). Al deshacer, esa excepción se invalida y el caso vuelve a
 * `urgente` (mismo estado que deja el scan al no haber excepción activa), con `expected_version+1`, `resuelto_en`
 * limpio e historial. NO se reabre si queda otra excepción activa (decisión manual de otra persona): ese cierre
 * sigue vigente. No dependemos del cron de detección: sin esto la publicación queda fuera de la cola hasta el
 * próximo scan.
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
    reabrirCasoTrasDeshacer(db, clave, actor);
  })();
  if (noSePuede) return { ok: false, code: 'INVALID_STATE', status: 409, error: 'la pausa ya empezó o terminó; no se puede deshacer desde acá' };
  const vinculo = restaurarVinculoTrasDeshacer(db, clave, actor);
  return { ok: true, clave, variante, vinculo, aviso: vinculo.aviso };
}
