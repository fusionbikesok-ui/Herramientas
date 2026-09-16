/**
 * Auditoría de precios ML como PROYECCIÓN LOCAL (2026-09-16).
 *
 * Antes: `auditarPrecios` volvía a pedir `/items` masivamente cada vez que alguien tocaba
 * "Recalcular", duplicando la lectura que ya hace el refresco de publicaciones ML. Ahora la
 * auditoría se deriva de lo que ya está en la base:
 *
 *   - `ml_publicaciones_cache`: precio efectivo por variación, estado, category_id,
 *     listing_type_id y free_shipping (los completa el mismo multiget del refresco ML);
 *   - `sku_matcher_decisiones`: el vínculo confirmado (asignar/confirmar) y su SKU;
 *   - `catalogo_cache.regular_price`: precio de LISTA → `precioContado()` (nunca `precio`, que es
 *     el vigente y ya trae el sale_price).
 *
 * Nunca llama a `/items`. Sólo consulta comisión o envío cuando `ml_precios_cache` no tiene un valor
 * vigente (TTL 7 días), por `netoMl` → `mlFetch`, que respeta cupo, cooldown y pacing.
 *
 * Huella de fuente: sha256 de los datos que determinan el resultado. Una fila cuya huella no cambió
 * no se recalcula ni se reescribe. Una fila pendiente (dato faltante o ML no confirmó comisión/envío)
 * conserva su último resultado sano, queda marcada con `pendiente_motivo` y SIN huella, así el próximo
 * ciclo la reintenta.
 *
 * Poda (decisión del usuario): las filas de publicaciones inactivas o ausentes sólo se borran después
 * de un refresco ML exitoso (completo: todo el universo; acotado: los ítems releídos). Las filas cuyo
 * vínculo ya no existe se borran en cualquier corrida: eso no depende de la calidad del snapshot ML.
 */
import crypto from 'crypto';
import { netoMl, veredictoNeto, precioContado } from './mlPrecios.js';
import { espera } from './esperas.js';

const ML_CALL_DELAY_MS = 500;
// Tope de llamadas remotas (comisión/envío) por corrida: lo que no entre queda pendiente y lo toma
// la corrida siguiente. Evita que una corrida después de vencer la caché consuma el cupo de ML.
const MAX_LLAMADAS_POR_CORRIDA = 200;

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _mlCfg = null;
/** server.js registra la configuración ML una vez; los disparadores (refrescos ML/Woo, cron) la usan. */
export function configurarAuditoriaPrecios({ mlCfg } = {}) { _mlCfg = mlCfg || null; }

let _enCurso = false;
let _pedido = null; // pedido acumulado mientras hay una corrida: { claves: Set|null, podar, origen, manual }
let _progreso = { enCurso: false, origen: null, hechos: 0, total: 0, recalculadas: 0, sin_cambios: 0, pendientes: 0, borradas: 0, llamadas_ml: 0, inicio: null, fin: null, error: null };

export function estadoProgresoAuditoria() { return { ..._progreso }; }
export function auditoriaEnCurso() { return _enCurso; }

/** Para tests: vuelve el módulo a su estado inicial. */
export function _reiniciarAuditoriaParaTests() {
  _enCurso = false; _pedido = null; _mlCfg = null;
  _progreso = { enCurso: false, origen: null, hechos: 0, total: 0, recalculadas: 0, sin_cambios: 0, pendientes: 0, borradas: 0, llamadas_ml: 0, inicio: null, fin: null, error: null };
}

/**
 * Candidatas vigentes: publicación activa, vínculo confirmado con SKU. `regular_price` puede faltar
 * (fila `sin_precio`). Ante SKU duplicado en el catálogo se toma la fila Woo más reciente.
 */
function leerCandidatas(db, { claves = null, itemIds = null } = {}) {
  const filtros = []; const params = [];
  if (claves) { filtros.push(`p.clave IN (${claves.map(() => '?').join(',')})`); params.push(...claves); }
  if (itemIds) { filtros.push(`p.item_id IN (${itemIds.map(() => '?').join(',')})`); params.push(...itemIds); }
  const filas = db.prepare(`
    SELECT p.clave, p.item_id, p.variation_id, p.titulo, p.precio AS precio_ml, p.category_id, p.listing_type_id,
           p.free_shipping, p.actualizado_en AS ml_en,
           d.sku, c.regular_price AS precio_lista, c.actualizado_en AS woo_en
    FROM ml_publicaciones_cache p
    JOIN sku_matcher_decisiones d ON d.clave = p.clave AND d.accion IN ('asignar','confirmar') AND d.sku <> ''
    LEFT JOIN catalogo_cache c ON c.sku = d.sku AND c.sku <> ''
    WHERE p.status = 'active' ${filtros.length ? `AND (${filtros.join(' OR ')})` : ''}
    ORDER BY p.item_id, p.clave, c.actualizado_en DESC
  `).all(...params);
  const porClave = new Map();
  for (const f of filas) if (!porClave.has(f.clave)) porClave.set(f.clave, f);
  return [...porClave.values()];
}

