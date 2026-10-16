"""Explicit agent replies and forwards. Resolve content on the server, never from UI."""
import hashlib
import json
import re
import uuid

PUBLIC_SENDERS = {'customer','operator','bot','agent','human'}
LABELS = {'audio':'Audio','image':'Imagen','video':'Video','document':'Documento','sticker':'Sticker'}

def message_id(value):
    if isinstance(value,bool) or not re.fullmatch(r'[1-9][0-9]{0,18}',str(value or '')) or int(value)>9223372036854775807:
        from .inbox import InboxError
        raise InboxError('invalid_message_reference')
    return int(value)

def available(row):
    return bool(row and row['sender'] in PUBLIC_SENDERS and row.get('kind')!='note'
                and not (row.get('metadata') or {}).get('revoked')
                and (row.get('delivery_status') or 'received') in {'received','sent','delivered','read'})

def version(row):
    return hashlib.sha256(json.dumps([str(row['id']),row['body'],row.get('media_id'),row.get('kind'),
        bool((row.get('metadata') or {}).get('revoked'))],ensure_ascii=False).encode()).hexdigest()

def summary(row):
    if not available(row):return {'unavailable':True,'text':'Mensaje no disponible','author':'','id':''}
    body=str(row['body'] or '')
    if row.get('media_id') and (not body or re.fullmatch(r'\[[^\]]{1,100}\]',body)):
        body=LABELS.get(row.get('kind'),'Archivo')
    return {'id':str(row['id']),'text':body[:220],'author':str(row.get('agent_name') or ('Cliente' if row['sender']=='customer' else 'Equipo'))[:120],
            'kind':row.get('kind') or 'text','unavailable':False}

def reference(conn,key,identifier,expected=None):
    from .inbox import InboxError
    row=conn.execute('SELECT * FROM messages WHERE conversation_key=%s AND id=%s',(key,message_id(identifier))).fetchone()
    if not available(row):raise InboxError('message_reference_unavailable',409)
    if expected is not None and (not isinstance(expected,str) or expected!=version(row)):
        raise InboxError('message_reference_changed',409)
    return row

def require_version(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value):
        from .inbox import InboxError
        raise InboxError('invalid_message_reference')

def reply_metadata(conn,row,payload):
    from .inbox import InboxError
    if not payload.get('reply_to_id'):return {}
    if payload.get('template') is not None:raise InboxError('invalid_message_reference')
    require_version(payload.get('reply_to_version'))
    original=reference(conn,row['conversation_key'],payload['reply_to_id'],payload.get('reply_to_version'))
    external=str(original.get('external_id') or '')
    if row['channel']=='whatsapp' and not external.startswith('wamid.'):
        raise InboxError('message_reference_unavailable',409)
    return {'reply_to_id':str(original['id']),'reply_to_external_id':external,'reply_preview':summary(original)}

def attach_quotes(conn,key,rows):
    ids=[];external=[]
    for row in rows:
        meta=row.get('metadata') or {}
        if meta.get('reply_to_id'):ids.append(message_id(meta['reply_to_id']))
        if meta.get('reply_external_id'):external.append(str(meta['reply_external_id'])[:400])
    lookup={};by_external={}
    if ids or external:
        found=conn.execute('SELECT * FROM messages WHERE conversation_key=%s AND (id=ANY(%s) OR external_id=ANY(%s))',(key,ids,external)).fetchall()
        lookup={str(r['id']):r for r in found};by_external={r.get('external_id'):r for r in found}
    for row in rows:
        meta=row.get('metadata') or {}
        if meta.get('reply_to_id') or meta.get('reply_external_id'):
            original=lookup.get(str(meta.get('reply_to_id'))) or by_external.get(meta.get('reply_external_id'))
            row['quoted']=summary(original)

def prime_forward(payload,actor):
    """Download only an explicitly selected original, before taking transaction locks."""
    from .inbox import connection,InboxError,require_owner,send_blocked,media_read
    require_version(payload.get('source_version'))
    if not isinstance(payload.get('take_if_unassigned'),bool):raise InboxError('invalid_message_reference')
    with connection() as conn:
        target=conn.execute('SELECT * FROM conversations WHERE conversation_key=%s',(payload['key'],)).fetchone()
        if not target:raise InboxError('thread_not_found',404)
        if target['revision']!=payload.get('revision'):raise InboxError('revision_conflict',409)
        if not (not target.get('owner_id') and payload.get('take_if_unassigned') is True):require_owner(actor,target)
        reason=send_blocked(target,conn=conn)
        if reason:raise InboxError(reason,409)
        original=reference(conn,payload.get('source_key'),payload.get('source_message_id'),payload.get('source_version'))
        if original.get('media_id') and target['channel']!='whatsapp':raise InboxError('web_media_unsupported',422)
        media_id=original.get('media_id')
    if media_id:media_read({'id':media_id},actor)

def forwarded_content(conn,target,payload,actor):
    from .inbox import InboxError
    from .inbox_media import validate_media
    original=reference(conn,payload.get('source_key'),payload.get('source_message_id'),payload.get('source_version'))
    text=str(original['body'] or '').strip();media_id=None
    if original.get('media_id'):
        if target['channel']!='whatsapp':raise InboxError('web_media_unsupported',422)
        media=conn.execute('SELECT * FROM inbox_media WHERE id=%s AND conversation_key=%s',(original['media_id'],original['conversation_key'])).fetchone()
        if not media or not media['content']:raise InboxError('media_unavailable',409)
        mime,name,kind=validate_media(bytes(media['content']),media['mime'],media['name'])
        usage=conn.execute("SELECT COALESCE(sum(size),0) AS total FROM inbox_media WHERE actor_id=%s AND created_at>NOW()-INTERVAL '1 hour'",(actor['id'],)).fetchone()
        if usage['total']+len(media['content'])>128*1024*1024:raise InboxError('upload_quota_exceeded',429)
        media_id=str(uuid.uuid4())
        conn.execute('''INSERT INTO inbox_media(id,conversation_key,actor_id,name,mime,kind,content,number_id,size,is_voice)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(media_id,target['conversation_key'],actor['id'],name,mime,kind,
            media['content'],target.get('channel_number_id'),len(media['content']),bool(media.get('is_voice'))))
        if kind=='audio' or re.fullmatch(r'\[[^\]]{1,100}\]',text):text=''
    return text,media_id,{'forwarded':True,'forward_source_id':str(original['id']),
        'forward_source_key':original['conversation_key'],'forward_source_version':version(original)}

def reply_send_error(conn,row,message):
    meta=message.get('metadata') or {}
    if meta.get('forward_source_id'):
        try:reference(conn,meta.get('forward_source_key'),meta['forward_source_id'],meta.get('forward_source_version'))
        except Exception:return 'message_reference_unavailable'
    if not meta.get('reply_to_id'):return None
    try:
        original=reference(conn,row['conversation_key'],meta['reply_to_id'])
        if row['channel']=='whatsapp' and original.get('external_id')!=meta.get('reply_to_external_id'):
            return 'message_reference_unavailable'
    except Exception:return 'message_reference_unavailable'
    return None

def web_reply_text(message):
    meta=message.get('metadata') or {};quote=meta.get('reply_preview')
    if not isinstance(quote,dict):return message['body']
    # Web widget has a text-only contract. Keep a readable quote in the actual reply.
    return 'En respuesta a: «'+str(quote.get('text') or '')[:220]+'»\n\n'+message['body']
