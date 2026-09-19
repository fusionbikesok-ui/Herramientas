-- E2 T1 tarea 9: outbox durable del legado hacia la plataforma.
--
-- La cola de la copia de sombra no sirve para esto: hace un solo intento y trabaja sobre integration_events.
-- Acá cada fila se escribe en la MISMA transacción que el cambio que la origina (una decisión del matcher), así
-- que si el cambio se hizo, el evento existe; y un despachador aparte la manda después, fuera de la respuesta
-- HTTP, con reintentos. Con la plataforma caída el matcher sigue funcionando y los eventos esperan acá.
CREATE TABLE IF NOT EXISTS outbox_plataforma (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Id del evento para la plataforma: con él deduplica un reenvío (catalog.eventos_recibidos).
  evento_id    TEXT NOT NULL UNIQUE,
  tipo         TEXT NOT NULL CHECK (tipo IN ('matcher.decision')),
  payload      TEXT NOT NULL,
  creado_en    TEXT NOT NULL,
  estado       TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviando', 'enviado', 'rechazado')),
  intentos     INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  proximo_en   TEXT NOT NULL,
  lease_hasta  TEXT,
  ultimo_error TEXT,
  enviado_en   TEXT,
  -- Reclamada si y sólo si tiene lease: el mismo contrato que las colas de la plataforma.
  CHECK ((estado = 'enviando') = (lease_hasta IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS outbox_plataforma_reclamables
  ON outbox_plataforma (estado, proximo_en, id) WHERE estado IN ('pendiente', 'enviando');
