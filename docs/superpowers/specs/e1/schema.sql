-- E1 — Fundación PostgreSQL en sombra. Esquema base (especificación ejecutable, no migración aplicada).
-- Destino: PostgreSQL 18.6 desplegado por E0 (fusion-pg). Se aplica como migraciones expand/contract
-- versionadas en plataforma/migrations/ a partir de este archivo; cualquier cambio de contrato se
-- refleja primero aquí y en docs/superpowers/deliveries/E1-fundacion-sombra.md.
--
-- Módulos como schemas: core, security, audit, integrations. Ningún módulo lee tablas internas de
-- otro salvo por las FK declaradas acá. Tiempos en UTC (timestamptz). Sin borrado físico de entidades
-- comerciales: archivo con archived_at/archived_by/archive_reason.

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS security;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS integrations;

-- ─────────────────────────────── core ───────────────────────────────
CREATE TABLE core.companies (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  legal_name    text NOT NULL CHECK (length(trim(legal_name)) > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE core.channel_accounts (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id       uuid NOT NULL REFERENCES core.companies(id),
  channel          text NOT NULL CHECK (channel IN ('mercadolibre', 'woocommerce')),
  external_account text NOT NULL CHECK (length(external_account) > 0),  -- ML user_id / URL base Woo
  is_primary       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz,
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (channel, external_account)
);
-- Un único Woo primario por empresa (plan §8).
CREATE UNIQUE INDEX channel_accounts_un_woo_primario
  ON core.channel_accounts (company_id) WHERE channel = 'woocommerce' AND is_primary AND archived_at IS NULL;

-- Latido de cada servicio (API, worker, scheduler). GET /api/v2/health lo considera vivo si
-- visto_en tiene ≤ 120 s. Se actualiza con UPSERT; una fila por servicio. UNLOGGED: un latido no
-- necesita sobrevivir a una caída (se vacía en la recuperación) ni viajar en WAL/backups.
CREATE UNLOGGED TABLE core.service_heartbeats (
  servicio     text PRIMARY KEY CHECK (servicio IN ('api', 'worker', 'scheduler')),
  instancia    text NOT NULL,
  visto_en     timestamptz NOT NULL DEFAULT now(),
  version      text NOT NULL
);

-- ───────────────────────────── security ─────────────────────────────
CREATE TABLE security.roles (
  code text PRIMARY KEY CHECK (code IN ('operador', 'catalogo', 'administracion'))
);

CREATE TABLE security.capabilities (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z]+(\.[a-z_]+)+$'),   -- ej. operations.read
  description text NOT NULL
);

CREATE TABLE security.role_capabilities (
  role_code       text NOT NULL REFERENCES security.roles(code),
  capability_code text NOT NULL REFERENCES security.capabilities(code),
  PRIMARY KEY (role_code, capability_code)
);

CREATE TABLE security.users (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES core.companies(id),
  username            text NOT NULL CHECK (username ~ '^[a-z0-9._-]{2,64}$'),
  -- PII cifrada por aplicación (AES-256-GCM con clave fuera de la base); búsqueda exacta por índice
  -- ciego HMAC-SHA256 con otra clave. Nunca se guarda el email en claro.
  email_ciphertext    bytea,
  email_blind_index   bytea CHECK (email_blind_index IS NULL OR length(email_blind_index) = 32),
  status              text NOT NULL DEFAULT 'pending_enrollment'
                        CHECK (status IN ('pending_enrollment', 'active', 'suspended', 'archived')),
  legacy_user_id      integer UNIQUE,            -- users.id del SQLite legado (crosswalk)
  password_allowed    boolean NOT NULL DEFAULT false,  -- sólo rol operador puede tenerla (plan §4.2)
  created_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz,
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (company_id, username),
  CHECK ((email_ciphertext IS NULL) = (email_blind_index IS NULL)),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX users_un_email_blind ON security.users (company_id, email_blind_index) WHERE email_blind_index IS NOT NULL;

CREATE TABLE security.user_roles (
  user_id    uuid NOT NULL REFERENCES security.users(id),
  role_code  text NOT NULL REFERENCES security.roles(code),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES security.users(id),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE security.webauthn_credentials (
  credential_id    bytea PRIMARY KEY CHECK (length(credential_id) BETWEEN 16 AND 1023),
  user_id          uuid NOT NULL REFERENCES security.users(id),
  public_key       bytea NOT NULL,
  sign_count       bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports       text[] NOT NULL DEFAULT '{}',
  aaguid           uuid,
  backup_eligible  boolean NOT NULL,
  backup_state     boolean NOT NULL,
  device_label     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  revoked_at       timestamptz
);
CREATE INDEX webauthn_credentials_user ON security.webauthn_credentials (user_id) WHERE revoked_at IS NULL;

CREATE TABLE security.recovery_codes (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES security.users(id),
  code_hash  bytea NOT NULL CHECK (length(code_hash) = 32),   -- HMAC-SHA256; el código no se guarda
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at    timestamptz,
  UNIQUE (user_id, code_hash)
);

-- Feature flag de E1: passkeys desactivadas para uso real hasta la prueba en dispositivos (E4).
CREATE TABLE security.feature_flags (
  code       text PRIMARY KEY CHECK (code ~ '^[a-z0-9_.]+$'),
  enabled    boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES security.users(id),
  reason     text NOT NULL
);

-- E1 T4 · tarea 12 (migración 0010): el desafío de cada ceremonia WebAuthn. SimpleWebAuthn exige pasar el
-- desafío generado como `expectedChallenge` al verificar; en memoria se rompe con dos procesos o un reinicio.
-- Cada desafío tiene propósito, vencimiento corto y un solo uso. La migración además siembra la fila
-- `passkeys.real` en false: la primera de las dos llaves (la otra es PASSKEYS_HABILITADAS).
CREATE TABLE security.webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  proposito  text NOT NULL CHECK (proposito IN ('registro', 'login', 'reautenticacion')),
  desafio    text NOT NULL UNIQUE CHECK (desafio ~ '^[A-Za-z0-9_-]{16,128}$'),
  user_id    uuid REFERENCES security.users(id),
  creado_en  timestamptz NOT NULL DEFAULT now(),
  vence_en   timestamptz NOT NULL,
  usado_en   timestamptz,
  CHECK (vence_en > creado_en),
  CHECK (proposito = 'login' OR user_id IS NOT NULL)
);
CREATE INDEX webauthn_challenges_vigentes ON security.webauthn_challenges (vence_en) WHERE usado_en IS NULL;

-- E1 T4 · tarea 13 (migración 0011): los intentos de recuperación, donde se cuenta el límite de cinco por hora
-- por cuenta, por IP y global. Un intento contra un usuario inexistente se registra con user_id nulo.
CREATE TABLE security.recovery_attempts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid REFERENCES security.users(id),
  -- El id que se pidió, exista o no: el límite por cuenta se cuenta sobre esto para no revelar quién tiene cuenta.
  cuenta_pedida text NOT NULL CHECK (length(cuenta_pedida) BETWEEN 1 AND 64),
  ip           inet NOT NULL,
  intentado_en timestamptz NOT NULL,
  exitoso      boolean NOT NULL DEFAULT false
);
CREATE INDEX recovery_attempts_cuenta ON security.recovery_attempts (cuenta_pedida, intentado_en DESC);
CREATE INDEX recovery_attempts_ip ON security.recovery_attempts (ip, intentado_en DESC);
CREATE INDEX recovery_attempts_fecha ON security.recovery_attempts (intentado_en DESC);

-- ─────────────────────────────── audit ──────────────────────────────
-- Append-only con cadena de hash: hash = sha256(prev_hash || contenido canónico). Un único escritor
-- de la cadena a la vez (advisory lock transaccional). UPDATE/DELETE rechazados por trigger; una
-- alteración directa por superusuario se detecta con audit.verify_chain().
-- La cadena se ordena por chain_seq, NO por id: el id sale de la secuencia ANTES de tomar el lock y
-- dos transacciones concurrentes pueden encadenarse en orden inverso a su id (reproducido
-- 2026-09-14: verify_chain marcaba rota una cadena intacta). chain_seq se asigna dentro del lock.
CREATE TABLE audit.audit_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_seq       bigint NOT NULL UNIQUE CHECK (chain_seq > 0),
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  company_id      uuid NOT NULL REFERENCES core.companies(id),
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'system', 'channel')),
  actor_id        text NOT NULL,
  action          text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_.]+$'),
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  correlation_id  uuid NOT NULL,
  reason          text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash       bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash            bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_events_aggregate ON audit.audit_events (aggregate_type, aggregate_id, id);
CREATE INDEX audit_events_occurred ON audit.audit_events (occurred_at);

CREATE FUNCTION audit.canonical(e audit.audit_events) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT convert_to(concat_ws(E'\x1f',
    e.chain_seq::text, e.id::text, to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    e.company_id::text, e.actor_type, e.actor_id, e.action, e.aggregate_type, e.aggregate_id,
    e.correlation_id::text, coalesce(e.reason, ''), e.payload::text), 'UTF8')
$$;

