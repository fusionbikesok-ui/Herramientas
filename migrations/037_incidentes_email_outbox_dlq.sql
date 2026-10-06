-- Marca durablemente entregas SMTP agotadas sin perder el detalle del último fallo.
ALTER TABLE incidentes_email_outbox ADD COLUMN dlq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_incidentes_email_outbox_dlq
  ON incidentes_email_outbox(dlq, estado, actualizado_en);
