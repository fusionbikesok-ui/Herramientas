-- ALTO 2 fix: añadir estado 'agotado' para notificaciones que superaron el tope de reintentos.
--
-- Estado terminal: cuando un dispositivo ha agotado sus 3 reintentos, en lugar de seguir
-- saltándolo silenciosamente, marcamos la fila como 'agotado' para que quede registrado
-- que ya no se va a reintentar más.

-- SQLite no permite ALTER COLUMN en CHECK, así que crearemos una nueva tabla sin el CHECK
-- y copiaremos los datos.

ALTER TABLE notificaciones_enviadas RENAME TO notificaciones_enviadas_old;

CREATE TABLE IF NOT EXISTS notificaciones_enviadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_token_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  incidente_id INTEGER REFERENCES incidentes_operativos(id) ON DELETE SET NULL,
  estado TEXT NOT NULL,
  -- 'pendiente', 'enviado', 'fallido', 'agotado' (cuando excede reintentos)
  intentos INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  creado_en TEXT NOT NULL
);

-- Copiar datos de la tabla vieja
INSERT INTO notificaciones_enviadas
SELECT id, device_token_id, tipo, incidente_id, estado, intentos, error, creado_en
FROM notificaciones_enviadas_old;

-- Recrear índices (es importante mantener la semántica)
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_dedupe
  ON notificaciones_enviadas(device_token_id, tipo, incidente_id)
  WHERE tipo IN ('nuevo', 'resuelto');

CREATE INDEX IF NOT EXISTS idx_notificaciones_pendientes
  ON notificaciones_enviadas(device_token_id, estado, creado_en)
  WHERE estado IN ('pendiente', 'fallido', 'agotado');

-- Eliminar tabla vieja
DROP TABLE notificaciones_enviadas_old;
