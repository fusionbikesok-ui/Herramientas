-- E1 T4 · tarea 12: el desafío de cada ceremonia WebAuthn, y el interruptor de las passkeys.
-- SimpleWebAuthn exige pasar el desafío generado como `expectedChallenge` al verificar. En memoria se rompe
-- con dos procesos, un reinicio o dos pedidos a la vez (hallazgo 4 de la revisión externa del 2026-09-17).
-- Cada desafío tiene un propósito, un vencimiento corto y se usa una sola vez.
CREATE TABLE security.webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  proposito  text NOT NULL CHECK (proposito IN ('registro', 'login', 'reautenticacion')),
  desafio    text NOT NULL UNIQUE CHECK (desafio ~ '^[A-Za-z0-9_-]{16,128}$'),
  user_id    uuid REFERENCES security.users(id),
  creado_en  timestamptz NOT NULL DEFAULT now(),
  vence_en   timestamptz NOT NULL,
  usado_en   timestamptz,
  CHECK (vence_en > creado_en),
  -- Registrar y reautenticar son de un usuario ya identificado; el login es el que todavía no sabe quién es.
  CHECK (proposito = 'login' OR user_id IS NOT NULL)
);
CREATE INDEX webauthn_challenges_vigentes ON security.webauthn_challenges (vence_en) WHERE usado_en IS NULL;

-- El interruptor nace apagado y es la primera de las dos llaves: la segunda es la variable de entorno
-- PASSKEYS_HABILITADAS, que en producción no existe. Con una sola llave, un UPDATE habilitaba autenticación
-- real sin dominio ni HTTPS (diseño §8).
INSERT INTO security.feature_flags (code, enabled, reason)
VALUES ('passkeys.real', false, 'E1: passkeys sólo con autenticador virtual; se habilitan en E4 tras la prueba en dispositivos');
