/**
 * Trabajo durable por recurso (Fase E-1a). Una fila por (tipo, recurso):
 *  - un aviso nuevo SUBE `generacion`; si el trabajo está tomado queda `dirty` y al terminar se repite;
 *  - `run_after` reprograma el pendiente (la coalescencia nunca descarta);
 *  - el trabajo solo pasa a `hecho` cuando el efecto quedó verificado; todo lo demás se reencola con backoff.
 * La relectura del recurso la hace cada manejador: el aviso nunca trae el valor a aplicar.
 */
import crypto from 'node:crypto';

const ahora = () => new Date().toISOString();
export const LEASE_TRABAJO_MS = 5 * 60 * 1000;
export const MAX_INTENTOS_TRABAJO = 12;
export const DIFERIDO_BASE_MS = 30 * 1000;
export const DIFERIDO_TOPE_MS = 10 * 60 * 1000;
export const DIFERIDO_ALERTA_MS = 2 * 60 * 60 * 1000;

/** Encola (o reprograma) el trabajo del recurso. `demoraMs` > 0 coalesce ráfagas sin descartar el aviso. */
export function encolarTrabajo(db, { tipo, recurso, demoraMs = 0 }) {
  const ts = ahora();
  const runAfter = new Date(Date.now() + demoraMs).toISOString();
  return db.transaction(() => {
    const f = db.prepare('SELECT estado FROM trabajos_recurso WHERE tipo = ? AND recurso = ?').get(tipo, recurso);
    if (!f) {
      db.prepare(`INSERT INTO trabajos_recurso (tipo, recurso, estado, generacion, run_after, creado_en, actualizado_en, sin_cerrar_desde)
        VALUES (?, ?, 'pendiente', 1, ?, ?, ?, ?)`).run(tipo, recurso, runAfter, ts, ts, ts);
      return { creado: true };
    }
    if (f.estado === 'tomado') {
      db.prepare('UPDATE trabajos_recurso SET generacion = generacion + 1, dirty = 1, actualizado_en = ? WHERE tipo = ? AND recurso = ?').run(ts, tipo, recurso);
      return { dirty: true };
    }
    // pendiente → reprograma (se queda con la fecha más próxima si no hay demora); hecho/muerto → reabre.
    db.prepare(`UPDATE trabajos_recurso SET estado = 'pendiente', generacion = generacion + 1, dirty = 0,
      run_after = CASE WHEN estado = 'pendiente' AND fallos_consecutivos > 0 THEN max(run_after, ?) ELSE ? END,
      fallos_consecutivos = CASE WHEN estado = 'pendiente' THEN fallos_consecutivos ELSE 0 END,
      primer_fallo_en = CASE WHEN estado = 'pendiente' THEN primer_fallo_en ELSE NULL END,
      intentos = CASE WHEN estado = 'pendiente' THEN intentos ELSE 0 END,
      diferidos = CASE WHEN estado = 'pendiente' THEN diferidos ELSE 0 END,
      diferido_desde = CASE WHEN estado = 'pendiente' THEN diferido_desde ELSE NULL END,
      contexto_json = CASE WHEN estado = 'pendiente' THEN contexto_json ELSE NULL END,
      sin_cerrar_desde = CASE WHEN estado IN ('hecho', 'muerto') THEN ? ELSE COALESCE(sin_cerrar_desde, ?) END,
      ultimo_error = NULL, cerrado_en = NULL, actualizado_en = ?
      WHERE tipo = ? AND recurso = ?`).run(runAfter, runAfter, ts, ts, ts, tipo, recurso);
    return { reprogramado: true };
  })();
}

/**
 * Encola el `catalog.woo_product_sync` de un producto. Una variación se agrupa en su padre: el recurso es el id del padre
 * (el del aviso, o el que el caché conoce para esa variación). Lo llama el recibo del webhook ANTES del ACK.
 */
export function encolarProductoWoo(db, { productoId, parentId = null }) {
  let padre = Number(parentId) || null;
  if (!padre) {
    try { padre = Number(db.prepare('SELECT id_padre FROM catalogo_cache WHERE id_woo = ?').get(Number(productoId))?.id_padre) || null; } catch { /* sin caché: se usa el id del aviso */ }
  }
  return encolarTrabajo(db, { tipo: 'catalog.woo_product_sync', recurso: String(padre || Number(productoId)) });
}

