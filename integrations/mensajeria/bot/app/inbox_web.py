"""Web inbox ingestion/import and signed WordPress transports. No public routes."""
from __future__ import annotations
import json
import re
from datetime import datetime, timezone

from . import clients
from .inbox import InboxError, lock_thread, ai_allowed, setting
from .inbox_media import SendRejected
from .routing import conversation_key, department_for
from .storage import connection


def utc_time(value, required=False):
    try:
        if isinstance(value, (float, int)) or str(value).isdigit():
            return datetime.fromtimestamp(float(value), timezone.utc)
        stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('UTC/offset required')
        return stamp.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError, OSError):
        if required:
            raise ValueError('web_timestamp_requires_timezone')
        return datetime.now(timezone.utc)


def web_token(conversation):
    token = str(conversation.get('token') or '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,190}', token):
        raise ValueError('invalid_web_token')
    return token


def wp_message_id(message):
    value = str(message.get('id') or '')
    if not value.isdigit() or not 0 < int(value) < 9223372036854775807:
        raise ValueError('web_message_id_required')
    return int(value)


def existing_message(conn, key, token, message, event_id=''):
    mid = wp_message_id(message)
    mapped = conn.execute('SELECT m.* FROM inbox_web_message_map w JOIN messages m ON m.id=w.message_id WHERE w.wp_message_id=%s AND w.conversation_key=%s', (mid, key)).fetchone()
    if mapped:
        return mapped
    candidates = [str(message.get('external_id') or ''), 'wp:' + str(mid), str(event_id or '')]
    # Legacy incoming/agent rows used message.external_id or the bridge event UUID.
    # Read event payload IDs to alias those exact rows, never duplicate or rewrite IDs.
    legacy = conn.execute("""SELECT event_id FROM events WHERE payload->'message'->>'id'=%s
        AND payload->'conversation'->>'token'=%s""", (str(mid), token)).fetchall()
    candidates.extend(r['event_id'] for r in legacy)
    return conn.execute('SELECT * FROM messages WHERE conversation_key=%s AND external_id=ANY(%s) ORDER BY id LIMIT 1', (key, [c for c in candidates if c])).fetchone()


def map_message(conn, key, mid, stored_id):
    row = conn.execute('''INSERT INTO inbox_web_message_map(wp_message_id,message_id,conversation_key)
        VALUES(%s,%s,%s) ON CONFLICT(wp_message_id) DO UPDATE SET wp_message_id=EXCLUDED.wp_message_id
        RETURNING message_id,conversation_key''', (mid, stored_id, key)).fetchone()
    if row['conversation_key'] != key or row['message_id'] != stored_id:
        raise ValueError('web_message_identity_conflict')


def queue_web_sync(conn, row):
    conn.execute('''INSERT INTO inbox_web_sync(conversation_key,revision) VALUES(%s,%s)
        ON CONFLICT(conversation_key) DO UPDATE SET revision=EXCLUDED.revision,
        attempts=0,retry_at=NOW(),last_error=NULL,updated_at=NOW()''', (row['conversation_key'], row['revision']))


def web_source_id(message):
    return 'bot:wp:' + str(wp_message_id(message))


