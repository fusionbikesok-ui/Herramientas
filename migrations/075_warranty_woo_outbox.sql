CREATE TABLE IF NOT EXISTS warranty_woo_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compromiso_id INTEGER NOT NULL REFERENCES warranty_stock_commitments(id),
  caso_id INTEGER NOT NULL REFERENCES warranty_cases(id),
  sku TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK(delta <> 0),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','enviando','enviado','fallido')),
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  enviado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_warranty_woo_outbox_state ON warranty_woo_outbox(estado, actualizado_en, id);
