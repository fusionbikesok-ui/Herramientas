"""Transactional WhatsApp inbox. Only the signed Herramientas proxy sets identity."""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta

from .config import get_settings
from .storage import connection, get_system_setting
from .number_controls import MANAGED_NUMBERS, configured_number, number_bot_enabled
from .availability import channel_bot_available
from .inbox_media import CloudTransport, MediaError, decode_upload, validate_media
from .inbox_templates import TemplateCatalog, TemplateError, render_template, verified_template


class InboxError(Exception):
    def __init__(self, code, status=422):
        super().__init__(code)
        self.code, self.status = code, status


def json_safe(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


def verify_request(body, headers, redis, now=None):
    secret = os.getenv('INBOX_PROXY_SECRET', '')
    settings = get_settings()
    if len(secret) < 32 or secret in {settings.api_key, settings.callback_secret, settings.meta_app_secret}:
        raise InboxError('inbox_not_configured', 503)
    stamp = headers.get('x-inbox-timestamp', '')
    nonce = headers.get('x-inbox-nonce', '')
    signature = headers.get('x-inbox-signature', '')
    if not re.fullmatch(r'\d{10}', stamp) or abs((time.time() if now is None else now) - int(stamp)) > 60:
        raise InboxError('invalid_timestamp', 401)
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', nonce):
        raise InboxError('invalid_nonce', 401)
    expected = hmac.new(secret.encode(), stamp.encode() + b'.' + nonce.encode() + b'.' + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise InboxError('invalid_signature', 401)
    try:
        accepted = redis.set('inbox:nonce:' + nonce, '1', nx=True, ex=125)
    except Exception as exc:
        raise InboxError('nonce_store_unavailable', 503) from exc
    if not accepted:
        raise InboxError('replayed_request', 401)


def actor_from(payload):
    actor = payload.get('actor')
    if not isinstance(actor, dict) or not re.fullmatch(r'herramientas:[A-Za-z0-9_-]{1,100}', str(actor.get('id') or '')):
        raise InboxError('invalid_actor', 403)
    if actor.get('role') not in {'reader', 'agent', 'supervisor'}:
        raise InboxError('invalid_role', 403)
    name = str(actor.get('name') or '').strip()[:120]
    if not name:
        raise InboxError('invalid_actor', 403)
    return dict(id=actor['id'], name=name, role=actor['role'])


def require_writer(actor):
    if actor['role'] == 'reader':
        raise InboxError('write_required', 403)


def require_owner(actor, row):
    require_writer(actor)
    if actor['role'] != 'supervisor' and row.get('owner_id') != actor['id']:
        raise InboxError('owner_required', 403)


def lock_thread(conn, key, session=False):
    # The sender holds a session lock across its committed sending marker + HTTP.
    # All ownership/state/echo mutations use the same key in their transaction.
    fn = 'pg_advisory_lock' if session else 'pg_advisory_xact_lock'
    conn.execute('SELECT ' + fn + '(hashtextextended(%s, 171717))', (key,))


@contextmanager
def locked_thread(key):
    with connection() as conn, conn.transaction():
        lock_thread(conn, key)
        row = conn.execute("SELECT * FROM conversations WHERE conversation_key=%s AND channel IN ('web','whatsapp') FOR UPDATE", (key,)).fetchone()
        if not row:
            raise InboxError('thread_not_found', 404)
        yield conn, row


def setting(conn, key, default=None):
    row = conn.execute('SELECT setting_value FROM system_settings WHERE setting_key=%s', (key,)).fetchone()
    return row['setting_value'] if row else default


def number_connected(number_id):
    settings = get_settings()
    allowed = {s.strip() for s in os.getenv('INBOX_CONNECTED_NUMBER_IDS', '').split(',') if s.strip()}
    return str(number_id) in allowed and bool(configured_number(str(number_id), settings.whatsapp_numbers)) and bool(settings.whatsapp_access_token)


def send_blocked(row, now=None, conn=None, web_enabled=None, template=False):
    if row.get('inbox_status') != 'open':
        return 'thread_closed'
    if row.get('channel') == 'web':
        enabled = web_enabled if web_enabled is not None else (setting(conn, 'web_inbox_enabled', False) if conn is not None else get_system_setting('web_inbox_enabled', False))
        return '' if enabled is True and row.get('wp_token') else 'web_not_connected'
    if row.get('channel') != 'whatsapp':
        return 'unsupported_channel'
    if not number_connected(row.get('channel_number_id')):
        return 'number_not_connected'
    if template:
        return ''
    last = row.get('last_inbound_at')
    current = now or datetime.now(timezone.utc)
    if not last or last <= current - timedelta(hours=24) or last > current + timedelta(minutes=1):
        return 'window_closed'
    return ''


def ai_allowed(conn, row):
    settings = get_settings()
    read = lambda key, default=None: setting(conn, key, default)
    return (not row.get('owner_id') and row.get('bot_status') == 'active' and not send_blocked(row, conn=conn)
        and read('bot_enabled', settings.ai_enabled) is True
        and channel_bot_available(row.get('channel'), read('bot_channel_config', {}))
        and (row.get('channel') == 'web' or number_bot_enabled(str(row.get('channel_number_id') or ''), settings.whatsapp_numbers, read)))


def public_thread_key(row):
    if row.get('channel') == 'web':
        return 'webthread:' + str(row['inbox_public_id'])
    return row['conversation_key']


def resolve_public_key(key):
    key = str(key or '')
    if key.startswith('whatsapp:') and len(key) <= 300:
        return key
    if not key.startswith('webthread:'):
        # Raw web:<widget token> is never a supported authenticated API key.
        raise InboxError('thread_not_found', 404)
    try:
        public_id = str(uuid.UUID(key[len('webthread:'):]))
    except ValueError:
        raise InboxError('thread_not_found', 404)
    with connection() as conn:
        row = conn.execute("SELECT conversation_key FROM conversations WHERE inbox_public_id=%s AND channel='web'", (public_id,)).fetchone()
    if not row:
        raise InboxError('thread_not_found', 404)
    return row['conversation_key']


def thread_view(row, actor=None, conn=None, web_enabled=None):
    reason = send_blocked(row, conn=conn, web_enabled=web_enabled)
    context = row.get('context') or {}
    channel = row.get('channel') or 'whatsapp'
    if not reason and actor and (actor['role'] == 'reader' or (actor['role'] != 'supervisor' and row.get('owner_id') != actor['id'])):
        reason = 'owner_required'
    template_reason = send_blocked(row, conn=conn, web_enabled=web_enabled, template=True) if channel == 'whatsapp' else 'unsupported_channel'
    if not template_reason and actor and (actor['role'] == 'reader' or (actor['role'] != 'supervisor' and row.get('owner_id') != actor['id'])):
        template_reason = 'owner_required'
    return json_safe({
        'key': public_thread_key(row), 'name': row.get('customer_name') or ('Visitante web' if channel == 'web' else 'Cliente de WhatsApp'),
        'channel': channel, 'page_url': str(context.get('page_url') or '')[:2000],
        'page_title': str(context.get('page_title') or '')[:500], 'handoff_reason': str(context.get('handoff_reason') or row.get('handoff_reason') or '')[:1000],
        'capabilities': {'text': True, 'media': channel == 'whatsapp'},
        'phone': row.get('customer_phone') or row.get('external_user_id') or '',
        'number_id': row.get('channel_number_id') or '', 'number_label': row.get('channel_label') or ('Web' if channel == 'web' else 'WhatsApp'),
        'owner_id': row.get('owner_id'), 'owner_name': row.get('owner_name'),
        'status': row.get('inbox_status') or 'open', 'revision': row.get('revision', 0),
        'bot_paused': row.get('bot_status') != 'active', 'preview': row.get('preview') or '',
        'updated_at': row.get('updated_at'), 'unread': row.get('unread', 0), 'labels': row.get('labels') or [],
        'last_inbound_at': row.get('last_inbound_at'), 'can_send': not reason, 'send_blocked_reason': reason,
        'can_send_template': not template_reason, 'template_blocked_reason': template_reason,
    })


def message_view(row):
    meta = row.get('metadata') or {}
    return json_safe({'id': str(row['id']), 'sender': row['sender'], 'agent_name': row.get('agent_name') or '',
        'text': row['body'], 'kind': row.get('kind') or 'text', 'media_id': row.get('media_id'),
        'file_name': row.get('file_name') or meta.get('file_name') or '', 'mime': row.get('mime') or meta.get('mime') or '',
        'status': row.get('delivery_status') or 'received', 'created_at': row['created_at'],
        'request_id': meta.get('request_id'), 'error_code': row.get('error_code'),
        'edited': bool(meta.get('edited')), 'revoked': bool(meta.get('revoked'))})


def audit(conn, key, actor, action, detail=None):
    conn.execute('INSERT INTO inbox_audit(conversation_key,actor_id,actor_name,action,detail) VALUES (%s,%s,%s,%s,%s::jsonb)',
                 (key, actor['id'], actor['name'], action, json.dumps(detail or {}, ensure_ascii=False)))


def _bounded_int(value, default, low, high):
    if value is None:
        return default
    if isinstance(value, bool):
        raise InboxError('invalid_number')
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise InboxError('invalid_number')
    return max(low, min(result, high))


def counts(conn, actor, channel='all'):
    row = conn.execute("""SELECT count(*) FILTER (WHERE inbox_status='open') AS all,
        count(*) FILTER (WHERE inbox_status='open' AND owner_id=%s) AS mine,
        count(*) FILTER (WHERE inbox_status='open' AND owner_id IS NULL) AS unassigned,
        count(*) FILTER (WHERE inbox_status='closed') AS closed
        FROM conversations WHERE channel IN ('web','whatsapp') AND (%s='all' OR channel=%s)""", (actor['id'],channel,channel)).fetchone()
    return dict(row)


def list_threads(payload, actor):
    filters = {'all': "c.inbox_status='open'", 'closed': "c.inbox_status='closed'",
        'mine': "c.inbox_status='open' AND c.owner_id=%s", 'unassigned': "c.inbox_status='open' AND c.owner_id IS NULL"}
    mode = payload.get('filter', 'all')
    if mode not in filters:
        raise InboxError('invalid_filter')
    channel = payload.get('channel', 'all')
    if channel not in {'all','web','whatsapp'}:
        raise InboxError('invalid_channel')
    where = ["c.channel IN ('web','whatsapp')", filters[mode]]
    params = [actor['id']] if mode == 'mine' else []
    if channel != 'all':
        where.append('c.channel=%s')
        params.append(channel)
    search = str(payload.get('search') or '').strip()[:200]
    if search:
        where.append("(c.customer_name ILIKE %s OR c.customer_phone ILIKE %s OR EXISTS (SELECT 1 FROM messages s WHERE s.conversation_key=c.conversation_key AND s.body ILIKE %s))")
        pattern = '%' + search.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        params.extend([pattern] * 3)
    if payload.get('number'):
        where.append('c.channel_number_id=%s')
        params.append(str(payload['number'])[:100])
    limit = _bounded_int(payload.get('limit'), 50, 1, 100)
    offset = _bounded_int(payload.get('offset'), 0, 0, 100000)
    with connection() as conn:
        rows = conn.execute("""SELECT c.*, (SELECT CASE WHEN NULLIF(BTRIM(m.body),'') IS NOT NULL THEN m.body
                ELSE CASE m.kind WHEN 'audio' THEN 'Audio' WHEN 'image' THEN 'Imagen'
                    WHEN 'video' THEN 'Video' WHEN 'document' THEN 'Archivo' ELSE '' END END
            FROM messages m WHERE m.conversation_key=c.conversation_key AND m.sender!='note' AND m.kind!='note'
            ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS preview FROM conversations c WHERE """ + ' AND '.join(where) +
            ' ORDER BY c.updated_at DESC,c.conversation_key LIMIT %s OFFSET %s', (*params, limit + 1, offset)).fetchall()
        totals = counts(conn, actor, channel)
        web_enabled = setting(conn,'web_inbox_enabled',False) is True
    return {'ok': True, 'threads': [thread_view(r, actor, web_enabled=web_enabled) for r in rows[:limit]], 'more': len(rows) > limit, 'counts': totals}


def related_phone_identity(value):
    """Read-only identity for Argentina's national/E.164 forms, never suffix matching.

    An explicit '+' on a foreign international number prevents interpreting its
    ten digits as a local Argentine number. Capture/storage are never changed.
    """
    raw = str(value or '').strip()
    if not re.fullmatch(r'[+0-9().\s-]+', raw):
        return None
    digits = re.sub(r'[^0-9]', '', raw)
    if not 10 <= len(digits) <= 15 or ('+' in raw and not re.fullmatch(r'\+[^+]*', raw)):
        return None
    if len(digits) == 10 and not raw.startswith('+'):
        return 'ar', digits
    if len(digits) == 12 and digits.startswith('54'):
        return 'ar', digits[2:]
    if len(digits) == 13 and digits.startswith('549'):
        return 'ar', digits[3:]
    return 'exact', digits


def read_thread(payload, actor):
    key = str(payload.get('key') or '')[:300]
    before = _bounded_int(payload.get('before'), 9223372036854775807, 1, 9223372036854775807)
    with connection() as conn:
        row = conn.execute("SELECT * FROM conversations WHERE conversation_key=%s AND channel IN ('web','whatsapp')", (key,)).fetchone()
        if not row:
            raise InboxError('thread_not_found', 404)
        before_stamp = None
        if payload.get('before') is not None:
            cursor = conn.execute('SELECT created_at FROM messages WHERE id=%s AND conversation_key=%s', (before, key)).fetchone()
            if not cursor:
                raise InboxError('invalid_cursor', 422)
            before_stamp = cursor['created_at']
        messages = conn.execute("""SELECT m.*, a.name AS file_name,a.mime,o.error_code FROM messages m
            LEFT JOIN inbox_media a ON a.id=m.media_id LEFT JOIN inbox_outbox o ON o.message_id=m.id
            WHERE m.conversation_key=%s AND (%s::timestamptz IS NULL OR (m.created_at,m.id)<(%s::timestamptz,%s))
            ORDER BY m.created_at DESC,m.id DESC LIMIT 51""", (key, before_stamp, before_stamp, before)).fetchall()
        audits = conn.execute('SELECT id,actor_id,actor_name,action,detail,created_at FROM inbox_audit WHERE conversation_key=%s ORDER BY id DESC LIMIT 50', (key,)).fetchall()
        related = []
        identity = related_phone_identity(row.get('customer_phone') or row.get('external_user_id'))
        if identity and row['channel'] == 'whatsapp':
            family, number = identity
            variants = [number, '54' + number, '549' + number] if family == 'ar' else [number]
            # Match complete candidate numbers only. Ten digits beginning with '+'
            # remain foreign international candidates, even when the digits happen
            # to equal an Argentine national number. Every chat retains its own
            # identity and history; this read never merges customer records.
            web_rows = conn.execute("""SELECT * FROM (
                SELECT conversation_key,inbox_public_id,customer_name,customer_phone,bot_status,context,updated_at,
                    regexp_replace(COALESCE(customer_phone,''),'[^0-9]','','g') AS digits
                FROM conversations WHERE channel='web' AND customer_phone ~ '^[+0-9().[:space:]-]+$'
                    AND customer_phone !~ '[+].*[+]'
                    AND (position('+' in customer_phone)=0 OR ltrim(customer_phone) LIKE '+%%')
                ) candidates WHERE digits=ANY(%s)
                  AND (length(digits)!=10 OR (ltrim(customer_phone) LIKE '+%%')=%s)
                ORDER BY updated_at DESC,conversation_key LIMIT 3""", (variants, family == 'exact')).fetchall()
            for web in web_rows:
                context = web.get('context') or {}
                handoff = conn.execute("SELECT metadata->>'reason' AS reason FROM messages WHERE conversation_key=%s AND metadata->>'handoff'='true' ORDER BY id DESC LIMIT 1", (web['conversation_key'],)).fetchone()
                history = conn.execute("SELECT id,sender,agent_name,body,created_at FROM messages WHERE conversation_key=%s AND sender!='note' ORDER BY id DESC LIMIT 5", (web['conversation_key'],)).fetchall()
                related.append({'key': 'webthread:' + str(web['inbox_public_id']), 'name': web.get('customer_name'), 'phone': web.get('customer_phone'),
                    'bot_status': web['bot_status'], 'updated_at': web['updated_at'],
                    'context': {'page_title': str(context.get('page_title') or '')[:500], 'page_url': str(context.get('page_url') or '')[:2000],
                        'handoff_reason': str((handoff or {}).get('reason') or context.get('handoff_reason') or '')[:1000]},
                    'messages': [{'id': str(m['id']), 'sender': m['sender'], 'agent_name': m.get('agent_name'),
                                  'text': m['body'], 'created_at': m['created_at']} for m in reversed(history)]})
    return {'ok': True, 'thread': thread_view(row, actor), 'messages': [message_view(m) for m in reversed(messages[:50])],
            'more': len(messages) > 50, 'audit': json_safe(audits), 'related_web': json_safe(related)}


def request_identity(payload, actor):
    try:
        request_id = str(uuid.UUID(str(payload.get('request_id') or '')))
    except ValueError:
        raise InboxError('request_id_required')
    # Actor identity is stored separately; permission/name can legitimately change on replay.
    stable = {k: v for k, v in payload.items() if k not in {'actor', 'request_id'}}
    digest = hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    return request_id, digest


def replay(conn, actor, request_id, digest):
    # Serializes UUID reuse even when the second request targets a different thread.
    conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 171718))', (actor['id'] + ':' + request_id,))
    row = conn.execute('SELECT * FROM inbox_requests WHERE actor_id=%s AND request_id=%s', (actor['id'], request_id)).fetchone()
    if row:
        if row['fingerprint'] != digest:
            raise InboxError('idempotency_conflict', 409)
        return row['response']
    return None


