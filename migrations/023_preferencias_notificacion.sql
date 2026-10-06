-- Hito 7: Preferencias de notificación por usuario.
--
-- Cada usuario puede controlar qué tipos de eventos quiere recibir como notificaciones.
-- Inicialmente solo `incidentes_criticos`, pero extensible a futuro
-- (ej. `pedidos_nuevos`, `stock_bajo`, etc.).
--
-- El PK es user_id: un registro por usuario máximo.
-- DEFAULT de 1 (habilitado) para `incidentes_criticos`: la mayoría quiere enterarse de fallos críticos.
CREATE TABLE IF NOT EXISTS preferencias_notificacion (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  incidentes_criticos INTEGER NOT NULL DEFAULT 1,
  actualizado_en TEXT NOT NULL
);
