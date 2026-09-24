-- 0020 — E3 corte 1 tarea 1: esquema de decisiones, candidatos y evidencia de identidad.
--
-- `identity_decisions` es append-only por diseño (spec E3 §4, plan tarea 1): la única historia de
-- "quién decidió qué" tiene que quedar completa, nunca reescrita. El rol de la app pierde UPDATE y
-- DELETE sobre la tabla (igual que audit.audit_events, aunque acá se hace con REVOKE puntual en vez
-- de un trigger, porque catalog ya tiene GRANT UPDATE de esquema completo desde la 0013 y no hay
-- forma de revocarlo sólo para esta fila sin REVOKE explícito). La única columna que cambia después
-- del INSERT es `superada_en`, y sólo la escribe el trigger `identity_decisions_superar_anterior`
-- (SECURITY DEFINER), nunca la app directamente.
--
-- Por qué el CHECK ata `origen` a `efecto` (humano→aplicar, auto_sku→sombra): en este corte no existe
-- auto-vínculo aplicado (D2 del diseño), así que la base lo hace imposible en vez de confiar en que el
-- código nunca lo intente. El corte 3 reemplaza este CHECK cuando el canario habilite auto_sku/aplicar.
--
-- `identity_decisions_una_vigente` es el UNIQUE parcial que hace "una decisión vigente por clave y
-- efecto": la clave natural es (channel_account_id, recurso, variacion_normalizada), igual que
-- matcher_decisions en el legado, y `efecto` entra en la clave porque una humana (aplicar) y una
-- auto_sku (sombra) sobre la misma publicación conviven sin chocar — son dos anotaciones distintas,
-- no una decisión disputando a la otra.
SET lock_timeout = '5s';

ALTER TABLE catalog.identity_cases
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD COLUMN estado text NOT NULL DEFAULT 'actionable' CHECK (estado IN
    ('unclassified','actionable','decided','verified','parked','intervention','conflict','archived'));

CREATE TABLE catalog.identity_decisions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  case_id uuid REFERENCES catalog.identity_cases(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  recurso text NOT NULL, variacion_normalizada text NOT NULL DEFAULT '',
  eleccion text NOT NULL CHECK (eleccion IN ('vincular','omitir','mantener_omision','sin_candidato')),
  variant_id uuid REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  origen text NOT NULL CHECK (origen IN ('humano','auto_sku')),
  actor text NOT NULL, motivo text,
  efecto text NOT NULL CHECK (efecto IN ('sombra','aplicar')),
  engine_version text, hash_payload_ml text, expected_version int,
  idempotency_key text UNIQUE, hash_peticion text,
  -- El resultado que decidirCaso le devolvió al pedido original (E3 T3, hallazgo de la segunda opinión de
  -- Codex): un reintento idempotente tiene que devolver EXACTAMENTE lo mismo que la primera vez, no
  -- recalcularlo. `resultado_version` es la versión del caso tras esa decisión (case.version + 1 en ese
  -- momento), no la versión actual del caso, que puede haber seguido subiendo con decisiones posteriores.
  resultado_vinculo text, resultado_version int,
  supersede_a uuid REFERENCES catalog.identity_decisions(id),
  superada_en timestamptz,            -- la única columna que cambia, y sólo la escribe un trigger al superar
  creado_en timestamptz NOT NULL DEFAULT now(),
  CHECK ((eleccion = 'vincular') = (variant_id IS NOT NULL)),
  CHECK (origen <> 'humano' OR efecto = 'aplicar'),
  CHECK (origen <> 'auto_sku' OR efecto = 'sombra')   -- el corte 3 lo reemplaza
);
CREATE UNIQUE INDEX identity_decisions_una_vigente
  ON catalog.identity_decisions (channel_account_id, recurso, variacion_normalizada, efecto)
  WHERE superada_en IS NULL;
CREATE INDEX identity_decisions_caso ON catalog.identity_decisions (case_id, creado_en DESC);

