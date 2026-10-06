-- Gestión de pedidos: envío de MercadoLibre asociado a cada venta.
--
-- El estado que ML pone en la orden es de cobro, no de logística: una venta despachada
-- sigue diciendo 'paid'. Por eso "Requieren atención" mostraba como pendientes ventas que
-- ya habían salido — el caso reportado el 2026-09-09.
--
-- El estado real del envío ya vive en `ml_shipment_estado` (migración 006), que el flujo de
-- preparación mantiene al día: 'ready_to_ship', 'shipped', 'delivered', 'cancelled'. Lo que
-- faltaba era el puente, porque esa tabla se indexa por `shipment_id` y `gestion_pedidos` no
-- lo guardaba. La orden de ML lo trae en `shipping.id`.
--
-- Se guarda el identificador y no una copia del estado: el estado tiene su propia tabla y su
-- propia frescura, y duplicarlo acá crearía dos versiones del mismo hecho.
ALTER TABLE gestion_pedidos ADD COLUMN ml_shipment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_gestion_pedidos_ml_shipment
  ON gestion_pedidos(ml_shipment_id);
