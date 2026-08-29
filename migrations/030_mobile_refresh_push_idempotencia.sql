-- Hito 7: esquema móvil y reserva durable de delivery.
--
-- La aplicación ejecutable está en `aplicarMigracionHito7` (db/index.js), porque SQLite no
-- tiene un IF DDL para distinguir una tabla nueva de un refresh legacy nullable. Ese helper
-- ejecuta este mismo cambio dentro de una transacción: si falla una tabla, reconstrucción o
-- índice, hace rollback y no escribe user_version=30. En particular, un refresh huérfano
-- (device_id IS NULL) aborta la migración en vez de descartarse.

BEGIN;

CREATE TABLE IF NOT EXISTS device_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  plataforma TEXT NOT NULL CHECK(plataforma IN ('ios', 'android', 'web')),
  nombre_dispositivo TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  revocado_en TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_unique_active
  ON device_tokens(token) WHERE revocado_en IS NULL;
CREATE INDEX IF NOT EXISTS idx_device_tokens_usuario_activo
  ON device_tokens(user_id, revocado_en) WHERE revocado_en IS NULL;

CREATE TABLE IF NOT EXISTS preferencias_notificacion (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  incidentes_criticos INTEGER NOT NULL DEFAULT 1,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notificaciones_enviadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_token_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  incidente_id INTEGER REFERENCES incidentes_operativos(id) ON DELETE SET NULL,
  estado TEXT NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  creado_en TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_dedupe
  ON notificaciones_enviadas(device_token_id, tipo, incidente_id)
  WHERE tipo IN ('nuevo', 'resuelto');
CREATE INDEX IF NOT EXISTS idx_notificaciones_pendientes
  ON notificaciones_enviadas(device_token_id, estado, creado_en)
  WHERE estado IN ('pendiente', 'fallido', 'agotado');

CREATE TABLE IF NOT EXISTS notificaciones_usuario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  cuerpo TEXT NOT NULL,
  deep_link TEXT,
  leida INTEGER NOT NULL DEFAULT 0,
  incidente_id INTEGER REFERENCES incidentes_operativos(id) ON DELETE SET NULL,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario_no_leidas
  ON notificaciones_usuario(user_id, leida, creado_en DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_usuario_dedupe
  ON notificaciones_usuario(user_id, tipo, incidente_id);

-- Funciona para una base pre-Hito7 (tabla vacía recién creada) y para el refresh legacy
-- nullable. Si una fila tiene device_id NULL, el INSERT a la tabla NOT NULL falla y el
-- BEGIN completo revierte el cambio; no se pierde ni se filtra ninguna fila.
CREATE TABLE IF NOT EXISTS mobile_refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revocado_en TEXT,
  reemplazado_por TEXT,
  creado_en TEXT NOT NULL
);
DROP INDEX IF EXISTS idx_mobile_refresh_device;
DROP TABLE IF EXISTS mobile_refresh_tokens_nueva;
CREATE TABLE mobile_refresh_tokens_nueva (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revocado_en TEXT,
  reemplazado_por TEXT,
  creado_en TEXT NOT NULL
);
INSERT INTO mobile_refresh_tokens_nueva
  (id, token_hash, user_id, device_id, expires_at, revocado_en, reemplazado_por, creado_en)
SELECT id, token_hash, user_id, device_id, expires_at, revocado_en, reemplazado_por, creado_en
  FROM mobile_refresh_tokens;
DROP TABLE mobile_refresh_tokens;
ALTER TABLE mobile_refresh_tokens_nueva RENAME TO mobile_refresh_tokens;
CREATE INDEX idx_mobile_refresh_device
  ON mobile_refresh_tokens(device_id, revocado_en);

ALTER TABLE notificaciones_enviadas ADD COLUMN idempotencia TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_idempotencia
  ON notificaciones_enviadas(idempotencia) WHERE idempotencia IS NOT NULL;

PRAGMA user_version = 30;
COMMIT;
