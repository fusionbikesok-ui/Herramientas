ALTER TABLE etiquetas_cola ADD COLUMN idempotencia TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_etiquetas_idempotencia
  ON etiquetas_cola(idempotencia) WHERE idempotencia IS NOT NULL;