def remember(conn, actor, request_id, digest, response):
    conn.execute('INSERT INTO inbox_requests(actor_id,request_id,fingerprint,response) VALUES(%s,%s,%s,%s::jsonb)',
                 (actor['id'], request_id, digest, json.dumps(json_safe(response), ensure_ascii=False)))


def normalize_international_phone(value):
    if not isinstance(value, str) or not re.fullmatch(r'\+?[0-9][0-9 ()\-.]{6,30}', value.strip()):
        raise InboxError('invalid_international_phone')
    digits = re.sub(r'[^0-9]', '', value)
    if not re.fullmatch(r'[1-9][0-9]{7,14}', digits):
        raise InboxError('invalid_international_phone')
    return digits


def start_thread(payload, actor):
    require_writer(actor)
    request_id, digest = request_identity(payload, actor)
    phone = normalize_international_phone(payload.get('phone'))
    number_id = str(payload.get('number_id') or '')
    if not number_connected(number_id):
        raise InboxError('number_not_connected', 409)
    name = payload.get('name', '')
    if not isinstance(name, str) or len(name) > 120 or re.search(r'[\x00-\x1f\x7f]', name):
        raise InboxError('invalid_customer_name')
    config = get_settings().whatsapp_numbers[number_id]
    key = 'whatsapp:' + number_id + ':' + phone
    with connection() as conn, conn.transaction():
        old = replay(conn, actor, request_id, digest)
        if old is not None:
            return old
        lock_thread(conn, key)
        row = conn.execute("SELECT * FROM conversations WHERE conversation_key=%s AND channel='whatsapp' FOR UPDATE", (key,)).fetchone()
        created = row is None
        if created:
            row = conn.execute("""INSERT INTO conversations(conversation_key,channel,external_user_id,channel_number_id,
                channel_label,customer_phone,customer_name,department,bot_status,owner_id,owner_name)
                VALUES(%s,'whatsapp',%s,%s,%s,%s,%s,'ventas','paused',%s,%s) RETURNING *""",
                (key,phone,number_id,str(config.get('label') or 'WhatsApp'),phone,name.strip(),actor['id'],actor['name'])).fetchone()
            audit(conn,key,actor,'start',{'request_id':request_id})
        # Existing closed/owned chats are returned unchanged; no implicit reopen/take.
        result = {'ok': True, 'created': created, 'thread': thread_view(row,actor,conn)}
        remember(conn,actor,request_id,digest,result)
        return result


