-- E3: estado durable del agente local, leases y resultado idempotente.
ALTER TABLE etiquetas_cola ADD COLUMN agente_id TEXT;
ALTER TABLE etiquetas_cola ADD COLUMN claim_token TEXT;
ALTER TABLE etiquetas_cola ADD COLUMN claim_hasta TEXT;
ALTER TABLE etiquetas_cola ADD COLUMN ultimo_error TEXT;
ALTER TABLE etiquetas_cola ADD COLUMN error_en TEXT;
ALTER TABLE etiquetas_cola ADD COLUMN ultimo_claim_token TEXT;
ALTER TABLE etiquetas_cola ADD COLUMN ultimo_resultado TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_etiquetas_claim_token
  ON etiquetas_cola(claim_token) WHERE claim_token IS NOT NULL;
