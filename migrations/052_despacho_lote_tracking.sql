-- E4: tracking informado por transportista asociado al paquete del lote.
ALTER TABLE despacho_lote_items ADD COLUMN tracking TEXT;
CREATE INDEX IF NOT EXISTS idx_despacho_lote_items_tracking ON despacho_lote_items(tracking) WHERE tracking IS NOT NULL;
