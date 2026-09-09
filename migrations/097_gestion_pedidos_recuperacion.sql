-- GP7: oportunidades de recuperación y auditoría de contacto.
CREATE TABLE IF NOT EXISTS gestion_recuperacion_oportunidades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER REFERENCES gestion_pedidos(id) ON DELETE SET NULL,
  fuente TEXT NOT NULL CHECK (fuente IN ('pedido_cancelado','carrito_abandonado')),
  external_id TEXT,
  creado_fuente_en TEXT NOT NULL,
  vence_en TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'vigente' CHECK (estado IN ('vigente','vencida','recuperada','descartada')),
  datos_json TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  UNIQUE (fuente, external_id)
);
CREATE TABLE IF NOT EXISTS gestion_recuperacion_contactos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oportunidad_id INTEGER NOT NULL REFERENCES gestion_recuperacion_oportunidades(id) ON DELETE CASCADE,
  canal TEXT NOT NULL CHECK (canal IN ('whatsapp','email')),
  estado TEXT NOT NULL DEFAULT 'contactado' CHECK (estado = 'contactado'),
  actor TEXT NOT NULL,
  contactado_en TEXT NOT NULL,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gestion_recuperacion_estado_vence
  ON gestion_recuperacion_oportunidades(estado, vence_en);
CREATE INDEX IF NOT EXISTS idx_gestion_recuperacion_pedido
  ON gestion_recuperacion_oportunidades(pedido_id);