/** Toma hasta `limit` trabajos vencidos de los tipos dados (también los tomados con lease vencido: worker caído). */
export function reclamarTrabajos(db, tipos, { limit = 10, leaseMs = LEASE_TRABAJO_MS } = {}) {
  const ts = ahora();
  const lease = new Date(Date.now() + leaseMs).toISOString();
  return db.transaction(() => {
    const marcas = tipos.map(() => '?').join(',');
    const filas = db.prepare(`SELECT tipo, recurso FROM trabajos_recurso
      WHERE tipo IN (${marcas}) AND ((estado = 'pendiente' AND run_after <= ?) OR (estado = 'tomado' AND lease_hasta <= ?))
      ORDER BY run_after, creado_en LIMIT ?`).all(...tipos, ts, ts, limit);
    const out = [];
    for (const f of filas) {
      const token = crypto.randomUUID();
      db.prepare(`UPDATE trabajos_recurso SET estado = 'tomado', lease_hasta = ?, lease_token = ?, generacion_tomada = generacion,
        dirty = 0, intentos = intentos + 1, actualizado_en = ? WHERE tipo = ? AND recurso = ?`).run(lease, token, ts, f.tipo, f.recurso);
      out.push(db.prepare('SELECT * FROM trabajos_recurso WHERE tipo = ? AND recurso = ?').get(f.tipo, f.recurso));
    }
    return out;
  })();
}

/**
 * `enCierre(db)` (opcional) corre en la MISMA transacción, solo si el cierre como `hecho` procede (token vigente, sin aviso
 * nuevo): lo que se escribe ahí queda atómico con el cierre y condicionado a que la generación tomada siga vigente.
 */
export function cerrarTrabajo(db, trabajo, { enCierre = null } = {}) {
  const ts = ahora();
  return db.transaction(() => {
    const actual = db.prepare('SELECT * FROM trabajos_recurso WHERE tipo = ? AND recurso = ? AND lease_token = ?').get(trabajo.tipo, trabajo.recurso, trabajo.lease_token);
    if (!actual) return { cerrado: false, motivo: 'lease_perdido' };
    if (actual.dirty || actual.generacion !== trabajo.generacion_tomada) {
      db.prepare(`UPDATE trabajos_recurso SET estado = 'pendiente', dirty = 0, run_after = ?, lease_hasta = NULL, lease_token = NULL, intentos = 0, diferidos = 0, diferido_desde = NULL, fallos_consecutivos = 0, primer_fallo_en = NULL, actualizado_en = ?
        WHERE tipo = ? AND recurso = ?`).run(ts, ts, trabajo.tipo, trabajo.recurso);
      return { cerrado: false, motivo: 'repite_por_aviso_nuevo' };
    }
    db.prepare(`UPDATE trabajos_recurso SET estado = 'hecho', sin_cerrar_desde = NULL, lease_hasta = NULL, lease_token = NULL, ultimo_error = NULL, diferidos = 0, diferido_desde = NULL, fallos_consecutivos = 0, primer_fallo_en = NULL, cerrado_en = ?, actualizado_en = ?
      WHERE tipo = ? AND recurso = ?`).run(ts, ts, trabajo.tipo, trabajo.recurso);
    if (enCierre) enCierre(db);
    return { cerrado: true };
  })();
}

/** Fallos consecutivos (sin éxito de por medio) a partir de los cuales el trabajo es una falla persistente; también si falla >2 h. */
export const FALLOS_PERSISTENTES = 12;
export const FALLA_PERSISTENTE_MS = 2 * 60 * 60 * 1000;

/**
 * Fallo real: vuelve a pendiente con backoff; nunca se cierra como hecho. El contador de fallos NO depende de la generación:
 * un aviso nuevo durante el intento no lo reinicia (solo un éxito), así que una orden que falla siempre no queda en bucle caliente.
 * Con una generación nueva el trabajo no se mata (se relee igual), pero sí hay backoff y, al persistir, `persistente: true`.
 */
