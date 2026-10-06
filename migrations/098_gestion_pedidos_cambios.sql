-- GP8: cambios de productos y reintegros auditables.
CREATE TABLE IF NOT EXISTS gestion_pedido_cambios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES gestion_pedidos(id) ON DELETE CASCADE,
  accion TEXT NOT NULL CHECK (accion IN ('adicion','remocion')),
  producto_nombre TEXT NOT NULL,
  sku TEXT,
  cantidad INTEGER NOT NULL CHECK (cantidad > 0),
  motivo TEXT NOT NULL CHECK (motivo IN ('no_lo_quiso','no_apto_venta','falla_stock','cambio')),
  diferencia_contado_centavos INTEGER NOT NULL DEFAULT 0,
  diferencia_financiada_centavos INTEGER,
  cuotas INTEGER,
  estado TEXT NOT NULL DEFAULT 'confirmado' CHECK (estado IN ('pendiente','confirmado','anulado')),
  actor TEXT NOT NULL,
  creado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gestion_pedido_reintegros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES gestion_pedidos(id) ON DELETE CASCADE,
  cambio_id INTEGER REFERENCES gestion_pedido_cambios(id),
  importe_centavos INTEGER NOT NULL CHECK (importe_centavos > 0),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','reintegrado')),
  actor TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  reintegrado_en TEXT,
  reintegrado_por TEXT
);
CREATE INDEX IF NOT EXISTS idx_gestion_pedido_cambios_pedido ON gestion_pedido_cambios(pedido_id, creado_en);
CREATE INDEX IF NOT EXISTS idx_gestion_pedido_reintegros_pedido ON gestion_pedido_reintegros(pedido_id, creado_en);
