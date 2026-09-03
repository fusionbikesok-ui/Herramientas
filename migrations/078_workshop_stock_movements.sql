ALTER TABLE stock_movements ADD COLUMN referencia_tipo TEXT;
ALTER TABLE stock_movements ADD COLUMN referencia_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_stock_movements_referencia ON stock_movements(referencia_tipo, referencia_id);
