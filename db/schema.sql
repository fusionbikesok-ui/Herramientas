CREATE TABLE IF NOT EXISTS catalogo_cache (
  id_woo INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  sku TEXT,
  tipo TEXT,
  id_padre INTEGER,
  stock INTEGER,
  actualizado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalogo_cache_sku ON catalogo_cache(sku);

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

CREATE TABLE IF NOT EXISTS ordenes_ml_wc_pedidos (
  ml_order_id TEXT PRIMARY KEY,
  wc_order_id INTEGER NOT NULL,
  comprador_json TEXT,
  creado_en TEXT NOT NULL,
  cancelado_en TEXT,
  -- Timestamp en que la reserva (wc_order_id=0) quedo RETENIDA por fail-closed: el POST a
  -- Woo fallo y no se pudo verificar si el pedido llego a crearse. Mientras no sea NULL la
  -- reserva no se libera ni se reintenta sola: requiere intervencion manual.
  retenido_en TEXT
);

-- Cache de publicaciones de MercadoLibre (traídas de la API para el matcher)
CREATE TABLE IF NOT EXISTS ml_publicaciones_cache (
  clave TEXT PRIMARY KEY,          -- item_id|variation_id
  item_id TEXT NOT NULL,
  variation_id TEXT,
  titulo TEXT,
  status TEXT,
  sub_status TEXT,                  -- motivo de pausa de ML (ej. 'out_of_stock')
  es_variante INTEGER NOT NULL DEFAULT 0,
  color TEXT,                       -- atributo COLOR estructurado de ML
  talle TEXT,                       -- atributo SIZE/FRAME_SIZE estructurado de ML
  seller_sku TEXT,                  -- SELLER_SKU de ML (para auto-confirmar)
  variations_texto TEXT,            -- combo legible para mostrar
  actualizado_en TEXT NOT NULL
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

-- Pedidos de compra (agrupan recepciones y documentos bajo un mismo número de pedido)
CREATE TABLE IF NOT EXISTS pedidos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  numero_pedido   TEXT NOT NULL,
  importador      TEXT NOT NULL,
  proveedor       TEXT,
  estado          TEXT NOT NULL DEFAULT 'pendiente',
  -- 'pendiente' | 'recibido_parcial' | 'completado'
  notas           TEXT,
  drive_folder_id TEXT,
  creado_en       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_num_imp ON pedidos(numero_pedido, importador);

-- Recepciones de mercadería (cabecera)
CREATE TABLE IF NOT EXISTS recepciones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id      INTEGER,
  proveedor      TEXT NOT NULL,
  importador     TEXT,
  numero_pedido  TEXT,
  fecha          TEXT NOT NULL,
  notas          TEXT,
  estado         TEXT NOT NULL DEFAULT 'borrador',
  creado_en      TEXT NOT NULL,
  confirmado_en  TEXT
);

-- Migración: agregar confirmado_en a instancias existentes (ignorar si ya existe)
CREATE TABLE IF NOT EXISTS _schema_migrations (key TEXT PRIMARY KEY);
INSERT OR IGNORE INTO _schema_migrations VALUES ('recepciones_confirmado_en');

-- Documentos asociados a una recepción (factura, remito, OC, etc.)
CREATE TABLE IF NOT EXISTS recepcion_documentos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  recepcion_id   INTEGER NOT NULL,
  tipo           TEXT NOT NULL,
  numero         TEXT,
  nombre_archivo TEXT,
  drive_file_id  TEXT,
  drive_url      TEXT,
  creado_en      TEXT NOT NULL
);

-- Ítems de cada recepción
CREATE TABLE IF NOT EXISTS recepcion_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  recepcion_id     INTEGER NOT NULL,
  id_woo           INTEGER,
  sku              TEXT,
  nombre_doc       TEXT NOT NULL,
  codigo_proveedor TEXT,
  cantidad         INTEGER NOT NULL,
  precio_unitario  REAL,
  stock_previo     INTEGER,
  stock_nuevo      INTEGER,
  recibido         INTEGER NOT NULL DEFAULT 1,
  estado_item      TEXT,
  -- NULL/'pendiente' (borrador) | 'aplicado' | 'sin_match' | 'error' | 'no_recibido' | 'pendiente_creacion' | 'creado'
  ficha_json       TEXT,   -- ficha Gemini para pendiente_creacion (productos nuevos)
  error_wc         TEXT,   -- mensaje de error de WooCommerce si estado_item='error'
  resuelto_en      TEXT,
  creado_en        TEXT NOT NULL
);
