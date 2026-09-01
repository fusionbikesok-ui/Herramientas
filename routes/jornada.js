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

export function jornadaRouter(db, cfg) {
  ensureTablesJornada(db);
  const router = express.Router();
  return router;
}
