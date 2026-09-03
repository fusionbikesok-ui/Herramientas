CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, cantidad INTEGER NOT NULL CHECK(cantidad <> 0),
  tipo TEXT NOT NULL CHECK(tipo IN ('entrada','salida','transferencia')), origen_id INTEGER, destino_id INTEGER,
  motivo TEXT NOT NULL, idempotencia TEXT NOT NULL UNIQUE, usuario TEXT, creado_en TEXT NOT NULL,
  FOREIGN KEY(origen_id) REFERENCES ubicaciones(id), FOREIGN KEY(destino_id) REFERENCES ubicaciones(id)
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_sku ON stock_movements(sku, creado_en);
