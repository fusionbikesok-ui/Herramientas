import {
  comandoRepetido, decidirCasoIdentidad, guardarComando, registrarHistorial, validarMutacion,
} from './identidadProductos.js';
import { excepcionVigente, ningunoVigente, salteoVigente } from './catalogoVinculos.js';

/**
 * Acciones de la pantalla "Catálogo y vínculos" que no existían en Identidad (Fase D, H1-H4). Todas escriben solo en
 * SQLite. NINGUNA crea una operación remota nueva: el único camino a ML sigue siendo la cola de identidad que
 * `decidirCasoIdentidad` alimenta (y el `revertir` vuelve a encolar por ese mismo camino, con sus barreras).
 *
 * Convenciones (las mismas de identidadProductos.js): `operation_id` por intento (idempotencia vía identidad_comandos),
 * `expected_version` y `evidence_fingerprint` validados con `validarMutacion`. Errores `{ ok:false, code, error, status? }`.
 */

const CERRADOS = ['resuelto', 'verificado', 'exceptuado'];
export const MOTIVOS_NINGUNO = ['no_es_ninguno', 'no_existe_en_woo'];
const NOTA_MAX = 500;
const PREFIJO_CANCELADA = 'cancelada:';
// Operación que todavía no empezó: se puede deshacer. "bloqueada_impacto" espera confirmación humana, no corrió.
const NO_EMPEZADA = ['pendiente', 'shadow', 'bloqueada_impacto'];
// Ya corrió (o está corriendo) contra ML: no se deshace, solo se revierte con una operación nueva.
const EMPEZADA = ['procesando', 'verificando', 'completada', 'fallida', 'intervencion'];

const err = (code, error, status = null) => ({ ok: false, code, error, ...(status ? { status } : {}) });
const ahora = () => new Date().toISOString();
const obtenerCaso = (db, id) => db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(Number(id));
const obtenerOperacion = (db, id) => db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(Number(id));
const operationIdDe = (input) => String(input?.operation_id ?? '').trim();

/** Estado previo del caso al persistir la decisión (ver decidirCasoIdentidad: evento decision_persistida_antes_de_efecto). */
function casoPrevioDe(db, operacionId) {
  const ev = db.prepare(`SELECT detalle_json FROM identidad_historial
    WHERE entidad_tipo='operacion' AND entidad_id=? AND evento='decision_persistida_antes_de_efecto' ORDER BY id DESC LIMIT 1`).get(operacionId);
  try { return JSON.parse(ev?.detalle_json ?? 'null')?.caso_previo ?? null; } catch { return null; }
}

/**
 * Deshacer un Vincular mientras la operación no empezó. Cancela la operación (estado 'fallida' con ultimo_error
 * 'cancelada:…', como el resto de las cancelaciones), vuelve el caso a su estado previo y deja historial.
 * Si la operación ya empezó: 409 OPERACION_YA_INICIADA (para volver a un SKU anterior, usar revertirVinculo).
 * Solo la propia decisión (o admin). Sin llamada a ML.
 */
