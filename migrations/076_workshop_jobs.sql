CREATE TABLE IF NOT EXISTS workshop_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL CHECK(tipo IN ('cliente','armado_interno','garantia')),
  cliente TEXT,
  pedido_id TEXT,
  sku TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','en_trabajo','listo','cerrado','bloqueado')),
  bloqueo TEXT,
  diagnostico TEXT,
  presupuesto REAL,
  presupuesto_estado TEXT CHECK(presupuesto_estado IS NULL OR presupuesto_estado IN ('pendiente','enviado','aprobado','rechazado')),
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  expected_version INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_workshop_jobs_state ON workshop_jobs(estado, actualizado_en, id);
CREATE TABLE IF NOT EXISTS workshop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trabajo_id INTEGER NOT NULL REFERENCES workshop_jobs(id),
  tipo TEXT NOT NULL,
  nota TEXT NOT NULL,
  actor TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_workshop_events_job ON workshop_events(trabajo_id, id);