CREATE FUNCTION audit.chain_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ultimo_seq bigint; ultimo_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit.audit_events.chain', 0));
  SELECT chain_seq, hash INTO ultimo_seq, ultimo_hash FROM audit.audit_events ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := coalesce(ultimo_seq, 0) + 1;
  NEW.prev_hash := coalesce(ultimo_hash, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);
  NEW.hash := sha256(NEW.prev_hash || audit.canonical(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit.audit_events
  FOR EACH ROW EXECUTE FUNCTION audit.chain_before_insert();

CREATE FUNCTION audit.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_events es append-only (% rechazado)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit.audit_events
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_mutation();

-- Devuelve el primer chain_seq donde la cadena se rompe, o NULL si está íntegra. También detecta
-- huecos o saltos de chain_seq (una fila borrada con los triggers desactivados).
CREATE FUNCTION audit.verify_chain(desde bigint DEFAULT NULL, hasta bigint DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE r audit.audit_events; esperado bytea; seq_esperado bigint;
BEGIN
  seq_esperado := coalesce(desde, 1);
  SELECT hash INTO esperado FROM audit.audit_events WHERE chain_seq = seq_esperado - 1;
  esperado := coalesce(esperado, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea);
  FOR r IN SELECT * FROM audit.audit_events WHERE chain_seq >= seq_esperado AND (hasta IS NULL OR chain_seq <= hasta) ORDER BY chain_seq LOOP
    IF r.chain_seq <> seq_esperado OR r.prev_hash <> esperado OR r.hash <> sha256(r.prev_hash || audit.canonical(r)) THEN RETURN seq_esperado; END IF;
    seq_esperado := seq_esperado + 1;
    esperado := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

CREATE TABLE audit.audit_daily_manifests (
  manifest_date     date PRIMARY KEY,
  first_chain_seq   bigint REFERENCES audit.audit_events(chain_seq),
  last_chain_seq    bigint REFERENCES audit.audit_events(chain_seq),
  last_hash         bytea NOT NULL CHECK (length(last_hash) = 32),
  event_count       integer NOT NULL CHECK (event_count >= 0),
  signature         bytea NOT NULL,                          -- Ed25519 sobre el manifiesto canónico
  signing_key_id    text NOT NULL,
  b2_object_key     text NOT NULL,
  b2_version_id     text NOT NULL,
  retention_mode    text NOT NULL CHECK (retention_mode IN ('governance', 'compliance')),
  retention_until   timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (retention_until >= created_at + interval '365 days')
);

-- ──────────────────────────── integrations ──────────────────────────
CREATE TABLE integrations.inbox_messages (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id),
  topic              text NOT NULL CHECK (topic IN (
                       'ml.orders', 'ml.shipments', 'ml.questions', 'ml.messages', 'ml.claims', 'ml.items',
                       'woo.orders', 'woo.products')),
  resource_id        text NOT NULL CHECK (length(resource_id) > 0),
  remote_version     text NOT NULL,          -- last_updated / date_modified_gmt remoto o hash del recurso
  source             text NOT NULL CHECK (source IN ('webhook_copy', 'sweep', 'signal_reread', 'bootstrap')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'claimed', 'succeeded', 'retryable', 'uncertain', 'dead_lettered', 'parked')),
  received_at        timestamptz NOT NULL DEFAULT now(),
  available_at       timestamptz NOT NULL DEFAULT now(),
  lease_token        uuid,
  lease_until        timestamptz,
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  last_error_code    text,
  correlation_id     uuid NOT NULL,
  payload_hash       bytea CHECK (payload_hash IS NULL OR length(payload_hash) = 32),
  payload_ciphertext bytea,                   -- payload original cifrado, 90 días (plan §4.1)
  parked_reason      text,
  payload_key_id     text,
  payload_nonce      bytea,
  payload_tag        bytea,
  UNIQUE (channel_account_id, topic, resource_id, remote_version),
  CHECK ((status = 'claimed') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'parked') = (parked_reason IS NOT NULL)),
  CONSTRAINT inbox_payload_envelope_check CHECK (
    (payload_ciphertext IS NULL AND payload_key_id IS NULL AND payload_nonce IS NULL AND payload_tag IS NULL)
    OR
    (payload_ciphertext IS NOT NULL AND length(payload_ciphertext) > 0
      AND payload_key_id IS NOT NULL AND length(payload_key_id) BETWEEN 1 AND 128
      AND payload_nonce IS NOT NULL AND payload_tag IS NOT NULL
      AND length(payload_nonce) = 12 AND length(payload_tag) = 16)
  )
);
CREATE INDEX inbox_messages_claimable ON integrations.inbox_messages (available_at, id) WHERE status IN ('pending', 'retryable');
CREATE INDEX inbox_messages_lease ON integrations.inbox_messages (lease_until) WHERE status = 'claimed';

CREATE TABLE integrations.outbox_commands (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id),
  command_type       text NOT NULL,
  target_resource    text NOT NULL,
  idempotency_key    text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 200),
  expected_version   text,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'claimed', 'succeeded', 'retryable', 'uncertain', 'dead_lettered', 'parked')),
  available_at       timestamptz NOT NULL DEFAULT now(),
  lease_token        uuid,
  lease_until        timestamptz,
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  created_by         text NOT NULL,
  correlation_id     uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  parked_reason      text,
  CHECK ((status = 'claimed') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'parked') = (parked_reason IS NOT NULL))
);
-- E1 no tiene escritores remotos: todo comando real queda parked hasta la vertical que lo habilite.
CREATE INDEX outbox_commands_claimable ON integrations.outbox_commands (available_at, id) WHERE status IN ('pending', 'retryable');

CREATE TABLE integrations.command_attempts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_id       bigint NOT NULL REFERENCES integrations.outbox_commands(id),
  attempt_no       integer NOT NULL CHECK (attempt_no > 0),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  outcome          text CHECK (outcome IN ('succeeded', 'retryable', 'terminal', 'uncertain')),
  http_status      integer CHECK (http_status BETWEEN 100 AND 599),
  error_code       text,
  remote_evidence_hash bytea CHECK (remote_evidence_hash IS NULL OR length(remote_evidence_hash) = 32),
  UNIQUE (command_id, attempt_no),
  CHECK ((finished_at IS NULL) = (outcome IS NULL))
);

CREATE TABLE integrations.dead_letters (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type     text NOT NULL CHECK (source_type IN ('inbox', 'outbox')),
  source_id       bigint NOT NULL,
  reason_code     text NOT NULL,
  detail          text NOT NULL,
  dead_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     text,
  resolution_note text,
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);
CREATE UNIQUE INDEX dead_letters_un_abierta ON integrations.dead_letters (source_type, source_id) WHERE resolved_at IS NULL;