export function cancelarVinculo(db, operacionId, input = {}, actor, { esAdmin = false } = {}) {
  const operationId = operationIdDe(input);
  if (!operationId) return err('INVALID_INPUT', 'operation_id requerido', 422);
  const op = obtenerOperacion(db, operacionId);
  // Permiso ANTES del replay: un operation_id ajeno no devuelve el resultado guardado a quien no puede deshacer.
  if (op && !esAdmin && db.prepare('SELECT decidida_por FROM identidad_decisiones WHERE id=?').get(op.decision_id)?.decidida_por !== actor) {
    return err('FORBIDDEN', 'solo podés deshacer tu propia decisión', 403);
  }
  const repetido = comandoRepetido(db, operationId);
  if (repetido) return { ...repetido, repetido: true };
  if (!op) return err('NOT_FOUND', 'operación no encontrada', 404);
  if (op.estado === 'fallida' && String(op.ultimo_error ?? '').startsWith(PREFIJO_CANCELADA)) return err('INVALID_STATE', 'la operación ya está cancelada', 409);
  if (EMPEZADA.includes(op.estado)) return err('OPERACION_YA_INICIADA', 'la operación ya se mandó a ML; no se puede deshacer. Mirá Ejecución', 409);
  if (!NO_EMPEZADA.includes(op.estado)) return err('INVALID_STATE', `la operación en estado ${op.estado} no admite deshacer`, 409);
  const caso = obtenerCaso(db, op.caso_id);
  if (!caso) return err('NOT_FOUND', 'caso no encontrado', 404);
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };

  const previo = casoPrevioDe(db, op.id);
  const ts = ahora();
  return db.transaction(() => {
    const cambio = db.prepare(`UPDATE identidad_operaciones SET estado='fallida', ultimo_error=?, claim_hasta=NULL, actualizada_en=?
      WHERE id=? AND estado IN (${NO_EMPEZADA.map(() => '?').join(',')})`)
      .run(`${PREFIJO_CANCELADA} deshecha por ${actor} antes de empezar`, ts, op.id, ...NO_EMPEZADA);
    if (!cambio.changes) return err('INVALID_STATE', 'la operación cambió mientras se deshacía', 409);
    const restaurado = previo?.estado ?? 'urgente';
    db.prepare('UPDATE identidad_casos SET estado=?,responsable=?,tomado_en=?,expected_version=expected_version+1 WHERE id=?')
      .run(restaurado, previo?.responsable ?? null, previo?.tomado_en ?? null, caso.id);
    registrarHistorial(db, 'operacion', op.id, 'operacion_cancelada_por_deshacer', actor, { decision_id: op.decision_id, estado_previo: op.estado }, ts);
    registrarHistorial(db, 'caso', caso.id, 'vinculo_deshecho', actor, { operacion_id: op.id, estado_restaurado: restaurado }, ts);
    const resultado = { ok: true, operacion: obtenerOperacion(db, op.id), caso: obtenerCaso(db, caso.id) };
    guardarComando(db, operationId, 'deshacer_vinculo', 'operacion', op.id, resultado, actor, ts);
    return resultado;
  })();
}

/**
 * Revertir un Vincular ya completado: encola una operación NUEVA hacia el SKU anterior de la publicación. Pasa por
 * decidirCasoIdentidad, o sea las mismas barreras que Vincular (hermanas, contradicción, operación abierta, modo).
 * Motivo obligatorio. Solo sobre operaciones `completada` (una fallida puede haber aplicado algo: fail-closed).
 */
export function revertirVinculo(db, operacionId, input = {}, actor, { esAdmin = false } = {}) {
  const operationId = operationIdDe(input);
  if (!operationId) return err('INVALID_INPUT', 'operation_id requerido', 422);
  // Permiso ANTES del replay: los overrides son solo de administración.
  if ((input.override_contradiccion === true || input.override_omitir === true) && !esAdmin) return err('FORBIDDEN', 'solo administración puede revertir con override', 403);
  const repetido = comandoRepetido(db, operationId);
  if (repetido) return { ...repetido, repetido: true };
  const op = obtenerOperacion(db, operacionId);
  if (!op) return err('NOT_FOUND', 'operación no encontrada', 404);
  if (op.estado === 'fallida' && String(op.ultimo_error ?? '').startsWith(PREFIJO_CANCELADA)) return err('INVALID_STATE', 'la operación está cancelada: no hay nada que revertir', 409);
  if (op.estado !== 'completada') return err('INVALID_STATE', `solo se revierte una operación completada (está en ${op.estado}); si sigue abierta, deshacela`, 409);
  const motivo = String(input.motivo ?? '').trim();
  if (!motivo) return err('INVALID_INPUT', 'motivo obligatorio para revertir', 422);
  const skuAnterior = String(op.sku_anterior ?? '').trim();
  if (!skuAnterior) return err('INVALID_INPUT', 'la operación no tenía SKU anterior: no hay adónde volver', 422);
  const producto = db.prepare("SELECT * FROM productos_fusion WHERE fusion_sku=? AND estado='activo'").get(skuAnterior);
  if (!producto) return err('INVALID_INPUT', `no hay producto Fusion activo para el SKU anterior ${skuAnterior}`, 422);
  const caso = obtenerCaso(db, op.caso_id);
  if (!caso) return err('NOT_FOUND', 'caso no encontrado', 404);

  const r = decidirCasoIdentidad(db, caso.id, { ...input, tipo: 'vincular', product_id: producto.id, motivo, operation_id: operationId }, actor);
  if (!r.ok) return r;
  if (!r.repetido) {
    registrarHistorial(db, 'caso', caso.id, 'vinculo_revertido', actor,
      { operacion_id: op.id, sku_anterior: skuAnterior, motivo }, ahora());
  }
  return { ...r, revierte_operacion_id: op.id };
}

