-- Historial append-only de cada incidente operativo (abierto/repetido/escalado/resuelto),
-- separado de la fila "viva" de incidentes_operativos que se pisa en cada actualización.
-- Ver lib/incidentes.js.
CREATE TABLE IF NOT EXISTS incidentes_operativos_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incidente_id INTEGER NOT NULL REFERENCES incidentes_operativos(id),
  evento TEXT NOT NULL,
  detalle_json TEXT,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidentes_hist_incidente ON incidentes_operativos_historial(incidente_id);
