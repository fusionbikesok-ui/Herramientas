-- Hito 7: índice único parcial en device_tokens (en vez de UNIQUE(token) sobre toda la
-- columna), para soportar la reasignación de un token a otro usuario (routes/devices.js):
-- la fila vieja se revoca (revocado_en = now) y se crea una fila nueva con el mismo token
-- para el nuevo usuario, así que el mismo valor de `token` puede existir en más de una fila
-- siempre que a lo sumo una esté activa (revocado_en IS NULL).
--
-- Documentación humana: este .sql NO se ejecuta en runtime. El mecanismo real es el bloque
-- try/exec de db/index.js, que define la tabla sin UNIQUE(token) inline desde el principio
-- (esta tabla nunca llegó a desplegarse a producción con la constraint vieja, así que no
-- hizo falta ningún baile de rename/recrear tabla — a diferencia de una migración real sobre
-- datos existentes).
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_unique_active
  ON device_tokens(token) WHERE revocado_en IS NULL;