/** Deshacer un Saltear: saca el caso de "salteado" sin operación remota. Vale para cualquier operador. */
export function deshacerSalteo(db, casoId, input = {}, actor) {
  const caso = obtenerCaso(db, casoId);
  if (!caso) return err('NOT_FOUND', 'caso no encontrado', 404);
  if (!salteoVigente(db, caso)) return err('INVALID_STATE', 'el caso no está salteado', 409);
  if (Number(input.expected_version) !== caso.expected_version) return err('VERSION_CONFLICT', 'El caso cambió; refrescá antes de deshacer', 409);
  registrarHistorial(db, 'caso', caso.id, 'salteo_deshecho', actor, { expected_version: caso.expected_version }, ahora());
  return { ok: true, caso_id: caso.id };
}

/**
 * "Ninguno sirve" (tecla x): reemplaza "No es ninguno" y "No existe" de la Bandeja vieja. Guarda la decisión en el
 * historial del caso (identidad_historial, con operation_id en identidad_comandos) y saca el caso de la cola mientras
 * `evidence_fingerprint` no cambie. Sin operación remota. identidad_decisiones no se usa: su CHECK de `tipo` no
 * admite un tipo nuevo y reconstruir la tabla no se justifica (ver informe Fase D).
 */
export function ningunoSirve(db, casoId, input = {}, actor) {
  const operationId = operationIdDe(input);
  if (!operationId) return err('INVALID_INPUT', 'operation_id requerido', 422);
  const repetido = comandoRepetido(db, operationId);
  if (repetido) return { ...repetido, repetido: true };
  const motivo = String(input.motivo ?? '').trim();
  if (!MOTIVOS_NINGUNO.includes(motivo)) return err('INVALID_INPUT', 'motivo inválido: no_es_ninguno o no_existe_en_woo', 422);
  const nota = String(input.nota ?? '').trim();
  if (nota.length > NOTA_MAX) return err('INVALID_INPUT', `la nota supera ${NOTA_MAX} caracteres`, 422);
  const caso = obtenerCaso(db, casoId);
  if (!caso) return err('NOT_FOUND', 'caso no encontrado', 404);
  if (CERRADOS.includes(caso.estado)) return err('INVALID_STATE', 'el caso ya está cerrado', 409);
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };
  if (ningunoVigente(db, caso)) return err('INVALID_STATE', 'el caso ya está marcado como "ninguno sirve" para esta evidencia', 409);
  const ts = ahora();
  return db.transaction(() => {
    registrarHistorial(db, 'caso', caso.id, 'ninguno_sirve', actor,
      { motivo, nota: nota || null, evidence_fingerprint: caso.evidencia_fingerprint, operation_id: operationId }, ts);
    const resultado = { ok: true, caso_id: caso.id, motivo, nota: nota || null };
    guardarComando(db, operationId, 'ninguno_sirve', 'caso', caso.id, resultado, actor, ts);
    return resultado;
  })();
}

/** Deshacer "ninguno sirve" (tecla z): el caso vuelve a la cola. Sin operación remota. */
export function deshacerNingunoSirve(db, casoId, input = {}, actor) {
  const operationId = operationIdDe(input);
  if (!operationId) return err('INVALID_INPUT', 'operation_id requerido', 422);
  const repetido = comandoRepetido(db, operationId);
  if (repetido) return { ...repetido, repetido: true };
  const caso = obtenerCaso(db, casoId);
  if (!caso) return err('NOT_FOUND', 'caso no encontrado', 404);
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };
  if (!ningunoVigente(db, caso)) return err('INVALID_STATE', 'no hay "ninguno sirve" vigente para deshacer', 409);
  const ts = ahora();
  return db.transaction(() => {
    registrarHistorial(db, 'caso', caso.id, 'ninguno_sirve_deshecho', actor,
      { evidence_fingerprint: caso.evidencia_fingerprint, operation_id: operationId }, ts);
    const resultado = { ok: true, caso_id: caso.id };
    guardarComando(db, operationId, 'ninguno_sirve_deshecho', 'caso', caso.id, resultado, actor, ts);
    return resultado;
  })();
}

