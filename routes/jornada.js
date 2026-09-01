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
    cerrada_en TEXT
  )`).run();

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
  db.prepare('CREATE INDEX IF NOT EXISTS idx_pick_waves_day_estado ON pick_waves(operational_day_id, estado)').run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_waves_mini_abierta
    ON pick_waves(operational_day_id) WHERE tipo = 'mini' AND estado = 'abierta'`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS pick_wave_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pick_wave_id INTEGER NOT NULL REFERENCES pick_waves(id),
    pedido_clave TEXT NOT NULL,
    agregado_en TEXT NOT NULL
  )`).run();
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_wave_items_pedido ON pick_wave_items(pedido_clave)').run();

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
}

import { abrirJornada, jornadaDeHoy, reclamarOla, sincronizarMiniOlas, cerrarJornada } from '../lib/jornada.js';

export function jornadaRouter(db, cfg) {
  ensureTablesJornada(db);
  const router = express.Router();

  router.post('/abrir', (req, res) => {
    if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
    const { horaCorteWeb = null, ventanaMlJson = null } = req.body || {};
    const r = abrirJornada(db, { usuario: req.user.username, horaCorteWeb, ventanaMlJson });
    if (!r.ok) return res.status(409).json({ ok: false, code: r.code, jornada: r.jornada });
    res.json({ ok: true, jornada: r.jornada, olaInicial: r.olaInicial });
  });

  router.get('/hoy', (req, res) => {
    res.json({ ok: true, jornada: jornadaDeHoy(db) });
  });

  router.post('/ola/:id/reclamar', (req, res) => {
    if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
    const r = reclamarOla(db, id, req.user.username);
    if (!r.ok) {
      const status = r.code === 'WAVE_NOT_FOUND' ? 404 : 409;
      return res.status(status).json({ ok: false, code: r.code, claim: r.claim || null });
    }
    res.json({ ok: true, claim: r.claim, olaCongelada: r.olaCongelada, olaNueva: r.olaNueva });
  });

  router.get('/olas', (req, res) => {
    sincronizarMiniOlas(db);
    const jornada = jornadaDeHoy(db);
    if (!jornada) return res.json({ ok: true, jornada: null, olas: [] });
    const olas = db.prepare('SELECT * FROM pick_waves WHERE operational_day_id=? ORDER BY id').all(jornada.id)
      .map(ola => ({
        ...ola,
        items: db.prepare('SELECT pedido_clave, agregado_en FROM pick_wave_items WHERE pick_wave_id=?').all(ola.id),
      }));
    res.json({ ok: true, jornada, olas });
  });

  router.post('/cerrar', (req, res) => {
    if (!req.user?.username) return res.status(401).json({ ok: false, error: 'No autenticado', code: 'AUTH_REQUIRED' });
    if (!req.user.is_admin) return res.status(403).json({ ok: false, error: 'Requiere permiso de supervisor/despacho', code: 'FORBIDDEN' });
    const r = cerrarJornada(db, req.user.username);
    if (!r.ok) return res.status(409).json({ ok: false, code: r.code });
    res.json({ ok: true, jornada: r.jornada });
  });

  return router;
}
