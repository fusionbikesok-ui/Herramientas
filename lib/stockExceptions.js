const INCIDENT_TYPES = new Set(['faltante', 'daño', 'diferencia', 'identidad_dudosa', 'otro']);
const INCIDENT_SEVERITIES = new Set(['normal', 'alta', 'urgente']);
const TASK_TYPES = new Set(['devolver', 'reubicar', 'contar', 'inspeccionar', 'verificar', 'otro']);
const RETURN_CLASSIFICATIONS = new Set(['disponible', 'no_disponible', 'condicionado']);

function now() { return new Date().toISOString(); }
function requiredOperation(value) {
  const v = String(value || '').trim();
  if (!v || v.length > 180) throw new Error('operation_id obligatorio');
  return v;
}
function expected(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('expected_version inválida');
  return n;
}
function actor(value) { return String(value || 'sistema').trim() || 'sistema'; }
function json(value) { return value == null ? null : JSON.stringify(value); }
function audit(db, entidad, id, evento, usuario, antes, despues, motivo, operationId, ts) {
  db.prepare(`INSERT INTO stock_exception_events
    (entidad, entidad_id, evento, actor, antes_json, despues_json, motivo, operation_id, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entidad, id, evento, usuario, json(antes), json(despues), motivo || null, operationId, ts);
}
function encolarWoo(db, incidente, delta, motivo, usuario, operationId, ts) {
  if (!incidente.sku || !Number.isInteger(Number(incidente.cantidad)) || Number(incidente.cantidad) <= 0) return null;
  db.prepare(`INSERT OR IGNORE INTO stock_exception_woo_outbox
    (incident_id, sku, delta, motivo, operation_id, creado_por, creado_en, actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    incidente.id, incidente.sku, delta, motivo, operationId, usuario, ts, ts
  );
  return db.prepare('SELECT * FROM stock_exception_woo_outbox WHERE operation_id=?').get(operationId);
}
function duplicate(db, operationId, entidad) {
  const table = entidad === 'incidente' ? 'stock_incidents' : 'stock_tasks';
  const initial = db.prepare(`SELECT * FROM ${table} WHERE operation_id=?`).get(operationId);
  if (initial) return initial;
  const event = db.prepare('SELECT entidad_id FROM stock_exception_events WHERE entidad=? AND operation_id IN (?, ?)').get(entidad, operationId, `audit:${operationId}`);
  return event ? db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(event.entidad_id) : null;
}
function resultError(code, extra = {}) { return { ok: false, code, ...extra }; }
function mutationDuplicate(db, operationId, entidad, id) {
  const row = db.prepare('SELECT * FROM stock_exception_events WHERE entidad=? AND entidad_id=? AND operation_id=?').get(entidad, Number(id), operationId);
  return row ? db.prepare(`SELECT * FROM ${entidad === 'incidente' ? 'stock_incidents' : 'stock_tasks'} WHERE id=?`).get(Number(id)) : null;
}
function crearTareaEnTransaccion(db, input, op) {
  const repetido = duplicate(db, op, 'tarea');
  if (repetido) return { ok: true, repetido: true, tarea: repetido };
  if (!TASK_TYPES.has(input.tipo) || !String(input.creado_por || '').trim()) return resultError('INVALID_INPUT');
  const ts = now();
  const info = db.prepare(`INSERT INTO stock_tasks
      (incident_id,tipo,sku,ubicacion_origen_id,ubicacion_destino_id,cantidad,nota,creado_por,creado_en,operation_id)
      VALUES (@incident_id,@tipo,@sku,@ubicacion_origen_id,@ubicacion_destino_id,@cantidad,@nota,@creado_por,@creado_en,@operation_id)`).run({
    incident_id: input.incident_id ?? null, tipo: input.tipo, sku: input.sku || null,
    ubicacion_origen_id: input.ubicacion_origen_id ?? null, ubicacion_destino_id: input.ubicacion_destino_id ?? null,
    cantidad: input.cantidad ?? null, nota: input.nota || null, creado_por: actor(input.creado_por), creado_en: ts, operation_id: op,
  });
  const tarea = db.prepare('SELECT * FROM stock_tasks WHERE id=?').get(info.lastInsertRowid);
  audit(db, 'tarea', tarea.id, 'creada', actor(input.creado_por), null, tarea, tarea.nota, `audit:${op}`, ts);
  return { ok: true, tarea };
}

export function recibirDevolucion(db, id, input = {}) {
  const op = requiredOperation(input.operation_id), version = expected(input.expected_version);
  const repetido = mutationDuplicate(db, op, 'incidente', id);
  if (repetido) return { ok: true, repetido: true, incidente: repetido };
  const usuario = actor(input.recibido_por), estado = String(input.producto_estado || 'recibido').trim();
  const ts = now();
  return db.transaction(() => {
    const antes = db.prepare("SELECT * FROM stock_incidents WHERE id=? AND estado='abierto'").get(Number(id));
    if (!antes) return resultError('NOT_FOUND');
    if (antes.expected_version !== version) return resultError('VERSION_CONFLICT');
    const task = crearTareaEnTransaccion(db, { incident_id: antes.id, tipo: 'inspeccionar', sku: antes.sku, cantidad: antes.cantidad, nota: 'Inspeccionar devolución recibida', creado_por: usuario, operation_id: `${op}:inspeccion` }, `${op}:inspeccion`);
    const updated = db.prepare('UPDATE stock_incidents SET recibido_por=?, recibido_en=?, producto_estado=?, inspeccion_task_id=?, expected_version=expected_version+1 WHERE id=? AND expected_version=?').run(usuario, ts, estado, task.tarea.id, Number(id), version);
    if (!updated.changes) return resultError('VERSION_CONFLICT');
    const incidente = db.prepare('SELECT * FROM stock_incidents WHERE id=?').get(Number(id));
    audit(db, 'incidente', incidente.id, 'devolucion_recibida', usuario, antes, incidente, 'Sin aumento de stock comercial', op, ts);
    return { ok: true, incidente, tarea: task.tarea };
  })();
}

export function clasificarDevolucion(db, id, input = {}) {
  const op = requiredOperation(input.operation_id), version = expected(input.expected_version);
  const repetido = mutationDuplicate(db, op, 'incidente', id);
  if (repetido) return { ok: true, repetido: true, incidente: repetido };
  if (!RETURN_CLASSIFICATIONS.has(input.clasificacion)) return resultError('INVALID_INPUT');
  const usuario = actor(input.clasificado_por), ts = now();
  return db.transaction(() => {
    const antes = db.prepare("SELECT * FROM stock_incidents WHERE id=? AND recibido_en IS NOT NULL").get(Number(id));
    if (!antes) return resultError('NOT_FOUND');
    if (antes.expected_version !== version) return resultError('VERSION_CONFLICT');
    const changed = db.prepare('UPDATE stock_incidents SET clasificacion=?, expected_version=expected_version+1 WHERE id=? AND expected_version=?').run(input.clasificacion, Number(id), version);
    if (!changed.changes) return resultError('VERSION_CONFLICT');
    const incidente = db.prepare('SELECT * FROM stock_incidents WHERE id=?').get(Number(id));
    audit(db, 'incidente', incidente.id, 'devolucion_clasificada', usuario, antes, incidente, input.motivo || input.clasificacion, op, ts);
    const woo = input.clasificacion === 'disponible'
      ? encolarWoo(db, incidente, Number(incidente.cantidad || 0), 'devolucion disponible', usuario, `woo:${op}`, ts)
      : null;
    return { ok: true, incidente, woo };
  })();
}

export function marcarDanoDevolucion(db, id, input = {}) {
  const op = requiredOperation(input.operation_id), version = expected(input.expected_version);
  const repetido = mutationDuplicate(db, op, 'incidente', id);
  if (repetido) return { ok: true, repetido: true, incidente: repetido };
  const motivo = String(input.motivo || '').trim();
  if (!motivo) return resultError('INVALID_INPUT');
  const usuario = actor(input.marcado_por), ts = now();
  return db.transaction(() => {
    const antes = db.prepare("SELECT * FROM stock_incidents WHERE id=? AND recibido_en IS NOT NULL").get(Number(id));
    if (!antes) return resultError('NOT_FOUND');
    if (antes.expected_version !== version) return resultError('VERSION_CONFLICT');
    const task = crearTareaEnTransaccion(db, { incident_id: antes.id, tipo: 'verificar', sku: antes.sku, cantidad: antes.cantidad, nota: `Revisar daño: ${motivo}`, creado_por: usuario, operation_id: `${op}:revision` }, `${op}:revision`);
    const changed = db.prepare("UPDATE stock_incidents SET tipo='daño', severidad='urgente', clasificacion='no_disponible', dañado_en=?, nota=COALESCE(nota || ' | ', '') || ?, expected_version=expected_version+1 WHERE id=? AND expected_version=?").run(ts, motivo, Number(id), version);
    if (!changed.changes) return resultError('VERSION_CONFLICT');
    const incidente = db.prepare('SELECT * FROM stock_incidents WHERE id=?').get(Number(id));
    audit(db, 'incidente', incidente.id, 'devolucion_danada', usuario, antes, incidente, motivo, op, ts);
    const woo = encolarWoo(db, incidente, -Number(incidente.cantidad || 0), 'devolucion dañada', usuario, `woo:${op}`, ts);
    return { ok: true, incidente, tarea: task.tarea, woo };
  })();
}

export function listarWooOutbox(db, filters = {}) {
  const estado = String(filters.estado || '').trim();
  return db.prepare(`SELECT * FROM stock_exception_woo_outbox
    ${estado ? 'WHERE estado=?' : ''} ORDER BY id ASC`).all(...(estado ? [estado] : []));
}

export function crearIncidente(db, input = {}) {
  const op = requiredOperation(input.operation_id);
  const repetido = duplicate(db, op, 'incidente');
  if (repetido) return { ok: true, repetido: true, incidente: repetido };
  if (!INCIDENT_TYPES.has(input.tipo) || !INCIDENT_SEVERITIES.has(input.severidad || 'normal')) return resultError('INVALID_INPUT');
  const motivo = String(input.motivo || '').trim();
  if (!motivo || !String(input.creado_por || '').trim()) return resultError('INVALID_INPUT');
  const ts = now();
  return db.transaction(() => {
    const info = db.prepare(`INSERT INTO stock_incidents
      (tipo, severidad, sku, ubicacion_id, cantidad, motivo, nota, responsable, creado_por, creado_en, operation_id)
      VALUES (@tipo,@severidad,@sku,@ubicacion_id,@cantidad,@motivo,@nota,@responsable,@creado_por,@creado_en,@operation_id)`).run({
      tipo: input.tipo, severidad: input.severidad || 'normal', sku: input.sku || null,
      ubicacion_id: input.ubicacion_id ?? null, cantidad: input.cantidad ?? null, motivo,
      nota: input.nota || null, responsable: input.responsable || null, creado_por: actor(input.creado_por), creado_en: ts, operation_id: op,
    });
    const incidente = db.prepare('SELECT * FROM stock_incidents WHERE id=?').get(info.lastInsertRowid);
    audit(db, 'incidente', incidente.id, 'creado', actor(input.creado_por), null, incidente, motivo, `audit:${op}`, ts);
    return { ok: true, incidente };
  })();
}

export function listarIncidentes(db, filters = {}) {
  const where = [], params = [];
  if (filters.estado) { where.push('estado=?'); params.push(filters.estado); }
  if (filters.sku) { where.push('sku=?'); params.push(filters.sku); }
  if (filters.severidad) { where.push('severidad=?'); params.push(filters.severidad); }
  const sql = `SELECT * FROM stock_incidents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE severidad WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 ELSE 2 END, creado_en ASC, id ASC`;
  return db.prepare(sql).all(...params);
}

export function resolverIncidente(db, id, input = {}) {
  const op = requiredOperation(input.operation_id), version = expected(input.expected_version);
  const repetido = duplicate(db, op, 'incidente');
  if (repetido) return { ok: true, repetido: true, incidente: repetido };
  const resolucion = String(input.resolucion || '').trim();
  if (!resolucion) return resultError('INVALID_INPUT');
  const ts = now();
  return db.transaction(() => {
    const antes = db.prepare("SELECT * FROM stock_incidents WHERE id=? AND estado='abierto'").get(Number(id));
    if (!antes) return resultError('NOT_FOUND');
    const updated = db.prepare(`UPDATE stock_incidents SET estado='resuelto', resuelto_por=?, resuelto_en=?, resolucion=?, expected_version=expected_version+1 WHERE id=? AND expected_version=? AND estado='abierto'`).run(actor(input.resuelto_por), ts, resolucion, Number(id), version);
    if (!updated.changes) return resultError('VERSION_CONFLICT');
    const incidente = db.prepare('SELECT * FROM stock_incidents WHERE id=?').get(Number(id));
    audit(db, 'incidente', incidente.id, 'resuelto', actor(input.resuelto_por), antes, incidente, resolucion, `audit:${op}`, ts);
    return { ok: true, incidente };
  })();
}

export function crearTarea(db, input = {}) {
  const op = requiredOperation(input.operation_id);
  return db.transaction(() => crearTareaEnTransaccion(db, input, op))();
}

export function listarTareas(db, filters = {}) {
  const where = [], params = [];
  if (filters.estado) { where.push('estado=?'); params.push(filters.estado); }
  if (filters.incident_id) { where.push('incident_id=?'); params.push(Number(filters.incident_id)); }
  return db.prepare(`SELECT * FROM stock_tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE estado WHEN 'pendiente' THEN 0 WHEN 'tomada' THEN 1 ELSE 2 END, creado_en ASC, id ASC`).all(...params);
}

export function tomarTarea(db, id, input = {}) {
  const op = requiredOperation(input.operation_id), version = expected(input.expected_version);
  const repetido = duplicate(db, op, 'tarea');
  if (repetido) return { ok: true, repetido: true, tarea: repetido };
  const usuario = actor(input.asignado_a), ts = now();
  return db.transaction(() => {
    const antes = db.prepare("SELECT * FROM stock_tasks WHERE id=? AND estado='pendiente'").get(Number(id));
    if (!antes) return resultError('NOT_FOUND');
    const updated = db.prepare("UPDATE stock_tasks SET estado='tomada', asignado_a=?, tomada_en=?, expected_version=expected_version+1 WHERE id=? AND expected_version=? AND estado='pendiente'").run(usuario, ts, Number(id), version);
    if (!updated.changes) return resultError('VERSION_CONFLICT');
    const tarea = db.prepare('SELECT * FROM stock_tasks WHERE id=?').get(Number(id));
    audit(db, 'tarea', tarea.id, 'tomada', usuario, antes, tarea, input.motivo, `audit:${op}`, ts);
    return { ok: true, tarea };
  })();
}

export function completarTarea(db, id, input = {}) {
  const op = requiredOperation(input.operation_id), version = expected(input.expected_version);
  const repetido = duplicate(db, op, 'tarea');
  if (repetido) return { ok: true, repetido: true, tarea: repetido };
  const usuario = actor(input.completada_por), resultado = String(input.resultado || '').trim();
  if (!resultado) return resultError('INVALID_INPUT');
  const ts = now();
  return db.transaction(() => {
    const antes = db.prepare("SELECT * FROM stock_tasks WHERE id=? AND estado='tomada'").get(Number(id));
    if (!antes) return resultError('NOT_FOUND');
    if (antes.asignado_a !== usuario && !input.permitir_relevo) return resultError('TASK_NOT_OWNED');
    const updated = db.prepare("UPDATE stock_tasks SET estado='completada', resultado=?, completada_por=?, completada_en=?, expected_version=expected_version+1 WHERE id=? AND expected_version=? AND estado='tomada'").run(resultado, usuario, ts, Number(id), version);
    if (!updated.changes) return resultError('VERSION_CONFLICT');
    const tarea = db.prepare('SELECT * FROM stock_tasks WHERE id=?').get(Number(id));
    audit(db, 'tarea', tarea.id, 'completada', usuario, antes, tarea, resultado, `audit:${op}`, ts);
    return { ok: true, tarea };
  })();
}

export function listarEventosExcepcion(db, entidad, id) {
  return db.prepare('SELECT * FROM stock_exception_events WHERE entidad=? AND entidad_id=? ORDER BY id').all(entidad, Number(id));
}