/** Excepción "solo ML" con vencimiento (la pantalla vieja la pedía en Pendientes). Motivo y vencimiento obligatorios. */
export function excepcionSoloMl(db, casoId, input = {}, actor) {
  const caso = obtenerCaso(db, casoId);
  if (!caso) return err('NOT_FOUND', 'caso no encontrado', 404);
  // Un reintento con el mismo operation_id ya fue guardado (el caso quedó exceptuado): se responde como repetido.
  const yaGuardada = db.prepare('SELECT 1 FROM identidad_decisiones WHERE operation_id=?').get(operationIdDe(input));
  if (!yaGuardada && CERRADOS.includes(caso.estado)) return err('INVALID_STATE', 'el caso ya está cerrado', 409);
  if (!String(input.motivo ?? '').trim()) return err('INVALID_INPUT', 'motivo obligatorio', 422);
  if (!String(input.expires_at ?? '').trim()) return err('INVALID_INPUT', 'vencimiento obligatorio (fecha ISO futura)', 422);
  return decidirCasoIdentidad(db, casoId, { ...input, tipo: 'solo_ml', motivo: String(input.motivo).trim() }, actor);
}

/**
 * Reabrir un caso cerrado (filtro "Cerrados" de la cola). Revierte lo que lo cierra: la excepción solo_ml vigente
 * (se invalida: activa=0, invalidada_en) y/o el "ninguno sirve" vigente (se registra 'ninguno_sirve_deshecho' en el
 * historial, el mismo evento que escribe deshacerNingunoSirve). Si el caso estaba 'exceptuado' vuelve a 'urgente'
 * (mismo estado que deja el barrido al vencer una excepción). Motivo obligatorio; deja 'caso_reabierto' con motivo y actor.
 * Sin operación remota. Idempotente por operation_id (identidad_comandos).
 *
 * Fail-closed: si la excepción vigente pertenece a una marca de "no sincronizar" o "link de pago" (hay una decisión
 * `omitir` para la clave), NO se reabre acá: esas marcas se deshacen en su propia acción, que también mueve el caso.
 * No se inventan tipos nuevos en identidad_decisiones.
 */
export function reabrirCaso(db, casoId, input = {}, actor) {
  const operationId = operationIdDe(input);
  if (!operationId) return err('INVALID_INPUT', 'operation_id requerido', 422);
  const repetido = comandoRepetido(db, operationId);
  if (repetido) return { ...repetido, repetido: true };
  const motivo = String(input.motivo ?? '').trim();
  if (!motivo) return err('INVALID_INPUT', 'motivo obligatorio para reabrir', 422);
  const caso = obtenerCaso(db, casoId);
  if (!caso) return err('NOT_FOUND', 'caso no encontrado', 404);
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };

  const exc = excepcionVigente(db, caso.id) ? db.prepare(`SELECT id FROM identidad_excepciones
    WHERE caso_id=? AND activa=1 AND invalidada_en IS NULL ORDER BY id DESC LIMIT 1`).get(caso.id) : null;
  const nv = ningunoVigente(db, caso);
  if (!exc && !nv) return err('INVALID_STATE', 'el caso no está cerrado: no hay excepción ni "ninguno sirve" vigente', 409);
  const marcaDeClave = caso.ml_key && db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave=? AND accion='omitir'").get(caso.ml_key);
  if (exc && marcaDeClave) return err('INVALID_STATE', 'el cierre es una marca de no sincronizar o link de pago: deshacela desde su acción', 409);

  const ts = ahora();
  return db.transaction(() => {
    const revertidos = [];
    if (exc) {
      db.prepare("UPDATE identidad_excepciones SET activa=0,invalidada_en=?,invalidada_motivo='reabierto manualmente' WHERE id=? AND activa=1")
        .run(ts, exc.id);
      revertidos.push('excepcion');
    }
    if (nv) {
      registrarHistorial(db, 'caso', caso.id, 'ninguno_sirve_deshecho', actor,
        { evidence_fingerprint: caso.evidencia_fingerprint, operation_id: operationId, motivo }, ts);
      revertidos.push('ninguno_sirve');
    }
    const nuevoEstado = caso.estado === 'exceptuado' ? 'urgente' : caso.estado;
    db.prepare('UPDATE identidad_casos SET estado=?,expected_version=expected_version+1,resuelto_en=NULL WHERE id=?').run(nuevoEstado, caso.id);
    registrarHistorial(db, 'caso', caso.id, 'caso_reabierto', actor,
      { motivo, revertidos, excepcion_id: exc?.id ?? null, estado_previo: caso.estado, estado: nuevoEstado, operation_id: operationId }, ts);
    const actual = obtenerCaso(db, caso.id);
    const resultado = { ok: true, caso_id: caso.id, estado: actual.estado, expected_version: actual.expected_version, revertidos, motivo };
    guardarComando(db, operationId, 'reabrir_caso', 'caso', caso.id, resultado, actor, ts);
    return resultado;
  })();
}
