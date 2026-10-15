/**
 * Fase E-3: control MEDIDO. Tres métricas por separado (spec "Recuperación y medición"):
 *  1) Entregas fallidas: monitor de webhooks de Woo (incidente inmediato) y alerta diaria de `missed_feeds` de ML.
 *  2) Trabajos no terminados: generación sin cerrar > 15 min, o dead-letter (incidente inmediato).
 *  3) Diferencias del barrido: ver `barridoCorridas.js`.
 *
 * Nada de acá escribe en Woo ni en ML. En particular el monitor de webhooks NUNCA reactiva uno caído: reactivarlo sin arreglar
 * la causa lo vuelve a caer, y es una decisión de José.
 */
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

const ahora = () => new Date().toISOString();

/** Webhooks que debemos tener registrados en Woo: [topic, ruta de entrega]. */
export const WEBHOOKS_WOO_ESPERADOS = Object.freeze([
  ['order.created', '/api/woo/webhook/order'], ['order.updated', '/api/woo/webhook/order'],
  ['order.deleted', '/api/woo/webhook/order'], ['order.restored', '/api/woo/webhook/order'],
  ['product.created', '/api/woo/webhook/product'], ['product.updated', '/api/woo/webhook/product'],
  ['product.deleted', '/api/woo/webhook/product'], ['product.restored', '/api/woo/webhook/product'],
]);

const rutaDe = (url) => { try { return new URL(String(url)).pathname.replace(/\/$/, ''); } catch { return String(url || '').replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, ''); } };

/**
 * Evalúa `woo_webhooks_estado` (lo llena `refrescarWebhooksWoo`): propios pausados/deshabilitados o esperados ausentes abren un
 * incidente crítico INMEDIATO; sano cierra el incidente. Solo lee la base: no toca Woo.
 */
export function evaluarWebhooksWoo(db) {
  const propios = db.prepare('SELECT id, topic, status, status_desde, delivery_url FROM woo_webhooks_estado WHERE propio = 1').all();
  const caidos = propios.filter((w) => w.status !== 'active').map((w) => ({ id: w.id, topic: w.topic, status: w.status, desde: w.status_desde }));
  const ausentes = WEBHOOKS_WOO_ESPERADOS
    .filter(([topic, ruta]) => !propios.some((w) => w.topic === topic && rutaDe(w.delivery_url) === ruta))
    .map(([topic, ruta]) => ({ topic, ruta }));
  if (!caidos.length && !ausentes.length) {
    confirmarCicloSano(db, { integracion: 'woocommerce', proceso: 'webhooks', tipoError: 'woo_webhooks_no_activos' });
    return { ok: true, caidos, ausentes };
  }
  const partes = [];
  if (caidos.length) partes.push(`no entregan: ${caidos.map((w) => `#${w.id} ${w.topic} (${w.status})`).join(', ')}`);
  if (ausentes.length) partes.push(`ausentes: ${ausentes.map((w) => w.topic).join(', ')}`);
  abrirOActualizarIncidente(db, {
    integracion: 'woocommerce', proceso: 'webhooks', tipoError: 'woo_webhooks_no_activos', severidad: 'critico',
    mensajeTecnico: `Webhooks de Woo con problemas — ${partes.join('; ')}`,
    mensajeHumano: `Hay webhooks de WooCommerce que no están entregando (${partes.join('; ')}). Los pedidos y productos de la web dejan de llegar. Reactivarlos es manual: revisá la causa en Woo antes.`,
    contexto: { caidos, ausentes },
  });
  return { ok: false, caidos, ausentes };
}

/** Alerta diaria de `missed_feeds`: suma 24 h de rondas. Hay faltantes → advertencia; sin faltantes → se cierra. */
export function alertaMissedFeedsDiaria(db, { ahoraMs = Date.now() } = {}) {
  const desde = new Date(ahoraMs - 24 * 3600 * 1000).toISOString();
  const t = db.prepare(`SELECT COUNT(*) AS rondas, COALESCE(SUM(enumerados), 0) AS enumerados, COALESCE(SUM(nuevos), 0) AS nuevos,
      COALESCE(SUM(duplicados), 0) AS duplicados, COALESCE(SUM(excluidos), 0) AS excluidos, COALESCE(SUM(error IS NOT NULL), 0) AS con_error
    FROM missed_feeds_corridas WHERE fin >= ?`).get(desde);
  const porTopic = db.prepare(`SELECT topic, SUM(nuevos) AS nuevos, SUM(enumerados) AS enumerados FROM missed_feeds_corridas
    WHERE fin >= ? GROUP BY topic HAVING SUM(enumerados) > 0 ORDER BY topic`).all(desde);
  const texto = t.rondas
    ? `ML no pudo entregarnos ${t.enumerados} aviso(s) en 24 h (${t.nuevos} nuevos reinyectados, ${t.duplicados} ya recibidos, ${t.excluidos} excluidos; ${t.rondas} consultas, ${t.con_error} con error)`
    : 'missed_feeds no registró ninguna consulta en las últimas 24 h';
  if (t.nuevos > 0 || !t.rondas) {
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'missed_feeds', tipoError: 'ml_missed_feeds_diario', severidad: 'advertencia',
      mensajeTecnico: texto, mensajeHumano: `${texto}. ${t.nuevos > 0 ? 'Se reinyectaron al flujo normal; si se repite, revisá que el endpoint de avisos responda 200.' : 'Revisá que el cron horario esté corriendo.'}`,
      contexto: { ...t, por_topic: porTopic },
    });
  } else {
    confirmarCicloSano(db, { integracion: 'mercadolibre', proceso: 'missed_feeds', tipoError: 'ml_missed_feeds_diario' });
  }
  return { ...t, por_topic: porTopic };
}