def ingest_web(payload):
    conversation = payload.get('conversation') or {}
    message = payload.get('message') or {}
    token = web_token(conversation)
    key = 'web:' + token
    mid = wp_message_id(message)
    stamp = utc_time(message.get('created_at') or payload.get('occurred_at'))
    if stamp > datetime.now(timezone.utc):
        stamp = datetime.now(timezone.utc)
    context = {k: str(conversation.get(k) or '')[:2000] for k in ('page_url','page_title')}
    context['web_inbox_live'] = True
    with connection() as conn, conn.transaction():
        lock_thread(conn, key)
        conn.execute('''INSERT INTO conversations(conversation_key,channel,wp_token,customer_name,customer_phone,
            department,context,bot_status) VALUES(%s,'web',%s,%s,%s,%s,%s::jsonb,'active')
            ON CONFLICT(conversation_key) DO UPDATE SET wp_token=EXCLUDED.wp_token,
            context=conversations.context || EXCLUDED.context,
            customer_name=COALESCE(NULLIF(conversations.customer_name,''),EXCLUDED.customer_name),
            customer_phone=COALESCE(NULLIF(conversations.customer_phone,''),EXCLUDED.customer_phone)''',
            (key,token,str(conversation.get('customer_name') or '')[:120],str(conversation.get('customer_phone') or '')[:50],
             department_for(conversation, str(message.get('text') or '')),json.dumps(context)))
        existing = existing_message(conn,key,token,message,str(payload.get('event_id') or ''))
        if not existing:
            external_id = str(message.get('external_id') or 'wp:' + str(mid))
            existing = conn.execute('''INSERT INTO messages(conversation_key,external_id,sender,body,kind,delivery_status,metadata,created_at)
                VALUES(%s,%s,'customer',%s,'text','received',%s::jsonb,%s) RETURNING *''',
                (key,external_id,str(message.get('text') or '')[:4096],json.dumps({'wp_message_id':mid,'source_event_id':payload.get('event_id')}),stamp)).fetchone()
            conn.execute("""UPDATE conversations SET inbox_status='open',revision=revision+1,unread=unread+1,updated_at=NOW(),
                last_inbound_at=GREATEST(last_inbound_at,%s) WHERE conversation_key=%s""",(stamp,key))
        map_message(conn,key,mid,existing['id'])
        row = conn.execute('SELECT * FROM conversations WHERE conversation_key=%s', (key,)).fetchone()
        queue_web_sync(conn,row)
        latest = conn.execute("SELECT id FROM messages WHERE conversation_key=%s AND sender='customer' ORDER BY created_at DESC,id DESC LIMIT 1",(key,)).fetchone()
        source = web_source_id(message)
        done = conn.execute('SELECT 1 FROM inbox_outbox WHERE source_id=%s',(source,)).fetchone()
        old_event = str((existing.get('metadata') or {}).get('source_event_id') or payload.get('event_id') or '')
        old_reply = conn.execute('SELECT 1 FROM messages WHERE conversation_key=%s AND external_id=%s',(key,'bot:' + old_event)).fetchone() if old_event else None
        eligible = latest and latest['id'] == existing['id'] and not done and not old_reply and ai_allowed(conn,row)
        return key, bool(eligible), str(existing['external_id'])


