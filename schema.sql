CREATE TABLE IF NOT EXISTS catalogo_cache (
  id_woo INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  sku TEXT,
  tipo TEXT,
  id_padre INTEGER,
  stock INTEGER,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mapeo_fusion (
  clave_normalizada TEXT PRIMARY KEY,
  id_woo INTEGER NOT NULL,
  variacion_texto TEXT,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pendientes_mapeo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre_original TEXT NOT NULL,
  clave_normalizada TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  resuelto INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sku_matcher_decisiones (
  clave TEXT PRIMARY KEY,
  sku TEXT,
  wc_nombre TEXT,
  accion TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ml_oauth_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ml_stock_estado (
  clave TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  cantidad_ml INTEGER NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ordenes_ml_procesadas (
  order_id TEXT PRIMARY KEY,
  fecha_orden TEXT NOT NULL,
  items_json TEXT NOT NULL,
  estado TEXT NOT NULL,
  procesado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direccion TEXT NOT NULL,
  clave TEXT,
  sku TEXT,
  cant_anterior INTEGER,
  cant_nueva INTEGER,
  estado TEXT NOT NULL,
  error TEXT,
  intentos INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_log_reintento ON sync_log(estado, intentos);

CREATE TABLE IF NOT EXISTS sync_estado (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
