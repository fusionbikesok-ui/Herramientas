CREATE TABLE IF NOT EXISTS guardia_ml_aprendizajes (
  perfil TEXT NOT NULL,
  sku TEXT NOT NULL,
  confirmaciones INTEGER NOT NULL DEFAULT 0,
  ultima_confirmacion TEXT NOT NULL,
  PRIMARY KEY (perfil, sku)
);

CREATE INDEX IF NOT EXISTS idx_guardia_ml_aprendizajes_sku
  ON guardia_ml_aprendizajes(sku);
