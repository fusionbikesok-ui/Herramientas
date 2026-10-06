-- UM1: núcleo aditivo de identidad bilateral. Las tablas cache existentes siguen siendo
-- observaciones; no se convierten en fuente de identidad por esta migración.
CREATE TABLE IF NOT EXISTS identidad_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  modo TEXT NOT NULL DEFAULT 'shadow' CHECK (modo IN ('shadow', 'enforced')),
  escrituras_remotas_habilitadas INTEGER NOT NULL DEFAULT 0 CHECK (escrituras_remotas_habilitadas IN (0, 1)),
  ultimo_scan_confiable_en TEXT,
  ultimo_scan_error TEXT,
  actualizado_en TEXT NOT NULL
);
INSERT OR IGNORE INTO identidad_config (id, actualizado_en) VALUES (1, datetime('now'));

CREATE TABLE IF NOT EXISTS identidad_familias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'activa', 'archivada')),
  version INTEGER NOT NULL DEFAULT 1,
  creado_por TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identidad_reglas_familia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  familia_id INTEGER NOT NULL REFERENCES identidad_familias(id),
  version INTEGER NOT NULL,
  atributos_requeridos_json TEXT NOT NULL DEFAULT '[]',
  estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'activa', 'reemplazada')),
  creado_por TEXT,
  creado_en TEXT NOT NULL,
  UNIQUE (familia_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identidad_regla_activa
  ON identidad_reglas_familia(familia_id) WHERE estado = 'activa';

CREATE TABLE IF NOT EXISTS productos_fusion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre_canonico TEXT NOT NULL,
  familia_id INTEGER REFERENCES identidad_familias(id),
  primary_woo_id INTEGER,
  fusion_sku TEXT GENERATED ALWAYS AS
    (CASE WHEN primary_woo_id IS NULL THEN NULL ELSE 'FB-' || primary_woo_id END) STORED,
  estado TEXT NOT NULL DEFAULT 'provisional' CHECK (estado IN ('provisional', 'activo', 'archivado')),
  expected_version INTEGER NOT NULL DEFAULT 1,
  creado_por TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  archivado_en TEXT,
  UNIQUE (primary_woo_id),
  UNIQUE (fusion_sku)
);

CREATE TRIGGER IF NOT EXISTS trg_productos_fusion_sin_borrado
BEFORE DELETE ON productos_fusion
BEGIN
  SELECT RAISE(ABORT, 'Producto Fusion no admite borrado fisico');
END;

CREATE TABLE IF NOT EXISTS producto_fusion_atributos (
  producto_id INTEGER NOT NULL REFERENCES productos_fusion(id),
  clave TEXT NOT NULL,
  valor_json TEXT NOT NULL,
  regla_version INTEGER,
  actualizado_por TEXT,
  actualizado_en TEXT NOT NULL,
  PRIMARY KEY (producto_id, clave)
);

CREATE TABLE IF NOT EXISTS identidades_canal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos_fusion(id),
  canal TEXT NOT NULL CHECK (canal IN ('woo', 'ml')),
  external_key TEXT NOT NULL,
  item_id TEXT,
  variation_id TEXT,
  seller_sku_observado TEXT,
  gtin_observado TEXT,
  stock_observado INTEGER,
  stock_objetivo INTEGER,
  observado_en TEXT,
  sku_verificado_en TEXT,
  stock_verificado_en TEXT,
  evidencia_fingerprint TEXT,
  activa INTEGER NOT NULL DEFAULT 0,
  expected_version INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  archivado_en TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identidad_canal_externa_activa
  ON identidades_canal(canal, external_key) WHERE activa = 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_identidad_woo_producto_activa
  ON identidades_canal(producto_id) WHERE canal = 'woo' AND activa = 1;
CREATE INDEX IF NOT EXISTS idx_identidad_ml_producto
  ON identidades_canal(producto_id, canal, activa);

