CREATE TABLE IF NOT EXISTS stock_rollout_skus (
  sku TEXT PRIMARY KEY,
  habilitado INTEGER NOT NULL DEFAULT 0,
  habilitado_por TEXT,
  habilitado_en TEXT
);