export function reencolarTrabajo(db, trabajo, { demoraMs = null, motivo = 'reintento' } = {}) {
  const ts = ahora();
  return db.transaction(() => {
    const actual = db.prepare('SELECT dirty, generacion, fallos_consecutivos, primer_fallo_en FROM trabajos_recurso WHERE tipo = ? AND recurso = ? AND lease_token = ?').get(trabajo.tipo, trabajo.recurso, trabajo.lease_token);
    if (!actual) return { muerto: false, lease_perdido: true };
    const fallos = (actual.fallos_consecutivos || 0) + 1;
    const primer = actual.primer_fallo_en || ts;
    const persistente = fallos >= FALLOS_PERSISTENTES || Date.now() - Date.parse(primer) > FALLA_PERSISTENTE_MS;
    const err = String(motivo).slice(0, 300);
    if (actual.dirty || actual.generacion !== trabajo.generacion_tomada) {
      const espera = demoraMs ?? Math.min(DIFERIDO_TOPE_MS, DIFERIDO_BASE_MS * 2 ** Math.min(fallos - 1, 10));
      db.prepare(`UPDATE trabajos_recurso SET estado = 'pendiente', run_after = ?, lease_hasta = NULL, lease_token = NULL, fallos_consecutivos = ?, primer_fallo_en = ?,
        ultimo_error = ?, dirty = 0, actualizado_en = ? WHERE tipo = ? AND recurso = ?`).run(new Date(Date.now() + espera).toISOString(), fallos, primer, err, ts, trabajo.tipo, trabajo.recurso);
      return { muerto: false, repite_por_aviso_nuevo: true, fallos, persistente };
    }
    const espera = demoraMs ?? Math.min(10 * 60 * 1000, 5000 * 2 ** Math.max(0, trabajo.intentos - 1));
    const muerto = trabajo.intentos >= MAX_INTENTOS_TRABAJO;
    db.prepare(`UPDATE trabajos_recurso SET estado = ?, run_after = ?, lease_hasta = NULL, lease_token = NULL, ultimo_error = ?, dirty = 0, fallos_consecutivos = ?, primer_fallo_en = ?, actualizado_en = ?
      WHERE tipo = ? AND recurso = ? AND lease_token = ?`)
      .run(muerto ? 'muerto' : 'pendiente', new Date(Date.now() + espera).toISOString(), err, fallos, primer, ts, trabajo.tipo, trabajo.recurso, trabajo.lease_token);
    return { muerto, fallos, persistente };
  })();
}

/**
 * Espera legítima (algo está en curso: reserva incierta, barrera, candados…): vuelve a pendiente SIN contar como intento
 * y con backoff creciente (30 s·2^n, tope 10 min). Nunca mata el trabajo; si la espera dura más de `alertaMs` avisa
 * (`alerta: true`) para que el llamador abra un incidente visible.
 */
export function diferirTrabajo(db, trabajo, { motivo = 'diferido', demoraMs = null, alertaMs = DIFERIDO_ALERTA_MS } = {}) {
  const ts = ahora();
  return db.transaction(() => {
    const actual = db.prepare('SELECT diferidos, diferido_desde FROM trabajos_recurso WHERE tipo = ? AND recurso = ? AND lease_token = ?').get(trabajo.tipo, trabajo.recurso, trabajo.lease_token);
    if (!actual) return { lease_perdido: true, alerta: false };
    const espera = Math.min(DIFERIDO_TOPE_MS, Math.max(demoraMs ?? 0, DIFERIDO_BASE_MS * 2 ** Math.min(actual.diferidos, 10)));
    const desde = actual.diferido_desde || ts;
    db.prepare(`UPDATE trabajos_recurso SET estado = 'pendiente', run_after = ?, lease_hasta = NULL, lease_token = NULL, intentos = MAX(0, intentos - 1),
      diferidos = diferidos + 1, diferido_desde = ?, ultimo_error = ?, dirty = 0, actualizado_en = ? WHERE tipo = ? AND recurso = ?`)
      .run(new Date(Date.now() + espera).toISOString(), desde, String(motivo).slice(0, 300), ts, trabajo.tipo, trabajo.recurso);
    return { diferido: true, diferidos: actual.diferidos + 1, desde, alerta: Date.now() - new Date(desde).getTime() > alertaMs };
  })();
}