export function huellaFuente(c) {
  return crypto.createHash('sha256').update(JSON.stringify([
    c.item_id, c.variation_id, c.titulo, c.precio_ml, c.category_id, c.listing_type_id, c.free_shipping, c.sku, c.precio_lista,
  ])).digest('hex');
}

const leerFila = (db, clave) => db.prepare('SELECT * FROM ml_precio_auditoria WHERE clave = ?').get(clave);

function escribirResultado(db, f) {
  db.prepare(`
    INSERT INTO ml_precio_auditoria
      (clave, item_id, titulo, sku, precio_ml, sale_fee, envio, neto, precio_web, deficit_pct, estado, actualizado_en,
       huella_fuente, origen_ml_en, origen_woo_en, pendiente_motivo)
    VALUES (@clave, @item_id, @titulo, @sku, @precio_ml, @sale_fee, @envio, @neto, @precio_web, @deficit_pct, @estado, @actualizado_en,
       @huella_fuente, @origen_ml_en, @origen_woo_en, @pendiente_motivo)
    ON CONFLICT(clave) DO UPDATE SET
      item_id=excluded.item_id, titulo=excluded.titulo, sku=excluded.sku, precio_ml=excluded.precio_ml,
      sale_fee=excluded.sale_fee, envio=excluded.envio, neto=excluded.neto, precio_web=excluded.precio_web,
      deficit_pct=excluded.deficit_pct, estado=excluded.estado, actualizado_en=excluded.actualizado_en,
      huella_fuente=excluded.huella_fuente, origen_ml_en=excluded.origen_ml_en, origen_woo_en=excluded.origen_woo_en,
      pendiente_motivo=excluded.pendiente_motivo
  `).run(f);
}

/**
 * Pendiente: si la fila ya tenía un resultado, se conserva tal cual y sólo se marca el motivo (la
 * UI lo muestra como dato posiblemente desactualizado). Si no había fila, se crea `sin_precio`.
 * En ambos casos la huella queda NULL para que la próxima corrida la reintente.
 */
function marcarPendiente(db, c, motivo) {
  const previa = leerFila(db, c.clave);
  if (previa) {
    db.prepare('UPDATE ml_precio_auditoria SET pendiente_motivo = ?, huella_fuente = NULL WHERE clave = ?').run(motivo, c.clave);
    return;
  }
  escribirResultado(db, {
    clave: c.clave, item_id: c.item_id, titulo: c.titulo, sku: c.sku,
    precio_ml: c.precio_ml ?? null, sale_fee: null, envio: null, neto: null,
    precio_web: precioContado(c.precio_lista), deficit_pct: null, estado: 'sin_precio', actualizado_en: now(),
    huella_fuente: null, origen_ml_en: c.ml_en, origen_woo_en: c.woo_en ?? null, pendiente_motivo: motivo,
  });
}

