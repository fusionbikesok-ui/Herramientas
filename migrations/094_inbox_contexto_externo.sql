-- E6: contexto externo y ciclo de reconocimiento en la bandeja.
--
-- Aditiva e idempotente. No se agregan `question_id`, `claim_id` ni `external_type`: el par
-- (`kind`, `resource_id`) ya los identifica —pregunta e id de ML, reclamo e id de ML— y
-- duplicarlos crea dos fuentes para el mismo dato que pueden divergir en silencio.
--
-- Sí se agregan los que no se pueden derivar de lo que ya hay: el pack y la orden de una
-- conversación posventa, el ítem publicado, y el estado externo con su marca de frescura,
-- que es lo que permite decidir si el detalle que se muestra sigue siendo válido.

ALTER TABLE inbox_items ADD COLUMN pack_id TEXT;
ALTER TABLE inbox_items ADD COLUMN order_id TEXT;
ALTER TABLE inbox_items ADD COLUMN item_id TEXT;
ALTER TABLE inbox_items ADD COLUMN external_status TEXT;
ALTER TABLE inbox_items ADD COLUMN last_synced_at TEXT;

-- Reconocer no es resolver: §14 los distingue y hasta ahora la tabla no podía expresarlo.
-- Un caso reconocido sigue abierto y sigue contando como trabajo pendiente.
ALTER TABLE inbox_items ADD COLUMN acknowledged_at TEXT;
ALTER TABLE inbox_items ADD COLUMN acknowledged_by INTEGER;

-- Escalamiento: `escalated_at` marca que ya subió a supervisión, para no escalar dos veces;
-- `next_repeat_at` es el reloj que el worker consulta. Ambos nulos en lo que no repite.
ALTER TABLE inbox_items ADD COLUMN escalated_at TEXT;
ALTER TABLE inbox_items ADD COLUMN next_repeat_at TEXT;

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
