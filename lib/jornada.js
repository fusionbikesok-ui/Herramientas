import { pedidosElegiblesOrdenados } from './preparacion.js';

const ZONA = 'America/Argentina/Buenos_Aires';
const snapshotItemsPedido = (db, clave) => db.prepare('SELECT items_json FROM pedidos_cache WHERE clave=?').get(clave)?.items_json || '[]';

export function reglasApertura() {
  return {
    zona_horaria: ZONA,
    web: { tipo: 'preparacion_maxima', hora: '15:00' },
    ml_andreani: { tipo: 'deadline_centro_menos', margen_minutos: 30 },
    flex: { tipo: 'salida_maxima', hora: '17:00', logistic_type: 'self_service' },
    full: { estado: 'excluido' },
  };
}

export function preflightApertura(db) {
  const ahora = Date.now();
  const estadoSync = (direccion, nombre) => {
    if (!db) return { estado: 'pendiente', verificacion: 'requiere_verificacion', detalle: `${nombre}: todavía no se consultó el estado local` };
    const row = db.prepare('SELECT estado, creado_en, error FROM sync_log WHERE direccion=? ORDER BY id DESC LIMIT 1').get(direccion);
    if (!row) return { estado: 'desconocido', verificacion: 'sin_evidencia', detalle: `No hay una sincronización registrada para ${nombre}` };
    const edadMin = Math.max(0, Math.round((ahora - new Date(row.creado_en).getTime()) / 60000));
    if (row.estado !== 'ok') return { estado: 'error', verificacion: 'ultima_corrida_fallida', detalle: (row.error || `La última sincronización falló hace ${edadMin} min`).slice(0, 300), ultima_corrida: row.creado_en };
    if (edadMin > 30) return { estado: 'advertencia', verificacion: 'evidencia_antigua', detalle: `Última sincronización correcta hace ${edadMin} min`, ultima_corrida: row.creado_en };
    return { estado: 'ok', verificacion: 'ultima_corrida_correcta', detalle: `Sincronización correcta hace ${edadMin} min`, ultima_corrida: row.creado_en };
  };
  return {
    // Nombre histórico del contrato: la apertura puede continuar con advertencias.
    // La impresora queda pendiente de E3 y no bloquea E1.
    estado: 'abierta_con_advertencias',
    integraciones: {
      mercadolibre: estadoSync('ml_wc', 'MercadoLibre'),
      woocommerce: estadoSync('pedidos_cache', 'WooCommerce'),
    },
    agente_impresora: { estado: 'pendiente_e3', verificacion: 'no_requerido_e1', detalle: 'La impresión automática se habilitará en E3; no bloquea la apertura de E1' },
    operaciones_no_afectadas: 'continuan',
  };
}

export function fechaLocalHoy(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function jornadaDeHoy(db, now = new Date()) {
  const fecha = fechaLocalHoy(now);
  return db.prepare('SELECT * FROM operational_days WHERE fecha=?').get(fecha) || null;
}

export function abrirJornada(db, { usuario, confirmarHorarios = true }, now = new Date()) {
  const fecha = fechaLocalHoy(now);
  const existente = db.prepare('SELECT * FROM operational_days WHERE fecha=?').get(fecha);
  if (existente) return { ok: false, code: 'OPERATIONAL_DAY_EXISTS', jornada: existente };

  const ts = now.toISOString();
  const tx = db.transaction(() => {
    const dayInfo = db.prepare(`INSERT INTO operational_days
      (fecha, estado, hora_corte_web, ventana_ml_json, abierta_por, abierta_en, horarios_confirmados_por, horarios_confirmados_en)
      VALUES (?,?,?,?,?,?,?,?)`).run(fecha, 'abierta', '15:00', null, usuario, ts,
        confirmarHorarios ? usuario : null, confirmarHorarios ? ts : null);
    const dayId = dayInfo.lastInsertRowid;

    const waveInfo = db.prepare(`INSERT INTO pick_waves
      (operational_day_id, tipo, estado, creada_en, congelada_en, congelada_por)
      VALUES (?,'inicial','congelada',?,?,?)`).run(dayId, ts, ts, usuario);
    const waveId = waveInfo.lastInsertRowid;

    const elegibles = pedidosElegiblesOrdenados(db);
    const insertItem = db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en, items_json_snapshot) VALUES (?,?,?,?)');
    for (const pedido of elegibles) insertItem.run(waveId, pedido.clave, ts, pedido.items_json || '[]');

    return {
      jornada: db.prepare('SELECT * FROM operational_days WHERE id=?').get(dayId),
      olaInicial: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId),
    };
  });
  const { jornada, olaInicial } = tx();
  return { ok: true, jornada, olaInicial };
}

const CLAIM_TTL_DEFAULT_MS = 15 * 60 * 1000;
const AVISO_VENCIMIENTO_MS = 10 * 60 * 1000;

export function anotarVencimiento(claim, ahora = new Date(), avisoMs = AVISO_VENCIMIENTO_MS) {
  const restanteMs = new Date(claim.expires_at).getTime() - ahora.getTime();
  return {
    ...claim,
    segundos_restantes: Math.max(0, Math.round(restanteMs / 1000)),
    por_vencer: restanteMs <= avisoMs,
  };
}

