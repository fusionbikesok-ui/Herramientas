CREATE TABLE IF NOT EXISTS preparacion_etiquetas_manuales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preparacion_id INTEGER NOT NULL REFERENCES preparaciones(id),
  item_id INTEGER NOT NULL REFERENCES preparacion_items(id),
  sku TEXT NOT NULL DEFAULT '',
  nombre TEXT NOT NULL DEFAULT '',
  unidades INTEGER NOT NULL CHECK (unidades > 0),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','hecha')),
  creada_por TEXT,
  creada_en TEXT NOT NULL,
  hecha_por TEXT,
  hecha_en TEXT,
  UNIQUE(item_id)
);
CREATE INDEX IF NOT EXISTS idx_prep_etiquetas_manuales_estado
  ON preparacion_etiquetas_manuales(estado, preparacion_id);
