CREATE TABLE IF NOT EXISTS guardia_ml_pedidos_retenidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ml_order_id TEXT NOT NULL UNIQUE,
  motivo TEXT NOT NULL,
  items_json TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'retenido',
  responsable TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  liberado_en TEXT,
  liberado_por TEXT
);
CREATE INDEX IF NOT EXISTS idx_guardia_ml_pedidos_estado ON guardia_ml_pedidos_retenidos(estado);
CREATE TABLE IF NOT EXISTS guardia_ml_stock_compartido_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  evento TEXT NOT NULL,
  actor TEXT NOT NULL,
  motivo TEXT NOT NULL,
  creado_en TEXT NOT NULL
);
