-- E4: replay seguro de escaneos dentro de un lote.
ALTER TABLE despacho_lote_items ADD COLUMN ultima_idempotencia TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_despacho_lote_item_idempotencia
  ON despacho_lote_items(lote_id, ultima_idempotencia)
  WHERE ultima_idempotencia IS NOT NULL;