CREATE TABLE integrations.reconciliation_cursors (
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id),
  topic              text NOT NULL,
  strategy           text NOT NULL CHECK (strategy IN ('enumerable', 'convergence')),
  cursor_value       jsonb,
  overlap_seconds    integer NOT NULL CHECK (overlap_seconds BETWEEN 60 AND 86400),
  interval_seconds   integer NOT NULL CHECK (interval_seconds BETWEEN 60 AND 604800),
  next_run_at        timestamptz NOT NULL DEFAULT now(),
  last_success_at    timestamptz,
  version            integer NOT NULL DEFAULT 1 CHECK (version > 0),
  cursor_kind        text NOT NULL DEFAULT 'state_sweep'
                       CONSTRAINT reconciliation_cursors_cursor_kind_check
                       CHECK (cursor_kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  enabled            boolean NOT NULL DEFAULT true,
  CONSTRAINT reconciliation_cursors_cursor_value_check CHECK (cursor_value IS NULL OR (
    jsonb_typeof(cursor_value) = 'object' AND cursor_value ? 'v' AND cursor_value->>'v' = '1')),
  PRIMARY KEY (channel_account_id, topic, cursor_kind)
);
-- Alta de las corrientes de una cuenta de canal. La migración 0004 la llama para las cuentas
-- existentes; el ensayo de T2 y el alta de cuentas de T3 la llaman para las nuevas. Desde 0005
-- consulta el canal y sólo siembra las corrientes que le corresponden, y falla si la cuenta no existe
-- o su canal no tiene corrientes definidas; por eso es plpgsql y no SQL plano.
CREATE OR REPLACE FUNCTION integrations.sembrar_corrientes(cuenta uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  canal text;
  creadas integer;
BEGIN
  SELECT channel INTO canal FROM core.channel_accounts WHERE id = cuenta;
  IF canal IS NULL THEN
    RAISE EXCEPTION 'cuenta de canal inexistente: %', cuenta;
  END IF;
  IF canal NOT IN ('mercadolibre', 'woocommerce') THEN
    RAISE EXCEPTION 'canal sin corrientes definidas: %', canal;
  END IF;

  INSERT INTO integrations.reconciliation_cursors
    (channel_account_id, topic, cursor_kind, strategy, overlap_seconds, interval_seconds, next_run_at)
  SELECT cuenta, v.topic, v.cursor_kind, v.strategy, 600, v.interval_seconds, v.next_run_at
    FROM (VALUES
      -- Corrientes incrementales: cadencia de la matriz de barridos.
      ('ml.orders',    'state_sweep', 'enumerable',    600, now()),
      ('ml.shipments', 'state_sweep', 'convergence',   900, now()),
      ('ml.questions', 'state_sweep', 'enumerable',   1200, now()),
      ('ml.messages',  'state_sweep', 'enumerable',   1200, now()),
      ('ml.claims',    'state_sweep', 'enumerable',   1200, now()),
      ('woo.orders',   'state_sweep', 'enumerable',    600, now()),
      ('woo.products', 'state_sweep', 'enumerable',    600, now()),
      -- Vueltas completas escalonadas en hora de Argentina: items 04:00, productos 04:15 y
      -- pedidos los domingos 04:30. date_trunc('week') cae en lunes: el domingo está seis días después.
      ('ml.items',     'full_scan',   'enumerable',  86400,
        ((date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
          + interval '1 day 4 hours') AT TIME ZONE 'America/Argentina/Buenos_Aires')),
      ('woo.products', 'full_scan',   'enumerable',  86400,
        ((date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
          + interval '1 day 4 hours 15 minutes') AT TIME ZONE 'America/Argentina/Buenos_Aires')),
      ('woo.orders',   'full_scan',   'enumerable', 604800,
        (SELECT CASE WHEN b > now() THEN b ELSE b + interval '7 days' END
           FROM (SELECT ((date_trunc('week', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
                          + interval '6 days 4 hours 30 minutes')
                         AT TIME ZONE 'America/Argentina/Buenos_Aires') AS b) t))
    ) AS v(topic, cursor_kind, strategy, interval_seconds, next_run_at)
   WHERE (canal = 'mercadolibre' AND v.topic LIKE 'ml.%')
      OR (canal = 'woocommerce'  AND v.topic LIKE 'woo.%')
  ON CONFLICT (channel_account_id, topic, cursor_kind) DO NOTHING;

  GET DIAGNOSTICS creadas = ROW_COUNT;
  RETURN creadas;
END;
$$;

-- Señales de reconciliación (T3): un aviso, nunca una verdad remota (PM-179). No se proyecta ni se
-- presenta como observación; `inbox_messages` y `resource_observations` sólo reciben el resultado de
-- una relectura GET o de un barrido.
CREATE TABLE integrations.reconciliation_signals (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  topic              text NOT NULL CHECK (topic IN (
                       'ml.orders', 'ml.shipments', 'ml.questions', 'ml.messages', 'ml.claims', 'ml.items',
                       'woo.orders', 'woo.products')),
  resource_id        text NOT NULL CHECK (length(resource_id) > 0),
  notification_id    text,
  fingerprint        text NOT NULL CHECK (length(fingerprint) > 0),
  source             text NOT NULL CHECK (source IN ('webhook_copy', 'ml_missed_feed', 'payload_expired')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'claimed', 'succeeded', 'retryable', 'dead_lettered', 'excluded')),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  available_at       timestamptz NOT NULL DEFAULT now(),
  lease_token        uuid,
  lease_until        timestamptz,
  worker_id          text,
  error_detail       text,
  correlation_id     uuid NOT NULL DEFAULT uuidv7(),
  received_at        timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  deferred_since     timestamptz,  -- E1 T5 §2.4: fijado en el primer diferimiento por cupo sombra, no se resetea
  CONSTRAINT reconciliation_signals_lease_check CHECK (
    (status = 'claimed') = (lease_token IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)),
  CONSTRAINT reconciliation_signals_un_aviso UNIQUE (channel_account_id, topic, fingerprint)
);
CREATE UNIQUE INDEX reconciliation_signals_un_activa
  ON integrations.reconciliation_signals(channel_account_id, topic, resource_id)
  WHERE status IN ('pending', 'claimed', 'retryable');
CREATE INDEX reconciliation_signals_reclamables
  ON integrations.reconciliation_signals(status, available_at, id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX reconciliation_signals_lease
  ON integrations.reconciliation_signals(lease_until) WHERE status = 'claimed';
CREATE INDEX reconciliation_signals_cuenta
  ON integrations.reconciliation_signals(channel_account_id, topic, received_at DESC);

-- Corrientes sembradas por la migración 0004 para cada cuenta de canal (José, 2026-09-15):
--   cursor_kind='state_sweep' (ventana incremental): ml.orders 10 min, ml.shipments 15 min
--   (convergencia), ml.questions/ml.messages/ml.claims 20 min, woo.orders y woo.products 10 min.
--   cursor_kind='full_scan' (vuelta completa que declara bajas por conjunto): ml.items diaria 04:00,
--   woo.products diaria 04:15 y woo.orders semanal los domingos 04:30, hora de Argentina.
-- Las vueltas de Woo son de sólo presencia: enumeran IDs y no reescriben versión ni payload, para no
-- competir con el hash de la corriente incremental. La de productos enumera padres, así que no puede
-- declarar ausente una variación. T3 agregará cursor_kind='missed_feed' sin tocar estas posiciones.

CREATE TABLE integrations.sweep_runs (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id),
  topic              text NOT NULL,
  strategy           text NOT NULL CHECK (strategy IN ('enumerable', 'convergence')),
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'claimed', 'succeeded', 'retryable', 'failed', 'partial')),
  window_from        timestamptz,
  window_to          timestamptz,
  enumerated         integer CHECK (enumerated >= 0),      -- enumerable: recursos listados por la API
  missing_enqueued   integer CHECK (missing_enqueued >= 0),
  duplicates         integer CHECK (duplicates >= 0),
  known_resources    integer CHECK (known_resources >= 0),  -- convergencia: abiertos/recientes conocidos
  swept              integer CHECK (swept >= 0),
  converged          integer CHECK (converged >= 0),
  diverged           integer CHECK (diverged >= 0),
  error_detail       text,
  cursor_kind        text NOT NULL DEFAULT 'state_sweep'
                       CONSTRAINT sweep_runs_cursor_kind_check
                       CHECK (cursor_kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  scheduled_for      timestamptz NOT NULL DEFAULT now(),
  available_at       timestamptz NOT NULL DEFAULT now(),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  lease_token        uuid,
  lease_until        timestamptz,
  worker_id          text,
  cursor_before      jsonb CONSTRAINT sweep_runs_cursor_before_check
                       CHECK (cursor_before IS NULL OR jsonb_typeof(cursor_before) = 'object'),
  cursor_after       jsonb CONSTRAINT sweep_runs_cursor_after_check
                       CHECK (cursor_after IS NULL OR jsonb_typeof(cursor_after) = 'object'),
  correlation_id     uuid NOT NULL DEFAULT uuidv7(),
  deferred_since     timestamptz,  -- E1 T5 §2.4: fijado en el primer diferimiento por cupo sombra, no se resetea
  CONSTRAINT sweep_runs_cursor_fk FOREIGN KEY (channel_account_id, topic, cursor_kind)
    REFERENCES integrations.reconciliation_cursors(channel_account_id, topic, cursor_kind)
    ON DELETE RESTRICT,
  CHECK (strategy <> 'convergence' OR (swept IS NULL OR known_resources IS NULL OR swept <= known_resources)),
  CHECK (converged IS NULL OR swept IS NULL OR converged <= swept),
  CONSTRAINT sweep_runs_lease_check CHECK (
    (status = 'claimed') = (lease_token IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL))
);
CREATE INDEX sweep_runs_topic ON integrations.sweep_runs (channel_account_id, topic, started_at DESC);
CREATE UNIQUE INDEX sweep_runs_un_activa ON integrations.sweep_runs(channel_account_id, topic, cursor_kind)
  WHERE status IN ('pending', 'claimed', 'retryable');