export function reclamarOla(db, pickWaveId, usuario, { ttlMs = CLAIM_TTL_DEFAULT_MS, operationId, expectedVersion } = {}, now = new Date()) {
  const at = now.toISOString();
  const expires = new Date(now.getTime() + ttlMs).toISOString();

  const tx = db.transaction(() => {
    const ola = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(pickWaveId);
    if (!ola) return { ok: false, code: 'WAVE_NOT_FOUND' };
    if (operationId) {
      const previo = db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(operationId);
      if (previo) return { ok: true, repetido: true, claim: db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(pickWaveId), olaCongelada: ola, evento: previo };
    }
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(ola.expected_version || 1)) {
      return { ok: false, code: 'WAVE_VERSION_CONFLICT', expected_version: ola.expected_version || 1, ola };
    }
    if (!['abierta', 'congelada', 'en_picking'].includes(ola.estado)) {
      return { ok: false, code: 'WAVE_NOT_CLAIMABLE' };
    }

    const otra = db.prepare(`SELECT c.*, w.id AS otra_ola_id FROM pick_wave_claims c
      JOIN pick_waves w ON w.id=c.pick_wave_id
      WHERE c.usuario=? AND c.pick_wave_id<>? AND c.expires_at>?`).get(usuario, pickWaveId, at);
    if (otra) return { ok: false, code: 'OPERATOR_ALREADY_CLAIMED', claim: anotarVencimiento(otra, now), ola_id: otra.otra_ola_id };

    const claimActual = db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(pickWaveId);
    if (claimActual && claimActual.usuario !== usuario && claimActual.expires_at > at) {
      return { ok: false, code: 'WAVE_CLAIMED', claim: anotarVencimiento(claimActual, now) };
    }

    const claimedAt = claimActual && claimActual.usuario === usuario ? claimActual.claimed_at : at;
    if (claimActual) {
      db.prepare('UPDATE pick_wave_claims SET usuario=?, claimed_at=?, expires_at=?, renovado_en=? WHERE pick_wave_id=?')
        .run(usuario, claimedAt, expires, at, pickWaveId);
    } else {
      db.prepare('INSERT INTO pick_wave_claims (pick_wave_id, usuario, claimed_at, expires_at, renovado_en) VALUES (?,?,?,?,?)')
        .run(pickWaveId, usuario, claimedAt, expires, at);
    }
    const claim = anotarVencimiento({ usuario, claimed_at: claimedAt, expires_at: expires }, now);

    // Freeze solo la primera vez que esta ola pasa de 'abierta' a tomada — un segundo claim
    // del mismo usuario (renovación) sobre una ola ya 'en_picking' no debe volver a congelar
    // ni abrir una tercera ola.
    if (ola.estado === 'en_picking') {
      return { ok: true, claim, olaCongelada: ola };
    }

    db.prepare(`UPDATE pick_waves SET estado='en_picking', congelada_en=?, congelada_por=?, expected_version=expected_version+1 WHERE id=?`)
      .run(at, usuario, pickWaveId);
    const olaCongelada = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(pickWaveId);
    if (operationId) evento(db, ola, 'ola_reclamada', usuario, operationId, {}, ola, olaCongelada, now);

    let olaNueva = null;
    if (ola.tipo === 'mini') {
      const info = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'mini','abierta',?)`)
        .run(ola.operational_day_id, at);
      olaNueva = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(info.lastInsertRowid);
    }

    return { ok: true, claim, olaCongelada, olaNueva };
  });
  return tx();
}

export function cerrarJornada(db, usuario, now = new Date()) {
  const jornada = jornadaDeHoy(db, now);
  if (!jornada || jornada.estado !== 'abierta') return { ok: false, code: 'NO_OPEN_DAY' };
  const at = now.toISOString();
  db.prepare('UPDATE operational_days SET estado=?, cerrada_por=?, cerrada_en=? WHERE id=?')
    .run('cerrada', usuario, at, jornada.id);
  return { ok: true, jornada: db.prepare('SELECT * FROM operational_days WHERE id=?').get(jornada.id) };
}

export function pausarOla(db, waveId, usuario, { expectedVersion, operationId, motivo } = {}, now = new Date()) {
  if (!String(motivo || '').trim()) return { ok:false, code:'PAUSE_REASON_REQUIRED' };
  const tx = db.transaction(() => {
    const claim = db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(waveId);
    if (!claim || claim.usuario !== usuario) return { ok:false, code:'CLAIM_REQUIRED' };
    if (operationId) { const old = db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(operationId); if (old) return { ok:true, repetido:true, evento:old, claim }; }
    const ola = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId);
    if (!ola) return { ok:false, code:'WAVE_NOT_FOUND' };
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(ola.expected_version || 1)) return { ok:false, code:'WAVE_VERSION_CONFLICT', ola };
    if (claim.pausada_en) return { ok:true, repetido:true, claim, ola };
    const at=now.toISOString(); db.prepare('UPDATE pick_wave_claims SET pausada_en=?,pausada_por=?,motivo_pausa=? WHERE pick_wave_id=?').run(at,usuario,String(motivo).trim(),waveId);
    const despues=db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(waveId); db.prepare('UPDATE pick_waves SET expected_version=expected_version+1 WHERE id=?').run(waveId);
    evento(db,ola,'ola_pausada',usuario,operationId || `pause:${waveId}:${usuario}:${at}`,{motivo:String(motivo).trim()},claim,despues,now);
    return {ok:true, claim:despues, ola:db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId)};
  }); return tx();
}

export function reanudarOla(db, waveId, usuario, { expectedVersion, operationId } = {}, now = new Date()) {
  const tx = db.transaction(() => {
    const claim = db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(waveId);
    if (!claim || claim.usuario !== usuario) return {ok:false,code:'CLAIM_REQUIRED'};
    if (operationId) { const old=db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(operationId); if(old)return {ok:true,repetido:true,evento:old,claim}; }
    const ola=db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId); if(!ola)return {ok:false,code:'WAVE_NOT_FOUND'};
    if (expectedVersion !== undefined && Number(expectedVersion) !== Number(ola.expected_version || 1)) return {ok:false,code:'WAVE_VERSION_CONFLICT',ola};
    if (!claim.pausada_en) return {ok:true,repetido:true,claim,ola};
    const at=now.toISOString(); db.prepare('UPDATE pick_wave_claims SET pausada_en=NULL,pausada_por=NULL,motivo_pausa=NULL,renovado_en=? WHERE pick_wave_id=?').run(at,waveId);
    const despues=db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(waveId); db.prepare('UPDATE pick_waves SET expected_version=expected_version+1 WHERE id=?').run(waveId);
    evento(db,ola,'ola_reanudada',usuario,operationId || `resume:${waveId}:${usuario}:${at}`,{},claim,despues,now); return {ok:true,claim:despues,ola:db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId)};
  }); return tx();
}

const ESTADOS_OBJETIVO = new Set(['disponible', 'en_busqueda', 'en_mesa', 'cerrada']);
const estadoObjetivo = (ola) => {
  if (ola.estado === 'completada') return 'cerrada';
  if (ola.estado_operativo && ESTADOS_OBJETIVO.has(ola.estado_operativo)) return ola.estado_operativo;
  if (ola.estado === 'en_picking') return 'en_busqueda';
  if (ola.estado_operativo && ESTADOS_OBJETIVO.has(ola.estado_operativo)) return ola.estado_operativo;
  return 'disponible';
};

function evento(db, ola, tipo, usuario, operationId, detalle = {}, antes = null, despues = null, now = new Date()) {
  const id = operationId || `${tipo}:${ola.id}:${usuario}:${now.getTime()}`;
  const existente = db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(id);
  if (existente) return existente;
  db.prepare(`INSERT INTO operational_day_events
    (operational_day_id,pick_wave_id,tipo,usuario,operation_id,antes_json,despues_json,detalle_json,creado_en)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(ola.operational_day_id, ola.id, tipo, usuario, id,
    antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null,
    JSON.stringify(detalle), now.toISOString());
  return db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(id);
}

function olaConVersion(db, id, expectedVersion) {
  const ola = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(id);
  if (!ola) return { ok: false, code: 'WAVE_NOT_FOUND' };
  if (expectedVersion !== undefined && Number(expectedVersion) !== Number(ola.expected_version || 1)) {
    return { ok: false, code: 'WAVE_VERSION_CONFLICT', expected_version: ola.expected_version || 1, ola };
  }
  return { ok: true, ola };
}

function claimVigente(db, waveId, usuario, now) {
  const claim = db.prepare('SELECT * FROM pick_wave_claims WHERE pick_wave_id=?').get(waveId);
  if (!claim || claim.usuario !== usuario || new Date(claim.expires_at).getTime() <= now.getTime()) {
    return { ok: false, code: 'WAVE_CLAIM_REQUIRED', claim: claim ? anotarVencimiento(claim, now) : null };
  }
  return { ok: true, claim };
}

function pedidoEnOla(db, waveId, pedidoClave) {
  return db.prepare('SELECT 1 FROM pick_wave_items WHERE pick_wave_id=? AND pedido_clave=?').get(waveId, pedidoClave);
}

function pedidoCache(db, pedidoClave) {
  const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pedidos_cache'").get();
  if (!existe) return null;
  return db.prepare('SELECT * FROM pedidos_cache WHERE clave=?').get(pedidoClave) || null;
}

function lineasPedido(db, pedidoClave) {
  const existeTabla = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pedidos_cache'").get();
  if (!existeTabla) return null;
  const pedido = pedidoCache(db, pedidoClave);
  if (!pedido || !pedido.items_json) return null;
  try {
    const raw = JSON.parse(pedido.items_json);
    const items = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : []);
    if (!Array.isArray(items) || !items.length) return null;
    const normalizadas = items.map((item) => ({ sku: String(item.sku || item.SKU || item.id || '').trim(), cantidad: Number(item.cantidad ?? item.quantity ?? item.qty ?? 0) }));
    if (normalizadas.some((item) => !item.sku || !Number.isFinite(item.cantidad) || item.cantidad <= 0)) return null;
    return normalizadas;
  } catch (_) { return null; }
}

