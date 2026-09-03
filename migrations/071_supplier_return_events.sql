CREATE TABLE IF NOT EXISTS stock_supplier_return_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  devolucion_id INTEGER NOT NULL REFERENCES stock_supplier_returns(id),
  evento TEXT NOT NULL,
  actor TEXT NOT NULL,
  antes_json TEXT,
  despues_json TEXT,
  motivo TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_supplier_return_events_return ON stock_supplier_return_events(devolucion_id, id);
