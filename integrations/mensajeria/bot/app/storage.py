from __future__ import annotations

import json
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

from .config import get_settings
from .prompting import DEFAULT_PROMPT_CONFIG, sanitize_prompt_config


SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS conversations (
        conversation_key TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        wp_token TEXT,
        external_user_id TEXT,
        channel_number_id TEXT,
        channel_label TEXT,
        customer_name TEXT,
        customer_phone TEXT,
        department TEXT,
        bot_status TEXT NOT NULL DEFAULT 'active',
        context JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key) ON DELETE CASCADE,
        external_id TEXT UNIQUE,
        sender TEXT NOT NULL,
        agent_name TEXT,
        body TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS system_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS prompt_versions (
        id BIGSERIAL PRIMARY KEY,
        revision INTEGER UNIQUE NOT NULL,
        config JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'archived',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_at TIMESTAMPTZ
    )
    """,
    "CREATE INDEX IF NOT EXISTS events_status_idx ON events(status, created_at)",
    "CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_key, id DESC)",
    "CREATE INDEX IF NOT EXISTS prompt_versions_status_idx ON prompt_versions(status, revision DESC)",
)


@contextmanager
def connection() -> Iterator[psycopg.Connection[Any]]:
    conn = psycopg.connect(get_settings().database_url, autocommit=True, row_factory=dict_row)
    try:
        yield conn
    finally:
        conn.close()


def init_schema() -> None:
    with connection() as conn:
        for statement in SCHEMA_STATEMENTS:
            conn.execute(statement)
        conn.execute(
            """
            INSERT INTO prompt_versions(revision, config, status, created_by, activated_at)
            SELECT 1, %s::jsonb, 'active', 'Sistema', NOW()
            WHERE NOT EXISTS (SELECT 1 FROM prompt_versions)
            ON CONFLICT(revision) DO NOTHING
            """,
            (json.dumps(DEFAULT_PROMPT_CONFIG, ensure_ascii=False),),
        )
        from .inbox_schema import migrate
        migrate(conn)


def record_event(payload: dict[str, Any]) -> bool:
    event_id = str(payload.get("event_id") or "")
    event_type = str(payload.get("event_type") or "unknown")
    if not event_id:
        raise ValueError("event_id is required")
    with connection() as conn:
        row = conn.execute(
            """
            INSERT INTO events(event_id, event_type, payload)
            VALUES (%s, %s, %s::jsonb)
            ON CONFLICT(event_id) DO NOTHING
            RETURNING event_id
            """,
            (event_id, event_type, json.dumps(payload, ensure_ascii=False)),
        ).fetchone()
    return bool(row)


def mark_event(event_id: str, status: str, error: str = "") -> None:
    with connection() as conn:
        conn.execute(
            """
            UPDATE events
            SET status=%s,
                attempts=CASE WHEN %s='processing' THEN attempts+1 ELSE attempts END,
                last_error=%s,
                updated_at=NOW()
            WHERE event_id=%s
            """,
            (status, status, error[:1000] if error else None, event_id),
        )


def event_status(event_id: str) -> str:
    with connection() as conn:
        row = conn.execute(
            "SELECT status FROM events WHERE event_id=%s LIMIT 1",
            (event_id,),
        ).fetchone()
    return str(row["status"]) if row else ""


def recover_stale_events(minutes: int = 10) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            """
            UPDATE events
            SET status='queued', updated_at=NOW(), last_error='Recovered after interrupted worker'
            WHERE status='processing'
              AND updated_at < NOW() - (%s * INTERVAL '1 minute')
            RETURNING payload
            """,
            (max(1, minutes),),
        ).fetchall()
    return [dict(row["payload"]) for row in rows if isinstance(row.get("payload"), dict)]


def upsert_conversation(
    key: str,
    conversation: dict[str, Any],
    department: str,
    bot_status: str | None = None,
) -> dict[str, Any]:
    channel = str(conversation.get("channel") or "web")
    status = bot_status or str(conversation.get("bot_status") or "active")
    status_explicit = bot_status is not None or "bot_status" in conversation
    with connection() as conn:
        row = conn.execute(
            """
            INSERT INTO conversations(
                conversation_key, channel, wp_token, external_user_id, channel_number_id,
                channel_label, customer_name, customer_phone, department, bot_status, context
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
            ON CONFLICT(conversation_key) DO UPDATE SET
                channel=EXCLUDED.channel,
                wp_token=COALESCE(NULLIF(EXCLUDED.wp_token,''), conversations.wp_token),
                external_user_id=COALESCE(NULLIF(EXCLUDED.external_user_id,''), conversations.external_user_id),
                channel_number_id=COALESCE(NULLIF(EXCLUDED.channel_number_id,''), conversations.channel_number_id),
                channel_label=COALESCE(NULLIF(EXCLUDED.channel_label,''), conversations.channel_label),
                customer_name=COALESCE(NULLIF(EXCLUDED.customer_name,''), conversations.customer_name),
                customer_phone=COALESCE(NULLIF(EXCLUDED.customer_phone,''), conversations.customer_phone),
                department=EXCLUDED.department,
                bot_status=CASE WHEN %s THEN EXCLUDED.bot_status ELSE conversations.bot_status END,
                context=conversations.context || EXCLUDED.context,
                updated_at=NOW()
            RETURNING *
            """,
            (
                key,
                channel,
                str(conversation.get("token") or ""),
                str(conversation.get("external_user_id") or ""),
                str(conversation.get("channel_number_id") or ""),
                str(conversation.get("channel_label") or ""),
                str(conversation.get("customer_name") or ""),
                str(conversation.get("customer_phone") or ""),
                department,
                status,
                json.dumps(conversation, ensure_ascii=False),
                status_explicit,
            ),
        ).fetchone()
    return dict(row or {})


def get_conversation(key: str) -> dict[str, Any] | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE conversation_key=%s LIMIT 1",
            (key,),
        ).fetchone()
    return dict(row) if row else None


def set_bot_status(key: str, status: str) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE conversations SET bot_status=%s, updated_at=NOW() WHERE conversation_key=%s",
            (status, key),
        )


def set_system_setting(key: str, value: Any) -> None:
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO system_settings(setting_key, setting_value)
            VALUES (%s, %s::jsonb)
            ON CONFLICT(setting_key) DO UPDATE SET
                setting_value=EXCLUDED.setting_value,
                updated_at=NOW()
            """,
            (key, json.dumps(value, ensure_ascii=False)),
        )