CREATE TABLE IF NOT EXISTS identificadores_producto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('fusion_sku', 'woo_sku', 'gtin')),
  valor_normalizado TEXT NOT NULL,
  producto_id INTEGER NOT NULL REFERENCES productos_fusion(id),
  estado TEXT NOT NULL DEFAULT 'reservado' CHECK (estado IN ('activo', 'historico', 'reservado')),
  transferido_desde_producto_id INTEGER REFERENCES productos_fusion(id),
  transferido_por TEXT,
  motivo_transferencia TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  UNIQUE (tipo, valor_normalizado)
);
CREATE TRIGGER IF NOT EXISTS trg_identificadores_sin_borrado
BEFORE DELETE ON identificadores_producto
BEGIN
  SELECT RAISE(ABORT, 'identificador reservado no admite borrado fisico');
END;

CREATE TABLE IF NOT EXISTS identidad_casos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direccion TEXT NOT NULL DEFAULT 'ml_fusion' CHECK (direccion IN ('ml_fusion', 'woo_ml')),
  ml_key TEXT,
  producto_id INTEGER REFERENCES productos_fusion(id),
  clasificacion TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'urgente' CHECK (estado IN ('urgente', 'tomado', 'pendiente', 'verificado', 'exceptuado', 'intervencion', 'resuelto')),
  severidad TEXT NOT NULL DEFAULT 'urgente' CHECK (severidad IN ('normal', 'urgente', 'critica')),
  responsable TEXT,
  tomado_en TEXT,
  evidencia_fingerprint TEXT NOT NULL,
  expected_version INTEGER NOT NULL DEFAULT 1,
  primera_deteccion_en TEXT NOT NULL,
  ultima_deteccion_en TEXT NOT NULL,
  resuelto_en TEXT,
  UNIQUE (direccion, ml_key)
);
CREATE INDEX IF NOT EXISTS idx_identidad_casos_cola
  ON identidad_casos(direccion, estado, severidad, primera_deteccion_en);

CREATE TABLE IF NOT EXISTS identidad_evidencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id INTEGER NOT NULL REFERENCES identidad_casos(id),
  tipo TEXT NOT NULL,
  fuente TEXT NOT NULL CHECK (fuente IN ('ml', 'woo', 'sistema', 'usuario')),
  contenido_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  confiable INTEGER NOT NULL DEFAULT 0,
  observado_en TEXT NOT NULL,
  creado_por TEXT,
  creado_en TEXT NOT NULL,
  UNIQUE (caso_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS identidad_decisiones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id INTEGER NOT NULL REFERENCES identidad_casos(id),
  producto_id INTEGER REFERENCES productos_fusion(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('vincular', 'solo_ml', 'investigar', 'excluir_canal')),
  explicacion TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  expected_version INTEGER NOT NULL,
  evidencia_fingerprint TEXT NOT NULL,
  decidida_por TEXT NOT NULL,
  decidida_en TEXT NOT NULL,
  reemplazada_por INTEGER REFERENCES identidad_decisiones(id)
);

CREATE TABLE IF NOT EXISTS identidad_excepciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id INTEGER NOT NULL REFERENCES identidad_casos(id),
  tipo TEXT NOT NULL CHECK (tipo = 'solo_ml'),
  motivo TEXT NOT NULL,
  vence_en TEXT,
  evidencia_fingerprint TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  creada_por TEXT NOT NULL,
  creada_en TEXT NOT NULL,
  invalidada_en TEXT,
  invalidada_motivo TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identidad_excepcion_activa
  ON identidad_excepciones(caso_id) WHERE activa = 1;

