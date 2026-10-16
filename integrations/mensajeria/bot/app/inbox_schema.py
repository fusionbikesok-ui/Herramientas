"""Additive inbox migration. Existing web-chat tables and rows remain intact."""
from .inbox_prospects import TABLE_SQL, INDEX_SQL

STATEMENTS = (
    TABLE_SQL, INDEX_SQL,
    """CREATE TABLE IF NOT EXISTS sales_ai_calls (
        id BIGSERIAL PRIMARY KEY, message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key),
        step INTEGER NOT NULL, state TEXT NOT NULL, reserved_microusd BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(message_id,step))""",
    "CREATE INDEX IF NOT EXISTS sales_ai_calls_created_idx ON sales_ai_calls(created_at)",
    """CREATE TABLE IF NOT EXISTS multimedia_jobs (
        message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key),
        kind TEXT NOT NULL, state TEXT NOT NULL, reserved_microusd BIGINT NOT NULL,
        result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    "CREATE INDEX IF NOT EXISTS multimedia_jobs_created_idx ON multimedia_jobs(created_at)",
    # PostgreSQL 16 supplies gen_random_uuid natively; defaults cover future
    # legacy inserts too. Existing rows are backfilled by this additive ALTER.
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS inbox_public_id UUID NOT NULL DEFAULT gen_random_uuid()",
    "CREATE UNIQUE INDEX IF NOT EXISTS inbox_public_id_idx ON conversations(inbox_public_id)",
    """CREATE TABLE IF NOT EXISTS inbox_web_message_map (
        wp_message_id BIGINT PRIMARY KEY, message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key) ON DELETE CASCADE)""",
    """CREATE TABLE IF NOT EXISTS inbox_web_sync (
        conversation_key TEXT PRIMARY KEY REFERENCES conversations(conversation_key) ON DELETE CASCADE,
        revision BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS inbox_status TEXT NOT NULL DEFAULT 'open'",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_id TEXT",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_name TEXT",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS unread INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS inbox_read_at TIMESTAMPTZ",
    "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS labels JSONB NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text'",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_id TEXT",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'received'",
    """CREATE TABLE IF NOT EXISTS inbox_media (
        id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key),
        actor_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL,
        content BYTEA, remote_id TEXT, number_id TEXT NOT NULL, size INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS inbox_requests (
        actor_id TEXT NOT NULL, request_id UUID NOT NULL, fingerprint TEXT NOT NULL,
        response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(actor_id,request_id))""",
    "ALTER TABLE inbox_media ADD COLUMN IF NOT EXISTS is_voice BOOLEAN NOT NULL DEFAULT FALSE",
    """CREATE TABLE IF NOT EXISTS inbox_outbox (
        id UUID PRIMARY KEY, conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key),
        message_id BIGINT NOT NULL UNIQUE REFERENCES messages(id), actor_id TEXT NOT NULL,
        is_ai BOOLEAN NOT NULL DEFAULT FALSE, expected_revision BIGINT, source_id TEXT UNIQUE,
        state TEXT NOT NULL DEFAULT 'queued', remote_id TEXT UNIQUE, error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS inbox_audit (
        id BIGSERIAL PRIMARY KEY, conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key),
        actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS inbox_presence (
        actor_id TEXT PRIMARY KEY, actor_name TEXT NOT NULL, status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
    "CREATE INDEX IF NOT EXISTS inbox_threads_idx ON conversations(channel,inbox_status,updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS inbox_outbox_queue_idx ON inbox_outbox(state,created_at)",
    "CREATE INDEX IF NOT EXISTS inbox_audit_key_idx ON inbox_audit(conversation_key,id DESC)",
)


def migrate(conn):
    # Multiple API/worker processes can start concurrently.
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(736428190127)")
        for statement in STATEMENTS:
            conn.execute(statement)