function validarSnapshot(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.items) ? parsed.items : null;
    if (!items) return null;
    if (items.some((item) => !item || !String(item.sku || item.SKU || item.id || '').trim() || !Number.isFinite(Number(item.cantidad ?? item.quantity ?? item.qty)) || Number(item.cantidad ?? item.quantity ?? item.qty) <= 0)) return null;
    return JSON.stringify(items.map((item) => ({ sku: String(item.sku || item.SKU || item.id).trim(), cantidad: Number(item.cantidad ?? item.quantity ?? item.qty) })));
  } catch (_) { return null; }
}

function validarLineaPedido(db, pedidoClave, sku, cantidad, waveId) {
  const lineas = lineasPedido(db, pedidoClave);
  if (lineas === null) return { ok: false, code: 'ORDER_DATA_UNAVAILABLE' };
  const linea = lineas.find((item) => item.sku === String(sku));
  if (!linea) return { ok: false, code: 'SKU_NOT_IN_ORDER' };
  const ya = db.prepare('SELECT COALESCE(SUM(cantidad),0) AS cantidad FROM pick_wave_assignments WHERE pick_wave_id=? AND pedido_clave=? AND sku=?').get(waveId, pedidoClave, String(sku));
  if (Number(ya.cantidad) + cantidad > linea.cantidad) return { ok: false, code: 'ASSIGNMENT_EXCEEDS_ORDER', disponible: Math.max(0, linea.cantidad - Number(ya.cantidad)) };
  return { ok: true };
}

function resolverCodigoProducto(db, codigo) {
  const valor = String(codigo || '').trim();
  if (!valor) return { ok:false, code:'SKU_REQUIRED' };
  let huboCatalogo = false;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalogo_cache'").get()) {
    huboCatalogo = true;
    if (db.prepare('SELECT 1 FROM catalogo_cache WHERE sku=?').get(valor)) return { ok:true, sku:valor };
    const filas = db.prepare('SELECT DISTINCT sku FROM catalogo_cache WHERE gtin=? AND sku IS NOT NULL AND sku<>\'\'').all(valor);
    if (filas.length === 1) return { ok:true, sku:filas[0].sku, codigo:valor };
    if (filas.length > 1) return { ok:false, code:'PRODUCT_CODE_AMBIGUOUS' };
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ean_sku'").get()) {
    huboCatalogo = true;
    const fila = db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get(valor);
    if (fila?.sku) return { ok:true, sku:fila.sku, codigo:valor };
  }
  if (huboCatalogo) return { ok:false, code:'PRODUCT_CODE_UNKNOWN' };
  return { ok:false, code:'PRODUCT_CODE_UNKNOWN' };
}

