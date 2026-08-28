-- Notificaciones visibles al usuario (Hito 7 del plan de confiabilidad operativa, backend
-- de push, 2026-08-28): lo que el usuario ve en la app. Separado del log de envíos
-- (notificaciones_enviadas, migración 024): ese es "qué intentos de envío se hicieron",
-- este es "qué notificaciones tiene el usuario" — una notificación puede no haberse
-- enviado (estado='fallido' en notificaciones_enviadas) pero seguir existiendo acá para
-- que el usuario la vea y sepa que pasó algo.
--
-- Documentación humana: este .sql NO se ejecuta en runtime. El mecanismo real de creación
-- de esquema es el bloque try/exec de db/index.js.
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
