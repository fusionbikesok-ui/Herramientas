CREATE TABLE IF NOT EXISTS workshop_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trabajo_id INTEGER NOT NULL REFERENCES workshop_jobs(id),
  sku TEXT NOT NULL,
  cantidad INTEGER NOT NULL CHECK(cantidad > 0),
  estado TEXT NOT NULL DEFAULT 'comprometido' CHECK(estado IN ('comprometido','instalado','devuelto','cancelado')),
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  expected_version INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_workshop_parts_job ON workshop_parts(trabajo_id, estado);