def list_templates(payload, actor, catalog=None):
    require_writer(actor)
    number_id = str(payload.get('number_id') or '')
    if not number_connected(number_id):
        raise InboxError('number_not_connected', 409)
    return (catalog or TemplateCatalog(get_settings())).list(number_id)


def template_preview(payload, actor, catalog=None):
    require_writer(actor)
    with locked_thread(payload['key']) as (conn,row):
        require_owner(actor,row)
        if row['channel'] != 'whatsapp':
            raise InboxError('unsupported_channel')
        reason = send_blocked(row,conn=conn,template=True)
        if reason:
            raise InboxError(reason,409)
        view = (catalog or TemplateCatalog(get_settings())).resolve(row['channel_number_id'],payload.get('template_id'),payload.get('language'))
        rendered = render_template(view,payload.get('parameters'))
        return {'ok':True,'preview':rendered['preview'],'fingerprint':view['fingerprint'],'template_id':view['id'],'language':view['language']}


def queue_message(conn, row, actor, text, media_id=None, request_id=None, is_ai=False, source_id=None, metadata=None):
    media = None
    if media_id and row['channel'] == 'web':
        raise InboxError('web_media_unsupported', 422)
    if media_id:
        media = conn.execute('SELECT * FROM inbox_media WHERE id=%s AND conversation_key=%s', (media_id, row['conversation_key'])).fetchone()
        if not media or not media['content']:
            raise InboxError('media_not_available', 422)
        if len(text) > 1024 or (text and media['kind'] == 'audio'):
            raise InboxError('invalid_media_caption')
    meta = dict(metadata or {}, request_id=request_id, owner_id=row.get('owner_id'))
    if media:
        meta.update(file_name=media['name'], mime=media['mime'])
    message = conn.execute("""INSERT INTO messages(conversation_key,sender,agent_name,body,kind,media_id,delivery_status,metadata)
        VALUES(%s,%s,%s,%s,%s,%s,'queued',%s::jsonb) RETURNING *""",
        (row['conversation_key'], 'bot' if is_ai else 'operator', actor['name'], text,
         media['kind'] if media else 'template' if meta.get('template') else 'text', media_id, json.dumps(meta))).fetchone()
    outbox_id = str(uuid.uuid4())
    conn.execute("""INSERT INTO inbox_outbox(id,conversation_key,message_id,actor_id,is_ai,expected_revision,source_id)
        VALUES(%s,%s,%s,%s,%s,%s,%s)""", (outbox_id, row['conversation_key'], message['id'], actor['id'], is_ai,
                                                   row['revision'] if is_ai else None, source_id))
    return message


