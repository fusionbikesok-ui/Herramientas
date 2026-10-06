-- Claim exclusivo de trabajo de una preparación. Idempotente: el runtime también
-- ejecuta este DDL desde routes/preparacion.js para bases existentes.
CREATE TABLE IF NOT EXISTS preparacion_claims (
  preparacion_id INTEGER PRIMARY KEY,
  usuario TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  renovado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_preparacion_claims_expira
  ON preparacion_claims(expires_at);
