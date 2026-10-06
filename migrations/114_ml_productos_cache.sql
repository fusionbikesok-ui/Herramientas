CREATE TABLE IF NOT EXISTS ml_productos_cache (
  product_id TEXT PRIMARY KEY,
  http_status INTEGER NOT NULL,
  status TEXT,
  nombre TEXT,
  atributos_json TEXT,
  leido_en TEXT NOT NULL
);