def command(payload, actor):
    require_writer(actor)
    request_id, digest = request_identity(payload, actor)
    key = str(payload.get('key') or '')[:300]
    with connection() as conn, conn.transaction():
        old = replay(conn, actor, request_id, digest)
        if old is not None:
            return old
        lock_thread(conn, key)
        row = conn.execute("SELECT * FROM conversations WHERE conversation_key=%s AND channel IN ('web','whatsapp') FOR UPDATE", (key,)).fetchone()
        if not row:
            raise InboxError('thread_not_found', 404)
        if row['channel'] == 'web' and setting(conn, 'web_inbox_enabled', False) is not True:
            raise InboxError('web_not_connected', 409)
        revision = payload.get('revision')
        if isinstance(revision, bool) or not isinstance(revision, int) or revision != row['revision']:
            raise InboxError('revision_conflict', 409)
        action = payload.get('action')
        actions = {'take', 'transfer', 'release', 'close', 'reopen', 'pause', 'resume', 'note', 'send'}
        if action not in actions:
            raise InboxError('invalid_action')
        if row['inbox_status'] == 'closed' and action in {'take', 'transfer', 'send', 'resume'}:
            raise InboxError('thread_closed', 409)
        if action == 'take':
            if row.get('owner_id') and row['owner_id'] != actor['id']:
                raise InboxError('already_owned', 409)
            row.update(owner_id=actor['id'], owner_name=actor['name'], bot_status='paused')
        else:
            # Explicit pause/resume can control an unassigned thread; all writes still
            # require agent permission. An assigned thread always requires its owner.
            if not (action in {'pause', 'resume', 'reopen'} and not row.get('owner_id')):
                require_owner(actor, row)
            if action == 'transfer':
                target = payload.get('target')
                if not isinstance(target, dict) or not re.fullmatch(r'herramientas:[A-Za-z0-9_-]{1,100}', str(target.get('id') or '')) or not str(target.get('name') or '').strip():
                    raise InboxError('invalid_target')
                row.update(owner_id=target['id'], owner_name=str(target['name']).strip()[:120], bot_status='paused')
            elif action == 'release':
                row.update(owner_id=None, owner_name=None, bot_status='paused')
            elif action == 'close':
                row.update(inbox_status='closed', bot_status='paused')
            elif action == 'reopen':
                row.update(inbox_status='open', bot_status='paused')
            elif action == 'pause':
                row['bot_status'] = 'paused'
            elif action == 'resume':
                row.update(owner_id=None, owner_name=None, bot_status='active')
        text = str(payload.get('text') or '').strip()
        message = None
        if action in {'note', 'send'}:
            media_id = payload.get('media_id')
            template = payload.get('template')
            if template is not None and (action != 'send' or text or media_id or row['channel'] != 'whatsapp'):
                raise InboxError('invalid_template_message')
            if len(text) > 4096 or (not text and not (action == 'send' and (media_id or template is not None))):
                raise InboxError('invalid_message')
            if action == 'send':
                reason = send_blocked(row, conn=conn, template=template is not None)
                if reason:
                    raise InboxError(reason, 409)
                metadata = None
                if template is not None:
                    if payload.get('opt_in') is not True:
                        raise InboxError('template_opt_in_required')
                    stored, rendered = verified_template(get_settings(),row['channel_number_id'],template)
                    metadata = {'template': stored, 'opt_in': True}
                    text = rendered['preview']
                row['bot_status'] = 'paused'
                message = queue_message(conn, row, actor, text, media_id, request_id, metadata=metadata)
            else:
                message = conn.execute("""INSERT INTO messages(conversation_key,sender,agent_name,body,kind,delivery_status,metadata)
                    VALUES(%s,'note',%s,%s,'note','private',%s::jsonb) RETURNING *""",
                    (key, actor['name'], text, json.dumps({'request_id': request_id, 'actor_id': actor['id']}))).fetchone()
        cancelled = []
        if action in {'transfer', 'release', 'close', 'resume', 'take', 'pause', 'send'}:
            only_ai = action in {'take', 'pause', 'send'}
            cancelled = conn.execute("""UPDATE inbox_outbox SET state='cancelled',error_code=%s,updated_at=NOW()
                WHERE conversation_key=%s AND state='queued' AND (%s=FALSE OR is_ai=TRUE) RETURNING message_id""",
                ('control_' + action, key, only_ai)).fetchall()
            if cancelled:
                conn.execute("UPDATE messages SET delivery_status='cancelled' WHERE id=ANY(%s)", ([r['message_id'] for r in cancelled],))
        row = conn.execute("""UPDATE conversations SET owner_id=%s,owner_name=%s,bot_status=%s,inbox_status=%s,
            revision=revision+1,updated_at=NOW(),unread=CASE WHEN %s THEN 0 ELSE unread END
            WHERE conversation_key=%s RETURNING *""", (row.get('owner_id'), row.get('owner_name'), row['bot_status'],
            row['inbox_status'], action in {'take', 'send', 'close'}, key)).fetchone()
        audit(conn, key, actor, action, {'request_id': request_id, 'owner_id': row.get('owner_id'),
            'cancelled_messages': [str(r['message_id']) for r in cancelled]})
        if row['channel'] == 'web':
            from .inbox_web import queue_web_sync
            queue_web_sync(conn, row)
        result = {'ok': True, 'thread': thread_view(row, actor, conn)}
        if message:
            result['message'] = message_view(message)
        remember(conn, actor, request_id, digest, result)
        return result