CREATE INDEX sweep_runs_claimable ON integrations.sweep_runs(status, available_at, id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX sweep_runs_lease ON integrations.sweep_runs(lease_until) WHERE status = 'claimed';

CREATE TABLE integrations.resource_observations (
  channel_account_id    uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  topic                 text NOT NULL,
  resource_id           text NOT NULL CHECK (length(resource_id) > 0),
  remote_version        text NOT NULL CHECK (length(remote_version) > 0),
  remote_updated_at     timestamptz,
  remote_hash           bytea NOT NULL CHECK (length(remote_hash) = 32),
  projection_hash       bytea NOT NULL CHECK (length(projection_hash) = 32),
  lifecycle             text NOT NULL CHECK (lifecycle IN ('open', 'closed', 'deleted', 'unknown')),
  last_seen_run_id      bigint REFERENCES integrations.sweep_runs(id) ON DELETE SET NULL,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_enqueued_version text,
  PRIMARY KEY (channel_account_id, topic, resource_id),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX resource_observations_lifecycle
  ON integrations.resource_observations(channel_account_id, topic, lifecycle, last_seen_at);
CREATE INDEX resource_observations_retention ON integrations.resource_observations(last_seen_at)
  WHERE lifecycle IN ('closed', 'deleted');

CREATE TABLE integrations.resource_relations (
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  relation_type      text NOT NULL CHECK (relation_type IN ('order_shipment', 'order_pack', 'product_variation')),
  source_topic       text NOT NULL,
  source_id          text NOT NULL CHECK (length(source_id) > 0),
  target_topic       text NOT NULL,
  target_id          text NOT NULL CHECK (length(target_id) > 0),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_run_id   bigint REFERENCES integrations.sweep_runs(id) ON DELETE SET NULL,
  lifecycle          text NOT NULL DEFAULT 'open' CHECK (lifecycle IN ('open', 'closed', 'deleted', 'unknown')),
  PRIMARY KEY (channel_account_id, relation_type, source_topic, source_id, target_topic, target_id),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX resource_relations_target
  ON integrations.resource_relations(channel_account_id, target_topic, target_id);
CREATE INDEX resource_relations_retention ON integrations.resource_relations(last_seen_at)
  WHERE lifecycle IN ('closed', 'deleted');

-- Sin tabla de pérdidas de copia (2026-09-15): una falla de PostgreSQL no puede contarse dentro del mismo
-- PostgreSQL caído. El contador durable vive fuera (legado) y su importación auditada se diseña en el
-- tramo 3; el registro de observaciones remotas y el orden de versiones, en el tramo 2.

CREATE TABLE integrations.daily_shadow_reports (
  report_date      date PRIMARY KEY,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  report_sha256    bytea NOT NULL CHECK (length(report_sha256) = 32),
  signature        bytea NOT NULL,
  signing_key_id   text NOT NULL,
  b2_object_key    text NOT NULL,
  b2_version_id    text NOT NULL,
  retention_until  timestamptz NOT NULL,
  email_sent_at    timestamptz,
  email_error      text
);

-- Vista que alimenta GET /api/v2/incidents: nada bloqueado queda invisible (plan §2.1).
CREATE VIEW integrations.incidents AS
  SELECT 'inbox'::text AS source_type, m.id AS source_id, m.topic, m.status, m.last_error_code AS reason_code,
         m.received_at AS opened_at, m.attempts, m.correlation_id
    FROM integrations.inbox_messages m WHERE m.status IN ('uncertain', 'dead_lettered', 'parked', 'retryable')
  UNION ALL
  SELECT 'outbox', c.id, c.command_type, c.status, NULL, c.created_at, c.attempts, c.correlation_id
    FROM integrations.outbox_commands c WHERE c.status IN ('uncertain', 'dead_lettered', 'parked', 'retryable');

-- E1 T3 · corte C3: nonces de la API interna de señales.
-- El nonce vive en PostgreSQL y no en memoria: un reinicio de la API no puede reabrir la ventana de
-- replay de cinco minutos. La clave primaria es la defensa; la purga sólo acota el tamaño.
CREATE TABLE integrations.signal_nonces (
  key_id  text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 128),
  nonce   text NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX signal_nonces_seen_at ON integrations.signal_nonces(seen_at);

-- La purga borra nonces vencidos: DELETE no está en los privilegios por defecto de 0002.
GRANT DELETE ON integrations.signal_nonces TO plataforma_app;

-- E1 T3 · corte C8: resumen diario de la sombra, sin firma. La firma, el email y Object Lock son de T4
-- (`integrations.daily_shadow_reports`). Un resumen por día: regenerarlo lo reemplaza.
CREATE TABLE integrations.shadow_daily_summaries (
  summary_date date PRIMARY KEY,
  generated_at timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);

-- ─────────────────────────────── informes ────────────────────────────
-- E1 T4 · tarea 4: estado durable de cada artefacto firmado.
-- Las tablas de T1 (audit.audit_daily_manifests, integrations.daily_shadow_reports) exigen clave de objeto
-- y versión de B2 NOT NULL, así que no tienen dónde representar "firmado pero todavía no subido". Sin ese
-- estado, un fallo de red obliga a inventar identificadores o a perder la idempotencia (hallazgo 1 de la
-- revisión externa del 2026-09-17).
CREATE SCHEMA informes;

-- Dos estados independientes, no una cadena: con un solo camino, un email enviado daba por terminado un
-- artefacto que nunca se subió, y el reintento de B2 moría ahí (hallazgo 1 de la revisión del plan).
CREATE TABLE informes.entregas (
  tipo              text NOT NULL CHECK (tipo IN ('manifiesto', 'reporte')),
  fecha             date NOT NULL,
  estado_deposito   text NOT NULL DEFAULT 'generado' CHECK (estado_deposito IN ('generado', 'firmado', 'subido')),
  estado_aviso      text NOT NULL DEFAULT 'pendiente' CHECK (estado_aviso IN ('pendiente', 'avisado')),
  hash_contenido    text NOT NULL CHECK (hash_contenido ~ '^[0-9a-f]{64}$'),
  -- Sólo en los reportes: el semáforo con que salió ese día. La campaña contractual cuenta días seguidos que
  -- no fueron rojos, y sin guardarlo habría que re-armar cada reporte viejo para saberlo.
  semaforo          text CHECK (semaforo IN ('verde', 'amarillo', 'rojo')),
  kid               text,
  ruta_pendiente    text,
  b2_object_key     text,
  b2_version_id     text,
  -- La retención se fija al confirmar la subida, no al armar el contenido: si se calculara sobre el día
  -- reportado, recuperar días viejos dejaría menos de 365 días reales (hallazgo 3).
  retention_until   timestamptz,
  intentos_deposito integer NOT NULL DEFAULT 0 CHECK (intentos_deposito >= 0),
  intentos_aviso    integer NOT NULL DEFAULT 0 CHECK (intentos_aviso >= 0),
  ultimo_error      text,
  -- El candado de sesión del scheduler no alcanza: al perder la conexión, el proceso viejo puede seguir
  -- subiendo y enviando. Cada efecto se reclama con este testigo, verificado antes y después.
  testigo           uuid,
  lease_hasta       timestamptz,
  generado_en       timestamptz NOT NULL DEFAULT now(),
  firmado_en        timestamptz,
  subido_en         timestamptz,
  avisado_en        timestamptz,
  -- Las agrega la migración 0012 (ALTER TABLE), así que van al final: el volcado compara el orden real.
  oculto_en         timestamptz,
  oculto_version_retenida text,
  PRIMARY KEY (tipo, fecha),
  CONSTRAINT entregas_subido_check CHECK (
    (estado_deposito = 'subido') = (b2_object_key IS NOT NULL AND b2_version_id IS NOT NULL AND retention_until IS NOT NULL)),
  -- El email lleva adjunto el sobre firmado: avisar sin firmar es un estado imposible en el dominio.
  -- No exige haber subido — el aviso es deliberadamente independiente de Backblaze (hallazgo 2 de la
  -- revisión del 2026-09-17).
  CONSTRAINT entregas_aviso_check CHECK (estado_aviso = 'pendiente' OR estado_deposito <> 'generado'),
  CONSTRAINT entregas_semaforo_tipo_check CHECK ((tipo = 'reporte') OR semaforo IS NULL)
);

CREATE INDEX entregas_deposito_pendiente ON informes.entregas (fecha) WHERE estado_deposito <> 'subido';
CREATE INDEX entregas_aviso_pendiente ON informes.entregas (fecha) WHERE estado_aviso = 'pendiente';
-- La credencial de escritura de B2 puede OCULTAR un objeto (en B2 escribir incluye ocultar): no lo destruye
-- —la versión retenida sobrevive— pero un cliente normal recibe 404. Se detecta y se marca acá.
CREATE INDEX entregas_ocultas ON informes.entregas (fecha) WHERE oculto_en IS NOT NULL;

-- Los GRANT por defecto de 0002_permisos.sql cubren core, security, audit e integrations: un esquema nuevo
-- necesita los suyos. Sin DELETE: una entrega es evidencia de lo que pasó ese día.
GRANT USAGE ON SCHEMA informes TO plataforma_app;
GRANT SELECT, INSERT, UPDATE ON informes.entregas TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA informes GRANT SELECT, INSERT, UPDATE ON TABLES TO plataforma_app;

-- ═══════════════════════════ catalog (E2 T1, migración 0013; E2 T2, migración 0014) ═══════════════════════════
-- El catálogo canónico: qué se vende, dónde, con qué SKU, y qué falta decidir. Los `source` nuevos
-- ('bootstrap' en inbox_messages, 'payload_expired' en reconciliation_signals) están arriba, en su tabla.
-- Lo de E2 T2 (atributos, imágenes y datos comerciales por representación) entró en este archivo DESPUÉS de la
-- migración 0014, no antes: el orden que pide la cabecera ("primero aquí") se invirtió y este contrato se puso al
-- día cuando la suite completa lo detectó (test "el esquema migrado coincide con la referencia").

CREATE SCHEMA catalog;
GRANT USAGE ON SCHEMA catalog TO plataforma_app;

-- Las marcas van acá, antes de `product_models`, porque su `brand_id` las referencia. En la
-- migración 0015 están más abajo, junto al resto del tramo 3.
-- ───────────────────────── tarea 2: marcas canónicas ─────────────────────────
-- Una marca es una entidad, no un texto libre ni una categoría. `FANTTIK` era una raíz del árbol de Woo y
-- por D2 pasa a ser marca. El nombre normalizado es la clave: 'Shimano', 'SHIMANO' y ' shimano ' son una.
CREATE TABLE catalog.brands (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  nombre             text NOT NULL CHECK (length(btrim(nombre)) > 0),
  nombre_normalizado text NOT NULL CHECK (length(nombre_normalizado) > 0),
  archivado_en       timestamptz,
  motivo_archivo     text,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brands_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL)),
  CONSTRAINT brands_un_nombre UNIQUE (company_id, nombre_normalizado)
);

-- Los otros nombres con los que la misma marca aparece en los canales y en el legado. Sin esto, cada
-- variante de escritura sería una marca distinta y las 155 del legado nunca cerrarían con las 204 de ML.
CREATE TABLE catalog.brand_aliases (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  brand_id            uuid NOT NULL REFERENCES catalog.brands(id) ON DELETE RESTRICT,
  alias_normalizado   text NOT NULL CHECK (length(alias_normalizado) > 0),
  -- De dónde salió este alias. 'categoria_canal' es el caso de las 15 categorías que son marca mal usada:
  -- queda registrado de dónde vino en vez de perderse en un merge silencioso.
  origen              text NOT NULL CHECK (origen IN ('legado', 'ml_atributo', 'woo_taxonomia', 'categoria_canal', 'persona')),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  -- Un alias no puede apuntar a dos marcas: eso sería una identidad ambigua, justo lo que E2 no permite.
  CONSTRAINT brand_aliases_un_alias UNIQUE (company_id, alias_normalizado)
);
CREATE INDEX brand_aliases_marca ON catalog.brand_aliases (brand_id);


-- ───────────────────────────── el producto como concepto ─────────────────────────────
-- Un modelo nunca se vende: se vende una de sus variantes. Por eso no tiene precio ni stock.
CREATE TABLE catalog.product_models (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  origen             text NOT NULL CHECK (origen IN ('woo_padre', 'woo_simple', 'ml_familia', 'ml_clasico', 'ml_simple')),
  -- Para `ml_familia`, el id de la familia de ML. NO es el user_product_id: ése identifica una variante
  -- (cada variación del modelo viejo tiene el suyo, y dos publicaciones pueden compartirlo). Verificado el
  -- 2026-09-18 sobre las 6.969 filas de la cache del legado.
  clave_origen       text NOT NULL CHECK (length(clave_origen) > 0),
  titulo             text NOT NULL,
  observado_en       timestamptz NOT NULL DEFAULT now(),
  archivado_en       timestamptz,
  motivo_archivo     text,
  version            integer NOT NULL DEFAULT 1 CHECK (version > 0),
  creado_en          timestamptz NOT NULL DEFAULT now(),
  -- A lo sumo una marca por modelo (E2 T3). Nullable: "no sé" es un estado legítimo y la marca no se
  -- adivina por el título. Va última porque la migración 0015 la agregó con ALTER.
  brand_id           uuid REFERENCES catalog.brands(id) ON DELETE RESTRICT,
  -- El archivo lleva motivo siempre: una baja sin causa es exactamente lo que no queremos.
  CONSTRAINT product_models_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL)),
  CONSTRAINT product_models_un_clave UNIQUE (channel_account_id, origen, clave_origen)
);
CREATE INDEX product_models_empresa ON catalog.product_models (company_id, origen);
CREATE INDEX product_models_marca ON catalog.product_models (brand_id) WHERE brand_id IS NOT NULL;

