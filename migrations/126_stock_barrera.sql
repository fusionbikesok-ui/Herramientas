-- Fase E-0 (spec 2026-10-11-fase-e-webhooks-design.md): barrera de venta ML.
-- Una venta ML descuenta stock en Woo; hasta que se confirme ese descuento, ninguna escritura de stock hacia ML
-- puede empujar el stock anterior al descuento.

-- Una fila por SKU y venta: cada venta es su propia obligación. `lineas_json` lleva TODAS las líneas de esa venta con
-- ese SKU (índice, product_id, variation_id, cantidad, manage_stock, stock_gestor_id y, tras el POST, line_item_id y name).
CREATE TABLE IF NOT EXISTS stock_refresco_pendiente (
  sku TEXT NOT NULL,
  ml_order_id TEXT NOT NULL,
  vendido_en TEXT NOT NULL,
  lineas_json TEXT NOT NULL,
  woo_confirmado INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'bloqueante' CHECK (estado IN ('bloqueante','liberable')),
  wc_order_id INTEGER,
  confirmaciones_json TEXT,
  incidente_motivo TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  PRIMARY KEY (sku, ml_order_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_refresco_orden ON stock_refresco_pendiente(ml_order_id);

-- Candado por SKU válido entre procesos. El dueño renueva `vence` mientras el PUT está en vuelo y solo él lo libera.
CREATE TABLE IF NOT EXISTS stock_lock (
  sku TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  vence TEXT NOT NULL
);

-- Estado chico de la barrera (woocommerce_manage_stock, último chequeo periódico, etc.).
CREATE TABLE IF NOT EXISTS stock_barrera_estado (
  clave TEXT PRIMARY KEY,
  valor TEXT,
  actualizado_en TEXT NOT NULL
);