export function guardarContextoTrabajo(db, tipo, recurso, contexto) {
  db.prepare('UPDATE trabajos_recurso SET contexto_json = ? WHERE tipo = ? AND recurso = ?').run(JSON.stringify(contexto), tipo, recurso);
}

/** ¿Hay un `order.ml` en vuelo que pueda afectar a alguno de estos SKUs? Sin SKUs conocidos solo bloquea mientras no se lo leyó. */
export function ordenMlAfectaASkus(db, skus) {
  const jobs = db.prepare("SELECT estado, intentos, diferidos, contexto_json FROM trabajos_recurso WHERE tipo = 'order.ml' AND estado IN ('pendiente','tomado')").all();
  for (const j of jobs) {
    let conocidos = null;
    try { const c = JSON.parse(j.contexto_json || 'null'); if (Array.isArray(c?.skus)) conocidos = c.skus; } catch { /* sin contexto */ }
    if (conocidos) { if (conocidos.some((x) => skus.includes(x))) return true; continue; }
    if (j.estado === 'tomado' || (j.intentos === 0 && j.diferidos === 0)) return true; // todavía no se leyó la orden: no se sabe qué bolsa toca
  }
  return false;
}

export function hayTrabajoPendiente(db, tipo, { recurso = null } = {}) {
  const base = "SELECT 1 FROM trabajos_recurso WHERE tipo = ? AND estado IN ('pendiente','tomado')";
  return Boolean(recurso ? db.prepare(`${base} AND recurso = ?`).get(tipo, recurso) : db.prepare(base).get(tipo));
}

// ─── E-2: item.project (publicación de ML) ───────────────────────────────────

/** Ventana de coalescencia de avisos de un mismo ítem: dentro de ella el aviso REPROGRAMA el trabajo (run_after), nunca se descarta. */
export const COALESCENCIA_ITEM_MS = 2 * 60 * 1000;

/**
 * Encola (o reprograma) el `item.project` de un ítem de ML. Si su caché se refrescó hace menos de la ventana, el trabajo
 * corre recién al cumplirse (coalesce ráfagas: ML manda ~2,6 avisos por ítem) pero el aviso no se pierde.
 */
export function encolarItemMl(db, itemId, { demoraMs = null } = {}) {
  const id = String(itemId || '').trim();
  if (!id) return null;
  let demora = demoraMs;
  if (demora == null) {
    demora = 0;
    try {
      const ult = db.prepare('SELECT MAX(actualizado_en) ult FROM ml_publicaciones_cache WHERE item_id = ?').get(id)?.ult;
      const edad = ult ? Date.now() - Date.parse(ult) : Infinity;
      if (Number.isFinite(edad) && edad >= 0 && edad < COALESCENCIA_ITEM_MS) demora = COALESCENCIA_ITEM_MS - edad;
    } catch { /* sin caché: corre ya */ }
  }
  return encolarTrabajo(db, { tipo: 'item.project', recurso: id, demoraMs: demora });
}

/** Un `item.project` por cada ítem del user_product (resueltos desde el caché por user_product_id). Devuelve los item_ids. */
export function encolarItemsDeUserProduct(db, userProductId) {
  const up = String(userProductId || '').trim();
  if (!up) return [];
  const items = db.prepare('SELECT DISTINCT item_id FROM ml_publicaciones_cache WHERE user_product_id = ?').all(up).map((r) => r.item_id);
  for (const id of items) encolarItemMl(db, id);
  return items;
}

/** Trabajos sin cerrar hace más de `minutos` (alerta "trabajos no terminados" de la spec). */
export function trabajosAtascados(db, minutos = 15) {
  const corte = new Date(Date.now() - minutos * 60 * 1000).toISOString();
  return db.prepare("SELECT tipo, recurso, estado, intentos, ultimo_error, actualizado_en FROM trabajos_recurso WHERE (estado IN ('pendiente','tomado') AND COALESCE(sin_cerrar_desde, creado_en) < ?) OR estado = 'muerto'").all(corte);
}