CREATE TABLE IF NOT EXISTS identidad_operaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  caso_id INTEGER NOT NULL REFERENCES identidad_casos(id),
  decision_id INTEGER NOT NULL REFERENCES identidad_decisiones(id),
  producto_id INTEGER NOT NULL REFERENCES productos_fusion(id),
  ml_key TEXT NOT NULL,
  sku_anterior TEXT,
  sku_objetivo TEXT NOT NULL,
  stock_objetivo INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'shadow' CHECK (estado IN ('shadow', 'pendiente', 'procesando', 'verificando', 'completada', 'fallida', 'intervencion', 'bloqueada_impacto')),
  paso_actual TEXT NOT NULL DEFAULT 'zero',
  intentos INTEGER NOT NULL DEFAULT 0,
  proximo_intento_en TEXT,
  ultimo_error TEXT,
  impacto_hermanas INTEGER NOT NULL DEFAULT 0,
  impacto_confirmado INTEGER NOT NULL DEFAULT 0,
  iniciada_en TEXT NOT NULL,
  claim_hasta TEXT,
  actualizada_en TEXT NOT NULL,
  completada_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_identidad_operaciones_pendientes
  ON identidad_operaciones(estado, proximo_intento_en, id);

CREATE TABLE IF NOT EXISTS identidad_operacion_pasos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operacion_id INTEGER NOT NULL REFERENCES identidad_operaciones(id),
  paso TEXT NOT NULL CHECK (paso IN ('zero','verify_zero','clear','verify_clear','write','verify_write','restore','verify_restore','activate','reprocess')),
  estado TEXT NOT NULL CHECK (estado IN ('pendiente', 'procesando', 'confirmado', 'fallido')),
  intento INTEGER NOT NULL,
  solicitud_json TEXT,
  respuesta_json TEXT,
  error TEXT,
  iniciado_en TEXT NOT NULL,
  finalizado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_identidad_operacion_pasos
  ON identidad_operacion_pasos(operacion_id, id);

CREATE TABLE IF NOT EXISTS identidad_notas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id INTEGER NOT NULL REFERENCES identidad_casos(id),
  nota TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  creada_por TEXT NOT NULL,
  creada_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identidad_comandos (
  operation_id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,
  entidad_tipo TEXT NOT NULL,
  entidad_id INTEGER NOT NULL,
  resultado_json TEXT NOT NULL,
  ejecutado_por TEXT NOT NULL,
  ejecutado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identidad_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entidad_tipo TEXT NOT NULL,
  entidad_id INTEGER,
  evento TEXT NOT NULL,
  actor TEXT,
  detalle_json TEXT,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identidad_historial_entidad
  ON identidad_historial(entidad_tipo, entidad_id, id);

CREATE TABLE IF NOT EXISTS identidad_eventos_integracion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canal TEXT NOT NULL CHECK (canal IN ('ml', 'woo')),
  event_key TEXT NOT NULL UNIQUE,
  entidad_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ocurrido_en TEXT,
  recibido_en TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'procesando', 'procesado', 'fallido')),
  intentos INTEGER NOT NULL DEFAULT 0,
  proximo_intento_en TEXT,
  ultimo_error TEXT,
  claim_hasta TEXT
);
CREATE INDEX IF NOT EXISTS idx_identidad_eventos_pendientes
  ON identidad_eventos_integracion(estado, proximo_intento_en, id);

CREATE TABLE IF NOT EXISTS identidad_tareas_publicacion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos_fusion(id),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'tomada', 'publicada', 'vencida', 'cancelada')),
  responsable TEXT,
  vence_en TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  expected_version INTEGER NOT NULL DEFAULT 1,
  creada_por TEXT NOT NULL,
  creada_en TEXT NOT NULL,
  actualizada_en TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identidad_tarea_producto_abierta
  ON identidad_tareas_publicacion(producto_id) WHERE estado IN ('pendiente', 'tomada', 'vencida');

CREATE TABLE IF NOT EXISTS identidad_exclusiones_canal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos_fusion(id),
  canal TEXT NOT NULL CHECK (canal = 'ml'),
  motivo TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  operation_id TEXT NOT NULL UNIQUE,
  creada_por TEXT NOT NULL,
  creada_en TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identidad_exclusion_activa
  ON identidad_exclusiones_canal(producto_id, canal) WHERE activa = 1;
