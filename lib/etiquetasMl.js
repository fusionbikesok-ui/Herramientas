/**
 * Bajar etiquetas de envío de ML para imprimir (spec 2026-10-15-etiquetas-preparacion-design.md, parte B + v3.3, v4.4, v5.4, v6.1).
 * Elegibilidad con datos locales por clave, agrupada por envío (packs), membresía del pack confirmada contra ML (fail-closed),
 * UNA llamada a /shipment_labels con todos los envíos y, solo si ML rechaza el lote, clasificación individual y una llamada final.
 * "Descargada" significa PDF bajado, NO impresa.
 */
import { mlFetch, mlFetchBinario } from './mlClient.js';
import { esEnvioLocal, envioMlYaSalio, tipoLogisticaMl } from './preparacion.js';

export const MAX_CLAVES_ETIQUETAS = 50;
const SUBSTATUS_IMPRIMIBLE = new Set(['ready_to_print', 'printed']);
const ESTADOS_PREP_CERRADOS_SIN_ENVIO = new Set(['cancelada_sin_retiro', 'cancelada_pendiente_devolucion', 'anulado_en_woo']);
// 4xx que significan "este envío no se puede imprimir" (se aísla por envío). 429/5xx/red: ML no disponible, no se clasifica nada.
const RECHAZO_DE_ENVIO = new Set([400, 403, 404, 409, 410, 422]);

/** Estado del envío según datos locales: { motivo|null, impresaEnMl }. `motivo` es el texto corto que ve la UI. */
export function evaluarEnvioMlLocal(db, prep) {
  const g = db.prepare("SELECT estado_comercial, ml_shipment_id FROM gestion_pedidos WHERE fuente='mercadolibre' AND external_id=? LIMIT 1").get(String(prep.ml_order_id || ''));
  if (!g) return { motivo: 'sin datos del pedido', shipmentId: null };
  if (g.estado_comercial !== 'confirmado') return { motivo: 'orden no paga o cancelada', shipmentId: null };
  if (!g.ml_shipment_id) return { motivo: 'sin envío', shipmentId: null };
  const shipmentId = String(g.ml_shipment_id);
  const env = db.prepare('SELECT status, substatus, logistic_type FROM ml_shipment_estado WHERE shipment_id=?').get(shipmentId);
  if (!env) return { motivo: 'envío no listo', shipmentId };
  const logistica = String(tipoLogisticaMl(env) || '');
  if (['fulfillment', 'full'].includes(logistica)) return { motivo: 'Full', shipmentId };
  if (!esEnvioLocal(logistica)) return { motivo: 'logística no admitida', shipmentId };
  if (envioMlYaSalio(env)) return { motivo: 'envío ya salió', shipmentId };
  if (env.status !== 'ready_to_ship' || !SUBSTATUS_IMPRIMIBLE.has(env.substatus)) return { motivo: 'envío no listo', shipmentId };
  return { motivo: null, shipmentId, impresaEnMl: env.substatus === 'printed' };
}

function motivoDeMl(error) {
  if (!error) return 'ML rechazó la etiqueta';
  try { const j = JSON.parse(error); return String(j.error || j.message || 'ML rechazó la etiqueta').slice(0, 120); } catch { return String(error).slice(0, 120); }
}

async function pedirPdf(db, mlCfg, ids) {
  try {
    return await mlFetchBinario(db, mlCfg, `/shipment_labels?shipment_ids=${ids.map(encodeURIComponent).join(',')}&response_type=pdf`, { manual: true });
  } catch (e) {
    return { status: 0, buffer: null, error: `error_red:${e.code || e.message}` };
  }
}

/** Órdenes de un envío según ML. `null` si no se pudo verificar. */
async function ordenesDelEnvio(db, mlCfg, shipmentId) {
  try {
    const r = await mlFetch(db, mlCfg, 'get', `/shipments/${encodeURIComponent(shipmentId)}/items`, null, { manual: true, headers: { 'x-format-new': 'true' } });
    if (r.status !== 200 || !Array.isArray(r.data)) return null;
    return [...new Set(r.data.map((i) => String(i?.order_id ?? '')).filter(Boolean))];
  } catch { return null; }
}

/**
 * @param {object} deps `faltanFotos(prep)` → null si las fotos requeridas están completas y en `listo`, o el motivo corto si no.
 * @returns {{status:number, body:object}} respuesta HTTP lista para enviar.
 */
