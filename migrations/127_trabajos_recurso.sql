-- Fase E-1a (spec 2026-10-11-fase-e-webhooks-design.md): trabajo durable POR RECURSO.
-- Un aviso nuevo del mismo recurso no crea otro trabajo: sube `generacion` y, si el trabajo estaba tomado, lo marca `dirty`
-- para que al terminar se repita en vez de cerrarse. `run_after` reprograma (nunca descarta). El recibo del aviso sigue en
-- integration_events; esta tabla es lo que hace que un reinicio entre el ACK y el efecto no pierda la venta.
CREATE TABLE IF NOT EXISTS trabajos_recurso (
  tipo TEXT NOT NULL,
  recurso TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'tomado', 'hecho', 'muerto')),
  generacion INTEGER NOT NULL DEFAULT 1,
  generacion_tomada INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  lease_hasta TEXT,
  lease_token TEXT,
  intentos INTEGER NOT NULL DEFAULT 0,           -- solo fallos reales: los diferimientos legítimos no cuentan
  diferidos INTEGER NOT NULL DEFAULT 0,          -- espera por algo que está en curso (reserva, barrera, candados…)
  diferido_desde TEXT,                           -- inicio de la espera actual (alerta si dura demasiado)
  contexto_json TEXT,                            -- p. ej. {"skus":[…]} de la orden, para no bloquear bolsas ajenas
  ultimo_error TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  cerrado_en TEXT,
  PRIMARY KEY (tipo, recurso)
);
CREATE INDEX IF NOT EXISTS idx_trabajos_recurso_cola ON trabajos_recurso(estado, run_after);

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

-- Destino excluyente por orden ML: 'pedido' (se crea el pedido Woo) o 'descuento' (orden vieja: solo se descuenta stock).
-- Se reclama en una transacción antes de cualquier efecto en Woo; el primero gana.
CREATE TABLE IF NOT EXISTS ordenes_ml_destino (
  ml_order_id TEXT PRIMARY KEY,
  destino TEXT NOT NULL CHECK (destino IN ('pedido', 'descuento')),
  creado_en TEXT NOT NULL
);
