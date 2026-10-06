-- Outbox durable para alertas de incidentes. La unicidad evita duplicados aun después
-- de reiniciar el proceso o si dos ciclos intentan reservar el mismo aviso.
CREATE TABLE IF NOT EXISTS incidentes_email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incidente_id INTEGER NOT NULL REFERENCES incidentes_operativos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK(tipo IN ('caida', 'recuperada')),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','enviando','enviado','fallido')),
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  enviado_en TEXT,
  UNIQUE(incidente_id, tipo)
);
CREATE INDEX IF NOT EXISTS idx_incidentes_email_outbox_pendiente
  ON incidentes_email_outbox(estado, actualizado_en)
  WHERE estado IN ('pendiente','fallido');
