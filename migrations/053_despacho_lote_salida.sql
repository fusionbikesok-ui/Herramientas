-- E4: confirmación de entrega física del lote al transportista.
ALTER TABLE despacho_lotes ADD COLUMN salida_confirmada_por TEXT;
ALTER TABLE despacho_lotes ADD COLUMN salida_confirmada_en TEXT;
ALTER TABLE despacho_lotes ADD COLUMN salida_idempotencia TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_despacho_lote_salida_idem ON despacho_lotes(salida_idempotencia) WHERE salida_idempotencia IS NOT NULL;
