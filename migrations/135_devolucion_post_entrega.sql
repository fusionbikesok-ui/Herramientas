-- Devolución post-entrega: ML canceló una venta ya despachada/entregada. No se repone stock hasta que el depósito reciba la
-- unidad. La devolución vive en stock_incidents (tipo 'otro', origen 'devolucion_cliente': el CHECK de tipo no se toca para no
-- reconstruir una tabla con FKs). Una fila por SKU de la orden; idempotente por (ml_order_id, sku).
ALTER TABLE stock_incidents ADD COLUMN origen TEXT;
ALTER TABLE stock_incidents ADD COLUMN ml_order_id TEXT;
ALTER TABLE stock_incidents ADD COLUMN wc_order_id INTEGER;
ALTER TABLE stock_incidents ADD COLUMN woo_cierre_estado TEXT CHECK (woo_cierre_estado IS NULL OR woo_cierre_estado IN ('pendiente','hecho','error'));
ALTER TABLE stock_incidents ADD COLUMN woo_cierre_error TEXT;
ALTER TABLE stock_incidents ADD COLUMN descuento_woo_en TEXT;
ALTER TABLE stock_incidents ADD COLUMN aviso_sin_llegar_en TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_incidents_devolucion_ml
  ON stock_incidents(ml_order_id, sku) WHERE origen = 'devolucion_cliente';
-- Marca de la orden: el barrido de cancelaciones no vuelve a cancelar el pedido Woo; la nota privada se agrega una sola vez.
ALTER TABLE ordenes_ml_wc_pedidos ADD COLUMN devolucion_pendiente TEXT;
ALTER TABLE ordenes_ml_wc_pedidos ADD COLUMN devolucion_nota_en TEXT;
