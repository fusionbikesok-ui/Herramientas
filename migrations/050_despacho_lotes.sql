-- E4: lote congelado de salida; ML y Andreani/Web nunca comparten lote.
CREATE TABLE IF NOT EXISTS despacho_lotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canal TEXT NOT NULL CHECK (canal IN ('ml', 'web')),
  fecha_jornada TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'en_preparacion', 'cerrado', 'anulado')),
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  iniciado_en TEXT,
  cerrado_en TEXT,
  motivo_anulacion TEXT
);
CREATE INDEX IF NOT EXISTS idx_despacho_lotes_jornada_canal
  ON despacho_lotes(fecha_jornada, canal, estado);
CREATE TABLE IF NOT EXISTS despacho_lote_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lote_id INTEGER NOT NULL REFERENCES despacho_lotes(id),
  control_id INTEGER NOT NULL REFERENCES despacho_controles(id),
  estado TEXT NOT NULL DEFAULT 'esperado' CHECK (estado IN ('esperado', 'escaneado', 'confirmado', 'anulado')),
  agregado_en TEXT NOT NULL,
  escaneado_en TEXT,
  confirmado_en TEXT,
  motivo_anulacion TEXT,
  UNIQUE(lote_id, control_id)
);
CREATE INDEX IF NOT EXISTS idx_despacho_lote_items_control
  ON despacho_lote_items(control_id);
