-- E18 fase 1: excepciones físicas y tareas operativas durables.
-- Todas las mutaciones usan operation_id y expected_version desde lib/stockExceptions.js.
CREATE TABLE IF NOT EXISTS stock_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('faltante','daño','diferencia','identidad_dudosa','otro')),
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','resuelto')),
  severidad TEXT NOT NULL DEFAULT 'normal' CHECK (severidad IN ('normal','alta','urgente')),
  sku TEXT,
  ubicacion_id INTEGER,
  cantidad INTEGER CHECK (cantidad IS NULL OR cantidad > 0),
  motivo TEXT NOT NULL,
  nota TEXT,
  responsable TEXT,
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  resuelto_por TEXT,
  resuelto_en TEXT,
  resolucion TEXT,
  expected_version INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_stock_incidents_estado
  ON stock_incidents(estado, severidad, creado_en);
CREATE INDEX IF NOT EXISTS idx_stock_incidents_sku
  ON stock_incidents(sku, creado_en);

CREATE TABLE IF NOT EXISTS stock_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER REFERENCES stock_incidents(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('devolver','reubicar','contar','inspeccionar','verificar','otro')),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','tomada','completada')),
  sku TEXT,
  ubicacion_origen_id INTEGER,
  ubicacion_destino_id INTEGER,
  cantidad INTEGER CHECK (cantidad IS NULL OR cantidad > 0),
  nota TEXT,
  asignado_a TEXT,
  tomada_en TEXT,
  vence_en TEXT,
  completada_por TEXT,
  completada_en TEXT,
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  resultado TEXT,
  expected_version INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_stock_tasks_estado
  ON stock_tasks(estado, vence_en, creado_en);
CREATE INDEX IF NOT EXISTS idx_stock_tasks_incident
  ON stock_tasks(incident_id, estado);

CREATE TABLE IF NOT EXISTS stock_exception_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entidad TEXT NOT NULL CHECK (entidad IN ('incidente','tarea')),
  entidad_id INTEGER NOT NULL,
  evento TEXT NOT NULL,
  actor TEXT NOT NULL,
  antes_json TEXT,
  despues_json TEXT,
  motivo TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_exception_events_entity
  ON stock_exception_events(entidad, entidad_id, id);
