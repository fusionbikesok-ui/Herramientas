CREATE TABLE IF NOT EXISTS recepcion_aliases_proveedor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proveedor_norm TEXT NOT NULL,
  codigo_norm TEXT NOT NULL DEFAULT '',
  descripcion_norm TEXT NOT NULL,
  variacion_norm TEXT NOT NULL DEFAULT '',
  id_woo INTEGER NOT NULL,
  sku TEXT,
  recepcion_item_id INTEGER,
  creado_por TEXT NOT NULL,
  vigente_desde TEXT NOT NULL,
  vigente_hasta TEXT,
  motivo_cierre TEXT,
  CHECK (codigo_norm <> '' OR descripcion_norm <> ''),
  CHECK ((vigente_hasta IS NULL) = (motivo_cierre IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS recepcion_alias_codigo_vigente ON recepcion_aliases_proveedor(proveedor_norm,codigo_norm) WHERE vigente_hasta IS NULL AND codigo_norm <> '';
CREATE UNIQUE INDEX IF NOT EXISTS recepcion_alias_descripcion_vigente ON recepcion_aliases_proveedor(proveedor_norm,descripcion_norm,variacion_norm) WHERE vigente_hasta IS NULL AND codigo_norm = '';
CREATE TABLE IF NOT EXISTS recepcion_altas_woo (operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, estado TEXT NOT NULL CHECK (estado IN ('procesando','creado','incierto','fallido')), modo TEXT NOT NULL, id_woo INTEGER, id_padre INTEGER, sku TEXT, respuesta_json TEXT, error TEXT, creado_por TEXT NOT NULL, creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL);