export function iniciarBusqueda(db, waveId, usuario, { expectedVersion, operationId } = {}, now = new Date()) {
  const tx = db.transaction(() => {
    if (operationId) {
      const previo = db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(operationId);
      if (previo) return { ok: true, repetido: true, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId), evento: previo };
    }
    const found = olaConVersion(db, waveId, expectedVersion); if (!found.ok) return found;
    const claim = claimVigente(db, waveId, usuario, now); if (!claim.ok) return claim;
    const ola = found.ola; if (estadoObjetivo(ola) !== 'disponible') return { ok: false, code: 'WAVE_INVALID_STATE', ola };
    const at = now.toISOString();
    db.prepare("UPDATE pick_waves SET estado='en_picking', estado_operativo='en_busqueda', congelada_en=?, congelada_por=?, expected_version=expected_version+1 WHERE id=?").run(at, usuario, waveId);
    const despues = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId);
    evento(db, ola, 'busqueda_iniciada', usuario, operationId, {}, ola, despues, now);
    return { ok: true, ola: despues };
  }); return tx();
}

export function configurarZona(db, { nombre, verificada = false }, usuario, { operationId } = {}, now = new Date()) {
  if (!String(nombre || '').trim()) return { ok: false, code: 'ZONE_NAME_REQUIRED' };
  if (operationId) {
    const previo = db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(operationId);
    if (previo) return { ok:true, repetido:true, evento:previo, zona:db.prepare('SELECT * FROM warehouse_pick_zones WHERE nombre=?').get(nombre.trim()) };
  }
  const existente = db.prepare('SELECT * FROM warehouse_pick_zones WHERE nombre=?').get(nombre.trim());
  if (existente) return { ok: true, zona: existente, repetido: true };
  db.prepare('INSERT INTO warehouse_pick_zones (nombre,verificada,creado_por,creado_en) VALUES (?,?,?,?)').run(nombre.trim(), 0, usuario, now.toISOString());
  return { ok: true, zona: db.prepare('SELECT * FROM warehouse_pick_zones WHERE nombre=?').get(nombre.trim()), operation_id: operationId || null };
}

export function pedirAyudaZona(db, waveId, { zonaId, ayudante }, usuario, { expectedVersion, operationId } = {}, now = new Date()) {
  const tx = db.transaction(() => {
    if (operationId) {
      const repetida = db.prepare('SELECT * FROM pick_wave_helpers WHERE operation_id=?').get(operationId);
      if (repetida) return { ok: true, ayuda: repetida, repetido: true, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId) };
    }
    const found = olaConVersion(db, waveId, expectedVersion); if (!found.ok) return found;
    const claim = claimVigente(db, waveId, usuario, now); if (!claim.ok) return claim;
    if (!db.prepare('SELECT 1 FROM warehouse_pick_zones WHERE id=? AND activa=1').get(zonaId)) return { ok: false, code: 'ZONE_NOT_FOUND' };
    if (!ayudante) return { ok: false, code: 'HELPER_REQUIRED' };
    const id = operationId || `help:${waveId}:${zonaId}:${usuario}`;
    const old = db.prepare('SELECT * FROM pick_wave_helpers WHERE operation_id=?').get(id); if (old) return { ok: true, ayuda: old, repetido: true };
    const at = now.toISOString();
    db.prepare(`INSERT INTO pick_wave_helpers (pick_wave_id,zona_id,ayudante,solicitado_por,operation_id,creado_en,actualizado_en) VALUES (?,?,?,?,?,?,?)`).run(waveId, zonaId, ayudante, usuario, id, at, at);
    db.prepare('UPDATE pick_waves SET expected_version=expected_version+1 WHERE id=?').run(waveId);
    const despues = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId);
    evento(db, found.ola, 'ayuda_zona_solicitada', usuario, id, { zona_id: zonaId, ayudante }, found.ola, despues, now);
    return { ok: true, ayuda: db.prepare('SELECT * FROM pick_wave_helpers WHERE operation_id=?').get(id), ola: despues };
  }); return tx();
}

export function recibirAyudaZona(db, helperId, usuario, { expectedVersion, operationId, entrega = [], allowWithoutClaim = false } = {}, now = new Date()) {
  const tx = db.transaction(() => {
    const ayuda = db.prepare('SELECT * FROM pick_wave_helpers WHERE id=?').get(helperId); if (!ayuda) return { ok: false, code: 'HELP_NOT_FOUND' };
    if (operationId) {
      const previo = db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(operationId);
      if (previo) return { ok: true, ayuda, repetido: true, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(ayuda.pick_wave_id), evento: previo };
    }
    const found = olaConVersion(db, ayuda.pick_wave_id, expectedVersion); if (!found.ok) return found;
    const claim = claimVigente(db, ayuda.pick_wave_id, usuario, now); if (!claim.ok && usuario !== ayuda.ayudante && usuario !== ayuda.solicitado_por && !allowWithoutClaim) return claim;
    if (ayuda.estado === 'recibida') return { ok: true, ayuda, repetido: true };
    if (!Array.isArray(entrega) || entrega.some((linea) => !linea || !String(linea.sku || '').trim() || !Number.isInteger(linea.cantidad) || linea.cantidad < 1)) return { ok: false, code: 'HELP_DELIVERY_INVALID' };
    const at = now.toISOString(); const id = operationId || `receive-help:${helperId}`;
    db.prepare("UPDATE pick_wave_helpers SET estado='recibida', pedido_en_mesa_por=?, pedido_en_mesa_en=?, entrega_json=? WHERE id=?").run(usuario, at, JSON.stringify(entrega), helperId);
    // Recibir ayuda no abre la mesa: el responsable puede seguir buscando otra
    // zona. La transición a en_mesa es explícita mediante pasarAMesa().
    db.prepare('UPDATE pick_waves SET expected_version=expected_version+1 WHERE id=?').run(ayuda.pick_wave_id);
    const despues = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(ayuda.pick_wave_id);
    evento(db, found.ola, 'ayuda_recibida_en_mesa', usuario, id, { helper_id: helperId, ayudante: ayuda.ayudante, entrega }, found.ola, despues, now);
    return { ok: true, ayuda: db.prepare('SELECT * FROM pick_wave_helpers WHERE id=?').get(helperId), ola: despues };
  }); return tx();
}