-- ───────────────────────────── lo que se vende ─────────────────────────────
-- `sku` nulo = pendiente de decidir, que es un estado legítimo y no un error. `company_id` está acá
-- porque la unicidad del SKU es por empresa: dos empresas pueden tener su propio FB-123.
CREATE TABLE catalog.sellable_variants (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  model_id       uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  -- El canónico es FB-{ID_WOO}: sólo dígitos después del prefijo, y al menos uno.
  sku            text CHECK (sku ~ '^FB-[0-9]+$'),
  archivado_en   timestamptz,
  motivo_archivo text,
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sellable_variants_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL))
);
-- Único cuando no es nulo, y por empresa. Un UNIQUE común dejaría pasar dos FB-123 de empresas
-- distintas o, al revés, trataría cada pendiente como un valor repetido.
CREATE UNIQUE INDEX sellable_variants_un_sku
  ON catalog.sellable_variants (company_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX sellable_variants_modelo ON catalog.sellable_variants (model_id);
CREATE INDEX sellable_variants_pendientes
  ON catalog.sellable_variants (company_id) WHERE sku IS NULL AND archivado_en IS NULL;

-- El SKU se pone una vez y no se cambia más: es la identidad con la que el resto del programa
-- (stock, precios, publicación) va a referirse a esta variante. Resolver un pendiente sí se permite.
CREATE OR REPLACE FUNCTION catalog.sku_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sku IS NOT NULL AND NEW.sku IS DISTINCT FROM OLD.sku THEN
    RAISE EXCEPTION 'el sku de una variante es inmutable: % no puede pasar a %', OLD.sku, COALESCE(NEW.sku, 'NULL');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sellable_variants_sku_inmutable
  BEFORE UPDATE OF sku ON catalog.sellable_variants
  FOR EACH ROW EXECUTE FUNCTION catalog.sku_inmutable();

-- ───────────────────────────── cada aparición en un canal ─────────────────────────────
-- `contenedor` es lo que agrupa y no se vende (el padre de Woo, el ítem clásico de ML con variaciones);
-- apunta a un modelo. `vendible` es lo que se compra; apunta a una variante.
CREATE TABLE catalog.external_representations (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id            uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id    uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal                 text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  recurso               text NOT NULL CHECK (length(recurso) > 0),
  -- No nula, '' cuando no hay variación: un UNIQUE con NULL admite duplicados, y ahí se nos escapaba
  -- exactamente el caso que más se repite (el ítem sin variaciones cargado dos veces).
  variacion_normalizada text NOT NULL DEFAULT '',
  tipo                  text NOT NULL CHECK (tipo IN ('contenedor', 'vendible')),
  model_id              uuid REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  variant_id            uuid REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  sku_observado         text,                 -- lo que dice el canal, tal cual, aunque esté mal
  user_product_id       text,                 -- ML: el producto que se vende. Pista de variante, no identidad
  estado_remoto         text,
  version_remota        text,
  omitida_por_decision  boolean NOT NULL DEFAULT false,
  sweep_run_id          uuid,                 -- de qué corrida o mensaje vino esta observación
  observado_en          timestamptz NOT NULL DEFAULT now(),
  archivado_en          timestamptz,
  motivo_archivo        text,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  -- Lo que el canal informó de ESTA publicación (E2 T2). Todo nullable y sin default: una representación
  -- proyectada antes de T2 no lo tiene. Es evidencia por canal y va acá y no en la variante, porque una variante
  -- puede estar en Woo y en ML a la vez y cada canal tiene su precio y su stock.
  atributos_crudos      jsonb,                -- lo que vino, sin tocar: permite reproyectar sin volver al canal
  comercial_crudo       jsonb,
  capturado_en          timestamptz,          -- NULL = todavía no se intentó capturar (checkpoint del backfill)
  precio                numeric(12,2),
  moneda                text,
  stock_canal           integer,
  gtin                  text,                 -- evidencia, nunca autoridad: no casa identidades
  -- Identidad E3 punto B v2 (0021): título del payload de ML para ESTA representación, cuando no hay modelo
  -- propio que lo guarde (ítem sin variaciones ya vinculado a una variante de Woo). Sólo fallback de lectura
  -- para modeloMlSql/tituloMlSql; nunca decide identidad ni entra en hashCatalogo.
  titulo_observado      text,
  CONSTRAINT external_representations_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL)),
  -- Lo que el diseño pide que la base garantice sola: un contenedor jamás cuelga de una variante.
  -- El nombre no repite "tipo_check": ése lo toma PostgreSQL solo para el CHECK inline de la columna.
  CONSTRAINT external_representations_colgadura_check CHECK (
    (tipo = 'contenedor' AND model_id IS NOT NULL AND variant_id IS NULL AND NOT omitida_por_decision)
    -- Un vendible omitido por decisión del matcher no tiene variante (§5.2 del diseño): existe en el canal,
    -- pero alguien decidió que no es un producto nuestro que se venda. Cualquier otro vendible sí la tiene.
    OR (tipo = 'vendible' AND (variant_id IS NOT NULL) <> omitida_por_decision)),
  CONSTRAINT external_representations_un_aparicion
    UNIQUE (channel_account_id, recurso, variacion_normalizada)
);
COMMENT ON COLUMN catalog.external_representations.titulo_observado IS
  'Título que trae el payload del canal para ESTA representación, cuando no hay modelo propio que lo guarde '
  '(ítem de ML sin variaciones ya vinculado a una variante de Woo). Sólo lectura para modeloMlSql como último '
  'fallback; nunca se usa para decidir identidad ni entra en hashCatalogo.';
CREATE INDEX external_representations_variante ON catalog.external_representations (variant_id);
CREATE INDEX external_representations_modelo ON catalog.external_representations (model_id);
CREATE INDEX external_representations_user_product
  ON catalog.external_representations (channel_account_id, user_product_id) WHERE user_product_id IS NOT NULL;

-- ───────────────────────────── observación de formato de ML (0023, E3 corte 3) ─────────────────────────────
CREATE TABLE catalog.format_observations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  recurso text NOT NULL,
  hash_estructura text NOT NULL,
  estructura jsonb NOT NULL,
  version_remota text,
  variaciones jsonb,
  cantidad_pack text,
  listing_type text,
  catalog_listing boolean,
  seller_sku text,
  origen text NOT NULL CHECK (origen IN ('barrido','relectura')),
  observado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX format_observations_ultima ON catalog.format_observations (channel_account_id, recurso, observado_en DESC, id DESC);

-- ───────────────────────────── atributos e imágenes (E2 T2) ─────────────────────────────
-- Una fila por (representación, nombre, valor): un atributo multivalor son varias filas. La procedencia es la
-- representación y no el canal, porque un canal puede tener varias publicaciones del mismo modelo (el canal sale
-- por join). Nada se borra: lo que el canal deja de informar queda con `vigente_hasta`, y si reaparece revive la
-- misma fila. `nombre_normalizado` es léxico (minúsculas, sin acentos, `_`); no hay sinónimos.
CREATE TABLE catalog.model_attributes (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id           uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  representation_id  uuid NOT NULL REFERENCES catalog.external_representations(id) ON DELETE RESTRICT,
  nombre_normalizado text NOT NULL CHECK (length(nombre_normalizado) > 0),
  valor              text NOT NULL,
  observado_en       timestamptz NOT NULL,
  vigente_hasta      timestamptz,             -- NULL = vigente
  CONSTRAINT model_attributes_un_valor UNIQUE (representation_id, nombre_normalizado, valor)
);
CREATE INDEX model_attributes_modelo ON catalog.model_attributes (model_id);
CREATE INDEX model_attributes_nombre_valor ON catalog.model_attributes (nombre_normalizado, valor);

-- Una fila por (representación, url), con su posición original. Dos canales pueden publicar la misma URL y cada
-- uno conserva su procedencia. Misma regla de vigencia que los atributos.
CREATE TABLE catalog.model_images (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id          uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  representation_id uuid NOT NULL REFERENCES catalog.external_representations(id) ON DELETE RESTRICT,
  url               text NOT NULL CHECK (length(url) > 0),
  orden             integer,
  observado_en      timestamptz NOT NULL,
  vigente_hasta     timestamptz,
  CONSTRAINT model_images_una_url UNIQUE (representation_id, url)
);
CREATE INDEX model_images_modelo ON catalog.model_images (model_id);

-- ───────────────────────────── la evidencia del legado ─────────────────────────────
-- Append-only: una decisión no se edita, se cierra y entra la siguiente. Así queda el historial de
-- quién decidió qué y cuándo, que es lo que hace auditable al catálogo.
CREATE TABLE catalog.matcher_decisions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id            uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id    uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal                 text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  recurso               text NOT NULL CHECK (length(recurso) > 0),
  variacion_normalizada text NOT NULL DEFAULT '',
  sku                   text,
  accion                text NOT NULL CHECK (accion IN ('confirmar', 'asignar', 'omitir', 'revocar')),
  -- 'sistema' es la autoasignación por SKU y la corrección de Guardia: decisiones automáticas que
  -- igual son decisiones, con su motivo (José, 2026-09-18).
  origen                text NOT NULL CHECK (origen IN ('copia', 'evento')),
  actor                 text NOT NULL CHECK (actor IN ('persona', 'sistema')),
  motivo                text,
  confirmado_por        text,
  actualizado_en_legado timestamptz,
  copy_id               uuid,
  vigente_desde         timestamptz NOT NULL DEFAULT now(),
  vigente_hasta         timestamptz,
  motivo_cierre         text,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT matcher_decisions_cierre_check CHECK ((vigente_hasta IS NULL) = (motivo_cierre IS NULL))
);
-- Una sola decisión vigente por clave: es la regla que hace que "lo vigente" sea una lectura y no un cálculo.
CREATE UNIQUE INDEX matcher_decisions_un_vigente
  ON catalog.matcher_decisions (channel_account_id, recurso, variacion_normalizada)
  WHERE vigente_hasta IS NULL;
CREATE INDEX matcher_decisions_sku ON catalog.matcher_decisions (company_id, sku) WHERE sku IS NOT NULL;

