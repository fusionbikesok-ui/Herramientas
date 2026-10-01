import { mlFetch } from './mlClient.js';

const ZONA = 'America/Argentina/Buenos_Aires';

const SLA_CACHE_TTL_MS = 15 * 60 * 1000;
const SLA_FAILURE_CACHE_TTL_MS = 30 * 1000;
const SLA_CACHE_MAX_ENTRIES = 2000;
const TIPOS_CON_SLA = new Set(['cross_docking', 'drop_off', 'xd_drop_off']);
const slaCachePorDb = new WeakMap();

function cacheSla(db) {
  let cache = slaCachePorDb.get(db);
  if (!cache) { cache = new Map(); slaCachePorDb.set(db, cache); }
  return cache;
}

/** Enriquece shipments elegibles con el SLA de `/shipments/{id}/sla`, con caché
 * acotado, fail-open y formato nuevo; ante una falla conserva el shipment fresco.
 */
export async function resolverSlaShipment({ db, mlCfg, shipmentId, shipment, logisticType, manual = false, beforeFetch }) {
  const tipo = logisticType ?? shipment?.logistic_type ?? shipment?.logistic?.type;
  const estado = String(shipment?.status || '').toLowerCase();
  if (!shipmentId || !TIPOS_CON_SLA.has(String(tipo)) || ['cancelled', 'canceled', 'cancelled_returned', 'canceled_returned'].includes(estado)) return shipment;
  const cache = cacheSla(db);
  const key = String(shipmentId);
  const previo = cache.get(key);
  const ahora = Date.now();
  if (previo) {
    const ttl = previo.fallo ? SLA_FAILURE_CACHE_TTL_MS : SLA_CACHE_TTL_MS;
    if (ahora - previo.at < ttl) return previo.sla ? { ...(shipment || {}), sla: previo.sla } : shipment;
    cache.delete(key);
  }
  let sla = null;
  let fallo = false;
  try {
    if (beforeFetch) await beforeFetch();
    const resp = await mlFetch(db, mlCfg, 'get', `/shipments/${encodeURIComponent(key)}/sla`, null, {
      ...(manual ? { manual: true } : {}), headers: { 'x-format-new': 'true' },
    });
    sla = resp?.status === 200 && resp.data?.expected_date ? resp.data : null;
    fallo = !sla;
  } catch (_) {
    // Fail-open: el caller conserva los campos viejos del shipment.
    fallo = true;
  }
  for (const [cacheKey, entrada] of cache) {
    const ttl = entrada.fallo ? SLA_FAILURE_CACHE_TTL_MS : SLA_CACHE_TTL_MS;
    if (ahora - entrada.at >= ttl) cache.delete(cacheKey);
  }
  cache.set(key, { at: ahora, sla, fallo });
  while (cache.size > SLA_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return sla ? { ...(shipment || {}), sla } : shipment;
}

export const DIAS_SEMANA = [1, 2, 3, 4, 5, 6, 7];

export function horaValida(hora) {
  return typeof hora === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(hora);
}

export function normalizarHorarios(rows = []) {
  const porDia = new Map(rows.map((r) => [Number(r.dia), r]));
  return DIAS_SEMANA.map((dia) => {
    const row = porDia.get(dia);
    return {
      dia,
      habilitado: row ? Number(row.habilitado) === 1 : dia <= 5,
      hora_corte: row?.hora_corte && horaValida(row.hora_corte) ? row.hora_corte : '16:00',
    };
  });
}

function partesBuenosAires(date = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
  const fecha = `${p.year}-${p.month}-${p.day}`;
  const hora = `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
  const weekday = Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONA, weekday: 'short' })
    .format(date).replace(/^Sun$/, '7').replace(/^Mon$/, '1').replace(/^Tue$/, '2')
    .replace(/^Wed$/, '3').replace(/^Thu$/, '4').replace(/^Fri$/, '5').replace(/^Sat$/, '6'));
  return { fecha, hora, weekday };
}

function sumarDias(fecha, dias) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function calcularFechaDespacho(rows, ahora = new Date()) {
  const horarios = normalizarHorarios(rows);
  const actual = partesBuenosAires(ahora);
  for (let offset = 0; offset < 8; offset += 1) {
    const dia = ((actual.weekday - 1 + offset) % 7) + 1;
    const horario = horarios.find((h) => h.dia === dia);
    if (!horario?.habilitado) continue;
    if (offset === 0 && actual.hora >= horario.hora_corte) continue;
    return sumarDias(actual.fecha, offset);
  }
  return null;
}

export function fechaEstimadaShipment(shipment) {
  // ML distingue la fecha de entrega de la fecha límite para despachar. Para la cola
  // necesitamos esta última; no usar date_estimated_delivery, que es posterior.
  // Precedencia explícita: SLA de preparación documentado por ML, luego los
  // alias históricos del límite de handling. Nunca usar la fecha de entrega.
  const candidatos = [
    shipment?.sla?.expected_date,
    shipment?.expected_date,
    shipment?.shipping_option?.estimated_handling_limit?.date,
    shipment?.estimated_handling_limit?.date,
    shipment?.handling_limit?.date,
    shipment?.buffering?.date,
  ];
  for (const valor of candidatos) {
    if (typeof valor !== 'string') continue;
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:(T)(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/.exec(valor);
    if (!match) continue;
    const fecha = new Date(valor.length === 10 ? `${valor}T12:00:00Z` : valor);
    if (Number.isNaN(fecha.getTime())) continue;
    const fechaBase = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
    if (fechaBase.getUTCFullYear() !== Number(match[1]) || fechaBase.getUTCMonth() + 1 !== Number(match[2]) || fechaBase.getUTCDate() !== Number(match[3])) continue;
    const calendario = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
    if (valor.length === 10 || calendario) return calendario;
  }
  return null;
}

function timestampIsoEstricto(valor) {
  if (typeof valor !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/.exec(valor);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss = '00', fraccion = '', zona] = match;
  const offset = zona === 'Z' ? 0 : Number(`${zona[0]}1`) * (Number(zona.slice(1, 3)) * 60 + Number(zona.slice(-2)));
  if (Number(m) > 12 || Number(d) < 1 || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59 || (zona !== 'Z' && (Number(zona.slice(1, 3)) > 23 || Number(zona.slice(-2)) > 59))) return null;
  const calendario = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss), Number((fraccion + '000').slice(0, 3))) - offset * 60000);
  const base = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 12));
  if (base.getUTCFullYear() !== Number(y) || base.getUTCMonth() + 1 !== Number(m) || base.getUTCDate() !== Number(d)) return null;
  if (Number.isNaN(calendario.getTime())) return null;
  return { original: valor, iso: calendario.toISOString() };
}

export function fechaHoraEstimadaShipment(shipment) {
  const candidatos = [shipment?.sla?.expected_date, shipment?.expected_date,
    shipment?.shipping_option?.estimated_handling_limit?.date,
    shipment?.estimated_handling_limit?.date, shipment?.handling_limit?.date,
    shipment?.buffering?.date];
  for (const valor of candidatos) {
    if (typeof valor !== 'string') continue;
    // El SLA operativo requiere hora y zona; una fecha sola no permite
    // calcular el margen interno ni priorizar el paquete.
    if (valor.length === 10) continue;
    const fecha = timestampIsoEstricto(valor);
    if (fecha) return { ...fecha, tieneHora: true };
  }
  return null;
}

function localIsoConHora(fecha, hora) {
  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm] = hora.split(':').map(Number);
  // Argentina no cambia horario: UTC-03 durante todo el año.
  return new Date(Date.UTC(y, m - 1, d, hh + 3, mm)).toISOString();
}

export function calcularSlaPreparacion({ canal, logisticType, shipment, ahora = new Date() }) {
  const actual = partesBuenosAires(ahora);
  if (canal === 'web') return {
    limite: localIsoConHora(actual.fecha, '15:00'), fecha_local: actual.fecha,
    estado: actual.hora >= '15:00' ? 'diferido' : 'activo',
    razon: actual.hora >= '15:00' ? 'WEB_CORTE_15:00_SUPERADO' : null, fuente: 'web_corte_15:00',
  };
  if (logisticType === 'fulfillment' || logisticType === 'full') return { limite: null, estado: 'excluido', razon: 'ML_FULL_FULFILLMENT_EXCLUIDO', fuente: 'logistica_ml' };
  if (logisticType === 'self_service') {
    const limite = localIsoConHora(actual.fecha, '17:00');
    return { limite, fecha_local: actual.fecha, estado: actual.hora >= '17:00' ? 'diferido' : 'activo', razon: actual.hora >= '17:00' ? 'FLEX_SALIDA_17:00_SUPERADA' : null, fuente: 'flex_salida_17:00' };
  }
  const shipmentLimit = fechaHoraEstimadaShipment(shipment);
  if (!shipmentLimit || !shipmentLimit.tieneHora) return { limite: null, estado: 'diferido', razon: 'SLA_SHIPMENT_HORA_FALTANTE', fuente: 'shipment' };
  const limite = new Date(shipmentLimit.iso).getTime() - 30 * 60 * 1000;
  const limiteIso = new Date(limite).toISOString();
  return { limite: limiteIso, fecha_local: partesBuenosAires(new Date(limite)).fecha, estado: ahora.getTime() >= limite ? 'diferido' : 'activo', razon: ahora.getTime() >= limite ? 'MARGEN_30_MIN_SUPERADO' : null, fuente: 'shipment_menos_30_min', shipment_original: shipmentLimit.original };
}

export function sembrarHorarios(db, now = new Date().toISOString()) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO despacho_horarios (dia, habilitado, hora_corte, actualizado_en)
    VALUES (?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const dia of DIAS_SEMANA) insert.run(dia, dia <= 5 ? 1 : 0, '16:00', now);
  });
  tx();
}

export function asegurarEsquemaHorarios(db) {
  const columnas = db.prepare('PRAGMA table_info(pedidos_cache)').all().map((c) => c.name);
  if (columnas.length && !columnas.includes('fecha_despacho')) {
    db.prepare('ALTER TABLE pedidos_cache ADD COLUMN fecha_despacho TEXT').run();
  }
  for (const [nombre, sql] of [
    ['fecha_despacho_limite', 'ALTER TABLE pedidos_cache ADD COLUMN fecha_despacho_limite TEXT'],
    ['estado_despacho', "ALTER TABLE pedidos_cache ADD COLUMN estado_despacho TEXT NOT NULL DEFAULT 'activo'"],
    ['despacho_motivo', 'ALTER TABLE pedidos_cache ADD COLUMN despacho_motivo TEXT'],
    ['shipment_limite_original', 'ALTER TABLE pedidos_cache ADD COLUMN shipment_limite_original TEXT'],
  ]) {
    if (columnas.length && !columnas.includes(nombre)) db.exec(sql);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS despacho_horarios_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    actualizado_en TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS despacho_horarios_auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT,
    valores_anteriores_json TEXT NOT NULL,
    valores_nuevos_json TEXT NOT NULL,
    version_anterior INTEGER NOT NULL,
    version_nueva INTEGER NOT NULL,
    creado_en TEXT NOT NULL
  )`);
  db.prepare(`INSERT OR IGNORE INTO despacho_horarios_meta (id, version, actualizado_en)
    VALUES (1, 1, ?)`).run(new Date().toISOString());
}

export function leerVersionHorarios(db) {
  return db.prepare('SELECT version FROM despacho_horarios_meta WHERE id=1').get()?.version ?? 1;
}

export function leerHorarios(db) {
  return normalizarHorarios(db.prepare('SELECT dia, habilitado, hora_corte FROM despacho_horarios ORDER BY dia').all());
}