def import_web_history(batch, owner_map=None, refresh_initial=False):
    """Trusted local coordinator only. sessions:[{token,...,messages:[...]}].

    owner_map maps the WP agent string to a validated Herramientas {id,name}.
    All timestamps must contain UTC/offset. No AI/outgoing messages are generated.
    First import can initialize untouched legacy state; later import never replaces
    live or already imported ownership/state/context. Original external IDs survive.
    A trusted coordinator with workers stopped may pass refresh_initial=True when
    retrying a cutover. Refresh requires the central flag off, revision zero and
    no web_inbox_live marker, and thus cannot overwrite centralized activity.
    """
    if not isinstance(batch,dict) or not isinstance(batch.get('sessions'),list):
        raise ValueError('sessions_required')
    owner_map = owner_map or {}
    result = {'sessions':0,'messages':0,'existing':0}
    for session in batch['sessions']:
        token = web_token(session); key = 'web:' + token
        created = utc_time(session.get('created_at'),True)
        updated = utc_time(session.get('updated_at'),True)
        owner = owner_map.get(str(session.get('agent') or '')) or {}
        if owner and (not re.fullmatch(r'herramientas:[A-Za-z0-9_-]{1,100}',str(owner.get('id') or '')) or not owner.get('name')):
            raise ValueError('invalid_owner_mapping')
        closed = session.get('status') in {'closed','archived','trash','trashed'}
        bot = str(session.get('bot_status') or 'paused')
        if owner or session.get('agent') or closed:
            bot = 'paused'
        elif bot not in {'active','paused','handoff','off'}:
            bot = 'paused'
        context = {'page_url':str(session.get('page_url') or '')[:2000], 'page_title':str(session.get('page_title') or session.get('title') or '')[:500],
            'handoff_reason':str(session.get('handoff_reason') or '')[:1000], 'web_inbox_imported':True}
        with connection() as conn, conn.transaction():
            lock_thread(conn,key)
            conn.execute("""INSERT INTO conversations(conversation_key,channel,wp_token,created_at,updated_at)
                VALUES(%s,'web',%s,%s,%s) ON CONFLICT(conversation_key) DO NOTHING""",(key,token,created,updated))
            row = conn.execute('SELECT * FROM conversations WHERE conversation_key=%s FOR UPDATE',(key,)).fetchone()
            old_context = row.get('context') or {}
            can_refresh = refresh_initial is True and setting(conn,'web_inbox_enabled',False) is False
            can_initialize = row['revision']==0 and not old_context.get('web_inbox_live') and (not old_context.get('web_inbox_imported') or can_refresh)
            if can_initialize:
                conn.execute('''UPDATE conversations SET wp_token=%s,customer_name=%s,customer_phone=%s,inbox_status=%s,
                    bot_status=%s,owner_id=%s,owner_name=%s,context=context || %s::jsonb,created_at=%s,updated_at=%s WHERE conversation_key=%s''',
                    (token,str(session.get('customer_name') or '')[:120],str(session.get('customer_phone') or session.get('phone') or '')[:50],
                     'closed' if closed else 'open',bot,owner.get('id'),owner.get('name'),json.dumps(context),created,updated,key))
            for message in session.get('messages') or []:
                mid = wp_message_id(message)
                stamp = utc_time(message.get('created_at'),True)
                existing = existing_message(conn,key,token,message)
                if existing:
                    # Correct import timestamp only for untouched legacy history.
                    if can_initialize:
                        conn.execute('UPDATE messages SET created_at=%s WHERE id=%s',(stamp,existing['id']))
                    result['existing'] += 1
                else:
                    sender = str(message.get('sender') or 'customer')
                    if sender not in {'customer','bot','operator','system','note'}:
                        raise ValueError('unsupported_web_sender')
                    existing = conn.execute('''INSERT INTO messages(conversation_key,external_id,sender,agent_name,body,created_at,metadata,delivery_status,kind)
                        VALUES(%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s) RETURNING *''',
                        (key,str(message.get('external_id') or 'wp:' + str(mid)),sender,str(message.get('agent_name') or '')[:120],
                         str(message.get('message') or message.get('text') or ''),stamp,json.dumps({'historical':True,'wp_message_id':mid}),
                         'private' if sender=='note' else 'received' if sender=='customer' else 'sent','note' if sender=='note' else 'text')).fetchone()
                    result['messages'] += 1
                map_message(conn,key,mid,existing['id'])
            # Import reflects existing WordPress state. Do not enqueue a callback
            # for every historical session when the coordinated flag is enabled.
        result['sessions'] += 1
    return result


def control_payload(row):
    return {'revision':int(row['revision']), 'owner_name':row.get('owner_name') or '',
            'bot_status':row['bot_status'], 'status':row['inbox_status']}


def conversation_payload(row):
    context = row.get('context') or {}
    return {'channel':'web','token':row['wp_token'],'customer_name':row.get('customer_name') or '',
            'customer_phone':row.get('customer_phone') or '', 'page_url':context.get('page_url',''), 'page_title':context.get('page_title','')}


def _callback(payload):
    try:
        return clients.wordpress_callback(payload)
    except clients.RemoteServiceError as exc:
        if 400 <= int(getattr(exc,'status_code',0) or 0) < 500:
            raise SendRejected('wordpress_rejected_' + str(exc.status_code)) from exc
        raise


