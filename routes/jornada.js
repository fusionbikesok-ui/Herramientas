import express from 'express';

const now = () => new Date().toISOString();

export function ensureTablesJornada(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS operational_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL UNIQUE,
    estado TEXT NOT NULL DEFAULT 'abierta',
    hora_corte_web TEXT,
    ventana_ml_json TEXT,
    abierta_por TEXT NOT NULL,
    abierta_en TEXT NOT NULL,
    cerrada_por TEXT,
    cerrada_en TEXT,
    horarios_confirmados_por TEXT,
    horarios_confirmados_en TEXT
  )`).run();
  try { db.exec('ALTER TABLE pick_wave_helpers ADD COLUMN entrega_json TEXT'); } catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
  for (const ddl of [
    'ALTER TABLE operational_days ADD COLUMN horarios_confirmados_por TEXT',
    'ALTER TABLE operational_days ADD COLUMN horarios_confirmados_en TEXT',
  ]) { try { db.prepare(ddl).run(); } catch (_) {} }

  db.prepare(`CREATE TABLE IF NOT EXISTS pick_waves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operational_day_id INTEGER NOT NULL REFERENCES operational_days(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('inicial', 'mini', 'ml_urgente')),
    estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'congelada', 'en_picking', 'completada')),
    creada_en TEXT NOT NULL,
    congelada_en TEXT,
    congelada_por TEXT,
    completada_en TEXT
  )`).run();
  for (const ddl of [
    "ALTER TABLE pick_waves ADD COLUMN estado_operativo TEXT NOT NULL DEFAULT 'disponible'",
    'ALTER TABLE pick_waves ADD COLUMN expected_version INTEGER NOT NULL DEFAULT 1',
  ]) { try { db.prepare(ddl).run(); } catch (_) {} }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_pick_waves_day_estado ON pick_waves(operational_day_id, estado)').run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_waves_mini_abierta
    ON pick_waves(operational_day_id) WHERE tipo = 'mini' AND estado = 'abierta'`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS pick_wave_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_wave_id INTEGER NOT NULL REFERENCES pick_waves(id),
    pedido_clave TEXT NOT NULL,
    agregado_en TEXT NOT NULL
  )`).run();
  // Compatibilidad con instalaciones que crearon las tablas antes de la 043.
  // SQLite no admite ADD COLUMN IF NOT EXISTS: inspeccionamos el esquema antes
  // de alterar y luego completamos la columna desde la ola existente.
  const columnasItems = db.prepare('PRAGMA table_info(pick_wave_items)').all();
  if (!columnasItems.some((columna) => columna.name === 'operational_day_id')) {
    db.prepare('ALTER TABLE pick_wave_items ADD COLUMN operational_day_id INTEGER REFERENCES operational_days(id)').run();
  }
  if (!columnasItems.some((columna) => columna.name === 'items_json_snapshot')) {
    db.prepare('ALTER TABLE pick_wave_items ADD COLUMN items_json_snapshot TEXT').run();
  }
  db.prepare(`UPDATE pick_wave_items
    SET operational_day_id = (SELECT operational_day_id FROM pick_waves WHERE pick_waves.id = pick_wave_items.pick_wave_id)
    WHERE operational_day_id IS NULL`).run();
  db.prepare('DROP INDEX IF EXISTS uq_pick_wave_items_pedido').run();
  db.prepare('DROP INDEX IF EXISTS uq_pick_wave_items_wave_pedido').run();
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_wave_items_day_pedido ON pick_wave_items(operational_day_id, pedido_clave)').run();
  db.prepare(`CREATE TRIGGER IF NOT EXISTS trg_pick_wave_items_day_insert
    BEFORE INSERT ON pick_wave_items
    FOR EACH ROW
    WHEN EXISTS (
      SELECT 1 FROM pick_wave_items pi
      JOIN pick_waves pw ON pw.id = pi.pick_wave_id
      JOIN pick_waves nw ON nw.id = NEW.pick_wave_id
      WHERE pi.pedido_clave = NEW.pedido_clave
        AND pw.operational_day_id = nw.operational_day_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'pedido ya asignado en otra ola de la jornada');
    END`).run();
  db.prepare(`CREATE TRIGGER IF NOT EXISTS trg_pick_wave_items_day_fill
    AFTER INSERT ON pick_wave_items
    FOR EACH ROW
    WHEN NEW.operational_day_id IS NULL
    BEGIN
      UPDATE pick_wave_items SET operational_day_id =
        (SELECT operational_day_id FROM pick_waves WHERE id = NEW.pick_wave_id)
      WHERE id = NEW.id;
    END`).run();
  db.prepare(`CREATE TRIGGER IF NOT EXISTS trg_pick_wave_items_day_update
    BEFORE UPDATE OF pick_wave_id, pedido_clave, operational_day_id ON pick_wave_items
    FOR EACH ROW
    WHEN EXISTS (
      SELECT 1 FROM pick_wave_items pi
      JOIN pick_waves pw ON pw.id = pi.pick_wave_id
      JOIN pick_waves nw ON nw.id = NEW.pick_wave_id
      WHERE pi.id <> OLD.id
        AND pi.pedido_clave = NEW.pedido_clave
        AND pw.operational_day_id = nw.operational_day_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'pedido ya asignado en otra ola de la jornada');
    END`).run();

  // Claim de ola: tabla paralela a preparacion_claims (mismo patrón, misma razón: no
  // reescribir el contrato ya probado de preparacion_claims). PK simple porque a lo sumo
  // un claim vigente por ola.
  db.prepare(`CREATE TABLE IF NOT EXISTS pick_wave_claims (
    pick_wave_id INTEGER PRIMARY KEY,
    usuario TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    renovado_en TEXT NOT NULL
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_pick_wave_claims_expira ON pick_wave_claims(expires_at)').run();
  for (const ddl of [
    'ALTER TABLE pick_wave_claims ADD COLUMN pausada_en TEXT',
    'ALTER TABLE pick_wave_claims ADD COLUMN pausada_por TEXT',
    'ALTER TABLE pick_wave_claims ADD COLUMN motivo_pausa TEXT',
  ]) { try { db.prepare(ddl).run(); } catch (_) {} }

  db.prepare(`CREATE TABLE IF NOT EXISTS warehouse_pick_zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, activa INTEGER NOT NULL DEFAULT 1,
    verificada INTEGER NOT NULL DEFAULT 0, creado_por TEXT NOT NULL, creado_en TEXT NOT NULL
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS pick_wave_helpers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pick_wave_id INTEGER NOT NULL, zona_id INTEGER NOT NULL,
    ayudante TEXT NOT NULL, solicitado_por TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'solicitada',
    pedido_en_mesa_por TEXT, pedido_en_mesa_en TEXT, operation_id TEXT NOT NULL UNIQUE,
    creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS pick_wave_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pick_wave_id INTEGER NOT NULL, pedido_clave TEXT NOT NULL,
    sku TEXT NOT NULL, cantidad INTEGER NOT NULL CHECK(cantidad > 0), zona_id INTEGER,
    asignado_por TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, creado_en TEXT NOT NULL,
    expected_version INTEGER NOT NULL DEFAULT 1
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_pick_wave_assignments_wave ON pick_wave_assignments(pick_wave_id)').run();
  db.prepare(`CREATE TABLE IF NOT EXISTS pick_wave_shortages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pick_wave_id INTEGER NOT NULL, pedido_clave TEXT NOT NULL,
    sku TEXT NOT NULL, motivo TEXT NOT NULL, nota TEXT, registrado_por TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE, creado_en TEXT NOT NULL
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS pick_wave_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pick_wave_id INTEGER NOT NULL,
    pedido_clave TEXT NOT NULL, sku TEXT NOT NULL, zona_id INTEGER,
    estado TEXT NOT NULL DEFAULT 'pendiente', operation_id TEXT NOT NULL UNIQUE,
    creado_por TEXT NOT NULL, creado_en TEXT NOT NULL
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS operational_day_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, operational_day_id INTEGER NOT NULL, pick_wave_id INTEGER,
    tipo TEXT NOT NULL, usuario TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
    antes_json TEXT, despues_json TEXT, detalle_json TEXT NOT NULL, creado_en TEXT NOT NULL
  )`).run();
}

import { abrirJornada, jornadaDeHoy, reclamarOla, sincronizarMiniOlas, cerrarJornada, anotarVencimiento, reglasApertura, preflightApertura, configurarZona, iniciarBusqueda, pedirAyudaZona, recibirAyudaZona, pasarAMesa, asignarUnidadMesa, registrarFaltante, resolverFaltante, completarRetorno, cerrarOla, eventosJornada, pausarOla, reanudarOla } from '../lib/jornada.js';

export function jornadaRouter(db, cfg) {
  ensureTablesJornada(db);
  const router = express.Router();

  router.post('/abrir', (req, res) => {
    if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'horaCorteWeb') || Object.prototype.hasOwnProperty.call(req.body || {}, 'ventanaMlJson')) {
      return res.status(400).json({ ok: false, code: 'OPENING_RULES_SERVER_CONTROLLED', error: 'Las reglas de apertura son canónicas y no admiten overrides' });
    }
    if (req.body?.confirmar_horarios === false) {
      return res.status(400).json({ ok: false, code: 'SCHEDULE_CONFIRMATION_REQUIRED', error: 'Confirmá los horarios antes de abrir la jornada' });
    }
    const r = abrirJornada(db, { usuario: req.user.username, confirmarHorarios: true });
    if (!r.ok) return res.status(409).json({ ok: false, code: r.code, jornada: r.jornada });
    res.json({ ok: true, jornada: r.jornada, olaInicial: r.olaInicial,
      reglas: reglasApertura(), preflight: preflightApertura(db) });
  });

  router.get('/hoy', (req, res) => {
    res.json({ ok: true, jornada: jornadaDeHoy(db), reglas: reglasApertura(), preflight: preflightApertura(db) });
  });

  router.post('/ola/:id/reclamar', (req, res) => {
    if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
    const r = reclamarOla(db, id, req.user.username, { operationId: req.body?.operation_id, expectedVersion: req.body?.expected_version });
    if (!r.ok) {
      const status = r.code === 'WAVE_NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ ok: false, code: r.code, claim: r.claim || null });
    }
    res.json({ ok: true, claim: r.claim, olaCongelada: r.olaCongelada, olaNueva: r.olaNueva });
  });

  const usuario = (req, res) => {
    if (!req.user?.username) { res.status(401).json({ ok: false, code: 'AUTH_REQUIRED' }); return null; }
    return req.user.username;
  };
  const bodyOptions = (req) => ({ expectedVersion: req.body?.expected_version, operationId: req.body?.operation_id });
  const rol = (req) => String(req.user?.rol || req.user?.role || req.user?.perfil || '').toLowerCase();
  const puedeSupervisar = (req) => !!req.user?.is_admin || ['supervisor','supervisor_deposito','despacho'].includes(rol(req));
  const puedeAuditar = (req) => !!req.user?.is_admin || ['auditor','supervisor','supervisor_deposito','despacho'].includes(rol(req));
  const responder = (res, r) => {
    if (r.ok) return res.json(r);
    const status = r.code === 'WAVE_NOT_FOUND' || r.code === 'HELP_NOT_FOUND' || r.code === 'ZONE_NOT_FOUND' ? 404 :
      r.code?.includes('VERSION_CONFLICT') || r.code === 'WAVE_CLAIMED' ? 409 : 400;
    return res.status(status).json({ ...r, error: r.error || r.code });
  };
  router.post('/zonas', (req, res) => { const u=usuario(req,res); if(!u)return; if(!puedeSupervisar(req))return res.status(403).json({ok:false,code:'FORBIDDEN',error:'Requiere permiso de supervisor'}); responder(res, configurarZona(db, req.body || {}, u, bodyOptions(req))); });
  router.get('/zonas', (_req,res) => res.json({ ok:true, zonas: db.prepare('SELECT * FROM warehouse_pick_zones WHERE activa=1 ORDER BY nombre').all() }));
  router.post('/ola/:id/iniciar-busqueda', (req,res) => { const u=usuario(req,res); if(!u)return; responder(res,iniciarBusqueda(db,Number(req.params.id),u,bodyOptions(req))); });
  router.post('/ola/:id/pedir-ayuda', (req,res) => { const u=usuario(req,res); if(!u)return; responder(res,pedirAyudaZona(db,Number(req.params.id),req.body||{},u,bodyOptions(req))); });
  router.post('/ola/:id/pausar', (req,res) => { const u=usuario(req,res); if(!u)return; responder(res,pausarOla(db,Number(req.params.id),u,{...bodyOptions(req),motivo:req.body?.motivo})); });
  router.post('/ola/:id/reanudar', (req,res) => { const u=usuario(req,res); if(!u)return; responder(res,reanudarOla(db,Number(req.params.id),u,bodyOptions(req))); });
  router.get('/ayuda/:id', (req,res) => {
    const u = usuario(req,res); if(!u)return;
    const ayuda = db.prepare(`SELECT h.*, z.nombre AS zona_nombre
      FROM pick_wave_helpers h JOIN warehouse_pick_zones z ON z.id=h.zona_id WHERE h.id=?`).get(Number(req.params.id));
    if (!ayuda) return res.status(404).json({ ok:false, code:'HELP_NOT_FOUND', error:'HELP_NOT_FOUND' });
    const esResponsable = ayuda.ayudante === u || ayuda.solicitado_por === u;
    if (!esResponsable && !puedeSupervisar(req) && !puedeAuditar(req)) return res.status(403).json({ ok:false, code:'FORBIDDEN', error:'No tenés acceso a esta ayuda' });
    const tieneMapaUbicaciones = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='producto_ubicacion'").get()
      && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ubicaciones'").get();
    const datosNoVerificables = [];
    const items = db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=? AND estado_operativo=\'elegible\'').all(ayuda.pick_wave_id);
    const necesidades = [];
    for (const item of items) {
      const row = db.prepare('SELECT items_json FROM pedidos_cache WHERE clave=?').get(item.pedido_clave);
      try {
        const raw = row?.items_json ? JSON.parse(row.items_json) : [];
        const lines = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : []);
        for (const line of lines) {
          const sku = String(line.sku || line.SKU || line.id || '').trim();
          const cantidad = Number(line.cantidad ?? line.quantity ?? line.qty ?? 0);
          if (sku && cantidad > 0) {
            const enZona = tieneMapaUbicaciones && db.prepare(`SELECT 1 FROM producto_ubicacion pu
              JOIN ubicaciones u ON u.id=pu.ubicacion_id
              WHERE pu.sku=? AND u.activa=1 AND u.zona=? LIMIT 1`).get(sku, ayuda.zona_nombre);
            // La ayuda física no debe recibir productos de otra zona ni inventar una
            // ubicación: los SKU sin mapa quedan para la tarea de ubicar.
            if (enZona) necesidades.push({ pedido_clave:item.pedido_clave, sku, cantidad });
          }
        }
      } catch (_) { datosNoVerificables.push({ pedido_clave: item.pedido_clave, motivo: 'items_no_verificables' }); }
    }
    if (!tieneMapaUbicaciones) datosNoVerificables.push({ motivo: 'ubicaciones_no_verificables' });
    res.json({ ok:true, ayuda, tarea:{ zona_id:ayuda.zona_id, zona_nombre:ayuda.zona_nombre, necesidades, datos_no_verificables: datosNoVerificables } });
  });
  router.post('/ayuda/:id/recibir', (req,res) => {
    const u=usuario(req,res); if(!u)return;
    const ayuda = db.prepare('SELECT ayudante, solicitado_por FROM pick_wave_helpers WHERE id=?').get(Number(req.params.id));
    if (!ayuda) return res.status(404).json({ ok:false, code:'HELP_NOT_FOUND', error:'HELP_NOT_FOUND' });
    if (ayuda.ayudante !== u && ayuda.solicitado_por !== u && !puedeSupervisar(req) && !puedeAuditar(req)) {
      return res.status(403).json({ ok:false, code:'FORBIDDEN', error:'Solo el ayudante, responsable o supervisor puede recibir la ayuda' });
    }
    responder(res,recibirAyudaZona(db,Number(req.params.id),u,{...bodyOptions(req),allowWithoutClaim:puedeSupervisar(req)||puedeAuditar(req),entrega:req.body?.entrega}));
  });
  router.post('/ola/:id/pasar-a-mesa', (req,res) => { const u=usuario(req,res); if(!u)return; responder(res,pasarAMesa(db,Number(req.params.id),u,bodyOptions(req))); });
  router.post('/ola/:id/mesa/asignar', (req,res) => { const u=usuario(req,res); if(!u)return; responder(res,asignarUnidadMesa(db,Number(req.params.id),req.body||{},u,bodyOptions(req))); });
  router.post('/ola/:id/faltante', (req,res) => { const u=usuario(req,res); if(!u)return; responder(res,registrarFaltante(db,Number(req.params.id),req.body||{},u,bodyOptions(req))); });
  router.post('/faltante/:id/resolver', (req,res) => { const u=usuario(req,res); if(!u)return; if(!puedeSupervisar(req))return res.status(403).json({ok:false,code:'FORBIDDEN',error:'Requiere permiso de supervisor'}); responder(res,resolverFaltante(db,Number(req.params.id),u,{...bodyOptions(req),allowWithoutClaim:true,resolucion:req.body?.resolucion,nota:req.body?.nota})); });
  router.post('/retorno/:id/completar', (req,res) => { const u=usuario(req,res); if(!u)return; responder(res,completarRetorno(db,Number(req.params.id),u,bodyOptions(req))); });
  router.post('/ola/:id/cerrar', (req,res) => { const u=usuario(req,res); if(!u)return; if(!puedeSupervisar(req))return res.status(403).json({ok:false,code:'FORBIDDEN',error:'Requiere permiso de supervisor o despacho'}); responder(res,cerrarOla(db,Number(req.params.id),u,{...bodyOptions(req),derivados:req.body?.derivados||[]})); });
  router.get('/ola/:id/eventos', (req,res) => { if (!req.user?.username) return res.status(401).json({ok:false,code:'AUTH_REQUIRED'}); if (!puedeAuditar(req)) return res.status(403).json({ok:false,code:'FORBIDDEN'}); res.json({ ok:true, eventos:eventosJornada(db,Number(req.params.id)) }); });

  router.get('/olas', (req, res) => {
    sincronizarMiniOlas(db);
    const jornada = jornadaDeHoy(db);
    if (!jornada) return res.json({ ok: true, jornada: null, olas: [] });
    const referenciaTemporal = new Date();
    const olas = db.prepare(`SELECT pw.*, pc.usuario AS claim_usuario, pc.claimed_at, pc.expires_at, pc.renovado_en
      FROM pick_waves pw LEFT JOIN pick_wave_claims pc ON pc.pick_wave_id=pw.id
      WHERE pw.operational_day_id=? ORDER BY pw.id`).all(jornada.id)
      .map(ola => ({
        ...ola,
        claim: ola.claim_usuario
          ? anotarVencimiento({ usuario: ola.claim_usuario, claimed_at: ola.claimed_at, expires_at: ola.expires_at, renovado_en: ola.renovado_en }, referenciaTemporal)
          : null,
        items: db.prepare('SELECT pedido_clave, agregado_en, estado_operativo, bloqueo_motivo FROM pick_wave_items WHERE pick_wave_id=?').all(ola.id),
        necesidades: db.prepare('SELECT pedido_clave FROM pick_wave_items WHERE pick_wave_id=?').all(ola.id).flatMap((item) => {
          const row = db.prepare('SELECT items_json FROM pedidos_cache WHERE clave=?').get(item.pedido_clave);
          try {
            const raw = row?.items_json ? JSON.parse(row.items_json) : [];
            const lines = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : []);
            return lines.map((line) => ({ zona_id: null, pedido_clave: item.pedido_clave, sku: String(line.sku || line.SKU || line.id || ''), cantidad: Number(line.cantidad ?? line.quantity ?? line.qty ?? 0) })).filter((line) => line.sku && line.cantidad > 0);
          } catch (_) { return []; }
        }).reduce((acc, line) => { const key = `${line.sku}::${line.zona_id || 'sin_zona'}`; const old = acc.find((x) => x.key === key); if (old) old.cantidad += line.cantidad; else acc.push({ ...line, key }); return acc; }, []).map(({ key, ...line }) => line),
        ayudas: db.prepare('SELECT * FROM pick_wave_helpers WHERE pick_wave_id=? ORDER BY id').all(ola.id),
        asignaciones: db.prepare('SELECT * FROM pick_wave_assignments WHERE pick_wave_id=? ORDER BY id').all(ola.id),
        faltantes: db.prepare('SELECT * FROM pick_wave_shortages WHERE pick_wave_id=? ORDER BY id').all(ola.id),
        retornos: db.prepare('SELECT * FROM pick_wave_returns WHERE pick_wave_id=? ORDER BY id').all(ola.id),
      }));
    res.json({ ok: true, jornada, olas });
  });

  router.post('/cerrar', (req, res) => {
    if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
    if (!puedeSupervisar(req)) return res.status(403).json({ ok: false, error: 'Requiere permiso de supervisor/despacho', code: 'FORBIDDEN' });
    const r = cerrarJornada(db, req.user.username);
    if (!r.ok) return res.status(409).json({ ok: false, code: r.code });
    res.json({ ok: true, jornada: r.jornada });
  });

  return router;
}
