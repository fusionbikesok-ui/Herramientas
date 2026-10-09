import { marcarClaveNoSincroniza } from './identidadProductos.js';
import { partirClaveMl } from './mlUtil.js';
import { registrarPausaMl } from './pausasMl.js';

/**
 * "No sincronizar" variante (b): marca la clave y pausa la publicación COMPLETA en ML con una operación durable
 * (`identidad_pausas`, migración 124). Es de un solo paso, pero se verifica releyendo: la pausa no se da por hecha
 * hasta que ML la muestra. Respeta los frenos de la saga de Identidad (modo, escrituras habilitadas, canario, lote).
 */
const MAX_INTENTOS = 5;
const CLAIM_MS = 2 * 60 * 1000;

const now = () => new Date().toISOString();
const invalido = (error) => ({ ok: false, code: 'INVALID_INPUT', status: 422, error });
const escrituras = (cfg) => cfg?.modo === 'enforced' && Number(cfg?.escrituras_remotas_habilitadas) === 1;

/** Cuántas otras variaciones activas del mismo ítem quedan pausadas junto con esta. */
export function hermanasActivas(db, clave) {
  const { itemId } = partirClaveMl(clave);
  return db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE item_id=? AND clave<>? AND status='active'").get(itemId, clave).n;
}

export function solicitarNoSincronizarPausa(db, { clave, motivo, actor, operation_id: operationId, confirm_sibling_impact: confirmado,
  expectedSku, expectedSkuProvided } = {}) {
  const opId = String(operationId || '').trim();
  if (!opId) return invalido('operation_id requerido');
  if (!String(motivo || '').trim()) return invalido('motivo requerido');
  const previa = db.prepare('SELECT * FROM identidad_pausas WHERE operation_id=?').get(opId);
  if (previa) return { ok: true, repetido: true, pausa: previa };
  const pub = db.prepare('SELECT item_id FROM ml_publicaciones_cache WHERE clave=?').get(clave);
  if (!pub) return { ok: false, code: 'NOT_FOUND', status: 404, error: 'clave no encontrada' };
  const hermanas = hermanasActivas(db, clave);
  if (hermanas > 0 && confirmado !== true) {
    return { ok: false, code: 'SIBLING_IMPACT_CONFIRMATION_REQUIRED', status: 409, sibling_count: hermanas,
      error: 'Pausar la publicación afecta a las otras variaciones activas del ítem' };
  }
  const cfg = db.prepare('SELECT * FROM identidad_config WHERE id=1').get();
  const estado = escrituras(cfg) ? 'pendiente' : 'shadow';
  const ts = now();
  let marca;
  const pausa = db.transaction(() => {
    marca = marcarClaveNoSincroniza(db, { clave, actor, expectedSku, expectedSkuProvided, origen: 'no_sincronizar_b' });
    if (!marca.ok) return null;
    const r = db.prepare(`INSERT INTO identidad_pausas
      (operation_id,ml_key,item_id,motivo,estado,impacto_hermanas,impacto_confirmado,proximo_intento_en,creada_por,creada_en,actualizada_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(opId, clave, pub.item_id, String(motivo).trim(), estado, hermanas, hermanas > 0 ? 1 : 0, ts, actor, ts, ts);
    db.prepare(`INSERT INTO identidad_historial (entidad_tipo,entidad_id,evento,actor,detalle_json,creado_en)
      VALUES ('clave',NULL,'no_sincronizar',?,?,?)`).run(actor || null,
      JSON.stringify({ clave, variante: 'b', motivo: String(motivo).trim(), sku_anterior: marca.sku_anterior, hermanas, pausa_id: r.lastInsertRowid }), ts);
    return db.prepare('SELECT * FROM identidad_pausas WHERE id=?').get(r.lastInsertRowid);
  })();
  if (!pausa) return marca;
  return { ok: true, clave, variante: 'b', pausa, hermanas };
}

/** Cancela la pausa si todavía no empezó. Lo usa `deshacerNoSincronizar`; devuelve false si ya no se puede. */
export function cancelarPausaSiNoEmpezo(db, clave) {
  const p = db.prepare('SELECT id,estado FROM identidad_pausas WHERE ml_key=? ORDER BY id DESC LIMIT 1').get(clave);
  if (!p) return true;
  if (!['shadow', 'pendiente'].includes(p.estado)) return !['procesando', 'completada', 'fallida'].includes(p.estado);
  return db.prepare("UPDATE identidad_pausas SET estado='cancelada',ultimo_error='deshecha por una persona',actualizada_en=? WHERE id=? AND estado IN ('shadow','pendiente')")
    .run(now(), p.id).changes > 0;
}

export function listarPausasIdentidad(db) {
  return db.prepare('SELECT * FROM identidad_pausas ORDER BY id DESC LIMIT 200').all();
}

/** Worker: lo agenda server.js junto con el de la saga. Fail-closed igual que ella. */
export async function procesarPausasIdentidad(db, adapter, { ahora = new Date() } = {}) {
  const cfg = db.prepare('SELECT * FROM identidad_config WHERE id=1').get();
  if (!escrituras(cfg)) return { ok: true, omitido: 'escrituras_remotas_deshabilitadas', modo: cfg?.modo ?? null, procesadas: 0 };
  if (!adapter) return { ok: false, code: 'SIN_ADAPTADOR', procesadas: 0 };
  const canarios = [...new Set(String(cfg.canario_ml_key || '').split(',').map((k) => k.trim()).filter(Boolean))].slice(0, 2);
  const tope = Math.max(1, Math.min(2, Number(cfg.lote_max) || 1));
  const iso = ahora.toISOString();
  const filas = db.prepare(`SELECT * FROM identidad_pausas
    WHERE estado IN ('pendiente','procesando')
      ${canarios.length ? `AND ml_key IN (${canarios.map(() => '?').join(',')})` : ''}
      AND (proximo_intento_en IS NULL OR proximo_intento_en<=?)
      AND (claim_hasta IS NULL OR claim_hasta<=?)
    ORDER BY id LIMIT ?`).all(...canarios, iso, iso, tope);
  const resultados = [];
  for (const fila of filas) {
    const tomada = db.prepare(`UPDATE identidad_pausas SET estado='procesando',claim_hasta=?,actualizada_en=?
      WHERE id=? AND estado IN ('pendiente','procesando') AND (claim_hasta IS NULL OR claim_hasta<=?)`)
      .run(new Date(ahora.getTime() + CLAIM_MS).toISOString(), iso, fila.id, iso).changes;
    if (!tomada) continue;
    try {
      // La marca puede haberse deshecho entre el encolado y ahora: sin marca no se pausa.
      if (!db.prepare("SELECT 1 FROM sku_matcher_decisiones WHERE clave=? AND accion='omitir' AND origen='no_sincronizar_b'").get(fila.ml_key)) {
        db.prepare("UPDATE identidad_pausas SET estado='cancelada',claim_hasta=NULL,ultimo_error='la marca ya no existe',actualizada_en=? WHERE id=?").run(now(), fila.id);
        resultados.push({ id: fila.id, ok: false, cancelada: true });
        continue;
      }
      await adapter.pausarItem(fila.item_id);
      const lectura = await adapter.estadoItem(fila.item_id);
      if (lectura?.status !== 'paused') throw new Error(`ML no muestra la pausa (status ${lectura?.status ?? 'desconocido'})`);
      const ts = now();
      const cerrada = db.transaction(() => {
        const r = db.prepare("UPDATE identidad_pausas SET estado='completada',claim_hasta=NULL,ultimo_error=NULL,completada_en=?,actualizada_en=? WHERE id=? AND estado='procesando'").run(ts, ts, fila.id);
        if (!r.changes) return false;
        db.prepare("UPDATE ml_publicaciones_cache SET status='paused' WHERE item_id=?").run(fila.item_id);
        registrarPausaMl(db, { itemId: fila.item_id, actor: fila.creada_por, origen: 'identidad_no_sincronizar', detalle: fila.motivo });
        return true;
      })();
      resultados.push({ id: fila.id, ok: cerrada });
    } catch (e) {
      const intentos = fila.intentos + 1;
      const agotada = intentos >= MAX_INTENTOS;
      db.prepare(`UPDATE identidad_pausas SET estado=?,intentos=?,ultimo_error=?,claim_hasta=NULL,proximo_intento_en=?,actualizada_en=?
        WHERE id=? AND estado='procesando'`).run(agotada ? 'fallida' : 'pendiente', intentos, String(e.message).slice(0, 300),
        new Date(ahora.getTime() + intentos * 60 * 1000).toISOString(), now(), fila.id);
      resultados.push({ id: fila.id, ok: false, error: e.message });
    }
  }
  return { ok: true, canario: canarios, tope, procesadas: resultados.length, resultados };
}
