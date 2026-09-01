CREATE TABLE IF NOT EXISTS operational_days (
  fecha TEXT PRIMARY KEY CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  zona_horaria TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
  opened_by TEXT,
  opened_at TEXT NOT NULL,
  ml_cutoff TEXT NOT NULL CHECK (ml_cutoff GLOB '[0-2][0-9]:[0-5][0-9]'),
  web_cutoff TEXT NOT NULL CHECK (web_cutoff GLOB '[0-2][0-9]:[0-5][0-9]'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE IF NOT EXISTS pick_waves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL REFERENCES operational_days(fecha),
  tipo TEXT NOT NULL CHECK (tipo IN ('inicial','mini','prioritaria')),
  estado TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa','cerrada')),
  created_at TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS pick_wave_items (
  wave_id INTEGER NOT NULL REFERENCES pick_waves(id) ON DELETE CASCADE,
  clave TEXT NOT NULL,
  canal TEXT NOT NULL CHECK (canal IN ('ml','web')),
  fecha_pedido TEXT NOT NULL,
  prioridad INTEGER NOT NULL DEFAULT 0,
  agregado_en TEXT NOT NULL,
  PRIMARY KEY (wave_id, clave)
);
CREATE INDEX IF NOT EXISTS idx_pick_waves_fecha ON pick_waves(fecha, id);
CREATE INDEX IF NOT EXISTS idx_pick_wave_items_clave ON pick_wave_items(clave);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_waves_inicial ON pick_waves(fecha) WHERE tipo='inicial';
CREATE TRIGGER IF NOT EXISTS trg_pick_wave_item_active_unique
BEFORE INSERT ON pick_wave_items
WHEN EXISTS (SELECT 1 FROM pick_waves w JOIN pick_wave_items i ON i.wave_id=w.id
             WHERE w.fecha=(SELECT fecha FROM pick_waves WHERE id=NEW.wave_id)
               AND w.estado='activa' AND i.clave=NEW.clave)
BEGIN SELECT RAISE(ABORT, 'pedido ya pertenece a una ola activa de la jornada'); END;