-- ───────────────────────────── lo que falta decidir ─────────────────────────────
CREATE TABLE catalog.identity_cases (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  tipo            text NOT NULL CHECK (tipo IN (
                    'sku_pendiente', 'omitida_revisar', 'sku_inexistente_en_woo', 'woo_sin_sku',
                    'woo_sku_duplicado', 'woo_sku_no_canonico', 'decision_en_conflicto', 'identidad_legado',
                    -- Dos publicaciones de ML con el mismo user_product_id (ML dice que venden lo mismo) que
                    -- el matcher no vincula a la misma variante. Pista, no identidad: se revisa, no se fusiona.
                    'user_product_divergente',
                    -- Dos canales afirman valores distintos para el mismo atributo de un modelo (E2 T2). Cuelga de
                    -- la representación que lo introduce; un solo caso abierto por representación agrupa todos sus
                    -- atributos en conflicto. Se revisa, nunca se fusiona sola.
                    'atributo_divergente',
                    -- Clasificación en el árbol (0019): cuelgan del MODELO, no de una publicación.
                    'categoria_en_desacuerdo', 'categoria_sin_mapeo', 'categoria_persona_contradicha')),
  prioridad       text NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('baja', 'normal', 'urgente')),
  variant_id      uuid REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  representation_id uuid REFERENCES catalog.external_representations(id) ON DELETE RESTRICT,
  detalle         jsonb NOT NULL DEFAULT '{}'::jsonb,
  abierto_en      timestamptz NOT NULL DEFAULT now(),
  cerrado_en      timestamptz,
  motivo_cierre   text,
  model_id        uuid REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  -- Identidad E3 (0020): versión optimista para decidirCaso (409 si no coincide) y el estado de la
  -- máquina de estados de la bandeja (spec E3 §8).
  version         int NOT NULL DEFAULT 1,
  estado          text NOT NULL DEFAULT 'actionable' CHECK (estado IN
                    ('unclassified','actionable','decided','verified','parked','intervention','conflict','archived')),
  -- «No estoy seguro» en la bandeja (0022): sale de la cola normal hasta que se decide o se desaparta.
  -- No es una decisión (no escribe identity_decisions ni mueve el vínculo), así que la calibración no lo ve.
  apartado_en     timestamptz,
  apartado_por    text,
  apartado_motivo text,
  CONSTRAINT identity_cases_cierre_check CHECK ((cerrado_en IS NULL) = (motivo_cierre IS NULL)),
  -- Todo caso apunta a algo concreto: sin objeto no hay nada que revisar.
  CONSTRAINT identity_cases_objeto_check CHECK (variant_id IS NOT NULL OR representation_id IS NOT NULL OR model_id IS NOT NULL)
);
COMMENT ON COLUMN catalog.identity_cases.apartado_en IS
  'Marcado «No estoy seguro» en la bandeja: sale de la cola normal hasta que se decide o se desaparta.';
-- Un caso abierto por objeto y tipo. Cerrado, puede volver a abrirse: el problema puede reaparecer.
CREATE UNIQUE INDEX identity_cases_un_abierto_variante
  ON catalog.identity_cases (variant_id, tipo) WHERE cerrado_en IS NULL AND variant_id IS NOT NULL;
-- El caso del legado entra en la clave: el legado admite varios casos abiertos por publicación (uno por dirección),
-- y con (representación, tipo) solos colapsaban en uno, y resolver uno cerraba el del otro (revisión de la
-- implementación). Para los casos propios del catálogo, caso_legado no existe y la clave queda como antes.
CREATE UNIQUE INDEX identity_cases_un_abierto_representacion
  ON catalog.identity_cases (representation_id, tipo, (COALESCE(detalle->>'caso_legado', '')))
  WHERE cerrado_en IS NULL AND representation_id IS NOT NULL;
CREATE UNIQUE INDEX identity_cases_un_abierto_modelo
  ON catalog.identity_cases (model_id, tipo) WHERE cerrado_en IS NULL AND model_id IS NOT NULL;
CREATE INDEX identity_cases_abiertos
  ON catalog.identity_cases (company_id, tipo, prioridad) WHERE cerrado_en IS NULL;

-- ───────────────────────────── decisiones de identidad (E3 corte 1, 0020) ─────────────────────────────
-- Append-only por diseño: la única historia de "quién decidió qué" tiene que quedar completa, nunca
-- reescrita. El rol de la app pierde UPDATE y DELETE sobre esta tabla puntualmente (REVOKE más abajo);
-- la única columna que cambia después del INSERT es `superada_en`, y sólo la escribe el trigger
-- SECURITY DEFINER de acá abajo, nunca la app directamente.
--
-- El CHECK ata `origen` a `efecto` (humano→aplicar, auto_sku→sombra) porque en este corte no existe
-- auto-vínculo aplicado (D2 del diseño E3): la base lo hace imposible en vez de confiar en que el
-- código nunca lo intente. El corte 3 reemplaza este CHECK cuando el canario habilite auto_sku/aplicar.
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
  supersede_a uuid REFERENCES catalog.identity_decisions(id),
  superada_en timestamptz,            -- la única columna que cambia, y sólo la escribe un trigger al superar
  creado_en timestamptz NOT NULL DEFAULT now(),
  CHECK ((eleccion = 'vincular') = (variant_id IS NOT NULL)),
  CHECK (origen <> 'humano' OR efecto = 'aplicar'),
  CHECK (origen <> 'auto_sku' OR efecto = 'sombra')   -- el corte 3 lo reemplaza
);
-- Una decisión vigente por clave (canal, recurso, variación) y efecto: humana (aplicar) y auto_sku
-- (sombra) sobre la misma publicación conviven sin chocar, son dos anotaciones distintas.
CREATE UNIQUE INDEX identity_decisions_una_vigente
  ON catalog.identity_decisions (channel_account_id, recurso, variacion_normalizada, efecto)
  WHERE superada_en IS NULL;
CREATE INDEX identity_decisions_caso ON catalog.identity_decisions (case_id, creado_en DESC);

-- Puntual sobre esta tabla: catalog ya tiene GRANT UPDATE de esquema completo desde la 0013 y no hay
-- forma de revocarlo sólo para esta fila sin REVOKE explícito.
REVOKE UPDATE, DELETE ON catalog.identity_decisions FROM plataforma_app;

-- BEFORE INSERT y no AFTER: el UNIQUE parcial de arriba se evalúa contra el estado de la tabla en el
-- momento del INSERT. Si se marcara la anterior superada DESPUÉS de insertar la nueva, las dos filas
-- coexistirían con `superada_en IS NULL` en el instante de la evaluación del índice y el propio INSERT
-- violaría el UNIQUE que se supone que este trigger evita.
--
-- SECURITY DEFINER es justamente lo que hace peligroso no validar `supersede_a` a fondo (hallazgo de
-- revisión): sin las comprobaciones de abajo, la app (sin UPDATE directo) podría insertar una fila con
-- `supersede_a` apuntando a la decisión VIGENTE DE OTRA CLAVE y "retirarla" sin pasar por decidirCaso
-- — un UPDATE encubierto vía el trigger. Por eso NEW.supersede_a tiene que ser, ya superada_en IS NULL,
-- de la MISMA clave natural y la MISMA empresa que NEW; si no, el INSERT entero aborta.
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

-- ───────────────────────────── candidatos calculados por el motor (0020) ─────────────────────────────
-- Se retienen por corrida (run_id): la bandeja siempre muestra la última, pero no se pisan las viejas,
-- así queda trazado qué vio el motor en cada vuelta (calibración de la tarea 7 de E3).
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

-- ───────────────────────────── marcas de «No estoy seguro» en la bandeja (0022) ─────────────────────────────
-- «No estoy seguro» aparta un caso sin decidirlo: no escribe identity_decisions ni mueve el vínculo, así que
-- la calibración no lo ve. La clave de idempotencia es por caso+acción, no global (hallazgo Alto de Codex
-- sobre la revisión de 0022): la misma Idempotency-Key reusada en OTRO caso o para la OTRA acción no debe
-- devolver un resultado ajeno.
CREATE TABLE catalog.identity_case_marks (
  idempotency_key text NOT NULL,
  case_id uuid NOT NULL REFERENCES catalog.identity_cases(id),
  accion text NOT NULL CHECK (accion IN ('apartar', 'desapartar')),
  version int NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (idempotency_key, case_id, accion)
);

-- ───────────────────────────── evidencia releída antes de auto-vincular (D4, 0020) ─────────────────────────────
CREATE TABLE catalog.identity_evidence (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id uuid NOT NULL REFERENCES catalog.identity_cases(id) ON DELETE RESTRICT,
  fuente text NOT NULL CHECK (fuente IN ('ml','woo','plataforma')),
  observado_en timestamptz NOT NULL DEFAULT now(),
  hash text,
  campos jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX identity_evidence_caso ON catalog.identity_evidence (case_id, observado_en DESC);

-- ───────────────────────────── checkpoint del bootstrap ─────────────────────────────
-- Una corrida por cuenta y tópico, con la página ya confirmada en disco: si el proceso se muere en la
-- página 30, el que arranca sigue en la 30 y no vuelve a leer 30 páginas de la API de ML.
CREATE TABLE catalog.bootstrap_runs (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  topic              text NOT NULL CHECK (topic IN ('ml.items', 'woo.products')),
  estado             text NOT NULL DEFAULT 'pendiente'
                       CHECK (estado IN ('pendiente', 'corriendo', 'pausada', 'terminada', 'abortada')),
  pagina_confirmada  integer NOT NULL DEFAULT 0 CHECK (pagina_confirmada >= 0),
  cursor             text,
  encolados          integer NOT NULL DEFAULT 0 CHECK (encolados >= 0),
  leidos             integer NOT NULL DEFAULT 0 CHECK (leidos >= 0),
  lease_token        uuid,
  lease_until        timestamptz,
  worker_id          text,
  error_detail       text,
  arrancada_en       timestamptz NOT NULL DEFAULT now(),
  terminada_en       timestamptz,
  CONSTRAINT bootstrap_runs_lease_check CHECK (
    (estado = 'corriendo') = (lease_token IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)),
  CONSTRAINT bootstrap_runs_un_corriente UNIQUE (channel_account_id, topic)
);

-- ───────────────────────────── copias en tandas ─────────────────────────────
-- Una tanda intermedia no permite distinguir "ausente" de "todavía no llegó". Por eso los lotes van a
-- staging y sólo el confirmar, con conteo y hash, cierra vigencias.
CREATE TABLE catalog.copias (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  tipo           text NOT NULL CHECK (tipo IN ('matcher', 'identidad')),
  total_esperado integer NOT NULL CHECK (total_esperado >= 0),
  hash_esperado  text NOT NULL CHECK (length(hash_esperado) > 0),
  corte          timestamptz NOT NULL DEFAULT now(),
  estado         text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'confirmada', 'abortada')),
  error_detail   text,
  -- Lo que hizo la confirmación (abiertas, cerradas, sin cambios…). Una copia diaria que cambia algo quiere
  -- decir que un evento se perdió en el camino: es la conciliación, y la lee el reporte diario.
  resultado      jsonb,
  abierta_en     timestamptz NOT NULL DEFAULT now(),
  confirmada_en  timestamptz,
  CONSTRAINT copias_confirmada_check CHECK ((estado = 'confirmada') = (confirmada_en IS NOT NULL))
);
CREATE TABLE catalog.copias_lotes (
  copy_id    uuid NOT NULL REFERENCES catalog.copias(id) ON DELETE RESTRICT,
  numero     integer NOT NULL CHECK (numero > 0),
  filas      jsonb NOT NULL,
  recibido_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (copy_id, numero)
);

