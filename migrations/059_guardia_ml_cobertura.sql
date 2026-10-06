-- Guardia ML: estado operativo independiente de las decisiones históricas del matcher.
CREATE TABLE IF NOT EXISTS guardia_ml_casos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT NOT NULL UNIQUE,
  estado TEXT NOT NULL DEFAULT 'abierto',
  severidad TEXT NOT NULL DEFAULT 'normal',
  motivo TEXT NOT NULL,
  responsable TEXT,
  tomado_en TEXT,
  excepcion_motivo TEXT,
  excepcion_nota TEXT,
  excepcion_vence_en TEXT,
  bloquea_sync INTEGER NOT NULL DEFAULT 1,
  expected_version INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  resuelto_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_guardia_ml_casos_estado ON guardia_ml_casos(estado, severidad, actualizado_en DESC);

CREATE TABLE IF NOT EXISTS guardia_ml_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id INTEGER NOT NULL REFERENCES guardia_ml_casos(id),
  evento TEXT NOT NULL,
  actor TEXT,
  detalle_json TEXT,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guardia_ml_eventos_caso ON guardia_ml_eventos(caso_id, id);

CREATE TABLE IF NOT EXISTS guardia_ml_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  modo TEXT NOT NULL DEFAULT 'lectura',
  habilitado_por TEXT,
  habilitado_en TEXT,
  ultimo_scan_exitoso_en TEXT,
  ultimo_scan_error TEXT,
  actualizado_en TEXT NOT NULL
);
INSERT OR IGNORE INTO guardia_ml_config (id, actualizado_en) VALUES (1, datetime('now'));

CREATE TABLE IF NOT EXISTS guardia_ml_stock_compartido (
  sku TEXT PRIMARY KEY,
  confirmado_por TEXT,
  motivo TEXT,
  confirmado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guardia_ml_operaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id INTEGER NOT NULL REFERENCES guardia_ml_casos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('vincular','pausar')),
  sku TEXT,
  item_id TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  intentos INTEGER NOT NULL DEFAULT 0,
  proximo_intento_en TEXT NOT NULL,
  ultimo_error TEXT,
  idempotencia TEXT NOT NULL UNIQUE,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guardia_ml_operaciones_pendientes ON guardia_ml_operaciones(estado, proximo_intento_en);
