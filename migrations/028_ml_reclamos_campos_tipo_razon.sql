-- P0.1 Claims ML.
-- Instalaciones nuevas: definición completa e idempotente.
-- Bases legacy: migrations/028_ml_reclamos_campos_tipo_razon.mjs amplía columnas
-- mediante PRAGMA table_info, porque SQLite no admite ADD COLUMN IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS ml_reclamos (
  id TEXT PRIMARY KEY,
  recurso TEXT,
  estado TEXT NOT NULL,
  titulo TEXT,
  detalle TEXT,
  fecha_creacion TEXT,
  cerrado_en TEXT,
  actualizado_en TEXT NOT NULL,
  type TEXT,
  reason_id TEXT,
  resource_id TEXT,
  consultado_en_ml INTEGER NOT NULL DEFAULT 1,
  ultimo_error_en TEXT,
  intentos INTEGER NOT NULL DEFAULT 0,
  proximo_intento_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_ml_reclamos_pendientes
  ON ml_reclamos(cerrado_en, fecha_creacion);