def get_system_setting(key: str, default: Any = None) -> Any:
    with connection() as conn:
        row = conn.execute(
            "SELECT setting_value FROM system_settings WHERE setting_key=%s LIMIT 1",
            (key,),
        ).fetchone()
    return row["setting_value"] if row else default


def get_active_prompt_version() -> dict[str, Any]:
    with connection() as conn:
        row = conn.execute(
            """
            SELECT revision, config, status, created_by, created_at, activated_at
            FROM prompt_versions
            WHERE status='active'
            ORDER BY revision DESC
            LIMIT 1
            """
        ).fetchone()
    if not row:
        return {
            "revision": 0,
            "config": dict(DEFAULT_PROMPT_CONFIG),
            "status": "default",
            "created_by": "Sistema",
        }
    result = dict(row)
    result["config"] = sanitize_prompt_config(result.get("config"))
    return result


def list_prompt_versions(limit: int = 10) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT revision, config, status, created_by, created_at, activated_at
            FROM prompt_versions
            ORDER BY revision DESC
            LIMIT %s
            """,
            (max(1, min(limit, 25)),),
        ).fetchall()
    versions: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["config"] = sanitize_prompt_config(item.get("config"))
        versions.append(item)
    return versions


def save_prompt_version(config: Any, created_by: str = "WooCommerce") -> dict[str, Any]:
    clean = sanitize_prompt_config(config)
    author = str(created_by or "WooCommerce").strip()[:120]
    with connection() as conn:
        with conn.transaction():
            conn.execute("LOCK TABLE prompt_versions IN EXCLUSIVE MODE")
            row = conn.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM prompt_versions"
            ).fetchone()
            revision = int(row["revision"] if row else 1)
            conn.execute(
                "UPDATE prompt_versions SET status='archived' WHERE status='active'"
            )
            saved = conn.execute(
                """
                INSERT INTO prompt_versions(revision, config, status, created_by, activated_at)
                VALUES (%s, %s::jsonb, 'active', %s, NOW())
                RETURNING revision, config, status, created_by, created_at, activated_at
                """,
                (revision, json.dumps(clean, ensure_ascii=False), author),
            ).fetchone()
    result = dict(saved or {})
    result["config"] = clean
    return result


def activate_prompt_version(revision: int) -> dict[str, Any] | None:
    with connection() as conn:
        with conn.transaction():
            target = conn.execute(
                "SELECT revision FROM prompt_versions WHERE revision=%s LIMIT 1",
                (int(revision),),
            ).fetchone()
            if not target:
                return None
            conn.execute("UPDATE prompt_versions SET status='archived' WHERE status='active'")
            row = conn.execute(
                """
                UPDATE prompt_versions
                SET status='active', activated_at=NOW()
                WHERE revision=%s
                RETURNING revision, config, status, created_by, created_at, activated_at
                """,
                (int(revision),),
            ).fetchone()
    result = dict(row or {})
    if result:
        result["config"] = sanitize_prompt_config(result.get("config"))
    return result or None


def append_message(
    *,
    key: str,
    external_id: str,
    sender: str,
    body: str,
    agent_name: str = "",
    metadata: dict[str, Any] | None = None,
) -> tuple[int, bool]:
    external_value = external_id or None
    with connection() as conn:
        row = conn.execute(
            """
            INSERT INTO messages(conversation_key, external_id, sender, agent_name, body, metadata)
            VALUES (%s,%s,%s,%s,%s,%s::jsonb)
            ON CONFLICT(external_id) DO NOTHING
            RETURNING id
            """,
            (
                key,
                external_value,
                sender,
                agent_name or None,
                body,
                json.dumps(metadata or {}, ensure_ascii=False),
            ),
        ).fetchone()
        if row:
            return int(row["id"]), True
        if external_value:
            existing = conn.execute(
                "SELECT id FROM messages WHERE external_id=%s LIMIT 1",
                (external_value,),
            ).fetchone()
            return int(existing["id"]) if existing else 0, False
    return 0, False


def recent_messages(key: str, limit: int = 16) -> list[dict[str, Any]]:
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT m.sender, m.agent_name, m.body, m.created_at
            FROM messages m JOIN conversations c ON c.conversation_key=m.conversation_key
            WHERE m.conversation_key=%s
              AND m.sender != 'note'
              AND (m.sender='customer'
                   OR m.delivery_status NOT IN ('queued','sending','unknown','failed','cancelled','pending'))
            ORDER BY CASE WHEN c.channel='whatsapp' OR c.context->>'web_inbox_live'='true'
                          OR c.context->>'web_inbox_imported'='true' THEN m.created_at END DESC,m.id DESC
            LIMIT %s
            """,
            (key, max(1, min(limit, 50))),
        ).fetchall()
    return [dict(row) for row in reversed(rows)]
