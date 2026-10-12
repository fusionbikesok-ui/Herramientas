-- Fase E-1a (separada de la 127, que ya recibió QA): descuento de stock de órdenes ML viejas sin pedido.
-- Orden ML pagada que llegó por aviso fuera de la ventana y nunca tuvo pedido en Woo: se descuenta el stock vendido SIN
-- crear el pedido, una sola vez por orden. `completo` corta los reintentos; `parcial` guarda el estado por línea.
CREATE TABLE IF NOT EXISTS ordenes_ml_descuento_sin_pedido (
  ml_order_id TEXT PRIMARY KEY,
  lineas_json TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'parcial' CHECK (estado IN ('parcial', 'completo')),
  actor TEXT NOT NULL DEFAULT 'sistema',
  origen TEXT NOT NULL DEFAULT 'job',
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- Reclamo 'descuento' por orden ML (orden vieja: solo se descuenta stock). Se toma en una transacción IMMEDIATE antes de
-- cualquier efecto en Woo y solo si no hay reserva ni pedido; el pedido, a su vez, reserva en otra transacción que mira este
-- reclamo. El lado 'pedido' NO se guarda aquí: lo representa la propia reserva (ordenes_ml_wc_pedidos), que se borra sola.
CREATE TABLE IF NOT EXISTS ordenes_ml_destino (
  ml_order_id TEXT PRIMARY KEY,
  destino TEXT NOT NULL CHECK (destino IN ('pedido', 'descuento')),
  creado_en TEXT NOT NULL
);
