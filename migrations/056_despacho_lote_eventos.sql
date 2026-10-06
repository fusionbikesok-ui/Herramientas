-- E4: auditoría inmutable de acciones del lote, independiente de una preparación.
CREATE TABLE IF NOT EXISTS despacho_lote_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lote_id INTEGER NOT NULL REFERENCES despacho_lotes(id),
  tipo TEXT NOT NULL,
  usuario TEXT,
  detalle_json TEXT NOT NULL,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_despacho_lote_eventos_lote
  ON despacho_lote_eventos(lote_id, id);
