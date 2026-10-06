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
  tipo         TEXT NOT NULL CHECK (tipo IN ('matcher.decision', 'identidad.caso')),
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

-- ───────────── captura por triggers (tarea 10) ─────────────
-- Las decisiones del matcher se escriben desde 14 lugares y los casos de identidad desde unos 20. En vez de
-- tocar cada uno y confiar en un test que busque texto, la captura la hace la base: un trigger escribe la fila
-- de la outbox en la MISMA transacción que el cambio. Cubre a los escritores de hoy y a los que se agreguen.
-- El trigger guarda el hecho crudo; la traducción al formato de la plataforma la hace el despachador en JS.
--
-- El interruptor vive en una tabla porque un trigger no puede leer el entorno: el legado copia
-- OUTBOX_PLATAFORMA_CAPTURA acá al arrancar (`sincronizarCaptura`).
CREATE TABLE IF NOT EXISTS outbox_config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
INSERT OR IGNORE INTO outbox_config (clave, valor) VALUES ('captura', 'false');

CREATE TRIGGER IF NOT EXISTS outbox_matcher_alta AFTER INSERT ON sku_matcher_decisiones
WHEN (SELECT valor FROM outbox_config WHERE clave = 'captura') = 'true'
BEGIN
  INSERT INTO outbox_plataforma (evento_id, tipo, payload, creado_en, proximo_en)
  VALUES (lower(hex(randomblob(16))), 'matcher.decision',
    json_object('op', 'vigente', 'clave', NEW.clave, 'sku', NEW.sku, 'accion', NEW.accion,
                'origen', NEW.origen, 'confirmado_por', NEW.confirmado_por),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Sólo si cambia lo que la plataforma mira: los procesos automáticos reescriben filas iguales y eso no es
-- un evento.
CREATE TRIGGER IF NOT EXISTS outbox_matcher_cambio AFTER UPDATE ON sku_matcher_decisiones
WHEN (SELECT valor FROM outbox_config WHERE clave = 'captura') = 'true'
  AND (OLD.sku IS NOT NEW.sku OR OLD.accion IS NOT NEW.accion OR OLD.clave IS NOT NEW.clave)
BEGIN
  -- Si cambió la clave (no debería), la vieja deja de tener decisión.
  INSERT INTO outbox_plataforma (evento_id, tipo, payload, creado_en, proximo_en)
  SELECT lower(hex(randomblob(16))), 'matcher.decision', json_object('op', 'borrada', 'clave', OLD.clave),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE OLD.clave IS NOT NEW.clave;
  INSERT INTO outbox_plataforma (evento_id, tipo, payload, creado_en, proximo_en)
  VALUES (lower(hex(randomblob(16))), 'matcher.decision',
    json_object('op', 'vigente', 'clave', NEW.clave, 'sku', NEW.sku, 'accion', NEW.accion,
                'origen', NEW.origen, 'confirmado_por', NEW.confirmado_por),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER IF NOT EXISTS outbox_matcher_baja AFTER DELETE ON sku_matcher_decisiones
WHEN (SELECT valor FROM outbox_config WHERE clave = 'captura') = 'true'
BEGIN
  INSERT INTO outbox_plataforma (evento_id, tipo, payload, creado_en, proximo_en)
  VALUES (lower(hex(randomblob(16))), 'matcher.decision', json_object('op', 'borrada', 'clave', OLD.clave),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER IF NOT EXISTS outbox_identidad_alta AFTER INSERT ON identidad_casos
WHEN (SELECT valor FROM outbox_config WHERE clave = 'captura') = 'true'
BEGIN
  INSERT INTO outbox_plataforma (evento_id, tipo, payload, creado_en, proximo_en)
  VALUES (lower(hex(randomblob(16))), 'identidad.caso',
    json_object('id', NEW.id, 'ml_key', NEW.ml_key, 'estado', NEW.estado, 'severidad', NEW.severidad,
                'clasificacion', NEW.clasificacion, 'direccion', NEW.direccion),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Sólo cambios de estado, severidad, clasificación o dirección: la detección periódica reescribe `ultima_deteccion_en` de cientos de
-- casos en cada pasada, y eso inundaría la outbox sin decirle nada nuevo a la plataforma.
CREATE TRIGGER IF NOT EXISTS outbox_identidad_cambio AFTER UPDATE ON identidad_casos
WHEN (SELECT valor FROM outbox_config WHERE clave = 'captura') = 'true'
  AND (OLD.estado IS NOT NEW.estado OR OLD.severidad IS NOT NEW.severidad OR OLD.ml_key IS NOT NEW.ml_key
       OR OLD.clasificacion IS NOT NEW.clasificacion OR OLD.direccion IS NOT NEW.direccion)
BEGIN
  INSERT INTO outbox_plataforma (evento_id, tipo, payload, creado_en, proximo_en)
  VALUES (lower(hex(randomblob(16))), 'identidad.caso',
    json_object('id', NEW.id, 'ml_key', NEW.ml_key, 'estado', NEW.estado, 'severidad', NEW.severidad,
                'clasificacion', NEW.clasificacion, 'direccion', NEW.direccion),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
