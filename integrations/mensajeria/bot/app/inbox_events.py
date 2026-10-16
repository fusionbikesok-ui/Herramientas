"""WhatsApp ingestion independent of WordPress and safe for replay/history/echoes."""
from __future__ import annotations
import json
import uuid
from datetime import datetime, timezone, timedelta

from .inbox import lock_thread, ai_allowed, queue_message, audit
from .inbox_media import TYPES
from .routing import conversation_key, department_for
from .storage import connection


def occurred_at(value):
    try:
        stamp = datetime.fromtimestamp(float(value), timezone.utc)
        return stamp if datetime(2009, 1, 1, tzinfo=timezone.utc) <= stamp <= datetime.now(timezone.utc) + timedelta(minutes=1) else None
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _media(conn, key, conversation, message):
    kind = str(message.get('type') or 'text')
    raw = message.get('raw') or {}
    attachment = raw.get(kind) if isinstance(raw.get(kind), dict) else {}
    remote_id = str(attachment.get('id') or '')
    mime = str(attachment.get('mime_type') or '').lower().split(';', 1)[0]
    if kind not in {'image', 'audio', 'video', 'document', 'sticker'} or not remote_id.isdigit() or mime not in TYPES:
        return None
    media_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'wa-media:' + key + ':' + remote_id))
    name = str(attachment.get('filename') or ('archivo' + TYPES[mime][1]))[:150]
    conn.execute('''INSERT INTO inbox_media(id,conversation_key,name,mime,kind,remote_id,number_id)
        VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(id) DO NOTHING''',
        (media_id, key, name, mime, TYPES[mime][0], remote_id, conversation['channel_number_id']))
    return media_id


