-- GP2: modelo relacional de Gestión de pedidos.
-- No reemplaza pedidos_cache: permite poblar el modelo nuevo y comparar antes del corte.

CREATE TABLE IF NOT EXISTS gestion_pedido_clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT,
  email TEXT,
  telefono TEXT,
  documento TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gestion_pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER REFERENCES gestion_pedido_clientes(id),
  fuente TEXT NOT NULL CHECK (fuente IN ('woocommerce','mercadolibre','local','manual')),
  external_id TEXT NOT NULL,
  numero_visible TEXT,
  estado_comercial TEXT NOT NULL DEFAULT 'confirmado',
  estado_operativo TEXT NOT NULL DEFAULT 'importado',
  pago_estado TEXT,
  pago_metodo TEXT,
  cuotas INTEGER,
  moneda TEXT NOT NULL DEFAULT 'ARS',
  subtotal_centavos INTEGER,
  envio_centavos INTEGER,
  total_centavos INTEGER,
  notas TEXT,
  creado_fuente_en TEXT,
  cancelado_en TEXT,
  importado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  UNIQUE (fuente, external_id)
);

CREATE TABLE IF NOT EXISTS gestion_pedido_entregas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL UNIQUE REFERENCES gestion_pedidos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('domicilio','retiro_local','punto_entrega','sin_entrega')),
  transportista TEXT,
  tracking TEXT,
  nombre_receptor TEXT,
  direccion TEXT,
  ciudad TEXT,
  provincia TEXT,
  codigo_postal TEXT,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gestion_pedido_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES gestion_pedidos(id) ON DELETE CASCADE,
  producto_woo_id INTEGER,
  sku TEXT,
  ean TEXT,
  nombre TEXT NOT NULL,
  imagen_url TEXT,
  cantidad INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario_centavos INTEGER,
  moneda TEXT NOT NULL DEFAULT 'ARS',
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gestion_pedido_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES gestion_pedidos(id) ON DELETE CASCADE,
  evento TEXT NOT NULL,
  estado_anterior TEXT,
  estado_nuevo TEXT,
  actor_tipo TEXT NOT NULL DEFAULT 'sistema',
  actor_id INTEGER,
  datos_json TEXT,
  creado_en TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gestion_pedidos_fuente_external
  ON gestion_pedidos(fuente, external_id);
CREATE INDEX IF NOT EXISTS idx_gestion_pedidos_estado_operativo
  ON gestion_pedidos(estado_operativo, actualizado_en DESC);
CREATE INDEX IF NOT EXISTS idx_gestion_pedidos_estado_comercial
  ON gestion_pedidos(estado_comercial, cancelado_en DESC);
CREATE INDEX IF NOT EXISTS idx_gestion_pedidos_cliente
  ON gestion_pedidos(cliente_id, actualizado_en DESC);
CREATE INDEX IF NOT EXISTS idx_gestion_pedido_items_sku
  ON gestion_pedido_items(sku);
CREATE INDEX IF NOT EXISTS idx_gestion_pedido_items_ean
  ON gestion_pedido_items(ean);
CREATE INDEX IF NOT EXISTS idx_gestion_pedido_eventos_pedido
  ON gestion_pedido_eventos(pedido_id, creado_en);
