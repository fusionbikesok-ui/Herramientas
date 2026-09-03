-- E18 fase 3: efectos comerciales durables, separados de la llamada a Woo.
CREATE TABLE IF NOT EXISTS stock_exception_woo_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES stock_incidents(id),
  sku TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK(delta <> 0),
  motivo TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','enviando','enviado','fallido')),
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  enviado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_stock_exception_woo_outbox_estado
  ON stock_exception_woo_outbox(estado, actualizado_en, id);