-- Eventos del matcher ya aplicados. La outbox del legado reintenta con una firma nueva cada vez, así que el
-- nonce no alcanza para deduplicar: un evento reintentado se reconoce por su id y no se aplica dos veces.
CREATE TABLE catalog.eventos_recibidos (
  evento_id   text PRIMARY KEY CHECK (length(evento_id) > 0),
  recibido_en timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────── taxonomía propia, marcas, colecciones y packs (E2 T3) ───────────────────────
-- Las decisiones que NO se deben "simplificar" al leer esto:
--   1. La jerarquía de los canales es EVIDENCIA, nunca el árbol propio (D1, cerrada por José el
--      2026-09-20). Viven en tablas separadas y se unen sólo por un mapeo explícito y humano.
--   2. La identidad de un nodo es estable e independiente de su nombre, su slug y su lugar en el árbol:
--      `taxonomy_nodes` guarda la identidad y `taxonomy_node_versions` cómo se veía en cada versión. Sin
--      esto, renombrar un rubro rompería todos los mapeos y E12/E13 no podrían publicar lo aprobado.
--   3. Los componentes de un pack son VARIANTES VENDIBLES, no modelos: un modelo no tiene stock ni precio,
--      y un pack se arma con cosas comprables. Elegir el modelo se paga caro en E5.
--   4. Forward-only, como todo `catalog`: nada se borra. `plataforma_app` no tiene DELETE.
--
-- Nada de esto escribe en ningún canal: es sombra entera.
-- ───────────────────────── tarea 1: la jerarquía del canal, como evidencia ─────────────────────────
-- Un canal informa su propio árbol (Woo: `id`/`parent`/`slug`/`count`; ML: los códigos MLA…). Se guarda
-- tal cual, por cuenta, y el padre se referencia por su ID REMOTO, no por una FK interna: la importación
-- puede ver un hijo antes que su padre y no debe fallar ni inventar una fila vacía.
CREATE TABLE catalog.channel_categories (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal              text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  id_externo         text NOT NULL CHECK (length(id_externo) > 0),
  parent_externo     text,                    -- NULL = raíz. Woo informa 0; la importación lo normaliza a NULL.
  nombre             text NOT NULL,
  slug               text,
  conteo             integer CHECK (conteo IS NULL OR conteo >= 0),
  capturado_en       timestamptz NOT NULL DEFAULT now(),
  vigente_hasta      timestamptz,             -- con fecha = el canal dejó de informarla. Nunca se borra.
  CONSTRAINT channel_categories_no_autopadre CHECK (parent_externo IS DISTINCT FROM id_externo)
);
-- Una sola fila vigente por categoría del canal. Si desaparece y vuelve, son dos filas y queda la historia.
CREATE UNIQUE INDEX channel_categories_un_vigente
  ON catalog.channel_categories (channel_account_id, id_externo) WHERE vigente_hasta IS NULL;
CREATE INDEX channel_categories_padre
  ON catalog.channel_categories (channel_account_id, parent_externo) WHERE vigente_hasta IS NULL;

-- ───────────────────────── tarea 2: colecciones con vigencia ─────────────────────────
-- Una colección NO es una rama del árbol: `Hotsale` es una promo con fecha, no un rubro (D2). Vive afuera
-- y la pertenencia es muchos-a-muchos.
CREATE TABLE catalog.collections (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  clave          text NOT NULL CHECK (clave ~ '^[a-z0-9][a-z0-9_-]*$'),
  nombre         text NOT NULL CHECK (length(btrim(nombre)) > 0),
  descripcion    text,
  vigente_desde  timestamptz,
  vigente_hasta  timestamptz,
  archivado_en   timestamptz,
  motivo_archivo text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collections_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL)),
  -- Una vigencia invertida listaría siempre vacío sin que nadie entienda por qué.
  CONSTRAINT collections_vigencia_check CHECK (
    vigente_desde IS NULL OR vigente_hasta IS NULL OR vigente_desde < vigente_hasta),
  CONSTRAINT collections_un_clave UNIQUE (company_id, clave)
);

CREATE TABLE catalog.collection_members (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  collection_id uuid NOT NULL REFERENCES catalog.collections(id) ON DELETE RESTRICT,
  model_id      uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  origen        text NOT NULL CHECK (origen IN ('categoria_canal', 'persona')),
  agregado_en   timestamptz NOT NULL DEFAULT now(),
  quitado_en    timestamptz,                  -- salir de una colección no borra que estuvo
  motivo_salida text,
  CONSTRAINT collection_members_salida_check CHECK ((quitado_en IS NULL) = (motivo_salida IS NULL))
);
CREATE UNIQUE INDEX collection_members_un_vigente
  ON catalog.collection_members (collection_id, model_id) WHERE quitado_en IS NULL;
CREATE INDEX collection_members_modelo ON catalog.collection_members (model_id) WHERE quitado_en IS NULL;

-- ───────────────────────── tarea 5: el árbol propio, versionado ─────────────────────────
-- Una versión es lo que E12 propone contra algo concreto y E13 publica exactamente. Sin versión, un
-- renombre entre la propuesta y la publicación cambiaría lo publicado sin que nadie lo apruebe.
CREATE TABLE catalog.taxonomy_versions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  numero       integer NOT NULL CHECK (numero > 0),
  estado       text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'vigente', 'reemplazada')),
  notas        text,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  vigente_desde timestamptz,
  vigente_hasta timestamptz,
  CONSTRAINT taxonomy_versions_un_numero UNIQUE (company_id, numero),
  CONSTRAINT taxonomy_versions_vigencia_check CHECK ((estado = 'vigente') = (vigente_desde IS NOT NULL AND vigente_hasta IS NULL))
);
-- Una sola vigente por empresa: "el árbol de hoy" es una lectura, no un cálculo.
CREATE UNIQUE INDEX taxonomy_versions_un_vigente
  ON catalog.taxonomy_versions (company_id) WHERE estado = 'vigente';

-- La IDENTIDAD del nodo. No tiene nombre ni padre: eso cambia por versión y no es lo que identifica.
-- `rubro` separa el árbol de productos del de servicios (D2: SERVICES y Taller no tienen stock ni marca).
CREATE TABLE catalog.taxonomy_nodes (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  clave        text NOT NULL CHECK (clave ~ '^[a-z0-9][a-z0-9_-]*$'),
  rubro        text NOT NULL DEFAULT 'producto' CHECK (rubro IN ('producto', 'servicio')),
  creado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxonomy_nodes_un_clave UNIQUE (company_id, clave)
);

-- Cómo se veía ese nodo en una versión dada: su nombre, su padre y su orden. Una versión pasada se
-- reconstruye entera leyendo sus filas, sin recalcular nada.
CREATE TABLE catalog.taxonomy_node_versions (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  version_id uuid NOT NULL REFERENCES catalog.taxonomy_versions(id) ON DELETE RESTRICT,
  node_id    uuid NOT NULL REFERENCES catalog.taxonomy_nodes(id) ON DELETE RESTRICT,
  -- Un solo padre (decisión 4 del plan). NULL = raíz de esa versión.
  parent_id  uuid REFERENCES catalog.taxonomy_nodes(id) ON DELETE RESTRICT,
  nombre     text NOT NULL CHECK (length(btrim(nombre)) > 0),
  orden      integer NOT NULL DEFAULT 0,
  archivado  boolean NOT NULL DEFAULT false,  -- archivar, no borrar (decisión 6 del plan)
  CONSTRAINT taxonomy_node_versions_no_autopadre CHECK (parent_id IS DISTINCT FROM node_id),
  CONSTRAINT taxonomy_node_versions_un_nodo UNIQUE (version_id, node_id)
);
CREATE INDEX taxonomy_node_versions_padre ON catalog.taxonomy_node_versions (version_id, parent_id);

-- Los ciclos no se pueden expresar como CHECK: se verifican por fila contra el resto de su versión.
-- No se fija profundidad máxima (D4): una reorganización legítima no debe chocar contra el esquema.
CREATE OR REPLACE FUNCTION catalog.taxonomia_sin_ciclos() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual uuid := NEW.parent_id; saltos integer := 0;
BEGIN
  -- Serializa las escrituras de esta versión. Sin esto, dos transacciones que hacen A.padre=B y B.padre=A a
  -- la vez ven cada una el estado anterior de la otra, las dos pasan la verificación y queda el ciclo: una
  -- restricción que sólo mira el snapshot propio no es una restricción bajo concurrencia.
  PERFORM 1 FROM catalog.taxonomy_versions WHERE id = NEW.version_id FOR UPDATE;
  WHILE actual IS NOT NULL LOOP
    IF actual = NEW.node_id THEN
      RAISE EXCEPTION 'el nodo % no puede colgar de % : cerraría un ciclo en la versión %',
        NEW.node_id, NEW.parent_id, NEW.version_id;
    END IF;
    saltos := saltos + 1;
    -- Cota de seguridad: si ya hay un ciclo preexistente entre OTRAS filas, el bucle no debe ser infinito.
    IF saltos > 64 THEN RAISE EXCEPTION 'cadena de padres demasiado larga o ya cíclica en la versión %', NEW.version_id; END IF;
    SELECT v.parent_id INTO actual FROM catalog.taxonomy_node_versions v
      WHERE v.version_id = NEW.version_id AND v.node_id = actual;
    -- Un padre SIN fila en esta versión no es un árbol válido: los nodos que cuelgan de él desaparecen de
    -- `leerArbol` (que baja desde las raíces) sin que nada proteste. Antes se aceptaba en silencio.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'el nodo % cuelga de un padre que no existe en la versión %', NEW.node_id, NEW.version_id;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER taxonomy_node_versions_sin_ciclos
  -- `node_id` y `version_id` también: mover una fila de nodo o de versión puede cerrar un ciclo igual que
  -- cambiar el padre, y con `UPDATE OF parent_id` a secas esas dos vías no disparaban nada.
  BEFORE INSERT OR UPDATE OF parent_id, node_id, version_id ON catalog.taxonomy_node_versions
  FOR EACH ROW EXECUTE FUNCTION catalog.taxonomia_sin_ciclos();

