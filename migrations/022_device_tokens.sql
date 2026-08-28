-- Hito 7: Infraestructura backend de notificaciones push
-- Tabla de dispositivos registrados para recibir notificaciones push
-- (iOS, Android, web — bajo FCM).
--
-- Un usuario puede tener múltiples dispositivos.
-- La columna `revocado_en` es NULL mientras el dispositivo esté activo;
-- cuando se revoca, se setea a ahora() y el token deja de usarse.
--
-- Unicidad de `token`: NO es una constraint de columna — ver migración 026. Un token puede
-- reasignarse a otro usuario (mismo teléfono con otra cuenta, o el proveedor reciclando el
-- token tras una reinstalación): la fila vieja se revoca y se crea una nueva con el mismo
-- token, así que el mismo valor puede existir en más de una fila mientras a lo sumo una esté
-- activa. Eso lo impone el índice único parcial de la migración 026, no esta tabla.
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

-- Índice para queries "dame todos los tokens activos de este usuario"
-- (usado por el worker de notificaciones para enviar).
CREATE INDEX IF NOT EXISTS idx_device_tokens_usuario_activo
  ON device_tokens(user_id, revocado_en) WHERE revocado_en IS NULL;
