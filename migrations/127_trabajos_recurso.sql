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
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  cerrado_en TEXT,
  PRIMARY KEY (tipo, recurso)
);
CREATE INDEX IF NOT EXISTS idx_trabajos_recurso_cola ON trabajos_recurso(estado, run_after);
