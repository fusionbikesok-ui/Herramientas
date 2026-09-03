CREATE TABLE IF NOT EXISTS warranty_stock_commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id INTEGER NOT NULL REFERENCES warranty_cases(id),
  sku TEXT NOT NULL,
  cantidad INTEGER NOT NULL CHECK(cantidad > 0),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','comprometido','liberado','consumido')),
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  expected_version INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_warranty_commitments_case ON warranty_stock_commitments(caso_id, estado);