export function pasarAMesa(db, waveId, usuario, { expectedVersion, operationId } = {}, now = new Date()) {
  const tx = db.transaction(() => {
    if (operationId) {
      const previo = db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(operationId);
      if (previo) return { ok: true, repetido: true, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId), evento: previo };
    }
    const found = olaConVersion(db, waveId, expectedVersion); if (!found.ok) return found;
    const claim = claimVigente(db, waveId, usuario, now); if (!claim.ok) return claim;
    if (!['en_busqueda', 'en_mesa'].includes(estadoObjetivo(found.ola))) return { ok: false, code: 'WAVE_INVALID_STATE', ola: found.ola };
    if (estadoObjetivo(found.ola) === 'en_mesa') return { ok: true, ola: found.ola, repetido: true };
    const at = now.toISOString(); db.prepare("UPDATE pick_waves SET estado_operativo='en_mesa', expected_version=expected_version+1 WHERE id=?").run(waveId);
    const despues = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId); evento(db, found.ola, 'ola_en_mesa', usuario, operationId, {}, found.ola, despues, now); return { ok: true, ola: despues };
  }); return tx();
}

export function asignarUnidadMesa(db, waveId, { pedidoClave, sku, cantidad = 1, zonaId = null, motivo = null }, usuario, { expectedVersion, operationId } = {}, now = new Date()) {
  if (!pedidoClave || !sku || !Number.isInteger(cantidad) || cantidad < 1) return { ok: false, code: 'ASSIGNMENT_INVALID' };
  const tx = db.transaction(() => {
    if (operationId) {
      const repetida = db.prepare('SELECT * FROM pick_wave_assignments WHERE operation_id=?').get(operationId);
      if (repetida) return { ok: true, asignacion: repetida, repetido: true };
    }
    const found = olaConVersion(db, waveId, expectedVersion); if (!found.ok) return found;
    const claim = claimVigente(db, waveId, usuario, now); if (!claim.ok) return claim;
    if (estadoObjetivo(found.ola) !== 'en_mesa') return { ok: false, code: 'WAVE_NOT_IN_TABLE', ola: found.ola };
    if (!pedidoEnOla(db, waveId, pedidoClave)) return { ok: false, code: 'ORDER_NOT_IN_WAVE' };
    const lineasDisponibles = lineasPedido(db, pedidoClave);
    if (lineasDisponibles === null) return { ok: false, code: 'ORDER_DATA_UNAVAILABLE' };
    const esSkuDeclarado = lineasDisponibles.some((linea) => linea.sku === String(sku));
    if (!esSkuDeclarado) { const codigo = resolverCodigoProducto(db, sku); if (!codigo.ok) return codigo; sku = codigo.sku; }
    const linea = validarLineaPedido(db, pedidoClave, sku, cantidad, waveId); if (!linea.ok) return linea;
    const id = operationId || `assign:${waveId}:${pedidoClave}:${sku}:${usuario}`;
    const at = now.toISOString(); db.prepare(`INSERT INTO pick_wave_assignments (pick_wave_id,pedido_clave,sku,cantidad,zona_id,asignado_por,operation_id,creado_en,motivo) VALUES (?,?,?,?,?,?,?,?,?)`).run(waveId, pedidoClave, sku, cantidad, zonaId, usuario, id, at, motivo);
    db.prepare('UPDATE pick_waves SET expected_version=expected_version+1 WHERE id=?').run(waveId); const despues = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId); evento(db, found.ola, 'unidad_asignada_en_mesa', usuario, id, { pedido_clave: pedidoClave, sku, cantidad, motivo }, found.ola, despues, now);
    return { ok: true, asignacion: db.prepare('SELECT * FROM pick_wave_assignments WHERE operation_id=?').get(id), ola: despues };
  }); return tx();
}

export function registrarFaltante(db, waveId, { pedidoClave, sku, motivo, nota = null }, usuario, { expectedVersion, operationId } = {}, now = new Date()) {
  if (!pedidoClave || !sku || !motivo) return { ok: false, code: 'SHORTAGE_INVALID' };
  if (operationId) {
    const previo = db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(operationId);
    if (previo) return { ok: true, faltante: db.prepare('SELECT * FROM pick_wave_shortages WHERE operation_id=?').get(operationId), repetido: true, evento: previo, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId) };
  }
  const tx = db.transaction(() => { const found = olaConVersion(db, waveId, expectedVersion); if (!found.ok) return found; const claim = claimVigente(db, waveId, usuario, now); if (!claim.ok) return claim; if (estadoObjetivo(found.ola) !== 'en_mesa') return { ok: false, code: 'WAVE_NOT_IN_TABLE' }; if (!pedidoEnOla(db, waveId, pedidoClave)) return { ok: false, code: 'ORDER_NOT_IN_WAVE' }; const linea = validarLineaPedido(db, pedidoClave, sku, 0, waveId); if (linea.code === 'SKU_NOT_IN_ORDER') return linea; const id = operationId || `shortage:${waveId}:${pedidoClave}:${sku}`; const old = db.prepare('SELECT * FROM pick_wave_shortages WHERE operation_id=?').get(id); if (old) return { ok: true, faltante: old, repetido: true }; const at = now.toISOString(); db.prepare('INSERT INTO pick_wave_shortages (pick_wave_id,pedido_clave,sku,motivo,nota,registrado_por,operation_id,creado_en) VALUES (?,?,?,?,?,?,?,?)').run(waveId,pedidoClave,sku,motivo,nota,usuario,id,at); db.prepare('UPDATE pick_waves SET expected_version=expected_version+1 WHERE id=?').run(waveId); const despues=db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId); evento(db,found.ola,'faltante_registrado',usuario,id,{pedido_clave:pedidoClave,sku,motivo,nota,pedido_bloqueado:true},found.ola,despues,now); return {ok:true,faltante:db.prepare('SELECT * FROM pick_wave_shortages WHERE operation_id=?').get(id),pedido_bloqueado:true,ola:despues}; }); return tx();
}

