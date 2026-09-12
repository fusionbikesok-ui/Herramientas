-- Gestión de pedidos: estado crudo del canal.
--
-- La 095 guardó sólo `estado_comercial` y `estado_operativo`, que son clasificaciones
-- propias y muy gruesas: al 2026-09-09, 625 de 723 pedidos caían en la misma combinación
-- ('confirmado' / 'importado'), así que la columna de estado de la pantalla no distinguía
-- nada. El estado que el operario reconoce es el del canal —'enviadoandreani',
-- 'lpaandreani', 'completed', 'paid/shipped/xd_drop_off'— y se descartaba al importar.
--
-- El plan lo pedía desde el principio ("estado del canal" en pedidos_despacho, "estado
-- externo y operativo" en la vista rápida). Además 'lpaandreani' es la condición que
-- habilita la cola de envíos: sin persistirla, esa regla no se puede implementar.
--
-- Se guarda tal cual llega, sin normalizar: la interfaz tiene que poder distinguir el
-- origen de cada afirmación, y una traducción propia perdería esa trazabilidad.
ALTER TABLE gestion_pedidos ADD COLUMN estado_canal TEXT;

CREATE INDEX IF NOT EXISTS idx_gestion_pedidos_estado_canal
  ON gestion_pedidos(estado_canal);

-- Pedido espejo: la venta de ML que el sync también crea como pedido de WooCommerce.
--
-- Sin esto, cada venta de ML entraba dos veces en la lista y el operario veía duplicados.
-- No se detectaban cruzando datos porque el espejo no comparte casi nada con su origen: el
-- nombre es el real y no el nickname de ML, la hora difiere en cerca de una hora y el
-- importe es distinto a propósito (el espejo usa el precio de contado de la web, nunca el
-- precio de venta de ML — ver "Reglas de negocio que no se rompen" en CLAUDE.md).
--
-- El vínculo sí es determinista: el espejo lleva la meta `_ml_order_id` de WooCommerce, que
-- `normalizarPedidoWc` ya sabía leer y que hasta ahora se descartaba al persistir.
--
-- Las dos filas se conservan: la lista muestra sólo la de ML cuando ambas existen, y el
-- espejo queda accesible como referencia. Si la orden de ML no llegó a importarse, el
-- espejo se sigue mostrando solo, para no perder el pedido.
ALTER TABLE gestion_pedidos ADD COLUMN espejo_ml INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gestion_pedidos ADD COLUMN ml_order_id TEXT;

CREATE INDEX IF NOT EXISTS idx_gestion_pedidos_ml_order_id
  ON gestion_pedidos(ml_order_id);
