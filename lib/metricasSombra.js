/**
 * E1 T3 C8 — métricas y alertas de la sombra del lado del legado.
 *
 * Viven acá, sobre SQLite, porque son las que tienen que funcionar con PostgreSQL caído: recibos, cola,
 * descartes y pérdidas pendientes de importar. Sin PII: conteos, razones y latencias. Las alertas se
 * publican como incidentes operativos (`lib/incidentes.js`, integración `sombra`), que ya notifican y se
 * cierran solos cuando el ciclo vuelve a estar sano.
 */
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

const SOP = 'docs/superpowers/specs/e1/sop-sombra.md';
export const UMBRALES_LEGADO = Object.freeze({
  COLA_SATURADA: 0.75,
  COLA_SATURADA_MS: 5 * 60 * 1000,
  PERDIDA_SIN_IMPORTAR_MS: 60 * 60 * 1000,
});

function percentil(valores, p) {
  if (!valores.length) return null;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.ceil((p / 100) * orden.length) - 1)];
}

export function medirSombraLegado(db, { cola = null, ahoraMs = Date.now() } = {}) {
  const hace24 = new Date(ahoraMs - 24 * 3600_000).toISOString();
  const hace1 = new Date(ahoraMs - 3600_000).toISOString();
  const porEstado = Object.fromEntries(db.prepare(`SELECT shadow_status s, COUNT(*) n FROM integration_events
    WHERE shadow_status IS NOT NULL AND received_at >= ? GROUP BY shadow_status`).all(hace24).map((f) => [f.s, f.n]));
  const porRazon = Object.fromEntries(db.prepare(`SELECT shadow_reason r, COUNT(*) n FROM integration_events
    WHERE shadow_reason IS NOT NULL AND received_at >= ? GROUP BY shadow_reason`).all(hace24).map((f) => [f.r, f.n]));
  const ultimaHora = Object.fromEntries(db.prepare(`SELECT shadow_reason r, COUNT(*) n FROM integration_events
    WHERE shadow_reason IS NOT NULL AND received_at >= ? GROUP BY shadow_reason`).all(hace1).map((f) => [f.r, f.n]));
  const latencias = db.prepare(`SELECT ack_at, completed_at FROM integration_events
    WHERE shadow_status = 'copied' AND ack_at IS NOT NULL AND completed_at IS NOT NULL AND received_at >= ?`).all(hace24)
    .map((f) => Date.parse(f.completed_at) - Date.parse(f.ack_at)).filter((ms) => Number.isFinite(ms) && ms >= 0);
  const perdidas = db.prepare(`SELECT COUNT(*) n, MIN(completed_at) mas_vieja FROM integration_events
    WHERE shadow_status = 'discarded' AND shadow_reason IN ('platform_unavailable','platform_timeout','cuenta_no_configurada')
      AND shadow_imported_at IS NULL`).get();
  let wooCaidos = 0;
  try {
    wooCaidos = db.prepare("SELECT COUNT(*) n FROM woo_webhooks_estado WHERE propio = 1 AND status <> 'active'").get().n;
  } catch { /* tabla ausente en una base vieja: no es una alerta de sombra */ }
  return {
    medido_en: new Date(ahoraMs).toISOString(),
    ultimas_24h: { por_estado: porEstado, por_razon: porRazon, latencia_copia_p95_ms: percentil(latencias, 95) },
    ultima_hora: { por_razon: ultimaHora },
    perdidas_sin_importar: { cantidad: perdidas.n, mas_vieja_s: perdidas.mas_vieja ? Math.round((ahoraMs - Date.parse(perdidas.mas_vieja)) / 1000) : 0 },
    cola: cola ? cola.estado() : null,
    webhooks_woo_caidos: wooCaidos,
  };
}

/** Muestreo de ocupación de la cola: "saturada" sólo si TODAS las muestras de los últimos 5 min superan el 75 %. */
export function crearMuestreoCola(cola, { ventanaMs = UMBRALES_LEGADO.COLA_SATURADA_MS } = {}) {
  const muestras = [];
  return {
    registrar(ahoraMs = Date.now()) {
      const e = cola.estado();
      muestras.push({ en: ahoraMs, ocupacion: e.capacidad ? e.profundidad / e.capacidad : 0 });
      while (muestras.length && muestras[0].en < ahoraMs - 2 * ventanaMs) muestras.shift();
    },
    saturadaSostenida(ahoraMs = Date.now()) {
      const recientes = muestras.filter((m) => m.en >= ahoraMs - ventanaMs);
      const cubre = muestras.some((m) => m.en <= ahoraMs - ventanaMs + 30_000);
      return cubre && recientes.length > 0 && recientes.every((m) => m.ocupacion > UMBRALES_LEGADO.COLA_SATURADA);
    },
  };
}

export const ALERTAS_LEGADO = Object.freeze(['cola_saturada', 'cola_llena', 'webhook_woo_inactivo', 'perdidas_sin_importar', 'respuesta_no_terminada']);

export function evaluarAlertasLegado(m, { colaSaturadaSostenida = false } = {}) {
  const alertas = [];
  const si = (cond, a) => { if (cond) alertas.push(a); };
  si(colaSaturadaSostenida, { id: 'cola_saturada', severidad: 'advertencia', responsable: 'operaciones',
    umbral: 'cola > 75 % durante 5 min', valor: m.cola?.profundidad ?? 0, runbook: `${SOP}#cola` });
  si((m.ultima_hora.por_razon.queue_full ?? 0) > 0, { id: 'cola_llena', severidad: 'advertencia', responsable: 'operaciones',
    umbral: 'queue_full > 0 en la última hora', valor: m.ultima_hora.por_razon.queue_full, runbook: `${SOP}#cola` });
  si(m.webhooks_woo_caidos > 0, { id: 'webhook_woo_inactivo', severidad: 'critico', responsable: 'operaciones',
    umbral: 'webhook propio de Woo no activo', valor: m.webhooks_woo_caidos, runbook: `${SOP}#webhook-woo-desactivado` });
  si(m.perdidas_sin_importar.cantidad > 0 && m.perdidas_sin_importar.mas_vieja_s * 1000 > UMBRALES_LEGADO.PERDIDA_SIN_IMPORTAR_MS, {
    id: 'perdidas_sin_importar', severidad: 'critico', responsable: 'operaciones',
    umbral: 'pérdida sin importar hace más de 1 h', valor: m.perdidas_sin_importar.cantidad, runbook: `${SOP}#pg-caido` });
  si((m.ultima_hora.por_razon.response_not_finished ?? 0) > 0, { id: 'respuesta_no_terminada', severidad: 'advertencia', responsable: 'desarrollo',
    umbral: 'respuesta de webhook cortada > 0 en la última hora', valor: m.ultima_hora.por_razon.response_not_finished, runbook: `${SOP}#respuesta-cortada` });
  return alertas;
}

/** Abre o actualiza el incidente de cada alerta activa y cierra las que ya no lo están. Fail-open. */
export function publicarAlertasLegado(db, alertas) {
  const activas = new Set(alertas.map((a) => a.id));
  for (const a of alertas) {
    abrirOActualizarIncidente(db, {
      integracion: 'sombra', proceso: 'copia', tipoError: a.id, severidad: a.severidad,
      mensajeHumano: `Sombra: ${a.umbral}. Ver ${a.runbook}.`,
      contexto: { valor: a.valor, responsable: a.responsable },
    });
  }
  for (const id of ALERTAS_LEGADO) {
    if (!activas.has(id)) confirmarCicloSano(db, { integracion: 'sombra', proceso: 'copia', tipoError: id });
  }
}
