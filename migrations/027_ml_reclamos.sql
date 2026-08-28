-- Reclamos de MercadoLibre para el aviso de Novedades ML.
CREATE TABLE IF NOT EXISTS ml_reclamos (
  id TEXT PRIMARY KEY,
  recurso TEXT,
  estado TEXT NOT NULL,
  titulo TEXT,
  detalle TEXT,
  fecha_creacion TEXT,
  cerrado_en TEXT,
  actualizado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ml_reclamos_pendientes
  ON ml_reclamos(cerrado_en, fecha_creacion);