-- ───────────────────────────── append-only: ni UPDATE ni DELETE para la app ─────────────────────────────
-- La 0013 ya dio GRANT SELECT, INSERT, UPDATE sobre TODAS las tablas de catalog a plataforma_app. Acá se
-- revoca el UPDATE (y el DELETE, que ya no tenía) SOLO sobre esta tabla, sin tocar el resto del esquema.
REVOKE UPDATE, DELETE ON catalog.identity_decisions FROM plataforma_app;
-- Excepción puntual: `resultado_vinculo`/`resultado_version` son el resultado que decidirCaso (E3 T3) le dio
-- al pedido original, y sólo se llenan DESPUÉS del INSERT porque dependen de reconciliarClave (que a su vez
-- necesita que la fila ya exista, para calcular la decisión vigente). No rompen el "append-only" real (todo
-- lo demás sigue inmutable): son la única letra pequeña de auditoría de un resultado que en el momento del
-- INSERT todavía no se conoce, no una revisión de la decisión en sí.
GRANT UPDATE (resultado_vinculo, resultado_version) ON catalog.identity_decisions TO plataforma_app;

-- El trigger corre como el dueño de la tabla (no como plataforma_app), así que puede escribir
-- `superada_en` aunque la app no tenga UPDATE. Es la única escritura posterior al INSERT que existe.
--
-- BEFORE INSERT y no AFTER: el UNIQUE parcial `identity_decisions_una_vigente` se evalúa contra el
-- estado de la tabla en el momento del INSERT. Si se marcara la anterior superada DESPUÉS de insertar
-- la nueva, las dos filas coexistirían con `superada_en IS NULL` en el instante de la evaluación del
-- índice y el propio INSERT violaría el UNIQUE que se supone que este trigger evita.
--
-- SECURITY DEFINER es justamente lo que hace peligroso no validar `supersede_a` a fondo (hallazgo de
-- revisión): sin las comprobaciones de abajo, la app (que no tiene UPDATE directo) podría insertar una
-- fila con `supersede_a` apuntando a la decisión VIGENTE DE OTRA CLAVE y "retirarla" sin pasar por
-- decidirCaso — un UPDATE encubierto vía el trigger. Por eso NEW.supersede_a tiene que ser, ya
-- superada_en IS NULL, de la MISMA clave natural (channel_account_id, recurso, variacion_normalizada,
-- efecto) y la MISMA empresa que NEW: si no existe, si la clave no coincide o si ya estaba superada,
-- el trigger aborta el INSERT entero en vez de dejar pasar un UPDATE que tocó 0 filas en silencio.
CREATE FUNCTION catalog.identity_decisions_superar_anterior() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = catalog AS $$
DECLARE anterior catalog.identity_decisions;
BEGIN
  IF NEW.supersede_a IS NOT NULL THEN
    SELECT * INTO anterior FROM catalog.identity_decisions WHERE id = NEW.supersede_a;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supersede_a % no existe', NEW.supersede_a USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF anterior.superada_en IS NOT NULL THEN
      RAISE EXCEPTION 'supersede_a % ya estaba superada', NEW.supersede_a USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF anterior.company_id <> NEW.company_id
       OR anterior.channel_account_id <> NEW.channel_account_id
       OR anterior.recurso <> NEW.recurso
       OR anterior.variacion_normalizada <> NEW.variacion_normalizada
       OR anterior.efecto <> NEW.efecto THEN
      RAISE EXCEPTION 'supersede_a % es de otra clave o empresa', NEW.supersede_a USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    UPDATE catalog.identity_decisions SET superada_en = now() WHERE id = NEW.supersede_a;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_decisions_superar_anterior BEFORE INSERT ON catalog.identity_decisions
  FOR EACH ROW EXECUTE FUNCTION catalog.identity_decisions_superar_anterior();

-- ───────────────────────────── candidatos calculados por el motor ─────────────────────────────
-- Se retienen por corrida (run_id): la bandeja siempre muestra la última, pero no se pisan las viejas,
-- así queda trazado qué vio el motor en cada vuelta (útil para la calibración de la tarea 7).
CREATE TABLE catalog.identity_candidates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id uuid NOT NULL REFERENCES catalog.identity_cases(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  rank int NOT NULL CHECK (rank > 0),
  puntaje double precision NOT NULL,
  explicacion jsonb NOT NULL DEFAULT '{}'::jsonb,
  fuentes text[] NOT NULL DEFAULT '{}',
  engine_version text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_candidates_caso ON catalog.identity_candidates (case_id, creado_en DESC);

-- ───────────────────────────── evidencia releída (D4) ─────────────────────────────
CREATE TABLE catalog.identity_evidence (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id uuid NOT NULL REFERENCES catalog.identity_cases(id) ON DELETE RESTRICT,
  fuente text NOT NULL CHECK (fuente IN ('ml','woo','plataforma')),
  observado_en timestamptz NOT NULL DEFAULT now(),
  hash text,
  campos jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX identity_evidence_caso ON catalog.identity_evidence (case_id, observado_en DESC);