/** tipo_error con que `routes/sync.js` abre los incidentes por trabajo (mantener igual a `tipoErrorTrabajo`). */
const tipoErrorTrabajo = (prefijo, t) => `${prefijo}_${t.tipo}_${t.recurso}`.slice(0, 120);
const PREFIJOS_TRABAJO = ['trabajo_muerto', 'trabajo_diferido_largo', 'trabajo_falla_persistente'];

/**
 * Trabajos no terminados: una generación sin cerrar hace más de `minutos`, o un job en dead-letter, abre UN incidente crítico
 * agregado. No duplica lo que ya cubre el worker: un recurso con incidente activo `trabajo_muerto_*` / `trabajo_falla_persistente_*`
 * / `trabajo_diferido_largo_*` queda fuera.
 */
export function vigilarTrabajosNoTerminados(db, { minutos = 15, ahoraMs = Date.now() } = {}) {
  const corte = new Date(ahoraMs - minutos * 60 * 1000).toISOString();
  const activos = new Set(db.prepare("SELECT tipo_error FROM incidentes_operativos WHERE estado = 'activo' AND proceso = 'trabajos_recurso'").all().map((r) => r.tipo_error));
  const cubierto = (t) => PREFIJOS_TRABAJO.some((p) => activos.has(tipoErrorTrabajo(p, t)));
  const sinCerrar = db.prepare(`SELECT tipo, recurso, estado, intentos, sin_cerrar_desde FROM trabajos_recurso
    WHERE (estado IN ('pendiente', 'tomado') AND sin_cerrar_desde IS NOT NULL AND sin_cerrar_desde < ?) OR estado = 'muerto'
    ORDER BY sin_cerrar_desde`).all(corte).filter((t) => !cubierto(t));
  const desdeDead = new Date(ahoraMs - 24 * 3600 * 1000).toISOString();
  const deadLetters = db.prepare(`SELECT job_type AS tipo, COUNT(*) AS n FROM integration_jobs
    WHERE status = 'dead_lettered' AND available_at >= ? GROUP BY job_type`).all(desdeDead);
  const totalDead = deadLetters.reduce((a, r) => a + r.n, 0);
  const total = sinCerrar.length + totalDead;
  if (!total) {
    confirmarCicloSano(db, { integracion: 'sistema', proceso: 'trabajos_recurso', tipoError: 'trabajos_sin_terminar' });
    return { total: 0, sinCerrar: [], deadLetters };
  }
  const porTipo = {};
  for (const t of sinCerrar) porTipo[t.tipo] = (porTipo[t.tipo] || 0) + 1;
  const muestra = sinCerrar.slice(0, 20).map((t) => ({ tipo: t.tipo, recurso: t.recurso, estado: t.estado, desde: t.sin_cerrar_desde }));
  const detalle = [
    sinCerrar.length ? `${sinCerrar.length} trabajo(s) sin cerrar hace más de ${minutos} min (${Object.entries(porTipo).map(([k, v]) => `${k}: ${v}`).join(', ')})` : null,
    totalDead ? `${totalDead} job(s) en dead-letter en 24 h (${deadLetters.map((r) => `${r.tipo}: ${r.n}`).join(', ')})` : null,
  ].filter(Boolean).join('; ');
  abrirOActualizarIncidente(db, {
    integracion: 'sistema', proceso: 'trabajos_recurso', tipoError: 'trabajos_sin_terminar', severidad: 'critico',
    mensajeTecnico: detalle,
    mensajeHumano: `Hay trabajos sin terminar: ${detalle}. Puede haber ventas o cambios sin reflejar en el otro canal.`,
    contexto: { total, por_tipo: porTipo, dead_letters: deadLetters, muestra, detectado_en: ahora() },
  });
  return { total, sinCerrar, deadLetters };
}
