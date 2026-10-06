-- E18 fase 5: salida a proveedor y baja física auditada.
CREATE TABLE IF NOT EXISTS stock_supplier_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER REFERENCES stock_incidents(id),
  sku TEXT NOT NULL,
  cantidad INTEGER NOT NULL CHECK(cantidad > 0),
  proveedor TEXT NOT NULL,
  documento TEXT,
  tracking TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','preparada','enviada','recibida','cancelada')),
  motivo TEXT NOT NULL,
  creado_por TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_stock_supplier_returns_estado ON stock_supplier_returns(estado, actualizado_en, id);
