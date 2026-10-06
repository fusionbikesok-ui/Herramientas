-- E1 T2: corrientes de reconciliación, leases, observaciones y payload cifrado.

ALTER TABLE integrations.inbox_messages
  ADD COLUMN payload_key_id text,
  ADD COLUMN payload_nonce bytea,
  ADD COLUMN payload_tag bytea,
  ADD CONSTRAINT inbox_payload_envelope_check CHECK (
    (payload_ciphertext IS NULL AND payload_key_id IS NULL AND payload_nonce IS NULL AND payload_tag IS NULL)
    OR
    (payload_ciphertext IS NOT NULL AND length(payload_ciphertext) > 0
      AND payload_key_id IS NOT NULL AND length(payload_key_id) BETWEEN 1 AND 128
      AND payload_nonce IS NOT NULL AND payload_tag IS NOT NULL
      AND length(payload_nonce) = 12 AND length(payload_tag) = 16)
  );

ALTER TABLE integrations.reconciliation_cursors
  DROP CONSTRAINT reconciliation_cursors_pkey,
  ADD COLUMN cursor_kind text NOT NULL DEFAULT 'state_sweep',
  ADD COLUMN enabled boolean NOT NULL DEFAULT true;

ALTER TABLE integrations.reconciliation_cursors
  ALTER COLUMN cursor_value TYPE jsonb
    USING CASE WHEN cursor_value IS NULL THEN NULL
      ELSE jsonb_build_object('v', 1, 'legacy', cursor_value) END;

UPDATE integrations.reconciliation_cursors
   SET enabled = false
 WHERE cursor_value ? 'legacy';

ALTER TABLE integrations.reconciliation_cursors
  ADD CONSTRAINT reconciliation_cursors_cursor_kind_check
    CHECK (cursor_kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  ADD CONSTRAINT reconciliation_cursors_cursor_value_check
    CHECK (cursor_value IS NULL OR (
      jsonb_typeof(cursor_value) = 'object'
      AND cursor_value ? 'v'
      AND cursor_value->>'v' = '1'
    )),
  ADD PRIMARY KEY (channel_account_id, topic, cursor_kind);

INSERT INTO integrations.reconciliation_cursors
  (channel_account_id, topic, cursor_kind, enabled, strategy, cursor_value,
   overlap_seconds, interval_seconds, next_run_at)
SELECT DISTINCT channel_account_id, topic, 'state_sweep', false, strategy, NULL::jsonb,
       600, 86400, now()
  FROM integrations.sweep_runs
ON CONFLICT (channel_account_id, topic, cursor_kind) DO NOTHING;

UPDATE integrations.sweep_runs SET status = 'partial' WHERE status = 'running';

ALTER TABLE integrations.sweep_runs
  DROP CONSTRAINT sweep_runs_status_check,
  ADD COLUMN cursor_kind text NOT NULL DEFAULT 'state_sweep',
  ADD COLUMN scheduled_for timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN worker_id text,
  ADD COLUMN cursor_before jsonb,
  ADD COLUMN cursor_after jsonb,
  ADD COLUMN correlation_id uuid NOT NULL DEFAULT uuidv7(),
  ADD CONSTRAINT sweep_runs_status_check
    CHECK (status IN ('pending', 'claimed', 'succeeded', 'retryable', 'failed', 'partial')),
  ADD CONSTRAINT sweep_runs_lease_check CHECK (
    (status = 'claimed') = (lease_token IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)
  ),
  ADD CONSTRAINT sweep_runs_cursor_kind_check
    CHECK (cursor_kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  ADD CONSTRAINT sweep_runs_cursor_before_check
    CHECK (cursor_before IS NULL OR jsonb_typeof(cursor_before) = 'object'),
  ADD CONSTRAINT sweep_runs_cursor_after_check
    CHECK (cursor_after IS NULL OR jsonb_typeof(cursor_after) = 'object'),
  ADD CONSTRAINT sweep_runs_cursor_fk
    FOREIGN KEY (channel_account_id, topic, cursor_kind)
    REFERENCES integrations.reconciliation_cursors(channel_account_id, topic, cursor_kind)
    ON DELETE RESTRICT;

ALTER TABLE integrations.sweep_runs ALTER COLUMN status SET DEFAULT 'pending';
CREATE UNIQUE INDEX sweep_runs_un_activa
  ON integrations.sweep_runs(channel_account_id, topic, cursor_kind)
  WHERE status IN ('pending', 'claimed', 'retryable');
CREATE INDEX sweep_runs_claimable
  ON integrations.sweep_runs(status, available_at, id)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX sweep_runs_lease
  ON integrations.sweep_runs(lease_until)
  WHERE status = 'claimed';

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
CREATE INDEX resource_observations_retention
  ON integrations.resource_observations(last_seen_at)
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
CREATE INDEX resource_relations_retention
  ON integrations.resource_relations(last_seen_at)
  WHERE lifecycle IN ('closed', 'deleted');