class WebTransport:
    def send(self,row,message,media,outbox_id):
        if media or message.get('media_id') or message.get('kind')!='text':
            raise SendRejected('web_media_unsupported')
        if not row.get('wp_token'):
            raise SendRejected('web_token_missing')
        external_id = 'inbox:' + str(outbox_id)
        meta = message.get('metadata') or {}
        state = control_payload(row)
        if meta.get('handoff') is True:
            state['bot_status'] = 'handoff'
        result = _callback({'event_id':external_id,'event_type':'inbox_message',
            'conversation':conversation_payload(row),'inbox':state,
            'message':{'external_id':external_id,'sender':message['sender'],'agent_name':message.get('agent_name') or '',
                'text':__import__('app.message_actions',fromlist=['web_reply_text']).web_reply_text(message),'status':'sent'},
            'handoff':{'requested':meta.get('handoff') is True,'reason':str(meta.get('reason') or '')}})
        mid = result.get('message_id') if isinstance(result,dict) else None
        if not isinstance(result,dict) or result.get('ok') is not True or isinstance(mid,bool) or not str(mid or '').isdigit() or int(mid)<=0:
            raise ValueError('ambiguous_wordpress_ack')
        return external_id


def flush_web_sync(transport=None):
    callback = transport or _callback
    with connection() as conn:
        if setting(conn,'web_inbox_enabled',False) is not True:
            return False
        rows = conn.execute('SELECT conversation_key FROM inbox_web_sync WHERE retry_at<=NOW() ORDER BY updated_at LIMIT 20').fetchall()
        for candidate in rows:
            key=candidate['conversation_key']
            held=conn.execute('SELECT pg_try_advisory_lock(hashtextextended(%s,171717)) AS held',(key,)).fetchone()['held']
            if not held: continue
            try:
                row=conn.execute("SELECT * FROM conversations WHERE conversation_key=%s AND channel='web'",(key,)).fetchone()
                pending=conn.execute('SELECT 1 FROM inbox_web_sync WHERE conversation_key=%s',(key,)).fetchone()
                if not row or not pending: continue
                try:
                    ack=callback({'event_id':'inbox-control:' + row['wp_token'] + ':' + str(row['revision']),
                        'event_type':'inbox_control','conversation':conversation_payload(row),'inbox':control_payload(row)})
                    if not isinstance(ack,dict) or ack.get('ok') is not True:
                        raise ValueError('missing_control_ack')
                except Exception:
                    conn.execute("""UPDATE inbox_web_sync SET attempts=attempts+1,last_error='control_sync_failed',
                        retry_at=NOW()+(LEAST(120,POWER(2,LEAST(attempts+1,7))) * INTERVAL '1 second') WHERE conversation_key=%s""",(key,))
                else:
                    conn.execute('DELETE FROM inbox_web_sync WHERE conversation_key=%s AND revision<=%s',(key,row['revision']))
                return True
            finally:
                conn.execute('SELECT pg_advisory_unlock(hashtextextended(%s,171717))',(key,))
    return False


def sync_web_presence(transport=None):
    with connection() as conn:
        if setting(conn,'web_inbox_enabled',False) is not True:
            return False
        rows=conn.execute("SELECT actor_name AS name,status,EXTRACT(EPOCH FROM updated_at)::bigint AS heartbeat FROM inbox_presence WHERE updated_at>NOW()-INTERVAL '90 seconds' AND status!='offline'").fetchall()
    ack=(transport or _callback)({'event_id':'inbox-presence:' + str(int(datetime.now(timezone.utc).timestamp())),
        'event_type':'inbox_presence','presence':{'agents':[dict(r) for r in rows]}})
    if not isinstance(ack,dict) or ack.get('ok') is not True:
        raise ValueError('missing_presence_ack')
    return True
