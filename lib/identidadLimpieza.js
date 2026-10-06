// Limpieza de operaciones de identidad que nunca podrían hacer nada.
//
// Una operación `correccion_sku` es un "no-op de SKU" cuando el SKU anterior ya es el objetivo. En
// producción quedaron 15 así (pendientes desde el 12/09, algunas duplicadas sobre la misma clave).
// Es "puro" si además el stock que pide es el que ML ya tiene publicado: no cambia nada en el canal.
//
// Sin SKU anterior (NULL) NO es no-op: es "sin dato". Y una clave con otra operación abierta que sí
// cambia algo queda afuera (la 135 comparte clave con la 128): ese par se decide a mano.
//
// Cancelar acá es un UPDATE a `fallida` con el motivo en `ultimo_error` (identidad_operaciones no
// tiene estado de cancelación; es la misma convención que "cancelada por omitir"). Nada toca ML.

const ESTADOS_ABIERTOS = "('shadow','pendiente')";
const MOTIVO_NOOP = 'cancelada: sku_anterior == sku_objetivo (no-op de SKU)';

const norm = (v) => String(v ?? '').trim();

/**
 * Operaciones abiertas con el SKU ya correcto, con lo que se vio para decidirlo.
 * - Por defecto solo las "puras": el stock que piden es el que ML ya tiene.
 * - `incluirStockObsoleto`: suma las que piden un stock distinto del actual de ML. Ejecutarlas
 *   empujaría un stock viejo (p. ej. pide 4 y ML tiene 2), así que cancelarlas es más seguro que
 *   correrlas, pero es una decisión aparte y por eso no es el valor por defecto.
 * - Nunca entra una clave que tenga otra operación abierta que NO sea no-op (p. ej. la 135 comparte
 *   clave con la 128, que cambia de SKU): el par se decide junto, a mano.
 */
export function buscarOperacionesNoOpIdentidad(db, { incluirStockObsoleto = false } = {}) {
  const filas = db.prepare(`SELECT o.id, o.ml_key, o.estado, o.sku_anterior, o.sku_objetivo, o.stock_objetivo,
      m.available_quantity AS stock_ml
    FROM identidad_operaciones o LEFT JOIN ml_publicaciones_cache m ON m.clave = o.ml_key
    WHERE o.tipo='correccion_sku' AND o.estado IN ${ESTADOS_ABIERTOS} ORDER BY o.id`).all();
  const skuIgual = (f) => norm(f.sku_anterior) !== '' && norm(f.sku_anterior) === norm(f.sku_objetivo);
  const clavesConCambioReal = new Set(filas.filter((f) => !skuIgual(f)).map((f) => f.ml_key));
  return filas
    .filter((f) => skuIgual(f) && !clavesConCambioReal.has(f.ml_key))
    .map((f) => ({ ...f, stock_obsoleto: f.stock_ml === null || Number(f.stock_ml) !== Number(f.stock_objetivo) }))
    .filter((f) => incluirStockObsoleto || !f.stock_obsoleto);
}

/**
 * Cancela (o solo simula) los no-op puros. `simular` es true por defecto: hay que pedir
 * explícitamente `simular: false`. Cada cancelación queda en `identidad_historial`.
 */
export function cancelarOperacionesNoOpIdentidad(db, { simular = true, incluirStockObsoleto = false, actor = 'script:cancelar-noop', ahora = new Date() } = {}) {
  const candidatas = buscarOperacionesNoOpIdentidad(db, { incluirStockObsoleto });
  if (simular) return { simulado: true, cancelaria: candidatas.map((c) => c.id), candidatas, canceladas: [] };
  const ts = ahora.toISOString();
  const canceladas = [];
  db.transaction(() => {
    for (const c of candidatas) {
      // Re-chequeo del estado en el UPDATE: si el worker la tomó entre la lectura y acá, no se pisa.
      const r = db.prepare(`UPDATE identidad_operaciones SET estado='fallida', claim_hasta=NULL, ultimo_error=?, actualizada_en=?
        WHERE id=? AND estado IN ${ESTADOS_ABIERTOS}`).run(MOTIVO_NOOP, ts, c.id);
      if (r.changes === 0) continue;
      db.prepare(`INSERT INTO identidad_historial (entidad_tipo,entidad_id,evento,actor,detalle_json,creado_en)
        VALUES ('operacion',?,'operacion_noop_cancelada',?,?,?)`)
        .run(c.id, actor, JSON.stringify({ ml_key: c.ml_key, sku: c.sku_objetivo, stock: c.stock_objetivo, stock_ml: c.stock_ml, stock_obsoleto: c.stock_obsoleto, motivo: MOTIVO_NOOP }), ts);
      canceladas.push(c.id);
    }
  })();
  return { simulado: false, cancelaria: [], candidatas, canceladas };
}

const ESTADOS_CANCELABLES = "('shadow','pendiente','bloqueada_impacto')";

/**
 * Cancelación explícita por id (la decisión de qué cancelar la toma una persona, no una regla).
 * Mismas garantías que el no-op: simula por defecto, deja historial, y el UPDATE re-chequea el
 * estado para no pisar una operación que el worker ya tomó. Solo cancela operaciones abiertas
 * (shadow, pendiente o bloqueada_impacto): una completada, fallida o en curso se reporta como
 * `omitidas` con el motivo y no se toca.
 */
export function cancelarOperacionesIdentidadPorIds(db, { ids, motivo, simular = true, actor = 'script:cancelar-ids', ahora = new Date() } = {}) {
  const lista = [...new Set((ids ?? []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (lista.length === 0) throw new Error('ids requeridos');
  const texto = norm(motivo) || 'cancelada por decisión explícita';
  const ts = ahora.toISOString();
  const aCancelar = [];
  const omitidas = [];
  for (const id of lista) {
    const o = db.prepare('SELECT id, tipo, estado, ml_key, sku_anterior, sku_objetivo, stock_objetivo FROM identidad_operaciones WHERE id=?').get(id);
    if (!o) omitidas.push({ id, motivo: 'no existe' });
    else if (!['shadow', 'pendiente', 'bloqueada_impacto'].includes(o.estado)) omitidas.push({ id, motivo: `estado ${o.estado}: no se toca` });
    else aCancelar.push(o);
  }
  if (simular) return { simulado: true, cancelaria: aCancelar.map((o) => o.id), operaciones: aCancelar, canceladas: [], omitidas };
  const canceladas = [];
  db.transaction(() => {
    for (const o of aCancelar) {
      const r = db.prepare(`UPDATE identidad_operaciones SET estado='fallida', claim_hasta=NULL, ultimo_error=?, actualizada_en=?
        WHERE id=? AND estado IN ${ESTADOS_CANCELABLES}`).run(`cancelada: ${texto}`, ts, o.id);
      if (r.changes === 0) { omitidas.push({ id: o.id, motivo: 'cambió de estado mientras tanto' }); continue; }
      db.prepare(`INSERT INTO identidad_historial (entidad_tipo,entidad_id,evento,actor,detalle_json,creado_en)
        VALUES ('operacion',?,'operacion_cancelada_explicita',?,?,?)`)
        .run(o.id, actor, JSON.stringify({ ml_key: o.ml_key, sku_anterior: o.sku_anterior, sku_objetivo: o.sku_objetivo, estado_previo: o.estado, motivo: texto }), ts);
      canceladas.push(o.id);
    }
  })();
  return { simulado: false, cancelaria: [], operaciones: aCancelar, canceladas, omitidas };
}
