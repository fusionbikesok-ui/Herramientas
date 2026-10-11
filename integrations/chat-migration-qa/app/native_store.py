"""Native chat persistence. Experimental: deployed only against the isolated QA database."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from typing import Any

from .storage import connection, init_schema


class ChatError(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)


def require_sandbox() -> None:
    import os
    from urllib.parse import urlparse
    from .config import get_settings
    settings = get_settings()
    parsed = urlparse(settings.database_url)
    if (settings.app_env != 'migration-test' or parsed.path != '/native_chat_qa'
            or parsed.username != 'native_chat_qa' or settings.ai_enabled
            or os.environ.get('NATIVE_BOT_MODE') != 'simulated'):
        raise RuntimeError('This migration preview must use its isolated QA database and simulated bot')


SCHEMA = (
    """CREATE TABLE IF NOT EXISTS native_sessions (
        id UUID PRIMARY KEY, conversation_key TEXT UNIQUE NOT NULL REFERENCES conversations(conversation_key),
        token_hash TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','archived')),
        agent_id TEXT, agent_name TEXT, revision INTEGER NOT NULL DEFAULT 1,
        needs_human BOOLEAN NOT NULL DEFAULT FALSE, handoff_reason TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'normal', last_customer_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS native_commands (
        session_id UUID NOT NULL REFERENCES native_sessions(id), request_id UUID NOT NULL,
        digest TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(session_id,request_id))""",
    """CREATE TABLE IF NOT EXISTS native_jobs (
        id UUID PRIMARY KEY, session_id UUID NOT NULL REFERENCES native_sessions(id),
        message_id BIGINT NOT NULL REFERENCES messages(id), revision INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','done','superseded','failed')),
        attempts INTEGER NOT NULL DEFAULT 0, lease UUID, lease_until TIMESTAMPTZ,
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(), error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS native_audit (
        id BIGSERIAL PRIMARY KEY, session_id UUID NOT NULL REFERENCES native_sessions(id),
        actor_id TEXT NOT NULL, action TEXT NOT NULL, request_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())""",
    'CREATE INDEX IF NOT EXISTS native_sessions_inbox ON native_sessions(status,updated_at DESC,id)',
    'CREATE INDEX IF NOT EXISTS native_jobs_ready ON native_jobs(status,available_at,lease_until)',
)


def initialize() -> None:
    require_sandbox()
    init_schema()
    with connection() as conn, conn.transaction():
        for sql in SCHEMA:
            conn.execute(sql)


def token_hash(token: str) -> str:
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ChatError(401, 'invalid_session')
    return hashlib.sha256(token.encode()).hexdigest()


def valid_phone(value: str) -> str:
    digits = re.sub(r'[^0-9]', '', value)
    if not 10 <= len(digits) <= 15 or len(set(digits)) < 3:
        raise ChatError(422, 'valid_phone_required')
    return digits


def session_view(row: dict) -> dict:
    return {k: (str(row[k]) if k == 'id' else row[k]) for k in (
        'id', 'status', 'agent_id', 'agent_name', 'revision', 'needs_human',
        'handoff_reason', 'priority', 'customer_name', 'customer_phone', 'bot_status')}


def get_locked(conn, session_id: str | None = None, digest: str | None = None) -> dict:
    predicate, value = ('s.id=%s', session_id) if session_id else ('s.token_hash=%s', digest)
    row = conn.execute(
        f'''SELECT s.*,c.customer_name,c.customer_phone,c.bot_status,c.context
        FROM native_sessions s JOIN conversations c USING(conversation_key)
        WHERE {predicate} FOR UPDATE OF s,c''', (value,)).fetchone()
    if not row:
        raise ChatError(404, 'session_not_found')
    return row


def start_session(token: str, name: str, phone: str, page_url: str, page_title: str) -> dict:
    digest = token_hash(token)
    phone = valid_phone(phone)
    key = 'native:web:' + digest
    with connection() as conn, conn.transaction():
        # Concurrent first requests use the same lock, before either session exists.
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (key,))
        existing = conn.execute('SELECT id FROM native_sessions WHERE token_hash=%s', (digest,)).fetchone()
        if not existing:
            conn.execute('''INSERT INTO conversations(conversation_key,channel,customer_name,customer_phone,department,context)
                VALUES(%s,'web',%s,%s,'ventas',%s::jsonb)''',
                (key, name, phone, json.dumps({'page_url': page_url, 'page_title': page_title, 'source': 'native-qa'})))
            conn.execute('INSERT INTO native_sessions(id,conversation_key,token_hash) VALUES(%s,%s,%s)',
                         (str(uuid.uuid4()), key, digest))
        return session_view(get_locked(conn, digest=digest))


def command_digest(action: str, payload: dict) -> str:
    return hashlib.sha256(json.dumps([action, payload], sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def previous_command(conn, row: dict, request_id: str, digest: str) -> dict | None:
    old = conn.execute('SELECT digest,result FROM native_commands WHERE session_id=%s AND request_id=%s',
                       (row['id'], request_id)).fetchone()
    if old and old['digest'] != digest:
        raise ChatError(409, 'request_id_reused_with_different_content')
    return old['result'] if old else None


def remember(conn, row: dict, request_id: str, digest: str, result: dict, actor: str, action: str) -> dict:
    conn.execute('INSERT INTO native_commands(session_id,request_id,digest,result) VALUES(%s,%s,%s,%s::jsonb)',
                 (row['id'], request_id, digest, json.dumps(result)))
    conn.execute('INSERT INTO native_audit(session_id,actor_id,action,request_id) VALUES(%s,%s,%s,%s)',
                 (row['id'], actor, action, request_id))
    return result


def insert_message(conn, row: dict, external_id: str, sender: str, text: str, agent: str = '') -> int:
    result = conn.execute('''INSERT INTO messages(conversation_key,external_id,sender,agent_name,body,metadata)
        VALUES(%s,%s,%s,%s,%s,'{"source":"native-qa"}') RETURNING id''',
        (row['conversation_key'], external_id, sender, agent or None, text)).fetchone()
    conn.execute('UPDATE native_sessions SET updated_at=now() WHERE id=%s', (row['id'],))
    conn.execute('UPDATE conversations SET updated_at=now() WHERE conversation_key=%s', (row['conversation_key'],))
    return int(result['id'])


def send_customer(token: str, request_id: str, text: str) -> dict:
    digest = command_digest('customer_message', {'text': text})
    with connection() as conn, conn.transaction():
        row = get_locked(conn, digest=token_hash(token))
        old = previous_command(conn, row, request_id, digest)
        if old is not None:
            return old
        if row['status'] == 'archived':
            conn.execute("UPDATE native_sessions SET status='open',agent_id=NULL,agent_name=NULL,needs_human=FALSE,handoff_reason='',revision=revision+1 WHERE id=%s", (row['id'],))
            conn.execute("UPDATE conversations SET bot_status='active' WHERE conversation_key=%s", (row['conversation_key'],))
            row = get_locked(conn, session_id=str(row['id']))
        message_id = insert_message(conn, row, f'native:{row["id"]}:{request_id}', 'customer', text)
        conn.execute('UPDATE native_sessions SET last_customer_id=%s WHERE id=%s', (message_id, row['id']))
        if not row['agent_id'] and row['bot_status'] == 'active':
            conn.execute('INSERT INTO native_jobs(id,session_id,message_id,revision) VALUES(%s,%s,%s,%s)',
                         (str(uuid.uuid4()), row['id'], message_id, row['revision']))
        return remember(conn, row, request_id, digest, {'message_id': message_id, 'session': session_view(row)}, 'customer', 'message')


def messages_for(conn, row: dict, after: int, limit: int) -> dict:
    items = conn.execute('''SELECT id,sender,agent_name,body AS text,created_at FROM messages
        WHERE conversation_key=%s AND id>%s ORDER BY id LIMIT %s''', (row['conversation_key'], after, limit + 1)).fetchall()
    return {'session': session_view(row), 'messages': items[:limit], 'has_more': len(items) > limit,
            'cursor': int(items[min(len(items), limit) - 1]['id']) if items else after}


def poll(token: str, after: int, limit: int = 100) -> dict:
    with connection() as conn, conn.transaction():
        row = get_locked(conn, digest=token_hash(token))
        return messages_for(conn, row, after, limit)


def operator_read(session_id: str, after: int = 0, limit: int = 100) -> dict:
    with connection() as conn, conn.transaction():
        return messages_for(conn, get_locked(conn, session_id=session_id), after, limit)


def inbox(status: str = 'open', offset: int = 0, limit: int = 50) -> dict:
    with connection() as conn:
        rows = conn.execute('''SELECT s.*,c.customer_name,c.customer_phone,c.bot_status,
            (SELECT body FROM messages WHERE conversation_key=s.conversation_key ORDER BY id DESC LIMIT 1) AS last_message
            FROM native_sessions s JOIN conversations c USING(conversation_key)
            WHERE s.status=%s AND EXISTS (SELECT 1 FROM messages WHERE conversation_key=s.conversation_key)
            ORDER BY s.updated_at DESC,s.id DESC LIMIT %s OFFSET %s''', (status, limit + 1, offset)).fetchall()
        return {'sessions': [dict(session_view(r), last_message=r['last_message'], updated_at=r['updated_at']) for r in rows[:limit]],
                'has_more': len(rows) > limit, 'next_offset': offset + min(len(rows), limit)}


def operator_action(action: str, session_id: str, actor_id: str, actor_name: str,
                    revision: int, request_id: str, text: str = '') -> dict:
    if action not in {'take', 'release', 'reply', 'archive', 'reopen'}:
        raise ChatError(422, 'invalid_action')
    digest = command_digest(action, {'actor_id': actor_id, 'actor_name': actor_name, 'revision': revision, 'text': text})
    with connection() as conn, conn.transaction():
        row = get_locked(conn, session_id=session_id)
        old = previous_command(conn, row, request_id, digest)
        if old is not None:
            return old
        if row['revision'] != revision:
            raise ChatError(409, 'conversation_changed_reload')
        if row['agent_id'] and row['agent_id'] != actor_id:
            raise ChatError(409, 'owned_by_another_operator')
        if action in {'release', 'reply'} and row['agent_id'] != actor_id:
            raise ChatError(403, 'take_conversation_first')
        if row['status'] != 'open' and action != 'reopen':
            raise ChatError(409, 'conversation_archived')
        if action == 'reopen' and row['status'] != 'archived':
            raise ChatError(409, 'conversation_already_open')
        message_id = None
        if action == 'take':
            conn.execute("UPDATE native_sessions SET agent_id=%s,agent_name=%s,needs_human=FALSE,revision=revision+1,updated_at=now() WHERE id=%s", (actor_id, actor_name, row['id']))
            conn.execute("UPDATE conversations SET bot_status='paused' WHERE conversation_key=%s", (row['conversation_key'],))
        elif action == 'reply':
            if not text:
                raise ChatError(422, 'message_required')
            message_id = insert_message(conn, row, f'native:{row["id"]}:{request_id}', 'operator', text, actor_name)
        else:
            status, bot = ('archived', 'paused') if action == 'archive' else ('open', 'active')
            conn.execute('''UPDATE native_sessions SET status=%s,agent_id=NULL,agent_name=NULL,
                needs_human=FALSE,handoff_reason='',revision=revision+1,updated_at=now() WHERE id=%s''', (status, row['id']))
            conn.execute('UPDATE conversations SET bot_status=%s WHERE conversation_key=%s', (bot, row['conversation_key']))
        current = get_locked(conn, session_id=session_id)
        return remember(conn, row, request_id, digest, {'session': session_view(current), 'message_id': message_id}, actor_id, action)


def claim_job() -> dict | None:
    with connection() as conn, conn.transaction():
        # Exhausted crashed jobs become visible as failed rather than remaining processing forever.
        conn.execute("UPDATE native_jobs SET status='failed',error_code='lease_retries_exhausted',updated_at=now() WHERE status='processing' AND lease_until<now() AND attempts>=5")
        row = conn.execute('''SELECT * FROM native_jobs WHERE attempts<5 AND
            ((status='queued' AND available_at<=now()) OR (status='processing' AND lease_until<now()))
            ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1''').fetchone()
        if not row:
            return None
        lease = str(uuid.uuid4())
        conn.execute("UPDATE native_jobs SET status='processing',attempts=attempts+1,lease=%s,lease_until=now()+interval '120 seconds',updated_at=now() WHERE id=%s", (lease, row['id']))
        row.update(lease=lease, attempts=row['attempts'] + 1)
        return row


def job_input(job: dict) -> dict:
    with connection() as conn:
        row = conn.execute('''SELECT s.conversation_key,c.customer_name,c.customer_phone,c.context,m.body
            FROM native_sessions s JOIN conversations c USING(conversation_key)
            JOIN messages m ON m.id=%s AND m.conversation_key=s.conversation_key WHERE s.id=%s''', (job['message_id'], job['session_id'])).fetchone()
        return dict(row)


def finish_job(job: dict, decision: Any) -> bool:
    with connection() as conn, conn.transaction():
        row = get_locked(conn, session_id=str(job['session_id']))
        current = conn.execute('SELECT * FROM native_jobs WHERE id=%s FOR UPDATE', (job['id'],)).fetchone()
        if current['status'] != 'processing' or str(current['lease']) != job['lease']:
            return False
        if (row['revision'] != job['revision'] or row['status'] != 'open' or row['agent_id']
                or row['bot_status'] != 'active' or row['last_customer_id'] != job['message_id']):
            conn.execute("UPDATE native_jobs SET status='superseded',lease=NULL,lease_until=NULL,updated_at=now() WHERE id=%s", (job['id'],))
            return False
        insert_message(conn, row, 'native:bot:' + str(job['id']), 'bot', decision.reply, 'Fabri · prueba')
        if decision.handoff:
            conn.execute("UPDATE native_sessions SET needs_human=TRUE,handoff_reason=%s,priority=%s,revision=revision+1 WHERE id=%s", (decision.reason[:500], decision.priority, row['id']))
            conn.execute("UPDATE conversations SET bot_status='handoff' WHERE conversation_key=%s", (row['conversation_key'],))
        conn.execute("UPDATE native_jobs SET status='done',lease=NULL,lease_until=NULL,updated_at=now() WHERE id=%s", (job['id'],))
        return True


def fail_job(job: dict, error_code: str) -> None:
    with connection() as conn:
        conn.execute("""UPDATE native_jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
            available_at=now()+interval '10 seconds',lease=NULL,lease_until=NULL,error_code=%s,updated_at=now()
            WHERE id=%s AND lease=%s AND status='processing'""", (error_code[:80], job['id'], job['lease']))
