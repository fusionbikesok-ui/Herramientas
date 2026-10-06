-- GP3: auditoría de corridas de importación de pedidos.
CREATE TABLE IF NOT EXISTS gestion_pedido_importaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desde TEXT NOT NULL,
  hasta TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('iniciada','completada','fallida')),
  woo_recibidos INTEGER NOT NULL DEFAULT 0,
  ml_recibidos INTEGER NOT NULL DEFAULT 0,
  importados INTEGER NOT NULL DEFAULT 0,
  creados INTEGER NOT NULL DEFAULT 0,
  actualizados INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  iniciado_en TEXT NOT NULL,
  finalizado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_gestion_pedido_importaciones_fecha
  ON gestion_pedido_importaciones(iniciado_en DESC);
