"""Meta envelope adapters, including coexistence echoes and asynchronous history."""
from __future__ import annotations
import hashlib
import json


def rows(value):
    return value if isinstance(value, list) else []


def obj(value):
    return value if isinstance(value, dict) else {}


def text_from(raw):
    kind = str(raw.get('type') or 'unknown')
    content = obj(raw.get(kind))
    if kind == 'text': return str(content.get('body') or ''), kind
    if kind == 'button': return str(content.get('text') or ''), kind
    if kind == 'interactive':
        reply = obj(content.get('button_reply')) or obj(content.get('list_reply'))
        return str(reply.get('title') or reply.get('id') or ''), kind
    labels = {'image': 'Imagen', 'audio': 'Audio', 'video': 'Vídeo', 'document': 'Documento',
        'sticker': 'Sticker', 'location': 'Ubicación', 'contacts': 'Contacto', 'media_placeholder': 'Adjunto histórico pendiente'}
    return str(content.get('caption') or '[' + labels.get(kind, 'Mensaje ' + kind) + ' recibido]'), kind


def message_event(raw, number_id, config, recipient, profile=None, echo=False, historical=False):
    raw = dict(raw)
    # Some history envelopes nest the standard type payload inside content.
    if isinstance(raw.get('content'), dict):
        raw = {**raw, **raw['content']}
    external_id = str(raw.get('id') or '')
    if not external_id or not recipient or not str(recipient).isdigit():
        return None
    text, kind = text_from(raw)
    event_id = ('wa-history:' if historical else 'wa-echo:' if echo else 'wa:') + external_id
    if kind in {'edit', 'revoke'} or historical:
        event_id += ':' + hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()[:20]
    return {'event_id': event_id, 'event_type': 'whatsapp_echo' if echo else 'whatsapp_inbound',
        'historical': historical, 'occurred_at': str(raw.get('timestamp') or ''),
        'conversation': {'channel': 'whatsapp', 'external_conversation_id': str(number_id) + ':' + str(recipient),
            'external_user_id': str(recipient), 'channel_number_id': str(number_id),
            'channel_label': config.get('label', 'WhatsApp'), 'customer_name': str(obj(profile).get('name') or ''),
            'customer_phone': str(recipient)},
        'message': {'external_id': external_id, 'sender': 'operator' if echo else 'customer',
            'text': text, 'type': kind, 'raw': raw,
            'status': str(obj(raw.get('history_context')).get('status') or ('sent' if echo else 'received')).lower()}}


def history_events(value, settings):
    metadata = obj(value.get('metadata'))
    number_id = str(metadata.get('phone_number_id') or '')
    config = settings.number(number_id)
    if not config:
        return
    business = ''.join(c for c in str(metadata.get('display_phone_number') or config.get('display_number') or '') if c.isdigit())
    for chunk in rows(value.get('history')):
        for thread in rows(obj(chunk).get('threads')):
            recipient = str(obj(thread).get('id') or '')
            for raw in rows(obj(thread).get('messages')):
                if not isinstance(raw, dict): continue
                echo = str(raw.get('from') or '') in {business, number_id} or (bool(raw.get('to')) and str(raw.get('to')) == recipient)
                event = message_event(raw, number_id, config, recipient, echo=echo, historical=True)
                if event: yield event
    for raw in rows(value.get('messages')):
        if not isinstance(raw, dict): continue
        echo = str(raw.get('from') or '') in {business, number_id}
        recipient = str(raw.get('to') if echo else raw.get('from') or '')
        event = message_event(raw, number_id, config, recipient, echo=echo, historical=True)
        if event: yield event


def events_from_meta(payload, settings):
    events = []
    for entry in rows(payload.get('entry')):
        for change in rows(obj(entry).get('changes')):
            value = obj(obj(change).get('value'))
            metadata = obj(value.get('metadata'))
            number_id = str(metadata.get('phone_number_id') or '')
            config = settings.number(number_id)
            if not config:
                continue
            field = str(obj(change).get('field') or 'messages')
            if field == 'history':
                # Store/enqueue one batch; PostgreSQL ingest runs in worker, not webhook HTTP.
                digest = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                events.append({'event_id': 'wa-history-batch:' + digest, 'event_type': 'whatsapp_history_batch', 'value': value})
                continue
            contacts = {str(obj(c).get('wa_id') or ''): obj(obj(c).get('profile')) for c in rows(value.get('contacts'))}
            echo = field == 'smb_message_echoes'
            for raw in rows(value.get('message_echoes' if echo else 'messages')):
                if not isinstance(raw, dict): continue
                recipient = str(raw.get('to') if echo else raw.get('from') or '')
                event = message_event(raw, number_id, config, recipient, contacts.get(recipient), echo=echo)
                if event: events.append(event)
            for status in rows(value.get('statuses')):
                if not isinstance(status, dict): continue
                external_id, state, stamp = str(status.get('id') or ''), str(status.get('status') or ''), str(status.get('timestamp') or '')
                if not external_id: continue
                events.append({'event_id': 'wa-status:' + external_id + ':' + state + ':' + stamp,
                    'event_type': 'whatsapp_status', 'occurred_at': stamp,
                    'conversation': {'channel': 'whatsapp', 'channel_number_id': number_id,
                        'external_user_id': str(status.get('recipient_id') or '')},
                    'message': {'external_id': external_id, 'status': state, 'errors': status.get('errors', []),
                        'outbox_id': status.get('biz_opaque_callback_data')}})
    return events
