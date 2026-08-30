-- U0.B: control de despacho agrupado, escaneos idempotentes y auditoría local.
CREATE TABLE IF NOT EXISTS despacho_controles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grupo_clave TEXT NOT NULL UNIQUE,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'escaneado', 'confirmado')),
  etiqueta_cola_id INTEGER,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  confirmado_por TEXT,
  confirmado_en TEXT
);
CREATE TABLE IF NOT EXISTS despacho_escaneos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  control_id INTEGER NOT NULL,
  preparacion_id INTEGER NOT NULL,
  codigo TEXT NOT NULL,
  idempotencia TEXT NOT NULL UNIQUE,
  usuario TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  CHECK (length(trim(codigo)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_despacho_escaneos_control ON despacho_escaneos(control_id, id);
CREATE TABLE IF NOT EXISTS etiquetas_cola (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, cantidad INTEGER NOT NULL,
  origen TEXT, sesion_id INTEGER, solicitado_por TEXT, nota TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente', creado_en TEXT NOT NULL, impreso_en TEXT
);