export function resolverFaltante(db, shortageId, usuario, { expectedVersion, operationId, allowWithoutClaim = false, resolucion = null, nota = null } = {}, now = new Date()) {
  const tx = db.transaction(() => {
    const falta = db.prepare('SELECT * FROM pick_wave_shortages WHERE id=?').get(shortageId); if (!falta) return { ok: false, code: 'SHORTAGE_NOT_FOUND' };
    if (operationId) {
      const eventoPrevio = db.prepare('SELECT 1 FROM operational_day_events WHERE operation_id=?').get(operationId);
      if (eventoPrevio) return { ok: true, faltante: db.prepare('SELECT * FROM pick_wave_shortages WHERE id=?').get(shortageId), repetido: true, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(falta.pick_wave_id) };
    }
    const found = olaConVersion(db, falta.pick_wave_id, expectedVersion); if (!found.ok) return found;
    if (falta.estado === 'resuelto') return { ok: true, faltante: falta, repetido: true };
    const resoluciones = new Set(['cancelacion','diferimiento','sustitucion','resguardo']);
    if (!resoluciones.has(resolucion)) return { ok: false, code: 'SHORTAGE_RESOLUTION_REQUIRED' };
    const claim = claimVigente(db, falta.pick_wave_id, usuario, now); if (!claim.ok && !allowWithoutClaim) return claim;
    const id = operationId || `resolve-shortage:${shortageId}`;
    db.prepare("UPDATE pick_wave_shortages SET estado='resuelto',resuelto_por=?,resuelto_en=?,nota=COALESCE(?,nota) WHERE id=?").run(usuario, now.toISOString(), nota, shortageId);
    db.prepare("UPDATE pick_wave_items SET estado_operativo='resuelto',bloqueo_motivo=? WHERE pick_wave_id=? AND pedido_clave=?").run(resolucion, falta.pick_wave_id, falta.pedido_clave);
    const despues = db.prepare('SELECT * FROM pick_wave_shortages WHERE id=?').get(shortageId);
    evento(db, found.ola, 'faltante_resuelto', usuario, id, { shortage_id: shortageId, pedido_clave:falta.pedido_clave, resolucion, nota }, falta, despues, now);
    db.prepare('UPDATE pick_waves SET expected_version=expected_version+1 WHERE id=?').run(falta.pick_wave_id);
    return { ok: true, faltante: despues, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(falta.pick_wave_id) };
  }); return tx();
}

export function completarRetorno(db, returnId, usuario, { expectedVersion, operationId } = {}, now = new Date()) {
  const tx = db.transaction(() => {
    const retorno = db.prepare('SELECT * FROM pick_wave_returns WHERE id=?').get(returnId); if (!retorno) return { ok: false, code: 'RETURN_NOT_FOUND' };
    if (operationId) {
      const eventoPrevio = db.prepare('SELECT 1 FROM operational_day_events WHERE operation_id=?').get(operationId);
      if (eventoPrevio) return { ok: true, retorno: db.prepare('SELECT * FROM pick_wave_returns WHERE id=?').get(returnId), repetido: true, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(retorno.pick_wave_id) };
    }
    const found = olaConVersion(db, retorno.pick_wave_id, expectedVersion); if (!found.ok) return found;
    if (retorno.estado === 'completado') return { ok: true, retorno, repetido: true };
    const claim = claimVigente(db, retorno.pick_wave_id, usuario, now); if (!claim.ok) return claim;
    const id = operationId || `complete-return:${returnId}`;
    db.prepare("UPDATE pick_wave_returns SET estado='completado' WHERE id=?").run(returnId);
    const despues = db.prepare('SELECT * FROM pick_wave_returns WHERE id=?').get(returnId);
    evento(db, found.ola, 'retorno_urgente_completado', usuario, id, { return_id: returnId }, retorno, despues, now);
    db.prepare('UPDATE pick_waves SET expected_version=expected_version+1 WHERE id=?').run(retorno.pick_wave_id);
    return { ok: true, retorno: despues, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(retorno.pick_wave_id) };
  }); return tx();
}

