ALTER TABLE warranty_cases ADD COLUMN inspeccion_resultado TEXT;
ALTER TABLE warranty_cases ADD COLUMN inspeccion_por TEXT;
ALTER TABLE warranty_cases ADD COLUMN inspeccion_en TEXT;
CREATE TABLE IF NOT EXISTS warranty_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id INTEGER NOT NULL REFERENCES warranty_cases(id),
  tipo TEXT NOT NULL CHECK(tipo IN ('foto','documento','comprobante','otro')),
  referencia TEXT NOT NULL,
  nota TEXT,
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_warranty_attachments_case ON warranty_attachments(caso_id, id);
