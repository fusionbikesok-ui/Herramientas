-- E6: contexto externo del caso y ciclo de reconocimiento/escalamiento de la bandeja.
--
-- Aditiva e idempotente. No se agregan `question_id`, `claim_id` ni `external_type`: el par
-- (`kind`, `resource_id`) ya los identifica —pregunta e id de ML, reclamo e id de ML— y
-- duplicarlos crea dos fuentes para el mismo dato que pueden divergir en silencio.
--
-- Sí se agregan los que no se pueden derivar de lo que ya hay: el pack y la orden de una
-- conversación posventa, el ítem publicado, y el estado externo con su marca de frescura,
-- que es lo que permite decidir si el detalle que se muestra sigue siendo válido.

-- NO es reaplicable con `ALTER TABLE ... ADD COLUMN` a secas: SQLite no soporta
-- `ADD COLUMN IF NOT EXISTS`. La fuente que se ejecuta de verdad es el bloque guardado de
-- `db/index.js` (clave `inbox_contexto_externo_094`), que consulta `PRAGMA table_info` antes
-- de cada ALTER y corre en cada `openDb()`. Este archivo queda como la declaración legible
-- del esquema y su porqué; si se aplica a mano sobre una base que ya arrancó, va a fallar con
-- `duplicate column name`, y eso significa que la migración ya está puesta.

ALTER TABLE inbox_items ADD COLUMN pack_id TEXT;
ALTER TABLE inbox_items ADD COLUMN order_id TEXT;
ALTER TABLE inbox_items ADD COLUMN item_id TEXT;
ALTER TABLE inbox_items ADD COLUMN external_status TEXT;
ALTER TABLE inbox_items ADD COLUMN last_synced_at TEXT;

-- Acciones que Mercado Libre declara para nuestro rol, tal como vienen: objetos
-- `{action, mandatory, due_date}` dentro de `players[]` (§4.2 de la especificación de ML).
-- Se guarda el JSON crudo y no una lista de nombres porque `mandatory` y `due_date` son el
-- plazo que manda para un caso de ML, y perderlos obligaría a inventar un reloj propio.
-- NULL significa DESCONOCIDO, no "ninguna acción" (§4.3): son cosas distintas y con la
-- primera no se habilita ni se esconde un botón.
ALTER TABLE inbox_items ADD COLUMN external_actions TEXT;

-- Reconocer no es resolver: §14 los distingue y hasta ahora la tabla no podía expresarlo.
-- Un caso reconocido sigue abierto y sigue contando como trabajo pendiente.
ALTER TABLE inbox_items ADD COLUMN acknowledged_at TEXT;
ALTER TABLE inbox_items ADD COLUMN acknowledged_by INTEGER;

-- Escalamiento: `escalated_at` marca que ya subió a supervisión, para no escalar dos veces;
-- `next_repeat_at` es el reloj que el worker consulta. Ambos nulos en lo que no repite.
ALTER TABLE inbox_items ADD COLUMN escalated_at TEXT;
ALTER TABLE inbox_items ADD COLUMN next_repeat_at TEXT;

-- Severidad operativa, separada de `priority`: `priority` describe el aviso y `severidad`
-- gobierna el reloj de repetición y escalamiento (ver lib/escalamientoAlertas.js).
ALTER TABLE inbox_items ADD COLUMN severidad TEXT;

-- Clave de deduplicación: una alerta repetida del mismo hecho no abre un caso nuevo mientras
-- el anterior siga sin reconocerse.
ALTER TABLE inbox_items ADD COLUMN dedupe_key TEXT;

-- Área a la que pertenece el trabajo, para enrutar y para el reemplazo de turno (E7).
ALTER TABLE inbox_items ADD COLUMN area TEXT;

-- Historia de reasignación: quién movió el caso, a quién y cuándo. Va en tabla aparte
-- porque una columna sola guardaría únicamente el último movimiento y §14 pide conservar
-- la historia.
CREATE TABLE IF NOT EXISTS inbox_assignments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id       INTEGER NOT NULL REFERENCES inbox_items(inbox_id) ON DELETE CASCADE,
  from_user_id   INTEGER,
  to_user_id     INTEGER,
  actor_user_id  INTEGER NOT NULL,
  motivo         TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_assignments_item ON inbox_assignments(inbox_id, id);
-- El worker de escalamiento barre por reloj: sin este índice haría scan completo cada vuelta.
CREATE INDEX IF NOT EXISTS idx_inbox_repeat ON inbox_items(next_repeat_at) WHERE next_repeat_at IS NOT NULL;
-- La deduplicación consulta por clave en cada ingesta.
CREATE INDEX IF NOT EXISTS idx_inbox_dedupe ON inbox_items(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Claves de idempotencia de las escrituras contra Mercado Libre. Sin esto un reintento por
-- red cortada le manda dos respuestas al comprador. `estado` distingue `en_curso`, `ok` e
-- `incierto`; el último es el que se usa cuando falló DESPUÉS de haber enviado a ML y no se
-- puede afirmar que no se escribió.
CREATE TABLE IF NOT EXISTS mobile_action_keys (
  idempotency_key TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL,
  accion          TEXT NOT NULL,
  recurso         TEXT NOT NULL,
  estado          TEXT NOT NULL,
  resultado       TEXT,
  created_at      TEXT NOT NULL
);
-- Sin este índice la tabla no se puede purgar, y crece con cada escritura.
CREATE INDEX IF NOT EXISTS idx_mobile_action_keys_fecha ON mobile_action_keys(created_at);