def upload(payload, actor):
    require_writer(actor)
    request_id, digest = request_identity(payload, actor)
    if not isinstance(payload.get('recording',False),bool):
        raise InboxError('invalid_recording_flag')
    key = str(payload.get('key') or '')[:300]
    with connection() as conn, conn.transaction():
        old = replay(conn, actor, request_id, digest)
        if old is not None:
            return old
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 171719))', (actor['id'],))
        lock_thread(conn, key)
        row = conn.execute("SELECT * FROM conversations WHERE conversation_key=%s AND channel IN ('web','whatsapp') FOR UPDATE", (key,)).fetchone()
        if not row:
            raise InboxError('thread_not_found', 404)
        require_owner(actor, row)
        if row['channel'] == 'web':
            raise InboxError('web_media_unsupported', 422)
        reason = send_blocked(row,conn=conn)
        if reason:
            raise InboxError(reason,409)
        # Decode and potentially expensive conversion only after role/ownership/channel checks.
        content = decode_upload(payload.get('data_base64'))
        # Bounds both storage abuse and accidentally repeated uploads. No message is sent here.
        usage = conn.execute("SELECT COALESCE(sum(size),0) AS total FROM inbox_media WHERE actor_id=%s AND created_at>NOW()-INTERVAL '1 hour'", (actor['id'],)).fetchone()
        if usage['total'] + len(content) > 128 * 1024 * 1024:
            raise InboxError('upload_quota_exceeded', 429)
        duration = None
        if payload.get('recording') is True:
            from .inbox_recording import convert_recording
            content,duration = convert_recording(content,payload.get('mime'))
            mime,name,kind = validate_media(content,'audio/ogg','audio-grabado.ogg')
        else:
            mime,name,kind = validate_media(content,str(payload.get('mime') or ''),str(payload.get('name') or 'archivo'))
        media_id = str(uuid.uuid4())
        conn.execute('INSERT INTO inbox_media(id,conversation_key,actor_id,name,mime,kind,content,number_id,size,is_voice) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                     (media_id, key, actor['id'], name, mime, kind, content, row['channel_number_id'], len(content),payload.get('recording') is True))
        result = {'ok': True, 'media_id': media_id, 'name': name, 'mime': mime}
        if duration is not None:
            result['duration_seconds'] = duration
        remember(conn, actor, request_id, digest, result)
    return result


def media_read(payload, actor, transport=None):
    media_id = str(payload.get('id') or '')[:100]
    with connection() as conn:
        media = conn.execute("SELECT a.* FROM inbox_media a JOIN conversations c USING(conversation_key) WHERE a.id=%s AND c.channel='whatsapp'", (media_id,)).fetchone()
    if not media:
        raise InboxError('media_not_found', 404)
    content = media['content']
    if content is None:
        try:
            content, remote_mime = (transport or CloudTransport(get_settings())).download(media['remote_id'], media['number_id'])
            mime, name, kind = validate_media(content, remote_mime, media['name'])
        except MediaError:
            raise
        except Exception as exc:
            raise InboxError('media_unavailable', 502) from exc
        with connection() as conn:
            conn.execute('UPDATE inbox_media SET content=%s,mime=%s,name=%s,kind=%s,size=%s WHERE id=%s',
                         (content, mime, name, kind, len(content), media_id))
        media.update(mime=mime, name=name)
    return {'ok': True, 'data_base64': base64.b64encode(bytes(content)).decode(), 'mime': media['mime'], 'name': media['name']}


def status(actor):
    settings = get_settings()
    with connection() as conn:
        totals = counts(conn, actor)
        delivery = conn.execute("SELECT count(*) FILTER (WHERE state IN ('queued','sending')) AS pending, count(*) FILTER (WHERE state IN ('failed','unknown')) AS errors FROM inbox_outbox").fetchone()
        presence = conn.execute("SELECT actor_id AS id,actor_name AS name,status,updated_at FROM inbox_presence WHERE updated_at>NOW()-INTERVAL '90 seconds' AND status!='offline' ORDER BY actor_name").fetchall()
        read = lambda key, default=None: setting(conn, key, default)
        master = read('bot_enabled', settings.ai_enabled) is True and channel_bot_available('whatsapp', read('bot_channel_config', {}))
        numbers = []
        for number, label in MANAGED_NUMBERS.items():
            ids = [str(k) for k in settings.whatsapp_numbers if configured_number(str(k), settings.whatsapp_numbers) == number]
            number_id = ids[0] if ids else ''
            connected = number_connected(number_id)
            numbers.append({'number_id': number_id, 'number_label': label, 'number': number, 'connected': connected,
                'status': 'connected' if connected else 'pending_connection', 'coexistence_pending': not connected,
                'bot_enabled': master and number_bot_enabled(number_id, settings.whatsapp_numbers, read)})
        web_connected = read('web_inbox_enabled', False) is True
        web_enabled = read('bot_enabled', settings.ai_enabled) is True and channel_bot_available('web', read('bot_channel_config', {}))
    return {'ok': True, 'web': {'connected': web_connected, 'bot_enabled': web_enabled, 'enabled': web_enabled, 'capabilities': {'text': True, 'media': False}}, 'numbers': numbers, 'agents': json_safe(presence), 'counts': totals,
        'metrics': {'open': totals['all'], 'unassigned': totals['unassigned'], 'pending': delivery['pending'], 'errors': delivery['errors']}}


def handle(payload):
    if not isinstance(payload, dict):
        raise InboxError('invalid_json')
    actor = actor_from(payload)
    op = payload.get('op')
    try:
        if op in {'thread','command','upload','template-preview'}:
            if op in {'command','upload','template-preview'}:
                require_writer(actor)
            payload = dict(payload, key=resolve_public_key(payload.get('key')))
        if op == 'list': return list_threads(payload, actor)
        if op == 'thread': return read_thread(payload, actor)
        if op == 'command': return command(payload, actor)
        if op == 'upload': return upload(payload, actor)
        if op == 'media': return media_read(payload, actor)
        if op == 'status': return status(actor)
        if op == 'start': return start_thread(payload,actor)
        if op == 'templates': return list_templates(payload,actor)
        if op == 'template-preview': return template_preview(payload,actor)
        if op == 'presence':
            require_writer(actor)
            if payload.get('status') not in {'available', 'busy', 'offline'}:
                raise InboxError('invalid_presence')
            with connection() as conn:
                conn.execute('''INSERT INTO inbox_presence(actor_id,actor_name,status) VALUES(%s,%s,%s)
                    ON CONFLICT(actor_id) DO UPDATE SET actor_name=EXCLUDED.actor_name,status=EXCLUDED.status,updated_at=NOW()''',
                    (actor['id'], actor['name'], payload['status']))
            return {'ok': True}
    except MediaError as exc:
        raise InboxError(str(exc), 422) from exc
    except TemplateError as exc:
        raise InboxError(str(exc),503 if str(exc) in {'templates_unavailable','templates_not_configured'} else 422) from exc
    raise InboxError('invalid_operation')