/** Calcula y persiste una candidata. Devuelve 'sin_cambios' | 'recalculada' | 'pendiente'. */
async function proyectarCandidata(db, mlCfg, c, ctx) {
  const huella = huellaFuente(c);
  const previa = leerFila(db, c.clave);
  if (previa && previa.huella_fuente === huella && !previa.pendiente_motivo) return 'sin_cambios';

  const precioWeb = precioContado(c.precio_lista);
  if (!(c.precio_ml > 0) || !c.category_id || !c.listing_type_id || c.free_shipping == null) {
    // Datos del multiget que todavía no llegaron al cache (p. ej. filas previas a la migración 107):
    // no se inventan; el próximo refresco ML normal los completa.
    marcarPendiente(db, c, 'datos_ml_incompletos');
    return 'pendiente';
  }
  if (ctx.llamadas >= MAX_LLAMADAS_POR_CORRIDA || !mlCfg) {
    // Sin cupo de esta corrida (o sin configuración ML): sólo se resuelve lo que ya está en caché.
    ctx.soloCache = true;
  }
  let remotas = 0;
  const r = await netoMl(db, ctx.soloCache ? null : mlCfg, {
    itemId: c.item_id, price: c.precio_ml, categoryId: c.category_id,
    listingTypeId: c.listing_type_id, freeShipping: c.free_shipping === 1,
  }, ctx.caches, {
    estricto: true,
    manual: ctx.manual === true,
    // Con `soloCache` no se puede llamar a ML: el hook corta antes del fetch.
    onRemote: () => {
      if (ctx.soloCache) throw Object.assign(new Error('solo_cache'), { soloCache: true });
      remotas += 1; ctx.llamadas += 1;
    },
  }).catch((e) => {
    if (e?.soloCache) return { sale_fee: null, envio: null, neto: null, soloCache: true };
    throw e;
  });
  if (remotas) await sleep(espera(ML_CALL_DELAY_MS * remotas));
  if (r.sale_fee == null) { marcarPendiente(db, c, r.soloCache ? 'cupo_corrida' : 'comision_pendiente'); return 'pendiente'; }
  if (r.envio == null) { marcarPendiente(db, c, r.soloCache ? 'cupo_corrida' : 'envio_pendiente'); return 'pendiente'; }

  const v = veredictoNeto(r.neto, precioWeb);
  escribirResultado(db, {
    clave: c.clave, item_id: c.item_id, titulo: c.titulo, sku: c.sku,
    precio_ml: c.precio_ml, sale_fee: r.sale_fee, envio: r.envio, neto: r.neto,
    precio_web: precioWeb, deficit_pct: v.deficitPct, estado: v.estado, actualizado_en: now(),
    huella_fuente: huella, origen_ml_en: c.ml_en, origen_woo_en: c.woo_en ?? null, pendiente_motivo: null,
  });
  return 'recalculada';
}

/**
 * Borra filas fuera de alcance.
 *  - Siempre: filas cuyo vínculo ya no existe o cambió de SKU (no depende del snapshot ML).
 *  - Con `podar`: filas cuya publicación ya no está activa o no está en el cache, dentro del alcance
 *    del refresco ML exitoso que la disparó (todo el universo, o los ítems releídos).
 */
function podarFilas(db, { podar, itemIds }) {
  let borradas = db.prepare(`
    DELETE FROM ml_precio_auditoria WHERE clave NOT IN (
      SELECT d.clave FROM sku_matcher_decisiones d
      WHERE d.accion IN ('asignar','confirmar') AND d.sku <> '' AND d.sku = ml_precio_auditoria.sku
    )`).run().changes;
  if (podar) {
    const filtro = itemIds ? `AND item_id IN (${itemIds.map(() => '?').join(',')})` : '';
    borradas += db.prepare(`
      DELETE FROM ml_precio_auditoria WHERE clave NOT IN (
        SELECT clave FROM ml_publicaciones_cache WHERE status = 'active'
      ) ${filtro}`).run(...(itemIds || [])).changes;
  }
  return borradas;
}

function fusionarPedido(a, b) {
  if (!a) return b;
  const claves = a.claves === null || b.claves === null ? null : new Set([...a.claves, ...b.claves]);
  const itemIds = a.itemIds === null || b.itemIds === null ? null : new Set([...a.itemIds, ...b.itemIds]);
  return {
    claves, itemIds,
    // Un pedido de todo el universo absorbe a los acotados.
    universo: a.universo || b.universo,
    podar: a.podar || b.podar,
    origen: b.origen,
    manual: a.manual || b.manual,
  };
}

