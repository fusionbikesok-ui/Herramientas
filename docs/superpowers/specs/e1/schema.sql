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
  retention_mode    text NOT NULL CHECK (retention_mode = 'governance'),
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
  source             text NOT NULL CHECK (source IN ('webhook_copy', 'sweep')),
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
-- existentes; el ensayo de T2 y el alta de cuentas de T3 la llaman para las nuevas.
CREATE FUNCTION integrations.sembrar_corrientes(cuenta uuid) RETURNS integer LANGUAGE sql AS $$
  WITH nuevas AS (
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
    ON CONFLICT (channel_account_id, topic, cursor_kind) DO NOTHING
    RETURNING 1)
  SELECT count(*)::integer FROM nuevas;
$$;

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