export function cerrarOla(db, waveId, usuario, { expectedVersion, operationId, derivados = [] } = {}, now = new Date()) {
  if (operationId) {
    const previo = db.prepare('SELECT * FROM operational_day_events WHERE operation_id=?').get(operationId);
    if (previo) return { ok: true, ola: db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId), repetido: true, evento: previo };
  }
  const tx = db.transaction(() => { const found=olaConVersion(db,waveId,expectedVersion); if(!found.ok)return found; const claim = claimVigente(db, waveId, usuario, now); if (!claim.ok) return claim; if(estadoObjetivo(found.ola)==='cerrada')return {ok:true,ola:found.ola,repetido:true}; const estado=estadoObjetivo(found.ola); if(estado!=='en_mesa')return {ok:false,code:'WAVE_INVALID_STATE',ola:found.ola}; const pendientes=db.prepare("SELECT COUNT(*) AS n FROM pick_wave_shortages WHERE pick_wave_id=? AND (estado IS NULL OR estado='pendiente')").get(waveId).n; const retornos=db.prepare("SELECT COUNT(*) AS n FROM pick_wave_returns WHERE pick_wave_id=? AND estado='pendiente'").get(waveId).n; if(pendientes || retornos)return {ok:false,code:'WAVE_INCOMPLETE',faltantes_pendientes:pendientes,retornos_pendientes:retornos}; const pedidos=db.prepare("SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=? AND COALESCE(estado_operativo,'') NOT IN ('bloqueado_cambio_externo','resuelto')").all(waveId); for (const pedido of pedidos) { const lineas=lineasPedido(db,pedido.pedido_clave); if (lineas && lineas.length) { for (const linea of lineas) { const total=db.prepare('SELECT COALESCE(SUM(cantidad),0) AS n FROM pick_wave_assignments WHERE pick_wave_id=? AND pedido_clave=? AND sku=?').get(waveId,pedido.pedido_clave,linea.sku).n; if (Number(total)<linea.cantidad) return {ok:false,code:'WAVE_UNITS_UNRESOLVED',pedido_clave:pedido.pedido_clave,sku:linea.sku,pendientes:linea.cantidad-Number(total)}; } } else if (!db.prepare("SELECT 1 FROM pick_wave_shortages WHERE pick_wave_id=? AND pedido_clave=? AND estado='resuelto'").get(waveId, pedido.pedido_clave)) return {ok:false,code:'WAVE_ORDERS_UNRESOLVED',pedido_clave:pedido.pedido_clave}; } const allowed=new Set(['asignado','devuelto','faltante_bloqueado','resguardo']); if(!derivados.every(x=>allowed.has(x)))return {ok:false,code:'DERIVED_STATE_INVALID'}; const at=now.toISOString(); db.prepare("UPDATE pick_waves SET estado='completada', estado_operativo='cerrada', completada_en=?, expected_version=expected_version+1 WHERE id=?").run(at,waveId); const despues=db.prepare('SELECT * FROM pick_waves WHERE id=?').get(waveId); evento(db,found.ola,'ola_cerrada',usuario,operationId,{derivados},found.ola,despues,now); return {ok:true,ola:despues,derivados}; }); return tx();
}

export function eventosJornada(db, waveId) { return db.prepare('SELECT * FROM operational_day_events WHERE pick_wave_id=? ORDER BY id').all(waveId); }

function pedidoEsMlUrgente(pedido, fechaHoy, now = new Date()) {
  const esMl = pedido.canal === 'ml' || Number(pedido.espejo_ml) === 1;
  if (!esMl || pedido.estado_despacho === 'diferido') return false;
  // Urgente significa que el límite operativo vence dentro de la próxima
  // media hora: permite actuar antes del margen interno de despacho.
  if (pedido.fecha_despacho_limite) {
    const limite = new Date(pedido.fecha_despacho_limite).getTime();
    return Number.isFinite(limite) && limite - now.getTime() <= 30 * 60 * 1000;
  }
  // Compatibilidad para cachés legacy sin SLA normalizado.
  return pedido.fecha_despacho === fechaHoy;
}

function crearRetornosPorCambioExterno(db, waveId, pedidoClave, usuario, now) {
  const asignaciones = db.prepare('SELECT id, sku, zona_id FROM pick_wave_assignments WHERE pick_wave_id=? AND pedido_clave=?').all(waveId, pedidoClave);
  const at = now.toISOString();
  for (const asignacion of asignaciones) {
    const operationId = `external-return:${waveId}:${pedidoClave}:${asignacion.id}`;
    db.prepare(`INSERT OR IGNORE INTO pick_wave_returns
      (pick_wave_id, pedido_clave, sku, zona_id, estado, operation_id, creado_por, creado_en)
      VALUES (?, ?, ?, ?, 'pendiente', ?, ?, ?)`).run(waveId, pedidoClave, asignacion.sku, asignacion.zona_id, operationId, usuario, at);
  }
  return asignaciones.length;
}