def ingest(payload):
    conversation = payload.get('conversation') or {}
    message = payload.get('message') or {}
    key = conversation_key(conversation)
    historical = bool(payload.get('historical'))
    echo = payload.get('event_type') == 'whatsapp_echo' or message.get('sender') == 'operator'
    external_id = str(message.get('external_id') or '')[:400]
    if not external_id:
        return key, False
    stamp = occurred_at(payload.get('occurred_at'))
    text = str(message.get('text') or '')[:4096]
    with connection() as conn, conn.transaction():
        lock_thread(conn, key)
        conn.execute('''INSERT INTO conversations(conversation_key,channel,external_user_id,channel_number_id,
            channel_label,customer_name,customer_phone,department,bot_status,context)
            VALUES(%s,'whatsapp',%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
            ON CONFLICT(conversation_key) DO UPDATE SET
                customer_name=COALESCE(NULLIF(EXCLUDED.customer_name,''),conversations.customer_name),
                channel_label=COALESCE(NULLIF(EXCLUDED.channel_label,''),conversations.channel_label)''',
            (key, conversation.get('external_user_id'), conversation.get('channel_number_id'), conversation.get('channel_label'),
             conversation.get('customer_name'), conversation.get('customer_phone'), department_for(conversation, text),
             'paused' if historical or echo else 'active', json.dumps(conversation)))
        raw = message.get('raw') or {}
        kind = str(message.get('type') or 'text')
        app_actor = {'id': 'whatsapp:business-app', 'name': 'WhatsApp Business'}
        if kind in {'edit', 'revoke'}:
            change = raw.get(kind) if isinstance(raw.get(kind), dict) else {}
            original = str(change.get('original_message_id') or '')
            existing = conn.execute('SELECT * FROM messages WHERE external_id=%s AND conversation_key=%s', (original, key)).fetchone()
            if not existing:
                return key, False
            # Idempotent audit across webhook retry; all raw edits carry a stable event id.
            already = conn.execute("SELECT 1 FROM inbox_audit WHERE conversation_key=%s AND detail->>'event_id'=%s", (key, str(payload.get('event_id')))).fetchone()
            if already:
                return key, False
            if kind == 'revoke':
                conn.execute("UPDATE messages SET body='[Mensaje eliminado en WhatsApp]',media_id=NULL,metadata=metadata || '{\"revoked\":true}'::jsonb WHERE id=%s", (existing['id'],))
            else:
                edited = change.get('message') or {}
                new_kind = str(edited.get('type') or 'text')
                content = edited.get(new_kind) or {}
                body = str(content.get('body') or content.get('caption') or '[Mensaje editado]')[:4096]
                media_id = _media(conn, key, conversation, {'type': new_kind, 'raw': edited})
                conn.execute("UPDATE messages SET body=%s,kind=%s,media_id=%s,metadata=metadata || '{\"edited\":true}'::jsonb WHERE id=%s", (body, new_kind, media_id, existing['id']))
            conn.execute("UPDATE conversations SET bot_status='paused',revision=revision+1,updated_at=NOW() WHERE conversation_key=%s", (key,))
            audit(conn, key, app_actor, kind, {'event_id': payload.get('event_id'), 'message_id': str(existing['id'])})
            return key, False
        existing = conn.execute('SELECT * FROM messages WHERE external_id=%s', (external_id,)).fetchone()
        if existing:
            # A second history notification can fill a media placeholder. It is not a new message.
            if historical and existing['conversation_key'] == key and not existing.get('media_id'):
                media_id = _media(conn, key, conversation, message)
                if media_id:
                    conn.execute('UPDATE messages SET media_id=%s,kind=%s WHERE id=%s', (media_id, kind, existing['id']))
            # A recovered event may have committed inbound storage just before its
            # worker died. Resume generation only if it is still the latest inbound
            # and no durable outgoing record exists for this event (including a
            # cancelled/unknown result, which must never be blindly retried).
            if not historical and not echo and existing['conversation_key'] == key and existing['sender'] == 'customer':
                source_id = 'bot:' + str(payload.get('event_id') or '')
                queued = conn.execute('SELECT 1 FROM inbox_outbox WHERE source_id=%s', (source_id,)).fetchone()
                latest = conn.execute("SELECT external_id FROM messages WHERE conversation_key=%s AND sender='customer' AND COALESCE(metadata->>'historical','false')!='true' ORDER BY created_at DESC,id DESC LIMIT 1", (key,)).fetchone()
                row = conn.execute('SELECT * FROM conversations WHERE conversation_key=%s', (key,)).fetchone()
                return key, not queued and bool(latest) and latest['external_id'] == external_id and ai_allowed(conn, row)
            return key, False
        media_id = _media(conn, key, conversation, message)
        conn.execute('''INSERT INTO messages(conversation_key,external_id,sender,agent_name,body,metadata,kind,media_id,delivery_status,created_at)
            VALUES(%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,COALESCE(%s,NOW()))''',
            (key, external_id, 'operator' if echo else 'customer', 'WhatsApp Business' if echo else None,
             text or '[Mensaje sin texto]', json.dumps({'historical': historical, 'source_event_id': payload.get('event_id'), 'reply_external_id':str((raw.get('context') if isinstance(raw.get('context'),dict) else {}).get('id') or '')[:400], 'forwarded':(raw.get('context') if isinstance(raw.get('context'),dict) else {}).get('forwarded') is True or (raw.get('context') if isinstance(raw.get('context'),dict) else {}).get('frequently_forwarded') is True}),
             kind, media_id, str(message.get('status') or ('sent' if echo else 'received')), stamp))
        if historical:
            # Import must not open the 24-hour window or mutate existing owner/state.
            return key, False
        if echo:
            # Replies from the Business app acknowledge only preceding inbound
            # messages; a delayed echo must not consume a newer customer message.
            conn.execute("""UPDATE conversations SET bot_status='paused',revision=revision+1,updated_at=NOW(),
                inbox_read_at=GREATEST(inbox_read_at,%s),unread=LEAST(unread,
                (SELECT count(*) FROM messages WHERE conversation_key=%s AND sender='customer'
                 AND created_at>COALESCE(%s,'-infinity'::timestamptz) AND COALESCE(metadata->>'historical','false')!='true'))
                WHERE conversation_key=%s""", (stamp, key, stamp, key))
            audit(conn, key, app_actor, 'business_app_echo', {'external_id': external_id})
            return key, False
        conn.execute("""UPDATE conversations SET inbox_status='open',revision=revision+1,unread=unread+1,updated_at=NOW(),
            last_inbound_at=CASE WHEN %s::timestamptz IS NULL THEN last_inbound_at ELSE GREATEST(last_inbound_at,%s::timestamptz) END
            WHERE conversation_key=%s""", (stamp, stamp, key))
        row = conn.execute('SELECT * FROM conversations WHERE conversation_key=%s', (key,)).fetchone()
        return key, ai_allowed(conn, row)


