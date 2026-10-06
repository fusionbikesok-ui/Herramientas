-- Devolución de preparaciones canceladas (2026-09-10).
--
-- Cuando un pedido se cancela después de que alguien fue a buscar el producto, ese producto
-- queda en la mesa de embalaje: no está en su estante y nadie registra que volvió. Hasta hoy
-- la única forma de cerrar una preparación era declararla enviada, así que las canceladas
-- quedaban abiertas para siempre (dos al 2026-09-10) porque "enviada" habría sido falso.
--
-- Una devolución por preparación (UNIQUE): la confirmación es una sola por pedido, decisión
-- del usuario. La ubicación, en cambio, va por producto: el 91% de las preparaciones tiene un
-- solo producto, pero para las que tienen varios una única ubicación sería un dato inventado.
CREATE TABLE IF NOT EXISTS preparacion_devoluciones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  preparacion_id INTEGER NOT NULL UNIQUE REFERENCES preparaciones(id),
  estado         TEXT    NOT NULL DEFAULT 'pendiente',
  motivo         TEXT,
  creado_en      TEXT    NOT NULL,
  confirmado_por TEXT,
  confirmado_en  TEXT
);

CREATE INDEX IF NOT EXISTS idx_prep_devoluciones_estado
  ON preparacion_devoluciones(estado, creado_en);

-- Qué producto volvió y a qué estante. `ubicacion_id` es NULL mientras está pendiente.
CREATE TABLE IF NOT EXISTS preparacion_devolucion_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  devolucion_id  INTEGER NOT NULL REFERENCES preparacion_devoluciones(id),
  item_id        INTEGER NOT NULL REFERENCES preparacion_items(id),
  sku            TEXT,
  cantidad       INTEGER NOT NULL DEFAULT 1,
  -- Sin REFERENCES ubicaciones(id) a propósito: esa tabla la crea el router de inventario al
  -- construirse, no una migración, así que una instalación que monte preparación sin
  -- inventario no la tiene y el INSERT fallaría con "no such table". La validación de que la
  -- ubicación existe y está activa la hace el endpoint, que además exige que esté activa —
  -- una FK no cubriría eso.
  ubicacion_id   INTEGER,
  UNIQUE(devolucion_id, item_id)
);