export function sincronizarMiniOlas(db, now = new Date()) {
  const jornada = jornadaDeHoy(db, now);
  if (!jornada || jornada.estado !== 'abierta') {
    return { ok: true, agregados: 0, motivo: 'sin_jornada_abierta' };
  }
  const at = now.toISOString();
  const fechaHoy = fechaLocalHoy(now);

  const tx = db.transaction(() => {
    const elegiblesActuales = new Map(pedidosElegiblesOrdenados(db).map((pedido) => [pedido.clave, pedido]));
    const itemsExistentes = db.prepare(`SELECT pi.*, pw.estado_operativo AS ola_estado
      FROM pick_wave_items pi JOIN pick_waves pw ON pw.id=pi.pick_wave_id
      WHERE pw.operational_day_id=? AND pw.estado_operativo NOT IN ('cerrada')
        AND pi.estado_operativo NOT IN ('bloqueado_cambio_externo','resuelto')`).all(jornada.id);
    for (const item of itemsExistentes) {
      const actual = elegiblesActuales.get(item.pedido_clave);
      if (actual && item.items_json_snapshot) {
        const viejo = validarSnapshot(item.items_json_snapshot);
        const nuevo = validarSnapshot(actual.items_json || snapshotItemsPedido(db, item.pedido_clave));
        if (!viejo || !nuevo) {
          db.prepare("UPDATE pick_wave_items SET estado_operativo='bloqueado_cambio_externo', bloqueo_motivo=? WHERE pick_wave_id=? AND pedido_clave=? AND estado_operativo NOT IN ('bloqueado_cambio_externo','resuelto')")
            .run('snapshot_no_verificable', item.pick_wave_id, item.pedido_clave);
          const ola = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(item.pick_wave_id);
          evento(db, ola, 'pedido_bloqueado_por_snapshot_no_verificable', 'sistema', `external-snapshot:${item.pick_wave_id}:${item.pedido_clave}`, { pedido_clave: item.pedido_clave, motivo: 'snapshot_no_verificable' }, item, { estado_operativo: 'bloqueado_cambio_externo' }, now);
          continue;
        }
        if (viejo !== nuevo) {
          db.prepare("UPDATE pick_wave_items SET estado_operativo='bloqueado_cambio_externo', bloqueo_motivo=? WHERE pick_wave_id=? AND pedido_clave=? AND estado_operativo NOT IN ('bloqueado_cambio_externo','resuelto')")
            .run('lineas_del_pedido_modificadas_externamente', item.pick_wave_id, item.pedido_clave);
          const retornos = crearRetornosPorCambioExterno(db, item.pick_wave_id, item.pedido_clave, 'sistema', now);
          const ola = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(item.pick_wave_id);
          evento(db, ola, 'pedido_bloqueado_por_cambio_externo', 'sistema', `external-lines:${item.pick_wave_id}:${item.pedido_clave}`, { pedido_clave: item.pedido_clave, motivo: 'lineas_del_pedido_modificadas_externamente', retornos_pendientes: retornos }, item, { estado_operativo: 'bloqueado_cambio_externo' }, now);
        }
        continue;
      }
      if (actual) {
        db.prepare("UPDATE pick_wave_items SET estado_operativo='bloqueado_cambio_externo', bloqueo_motivo=? WHERE pick_wave_id=? AND pedido_clave=? AND estado_operativo NOT IN ('bloqueado_cambio_externo','resuelto')")
          .run('snapshot_no_verificable', item.pick_wave_id, item.pedido_clave);
        const ola = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(item.pick_wave_id);
        evento(db, ola, 'pedido_bloqueado_por_snapshot_no_verificable', 'sistema', `external-snapshot:${item.pick_wave_id}:${item.pedido_clave}`, { pedido_clave: item.pedido_clave, motivo: 'snapshot_no_verificable' }, item, { estado_operativo: 'bloqueado_cambio_externo' }, now);
        continue;
      }
      db.prepare("UPDATE pick_wave_items SET estado_operativo='bloqueado_cambio_externo', bloqueo_motivo=? WHERE pick_wave_id=? AND pedido_clave=? AND estado_operativo NOT IN ('bloqueado_cambio_externo','resuelto')")
        .run('pedido_cancelado_o_modificado_externamente', item.pick_wave_id, item.pedido_clave);
      const retornos = crearRetornosPorCambioExterno(db, item.pick_wave_id, item.pedido_clave, 'sistema', now);
      const ola = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(item.pick_wave_id);
      evento(db, ola, 'pedido_bloqueado_por_cambio_externo', 'sistema', `external-change:${item.pick_wave_id}:${item.pedido_clave}`, { pedido_clave: item.pedido_clave, motivo: 'pedido_cancelado_o_modificado_externamente', retornos_pendientes: retornos }, item, { estado_operativo: 'bloqueado_cambio_externo' }, now);
    }
    const yaAsignados = new Set(
      db.prepare(`SELECT pi.pedido_clave FROM pick_wave_items pi
        JOIN pick_waves pw ON pw.id = pi.pick_wave_id
        WHERE pw.operational_day_id = ?`).all(jornada.id).map(r => r.pedido_clave)
    );
    const pendientes = pedidosElegiblesOrdenados(db).filter(p => !yaAsignados.has(p.clave));
    if (pendientes.length === 0) return 0;

    let miniAbierta = db.prepare(
      "SELECT * FROM pick_waves WHERE operational_day_id=? AND tipo='mini' AND estado='abierta'"
    ).get(jornada.id);
    const olaActiva = db.prepare(`SELECT pw.* FROM pick_waves pw
      JOIN pick_wave_claims pc ON pc.pick_wave_id=pw.id
      WHERE pw.operational_day_id=? AND (pw.estado_operativo IN ('en_busqueda','en_mesa') OR (pw.estado='en_picking' AND pw.estado_operativo='disponible'))
        AND pc.expires_at>? ORDER BY pw.id LIMIT 1`).get(jornada.id, at);

    let agregados = 0;
    for (const pedido of pendientes) {
      if (pedidoEsMlUrgente(pedido, fechaHoy, now)) {
        if (olaActiva) {
          db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en, items_json_snapshot) VALUES (?,?,?,?)')
            .run(olaActiva.id, pedido.clave, at, pedido.items_json || snapshotItemsPedido(db, pedido.clave));
          db.prepare(`INSERT OR IGNORE INTO pick_wave_returns
            (pick_wave_id,pedido_clave,sku,estado,operation_id,creado_por,creado_en)
            VALUES (?,?,?,'pendiente',?,?,?)`)
            .run(olaActiva.id, pedido.clave, lineasPedido(db, pedido.clave)?.[0]?.sku || '', `return:${olaActiva.id}:${pedido.clave}`, 'sistema', at);
          db.prepare('UPDATE pick_waves SET expected_version=expected_version+1 WHERE id=?').run(olaActiva.id);
        } else {
          const info = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, estado_operativo, creada_en, congelada_en) VALUES (?,'ml_urgente','congelada','disponible',?,?)`)
            .run(jornada.id, at, at);
          db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en, items_json_snapshot) VALUES (?,?,?,?)')
            .run(info.lastInsertRowid, pedido.clave, at, pedido.items_json || snapshotItemsPedido(db, pedido.clave));
        }
        agregados += 1;
        continue;
      }
      if (!miniAbierta) {
        const info = db.prepare(`INSERT INTO pick_waves (operational_day_id, tipo, estado, creada_en) VALUES (?,'mini','abierta',?)`)
          .run(jornada.id, at);
        miniAbierta = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(info.lastInsertRowid);
      }
      db.prepare('INSERT INTO pick_wave_items (pick_wave_id, pedido_clave, agregado_en, items_json_snapshot) VALUES (?,?,?,?)')
        .run(miniAbierta.id, pedido.clave, at, pedido.items_json || snapshotItemsPedido(db, pedido.clave));
      agregados += 1;
    }
    return agregados;
  });
  return { ok: true, agregados: tx() };
}
