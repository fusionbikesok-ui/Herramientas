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
      db.prepare(`INSERT INTO trabajos_recurso (tipo, recurso, estado, generacion, run_after, creado_en, actualizado_en)
        VALUES (?, ?, 'pendiente', 1, ?, ?, ?)`).run(tipo, recurso, runAfter, ts, ts);
      return { creado: true };
    }
    if (f.estado === 'tomado') {
      db.prepare('UPDATE trabajos_recurso SET generacion = generacion + 1, dirty = 1, actualizado_en = ? WHERE tipo = ? AND recurso = ?').run(ts, tipo, recurso);
      return { dirty: true };
    }
    // pendiente → reprograma (se queda con la fecha más próxima si no hay demora); hecho/muerto → reabre.
    db.prepare(`UPDATE trabajos_recurso SET estado = 'pendiente', generacion = generacion + 1, dirty = 0, run_after = ?,
      intentos = CASE WHEN estado = 'pendiente' THEN intentos ELSE 0 END,
      diferidos = CASE WHEN estado = 'pendiente' THEN diferidos ELSE 0 END,
      diferido_desde = CASE WHEN estado = 'pendiente' THEN diferido_desde ELSE NULL END,
      contexto_json = CASE WHEN estado = 'pendiente' THEN contexto_json ELSE NULL END,
      ultimo_error = NULL, cerrado_en = NULL, actualizado_en = ?
      WHERE tipo = ? AND recurso = ?`).run(runAfter, ts, tipo, recurso);
    return { reprogramado: true };
  })();
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

/** Cierra como hecho SOLO si el token sigue vigente; si llegó un aviso mientras tanto (generación nueva), se repite. */
export function cerrarTrabajo(db, trabajo) {
  const ts = ahora();
  return db.transaction(() => {
    const actual = db.prepare('SELECT * FROM trabajos_recurso WHERE tipo = ? AND recurso = ? AND lease_token = ?').get(trabajo.tipo, trabajo.recurso, trabajo.lease_token);
    if (!actual) return { cerrado: false, motivo: 'lease_perdido' };
    if (actual.dirty || actual.generacion !== trabajo.generacion_tomada) {
      db.prepare(`UPDATE trabajos_recurso SET estado = 'pendiente', dirty = 0, run_after = ?, lease_hasta = NULL, lease_token = NULL, intentos = 0, diferidos = 0, diferido_desde = NULL, actualizado_en = ?
        WHERE tipo = ? AND recurso = ?`).run(ts, ts, trabajo.tipo, trabajo.recurso);
      return { cerrado: false, motivo: 'repite_por_aviso_nuevo' };
    }
    db.prepare(`UPDATE trabajos_recurso SET estado = 'hecho', lease_hasta = NULL, lease_token = NULL, ultimo_error = NULL, diferidos = 0, diferido_desde = NULL, cerrado_en = ?, actualizado_en = ?
      WHERE tipo = ? AND recurso = ?`).run(ts, ts, trabajo.tipo, trabajo.recurso);
    return { cerrado: true };
  })();
}

/** Resultado incierto, omitido, 429, barrera…: vuelve a pendiente con backoff; nunca se cierra como hecho. */
export function reencolarTrabajo(db, trabajo, { demoraMs = null, motivo = 'reintento' } = {}) {
  const ts = ahora();
  const espera = demoraMs ?? Math.min(10 * 60 * 1000, 5000 * 2 ** Math.max(0, trabajo.intentos - 1));
  return db.transaction(() => {
    const actual = db.prepare('SELECT dirty, generacion FROM trabajos_recurso WHERE tipo = ? AND recurso = ? AND lease_token = ?').get(trabajo.tipo, trabajo.recurso, trabajo.lease_token);
    if (!actual) return { muerto: false, lease_perdido: true };
    // Llegó un aviso nuevo (generación distinta o dirty) durante el intento: el fallo es de una generación vieja. Nunca se mata:
    // se reprograma ya, con los contadores de la generación nueva, para que se relea la orden.
    if (actual.dirty || actual.generacion !== trabajo.generacion_tomada) {
      db.prepare(`UPDATE trabajos_recurso SET estado = 'pendiente', run_after = ?, lease_hasta = NULL, lease_token = NULL, intentos = 0, diferidos = 0, diferido_desde = NULL,
        ultimo_error = ?, dirty = 0, actualizado_en = ? WHERE tipo = ? AND recurso = ?`).run(ts, String(motivo).slice(0, 300), ts, trabajo.tipo, trabajo.recurso);
      return { muerto: false, repite_por_aviso_nuevo: true };
    }
    const muerto = trabajo.intentos >= MAX_INTENTOS_TRABAJO;
    db.prepare(`UPDATE trabajos_recurso SET estado = ?, run_after = ?, lease_hasta = NULL, lease_token = NULL, ultimo_error = ?, dirty = 0, actualizado_en = ?
      WHERE tipo = ? AND recurso = ? AND lease_token = ?`)
      .run(muerto ? 'muerto' : 'pendiente', new Date(Date.now() + espera).toISOString(), String(motivo).slice(0, 300), ts, trabajo.tipo, trabajo.recurso, trabajo.lease_token);
    return { muerto };
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

/** Trabajos sin cerrar hace más de `minutos` (alerta "trabajos no terminados" de la spec). */
export function trabajosAtascados(db, minutos = 15) {
  const corte = new Date(Date.now() - minutos * 60 * 1000).toISOString();
  return db.prepare("SELECT tipo, recurso, estado, intentos, ultimo_error, actualizado_en FROM trabajos_recurso WHERE (estado IN ('pendiente','tomado') AND creado_en < ? AND run_after < ?) OR estado = 'muerto'").all(corte, corte);
}
