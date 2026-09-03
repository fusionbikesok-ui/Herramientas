ALTER TABLE stock_supplier_returns ADD COLUMN expected_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE stock_supplier_returns ADD COLUMN cambiado_por TEXT;
ALTER TABLE stock_supplier_returns ADD COLUMN cambiado_en TEXT;
CREATE INDEX IF NOT EXISTS idx_stock_supplier_returns_tracking ON stock_supplier_returns(tracking);
