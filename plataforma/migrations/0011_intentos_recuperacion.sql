-- E1 T4 · tarea 13: los intentos de recuperación de acceso, que es donde vive el límite.
-- `security.recovery_codes` guarda los códigos, no los intentos: sin esta tabla, el límite de cinco por hora no
-- tenía dónde contarse (hallazgo 8 de la revisión del plan). Un intento contra un usuario que no existe también
-- se registra (con user_id nulo) y cuenta por IP: la respuesta no puede revelar quién tiene cuenta.
CREATE TABLE security.recovery_attempts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid REFERENCES security.users(id),
  ip           inet NOT NULL,
  intentado_en timestamptz NOT NULL,
  exitoso      boolean NOT NULL DEFAULT false
);
CREATE INDEX recovery_attempts_cuenta ON security.recovery_attempts (user_id, intentado_en DESC);
CREATE INDEX recovery_attempts_ip ON security.recovery_attempts (ip, intentado_en DESC);
CREATE INDEX recovery_attempts_fecha ON security.recovery_attempts (intentado_en DESC);