async function correr(db, pedido) {
  const mlCfg = pedido.mlCfg ?? _mlCfg;
  const alcance = pedido.universo ? {} : {
    claves: pedido.claves?.size ? [...pedido.claves] : null,
    itemIds: pedido.itemIds?.size ? [...pedido.itemIds] : null,
  };
  const acotado = !pedido.universo && (alcance.claves || alcance.itemIds);
  const candidatas = pedido.universo || acotado ? leerCandidatas(db, alcance) : [];
  _progreso = {
    enCurso: true, origen: pedido.origen, hechos: 0, total: candidatas.length, recalculadas: 0, sin_cambios: 0,
    pendientes: 0, borradas: 0, llamadas_ml: 0, inicio: now(), fin: null, error: null,
  };
  const ctx = { caches: { fee: new Map(), envio: new Map() }, llamadas: 0, manual: pedido.manual, soloCache: false };
  try {
    for (const c of candidatas) {
      const r = await proyectarCandidata(db, mlCfg, c, ctx);
      if (r === 'recalculada') _progreso.recalculadas++; else if (r === 'sin_cambios') _progreso.sin_cambios++; else _progreso.pendientes++;
      _progreso.hechos++;
      _progreso.llamadas_ml = ctx.llamadas;
    }
    _progreso.borradas = podarFilas(db, {
      podar: pedido.podar,
      itemIds: pedido.universo ? null : (alcance.itemIds || [...new Set(candidatas.map((c) => c.item_id))]),
    });
    const ts = now();
    db.prepare(`UPDATE precios_auditoria_estado SET ultima_sync_en = ?, ultima_sync_origen = ?,
        ultima_completa_en = CASE WHEN ? THEN ? ELSE ultima_completa_en END, ultimo_error = NULL WHERE id = 1`)
      .run(ts, pedido.origen, pedido.universo && pedido.podar ? 1 : 0, ts);
    _progreso.fin = ts;
    return { ..._progreso };
  } catch (e) {
    _progreso.error = e.message;
    try { db.prepare('UPDATE precios_auditoria_estado SET ultimo_error = ?, ultimo_error_en = ? WHERE id = 1').run(String(e.message).slice(0, 500), now()); } catch { /* fail-open */ }
    throw e;
  } finally {
    _progreso.enCurso = false;
  }
}

/**
 * Sincroniza la auditoría desde la caché local.
 *
 * opciones:
 *  - claves / itemIds: alcance acotado; sin ninguno, todo el universo.
 *  - podar: borrar filas de publicaciones inactivas/ausentes (sólo tras un refresco ML exitoso).
 *  - origen: ml_completo | ml_acotado | woo | cron | manual | manual_precio.
 *  - manual: las llamadas a ML (sólo comisión/envío vencidos) no quedan frenadas por el cooldown de crons.
 *
 * Candado: si hay una corrida en curso, el pedido se acumula y se ejecuta al terminar (nunca se
 * pierde un disparo ni corren dos a la vez). Devuelve el resultado de la corrida propia o
 * `{ encolado: true }`.
 */
export async function sincronizarAuditoriaPreciosDesdeCache(db, opciones = {}) {
  const pedido = {
    claves: opciones.claves ? new Set(opciones.claves.map(String)) : null,
    itemIds: opciones.itemIds ? new Set(opciones.itemIds.map(String)) : null,
    universo: !opciones.claves && !opciones.itemIds,
    podar: opciones.podar === true,
    origen: opciones.origen || 'manual',
    manual: opciones.manual === true,
    mlCfg: opciones.mlCfg,
  };
  if (!pedido.universo) { pedido.claves = pedido.claves ?? new Set(); pedido.itemIds = pedido.itemIds ?? new Set(); }
  if (_enCurso) {
    _pedido = fusionarPedido(_pedido, pedido);
    return { encolado: true };
  }
  _enCurso = true;
  try {
    let resultado = await correr(db, pedido);
    while (_pedido) {
      const siguiente = _pedido; _pedido = null;
      resultado = await correr(db, siguiente);
    }
    return resultado;
  } finally {
    _enCurso = false;
  }
}

/** Disparo en background para los hooks de refresco: nunca rompe la sincronización principal. */
export function dispararAuditoriaPrecios(db, opciones) {
  sincronizarAuditoriaPreciosDesdeCache(db, opciones)
    .catch((e) => console.error(`[auditoria-precios] ${opciones?.origen || 'sin origen'}:`, e.message));
}

/** Estado durable + antigüedad de las fuentes, para /api/precios/estado. */
export function estadoAuditoriaPrecios(db) {
  const e = db.prepare('SELECT ultima_sync_en, ultima_sync_origen, ultima_completa_en, ultimo_error, ultimo_error_en FROM precios_auditoria_estado WHERE id = 1').get() || {};
  const ml = db.prepare("SELECT MAX(actualizado_en) m FROM ml_publicaciones_cache").get()?.m ?? null;
  const woo = db.prepare("SELECT MAX(actualizado_en) m FROM catalogo_cache").get()?.m ?? null;
  return { ...e, ml_datos_en: ml, woo_datos_en: woo };
}