export async function bajarEtiquetasMl(db, mlCfg, claves, usuario, { faltanFotos }) {
  const rechazados = [];
  const grupos = new Map();   // shipment_id → { claves: [], impresa }
  for (const clave of claves) {
    const prep = db.prepare("SELECT * FROM preparaciones WHERE clave=? AND canal='ml'").get(clave);
    if (!prep) { rechazados.push({ clave, motivo: 'sin preparación' }); continue; }
    if (ESTADOS_PREP_CERRADOS_SIN_ENVIO.has(prep.estado)) { rechazados.push({ clave, motivo: 'preparación cancelada' }); continue; }
    const ev = evaluarEnvioMlLocal(db, prep);
    if (ev.motivo) { rechazados.push({ clave, motivo: ev.motivo }); continue; }
    const fotos = faltanFotos(prep);
    if (fotos) { rechazados.push({ clave, motivo: fotos }); continue; }
    const g = grupos.get(ev.shipmentId) || { claves: [], impresa: false };
    g.claves.push(clave); g.impresa = g.impresa || ev.impresaEnMl; grupos.set(ev.shipmentId, g);
  }

  // Pack: TODAS las órdenes del envío deben estar preparadas con fotos listas (membresía consultada a ML; si falla → fail-closed).
  for (const [shipmentId, g] of [...grupos]) {
    const ids = await ordenesDelEnvio(db, mlCfg, shipmentId);
    let motivo = null;
    if (!ids) motivo = 'no se pudo verificar el pack';
    else {
      for (const orderId of ids) {
        const hermana = db.prepare("SELECT * FROM preparaciones WHERE clave=? AND canal='ml'").get(`ml:${orderId}`);
        const sinCancelar = db.prepare("SELECT estado_comercial FROM gestion_pedidos WHERE fuente='mercadolibre' AND external_id=?").get(orderId);
        if (sinCancelar && sinCancelar.estado_comercial !== 'confirmado') continue;   // hermana cancelada: no frena el envío
        if (!hermana) { motivo = `pack con orden sin preparar #${orderId}`; break; }
        const f = faltanFotos(hermana);
        if (f) { motivo = `pack con fotos pendientes en #${orderId}`; break; }
      }
    }
    if (motivo) { for (const c of g.claves) rechazados.push({ clave: c, motivo }); grupos.delete(shipmentId); }
  }

  if (!grupos.size) return { status: 200, body: { ok: true, pdf_base64: null, aceptados: [], rechazados } };

  let aceptadosEnv = [...grupos.keys()];
  let pdf = await pedirPdf(db, mlCfg, aceptadosEnv);
  if (!pdf.buffer && aceptadosEnv.length > 1 && RECHAZO_DE_ENVIO.has(pdf.status)) {
    // ML rechazó el lote: se prueba cada envío por separado (secuencial) solo para clasificar; esos PDF se descartan.
    const buenos = [];
    for (const sid of aceptadosEnv) {
      const uno = await pedirPdf(db, mlCfg, [sid]);
      if (uno.buffer) { buenos.push(sid); continue; }
      if (!RECHAZO_DE_ENVIO.has(uno.status)) return { status: 502, body: { ok: false, error: 'ML no está disponible para bajar etiquetas, reintentá en un momento' } };
      for (const c of grupos.get(sid).claves) rechazados.push({ clave: c, motivo: motivoDeMl(uno.error) });
      grupos.delete(sid);
    }
    aceptadosEnv = buenos;
    pdf = buenos.length ? await pedirPdf(db, mlCfg, buenos) : { buffer: null, status: 200 };
    if (buenos.length && !pdf.buffer) return { status: 502, body: { ok: false, error: 'ML no entregó el PDF final, reintentá en un momento' } };
  } else if (!pdf.buffer) {
    if (RECHAZO_DE_ENVIO.has(pdf.status)) {
      const motivo = motivoDeMl(pdf.error);
      for (const g of grupos.values()) for (const c of g.claves) rechazados.push({ clave: c, motivo });
      return { status: 200, body: { ok: true, pdf_base64: null, aceptados: [], rechazados } };
    }
    return { status: 502, body: { ok: false, error: 'ML no está disponible para bajar etiquetas, reintentá en un momento' } };
  }

  const aceptados = [];
  const ts = new Date().toISOString();
  const insertar = db.prepare('INSERT INTO etiquetas_ml_descargas (clave, shipment_id, usuario, descargado_en) VALUES (?,?,?,?)');
  db.transaction(() => {
    for (const sid of aceptadosEnv) for (const c of grupos.get(sid).claves) { aceptados.push(c); insertar.run(c, sid, usuario || null, ts); }
  })();
  return { status: 200, body: { ok: true, pdf_base64: pdf.buffer ? pdf.buffer.toString('base64') : null, aceptados, rechazados } };
}
