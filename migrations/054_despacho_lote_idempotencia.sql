-- E4: clave técnica de creación de lote separada del motivo operativo.
ALTER TABLE despacho_lotes ADD COLUMN idempotencia TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_despacho_lote_idempotencia ON despacho_lotes(idempotencia) WHERE idempotencia IS NOT NULL;
