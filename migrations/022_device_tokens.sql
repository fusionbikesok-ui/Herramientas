-- Hito 7: Infraestructura backend de notificaciones push
-- Tabla de dispositivos registrados para recibir notificaciones push
-- (iOS, Android, web — bajo FCM).
--
-- Un usuario puede tener múltiples dispositivos.
-- La columna `revocado_en` es NULL mientras el dispositivo esté activo;
-- cuando se revoca, se setea a ahora() y el token deja de usarse.
--
-- Índice único en `token`: un token del proveedor (APNs/FCM) no puede
-- registrarse dos veces — el proveedor garantiza unicidad.
CREATE TABLE IF NOT EXISTS device_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  plataforma TEXT NOT NULL CHECK(plataforma IN ('ios', 'android', 'web')),
  nombre_dispositivo TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  revocado_en TEXT,
  UNIQUE(token)
);

-- Índice para queries "dame todos los tokens activos de este usuario"
-- (usado por el worker de notificaciones para enviar).
CREATE INDEX IF NOT EXISTS idx_device_tokens_usuario_activo
  ON device_tokens(user_id, revocado_en) WHERE revocado_en IS NULL;
