CREATE TABLE IF NOT EXISTS warranty_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id TEXT,
  sku TEXT,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK(estado IN ('abierto','esperando_producto','en_revision','reparar','reemplazar','reembolsar','rechazado','cerrado')),
  resultado TEXT,
  motivo TEXT NOT NULL,
  responsable TEXT NOT NULL,
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  expected_version INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_warranty_cases_state ON warranty_cases(estado, actualizado_en, id);
CREATE TABLE IF NOT EXISTS warranty_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id INTEGER NOT NULL REFERENCES warranty_cases(id),
  tipo TEXT NOT NULL,
  nota TEXT NOT NULL,
  actor TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_warranty_events_case ON warranty_events(caso_id, id);
