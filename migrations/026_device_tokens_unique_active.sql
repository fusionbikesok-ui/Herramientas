-- Hito 7: Ajuste del índice UNIQUE en device_tokens
--
-- La Opción B del fix ALTO 1 (6ª pasada revisor) reasigna tokens creando una nueva fila
-- revocando la vieja. Esto requiere que el índice UNIQUE sea parcial, aplicando solo
-- a filas ACTIVAS (revocado_en IS NULL), permitiendo reasignaciones.
--
-- Cambio:
-- - Antes: UNIQUE(token) — impide duplicados sin restricción
-- - Después: UNIQUE(token) WHERE revocado_en IS NULL — permite duplicados si una fila está revocada

-- Drop el índice viejo
DROP INDEX IF EXISTS sqlite_autoindex_device_tokens_1;

-- Recrear la tabla sin el UNIQUE genérico en token (la usaremos en el índice parcial)
-- SQLite no soporta ALTER COLUMN ni DROP COLUMN directo, así que:
-- 1. Crear tabla temporal
-- 2. Copiar datos
-- 3. Dropear tabla original
-- 4. Renombrar temporal a original
-- 5. Recrear índices

CREATE TABLE device_tokens_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  plataforma TEXT NOT NULL CHECK(plataforma IN ('ios', 'android', 'web')),
  nombre_dispositivo TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  revocado_en TEXT
);

INSERT INTO device_tokens_new
SELECT id, user_id, token, plataforma, nombre_dispositivo, creado_en, actualizado_en, revocado_en
FROM device_tokens;

DROP TABLE device_tokens;

ALTER TABLE device_tokens_new RENAME TO device_tokens;

-- Crear índice UNIQUE parcial: solo aplica a filas activas (revocado_en IS NULL)
CREATE UNIQUE INDEX idx_device_tokens_unique_active
  ON device_tokens(token) WHERE revocado_en IS NULL;

-- Recrear índice de búsqueda rápida por usuario activo
CREATE INDEX idx_device_tokens_usuario_activo
  ON device_tokens(user_id, revocado_en) WHERE revocado_en IS NULL;
