CREATE TABLE IF NOT EXISTS workshop_woo_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trabajo_id INTEGER NOT NULL REFERENCES workshop_jobs(id),
  total REAL NOT NULL CHECK(total >= 0),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','enviando','enviado','fallido')),
  intentos INTEGER NOT NULL DEFAULT 0, ultimo_error TEXT,
  operation_id TEXT NOT NULL UNIQUE, creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL, enviado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_workshop_woo_outbox_state ON workshop_woo_outbox(estado, actualizado_en, id);