def ai_revision(key, external_id=''):
    with connection() as conn, conn.transaction():
        lock_thread(conn, key)
        row = conn.execute("SELECT * FROM conversations WHERE conversation_key=%s AND channel IN ('web','whatsapp')", (key,)).fetchone()
        if external_id:
            latest = conn.execute("SELECT external_id FROM messages WHERE conversation_key=%s AND sender='customer' AND COALESCE(metadata->>'historical','false')!='true' ORDER BY created_at DESC,id DESC LIMIT 1", (key,)).fetchone()
            if not latest or latest['external_id'] != external_id:
                return None
        return row['revision'] if row and ai_allowed(conn, row) else None


def enqueue_ai(key, source_id, revision, decision):
    text = str(decision.reply or '').strip()[:4096]
    if not text:
        return False
    with connection() as conn, conn.transaction():
        lock_thread(conn, key)
        row = conn.execute('SELECT * FROM conversations WHERE conversation_key=%s FOR UPDATE', (key,)).fetchone()
        if not row or row['revision'] != revision or not ai_allowed(conn, row):
            return False
        if conn.execute('SELECT 1 FROM inbox_outbox WHERE source_id=%s', (source_id,)).fetchone():
            return False
        contact_phone = str(getattr(decision,'contact_phone','') or '')[:50]
        reason = str(decision.reason or '')[:1000]
        if row['channel'] == 'web':
            row = conn.execute("""UPDATE conversations SET customer_phone=COALESCE(NULLIF(%s,''),customer_phone),
                context=context || %s::jsonb WHERE conversation_key=%s RETURNING *""",
                (contact_phone,json.dumps({'handoff_reason':reason if decision.handoff else ''}),key)).fetchone()
        from .invoice_flow import queue_invoice
        media_id = queue_invoice(conn, row, decision)
        metadata = {'handoff': decision.handoff, 'reason': decision.reason}
        order_id = getattr(decision, 'invoice_order', None)
        if order_id is not None:
            metadata['invoice_order'] = order_id
        queue_message(conn, row, {'id': 'system:fabri', 'name': 'Matías IA'}, text,
            media_id=media_id, is_ai=True, source_id=source_id, metadata=metadata)
        conn.execute('UPDATE conversations SET updated_at=NOW() WHERE conversation_key=%s', (key,))
        return True


def delivery_status(payload):
    message = payload.get('message') or {}
    remote_id = str(message.get('external_id') or '')
    state = str(message.get('status') or '')
    if state not in {'sent', 'delivered', 'read', 'failed'}:
        return
    opaque = str(message.get('outbox_id') or '')
    try:
        opaque = str(uuid.UUID(opaque))
    except ValueError:
        opaque = None
    with connection() as conn, conn.transaction():
        out = conn.execute('SELECT * FROM inbox_outbox WHERE remote_id=%s OR id=%s', (remote_id, opaque)).fetchone()
        if not out:
            return
        lock_thread(conn, out['conversation_key'])
        out = conn.execute('SELECT * FROM inbox_outbox WHERE id=%s FOR UPDATE', (out['id'],)).fetchone()
        # Meta status must agree with the configured number and recipient.
        conv = conn.execute('SELECT * FROM conversations WHERE conversation_key=%s', (out['conversation_key'],)).fetchone()
        source = payload.get('conversation') or {}
        if source.get('channel_number_id') != conv['channel_number_id'] or source.get('external_user_id') != conv['external_user_id']:
            return
        current = conn.execute('SELECT delivery_status FROM messages WHERE id=%s', (out['message_id'],)).fetchone()['delivery_status']
        ranks = {'queued': 0, 'sending': 1, 'unknown': 1, 'failed': 1, 'sent': 2, 'delivered': 3, 'read': 4}
        if current in {'delivered', 'read'} and state == 'failed':
            return
        if state != 'failed' and ranks.get(state, 0) < ranks.get(current, 0):
            return
        conn.execute('UPDATE messages SET delivery_status=%s,external_id=COALESCE(external_id,%s) WHERE id=%s', (state, remote_id or None, out['message_id']))
        conn.execute('UPDATE inbox_outbox SET state=%s,remote_id=COALESCE(remote_id,%s),error_code=%s,updated_at=NOW() WHERE id=%s',
                     ('failed' if state == 'failed' else 'sent', remote_id or None, 'meta_delivery_failed' if state == 'failed' else None, out['id']))
        conn.execute('UPDATE conversations SET updated_at=NOW() WHERE conversation_key=%s', (out['conversation_key'],))
