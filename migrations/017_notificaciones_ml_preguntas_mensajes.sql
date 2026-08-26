-- Notificaciones ML: preguntas y mensajes sin responder (2026-08-26).
--
-- La app de ML tiene TODOS los topics seleccionados en el panel de developers (decisión del
-- usuario: más simple que ir y volver al panel cada vez que se suma una función nueva). El
-- endpoint POST /api/ml/notificacion (server.js) filtra por topic y solo procesa los que
-- tienen función implementada — hoy 'orders' (ya existía), 'questions' y 'messages'.
--
-- ml_preguntas: una fila por pregunta de ML (`id` = id real de la pregunta en ML, PK
-- natural). `estado` viene tal cual lo da la API de ML ('UNANSWERED', 'ANSWERED', etc.).
-- ml_mensajes: una fila por mensaje (post-venta u otro), `id` es TEXT porque el id de
-- mensaje de ML no es necesariamente numérico según el endpoint/versión.
--
-- Ambas se llenan vía ingerirPregunta()/ingerirMensaje() en routes/notificacionesMl.js,
-- disparadas por el webhook — no hay backfill retroactivo de lo que llegó antes de este
-- cambio (ML no reenvía notificaciones viejas).
CREATE TABLE IF NOT EXISTS ml_preguntas (
  id                INTEGER PRIMARY KEY,
  item_id           TEXT,
  texto             TEXT,
  estado            TEXT NOT NULL,
  fecha_creacion    TEXT,
  respondida_en     TEXT,
  actualizado_en    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ml_preguntas_estado ON ml_preguntas(estado);

CREATE TABLE IF NOT EXISTS ml_mensajes (
  id                TEXT PRIMARY KEY,
  pack_id           TEXT,
  order_id          TEXT,
  texto             TEXT,
  de_quien          TEXT,
  fecha_creacion    TEXT,
  respondido_en     TEXT,
  actualizado_en    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ml_mensajes_respondido ON ml_mensajes(respondido_en);