-- El mapeo con el canal: por ID REMOTO (nunca por nombre), por canal y por cuenta, y admitiendo
-- explícitamente "sin equivalencia" — que es una decisión tomada, distinta de una fila que falta.
CREATE TABLE catalog.taxonomy_channel_map (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  node_id            uuid NOT NULL REFERENCES catalog.taxonomy_nodes(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal              text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  id_externo         text,
  sin_equivalencia   boolean NOT NULL DEFAULT false,
  decidido_por       text,
  decidido_en        timestamptz NOT NULL DEFAULT now(),
  vigente_hasta      timestamptz,
  CONSTRAINT taxonomy_channel_map_equivalencia_check CHECK ((id_externo IS NULL) = sin_equivalencia),
  CONSTRAINT taxonomy_channel_map_no_vacio CHECK (id_externo IS NULL OR length(id_externo) > 0)
);
-- Un nodo puede absorber VARIAS categorías del canal (D7: el árbol propio tiene dos niveles y absorbe el
-- tercero de Woo), así que NO hay índice único por (node_id, channel_account_id). Lo único por nodo es
-- «no tiene equivalente en el canal», que no lleva categoría que lo identifique. Ver migración 0016.
CREATE UNIQUE INDEX taxonomy_channel_map_un_sin_equivalencia
  ON catalog.taxonomy_channel_map (node_id, channel_account_id)
  WHERE vigente_hasta IS NULL AND id_externo IS NULL;
-- Dos nodos propios no pueden reclamar la misma categoría del canal: el mapeo dejaría de ser una función.
CREATE UNIQUE INDEX taxonomy_channel_map_un_externo
  ON catalog.taxonomy_channel_map (channel_account_id, id_externo)
  WHERE vigente_hasta IS NULL AND id_externo IS NOT NULL;

-- 0017: una categoría del canal decidida como «sin equivalencia» en el árbol propio, con su motivo.
CREATE TABLE catalog.channel_category_sin_equivalencia (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal              text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  id_externo         text NOT NULL CHECK (length(id_externo) > 0),
  motivo             text NOT NULL CHECK (length(btrim(motivo)) > 0),
  decidido_por       text NOT NULL CHECK (length(btrim(decidido_por)) > 0),
  decidido_en        timestamptz NOT NULL DEFAULT now(),
  vigente_hasta      timestamptz
);
CREATE UNIQUE INDEX channel_category_sin_equivalencia_un_vigente
  ON catalog.channel_category_sin_equivalencia (channel_account_id, id_externo)
  WHERE vigente_hasta IS NULL;

-- 0018: facetas de un modelo decididas por nosotros. Tabla propia y no `model_attributes`: la ingestión cierra
-- todo atributo de una publicación que el canal no repitió (persistirExtras), y un dato derivado se perdería.
CREATE TABLE catalog.model_facets (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  model_id     uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  faceta       text NOT NULL CHECK (faceta ~ '^[a-z][a-z0-9_]*$'),
  valor        text NOT NULL CHECK (length(btrim(valor)) > 0),
  origen       text NOT NULL CHECK (origen IN ('regla_categoria', 'persona')),
  motivo       text NOT NULL CHECK (length(btrim(motivo)) > 0),
  decidido_por text NOT NULL CHECK (length(btrim(decidido_por)) > 0),
  decidido_en  timestamptz NOT NULL DEFAULT now(),
  vigente_hasta timestamptz
);
CREATE UNIQUE INDEX model_facets_un_vigente
  ON catalog.model_facets (company_id, model_id, faceta) WHERE vigente_hasta IS NULL;
CREATE INDEX model_facets_faceta_valor
  ON catalog.model_facets (company_id, faceta, valor) WHERE vigente_hasta IS NULL;
CREATE FUNCTION catalog.model_facets_misma_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog.product_models WHERE id = NEW.model_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'el modelo % no es de la empresa %', NEW.model_id, NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_facets_misma_empresa BEFORE INSERT ON catalog.model_facets
  FOR EACH ROW EXECUTE FUNCTION catalog.model_facets_misma_empresa();

-- ───────────────────────── tarea 6: el producto en el árbol ─────────────────────────
-- Exactamente una primaria por modelo cuando está clasificado; las secundarias sin límite. La primaria
-- es la que usan los informes y E13 para publicar; sin una sola, un modelo contaría dos veces por rubro.
CREATE TABLE catalog.model_categories (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  model_id      uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  node_id       uuid NOT NULL REFERENCES catalog.taxonomy_nodes(id) ON DELETE RESTRICT,
  primaria      boolean NOT NULL DEFAULT false,
  origen        text NOT NULL CHECK (origen IN ('mapeo_canal', 'persona')),
  asignado_en   timestamptz NOT NULL DEFAULT now(),
  quitado_en    timestamptz,
  motivo_salida text,
  CONSTRAINT model_categories_salida_check CHECK ((quitado_en IS NULL) = (motivo_salida IS NULL))
);
CREATE UNIQUE INDEX model_categories_un_vigente
  ON catalog.model_categories (model_id, node_id) WHERE quitado_en IS NULL;
CREATE UNIQUE INDEX model_categories_una_primaria
  ON catalog.model_categories (model_id) WHERE quitado_en IS NULL AND primaria;
CREATE INDEX model_categories_nodo ON catalog.model_categories (node_id) WHERE quitado_en IS NULL;

-- ───────────────────────── tarea 7: la composición de un pack ─────────────────────────
-- Un pack es una variante vendible más, con composición. Nace en BORRADOR y sin precio, sin reserva de
-- stock, sin explosión de pedidos y sin publicación: las cuatro cosas quedan diferidas a propósito.
CREATE TABLE catalog.packs (
  variant_id uuid PRIMARY KEY REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  estado     text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'vigente', 'archivado')),
  nombre     text NOT NULL CHECK (length(btrim(nombre)) > 0),
  notas      text,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

-- Componentes por VARIANTE VENDIBLE (decisión 7 del plan). Con vigencia, para que una venta de ayer
-- pueda reconstruir qué llevaba el pack ayer y no lo que lleva hoy.
CREATE TABLE catalog.pack_components (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  pack_variant_id uuid NOT NULL REFERENCES catalog.packs(variant_id) ON DELETE RESTRICT,
  variant_id      uuid NOT NULL REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  cantidad        numeric(12,4) NOT NULL CHECK (cantidad > 0),
  unidad          text NOT NULL DEFAULT 'unidad' CHECK (length(unidad) > 0),
  vigente_desde   timestamptz NOT NULL DEFAULT now(),
  vigente_hasta   timestamptz,
  motivo_cierre   text,
  CONSTRAINT pack_components_cierre_check CHECK ((vigente_hasta IS NULL) = (motivo_cierre IS NULL)),
  CONSTRAINT pack_components_no_autocomponente CHECK (pack_variant_id <> variant_id)
);
CREATE UNIQUE INDEX pack_components_un_vigente
  ON catalog.pack_components (pack_variant_id, variant_id) WHERE vigente_hasta IS NULL;
CREATE INDEX pack_components_componente ON catalog.pack_components (variant_id) WHERE vigente_hasta IS NULL;

-- Ni ciclos (un pack que se contiene a sí mismo por una cadena) ni componentes archivados: un pack
-- vendible armado con algo dado de baja es una venta que no se puede cumplir.
CREATE OR REPLACE FUNCTION catalog.pack_componente_valido() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE muerta boolean; cicla boolean;
BEGIN
  -- Mismo motivo que en el árbol: sin lock, dos transacciones que cierran el ciclo desde los dos lados a la
  -- vez pasan las dos. El lock es por pack para no serializar toda la tabla.
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog.pack_components:' || NEW.pack_variant_id::text, 0));
  SELECT archivado_en IS NOT NULL INTO muerta FROM catalog.sellable_variants WHERE id = NEW.variant_id;
  IF muerta THEN
    RAISE EXCEPTION 'la variante % está archivada: no puede ser componente de un pack', NEW.variant_id;
  END IF;
  -- Cierre transitivo hacia abajo desde el componente: si desde él se llega al pack, hay ciclo.
  WITH RECURSIVE baja(id, saltos) AS (
    SELECT NEW.variant_id, 0
    UNION ALL
    SELECT c.variant_id, b.saltos + 1
      FROM baja b
      JOIN catalog.pack_components c ON c.pack_variant_id = b.id AND c.vigente_hasta IS NULL
     WHERE b.saltos < 64
  )
  SELECT EXISTS (SELECT 1 FROM baja WHERE id = NEW.pack_variant_id) INTO cicla;
  IF cicla THEN
    RAISE EXCEPTION 'el componente % cerraría un ciclo en el pack %', NEW.variant_id, NEW.pack_variant_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pack_components_valido
  -- `vigente_hasta` está en la lista porque REABRIR un componente cerrado (poner `vigente_hasta` en NULL) es
  -- la vía por la que se colaba un ciclo sin verificar: el componente inverso pudo agregarse mientras este
  -- estaba cerrado, y al reabrirlo el trigger no se disparaba porque no se tocaba ninguna de las otras dos
  -- columnas. El comentario de arriba promete que no hay segunda vía de escritura: ésta era la segunda vía.
  BEFORE INSERT OR UPDATE OF variant_id, pack_variant_id, vigente_hasta ON catalog.pack_components
  FOR EACH ROW WHEN (NEW.vigente_hasta IS NULL) EXECUTE FUNCTION catalog.pack_componente_valido();

CREATE FUNCTION catalog.identity_cases_modelo_misma_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM catalog.product_models WHERE id = NEW.model_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'el modelo % no es de la empresa %', NEW.model_id, NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_cases_modelo_misma_empresa BEFORE INSERT OR UPDATE OF model_id, company_id ON catalog.identity_cases
  FOR EACH ROW EXECUTE FUNCTION catalog.identity_cases_modelo_misma_empresa();

-- 0020 (E3 T3): resultado de decidirCaso, INSERT-only.
CREATE TABLE catalog.identity_decision_results (
  decision_id uuid PRIMARY KEY REFERENCES catalog.identity_decisions(id) ON DELETE RESTRICT,
  vinculo text NOT NULL, version int NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
);
