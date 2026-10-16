"""Private media, bounded parsing and official Cloud API transport only."""
from __future__ import annotations
import base64
import binascii
import os
import re
import io
import zipfile
from xml.etree import ElementTree
from urllib.parse import urlparse

import httpx

MAX_MEDIA = 16 * 1024 * 1024
MAX_IMAGE = 5 * 1024 * 1024
TYPES = {
    'image/jpeg': ('image', '.jpg'), 'image/png': ('image', '.png'),
    'image/webp': ('image', '.webp'), 'application/pdf': ('document', '.pdf'),
    'audio/mpeg': ('audio', '.mp3'), 'audio/ogg': ('audio', '.ogg'),
    'audio/mp4': ('audio', '.m4a'), 'audio/aac': ('audio', '.aac'),
    'video/mp4': ('video', '.mp4'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ('document', '.xlsx'),
}


class MediaError(ValueError):
    pass


class SendRejected(Exception):
    """An explicit 4xx rejection is safe to classify failed; never auto-retry."""


def decode_upload(encoded):
    if not isinstance(encoded, str) or len(encoded) > ((MAX_MEDIA + 2) // 3) * 4:
        raise MediaError('media_too_large')
    try:
        return base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise MediaError('invalid_base64') from exc


def validate_xlsx(content: bytes):
    """Inspect the bounded OOXML package without extracting or executing its contents."""
    if not content.startswith(b'PK\x03\x04'):
        raise MediaError('media_signature_mismatch')
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > 2000 or sum(item.file_size for item in entries) > 100 * 1024 * 1024:
                raise MediaError('document_too_complex')
            names = [item.filename for item in entries]
            if len(names) != len(set(names)):
                raise MediaError('media_signature_mismatch')
            for item in entries:
                name = item.filename.replace('\\', '/').lower()
                if item.flag_bits & 1 or name.startswith('/') or '..' in name.split('/'):
                    raise MediaError('unsafe_document')
                if name.endswith('vbaproject.bin') or any(part in name.split('/') for part in ('activex', 'embeddings', 'macrosheets')):
                    raise MediaError('unsafe_document')
            if '[Content_Types].xml' not in names or 'xl/workbook.xml' not in names:
                raise MediaError('media_signature_mismatch')
            entry = archive.getinfo('[Content_Types].xml')
            if entry.file_size > 1024 * 1024:
                raise MediaError('document_too_complex')
            types = archive.read(entry)
            if b'<!DOCTYPE' in types.upper() or b'<!ENTITY' in types.upper():
                raise MediaError('unsafe_document')
            root = ElementTree.fromstring(types)
            workbook_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
            matches = [node for node in root if node.tag == '{http://schemas.openxmlformats.org/package/2006/content-types}Override'
                       and node.attrib.get('PartName') == '/xl/workbook.xml' and node.attrib.get('ContentType') == workbook_type]
            if not matches:
                raise MediaError('media_signature_mismatch')
    except (zipfile.BadZipFile, zipfile.LargeZipFile, ElementTree.ParseError, RuntimeError, NotImplementedError, OSError, EOFError) as exc:
        raise MediaError('media_signature_mismatch') from exc


def validate_media(content: bytes, mime: str, name: str):
    mime = mime.lower().split(';', 1)[0].strip()
    if mime not in TYPES:
        raise MediaError('unsupported_media_type')
    kind, ext = TYPES[mime]
    if not content or len(content) > (MAX_IMAGE if kind == 'image' else MAX_MEDIA):
        raise MediaError('media_too_large' if content else 'empty_media')
    data = content
    magic = {
        'image/jpeg': len(data) >= 12 and data.startswith(b'\xff\xd8\xff') and data.endswith(b'\xff\xd9'),
        'image/png': len(data) >= 45 and data.startswith(b'\x89PNG\r\n\x1a\n') and data[12:16] == b'IHDR' and data[-8:-4] == b'IEND',
        'image/webp': len(data) >= 20 and data.startswith(b'RIFF') and data[8:12] == b'WEBP' and int.from_bytes(data[4:8], 'little') + 8 == len(data),
        'application/pdf': data.startswith(b'%PDF-') and b'%%EOF' in data[-1024:],
        'audio/mpeg': len(data) >= 8 and (data.startswith(b'ID3') or (data[0] == 255 and data[1] & 0xe0 == 0xe0)),
        'audio/ogg': len(data) >= 30 and data.startswith(b'OggS') and b'OpusHead' in data[:4096],
        'audio/aac': len(data) >= 8 and data[0] == 255 and (data[1] & 0xf6) == 0xf0,
        'audio/mp4': len(data) >= 24 and data[4:8] == b'ftyp' and data[8:12] in {b'M4A ', b'M4B '},
        'video/mp4': len(data) >= 24 and data[4:8] == b'ftyp' and data[8:12] in {b'isom', b'iso2', b'mp41', b'mp42', b'avc1', b'M4V '},
    }
    if mime == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        validate_xlsx(data)
    elif not magic[mime]:
        raise MediaError('media_signature_mismatch')
    # PDFs with active actions, embedded files or encryption are not accepted.
    if mime == 'application/pdf' and re.search(rb'/(JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|Encrypt|RichMedia)\b', data, re.I):
        raise MediaError('unsafe_pdf')
    clean = re.sub(r'[^\w .()-]', '_', os.path.basename(str(name).replace('\\', '/')))[:110].strip(' .')
    clean = os.path.splitext(clean or 'archivo')[0] + ext
    return mime, clean, kind


class CloudTransport:
    def __init__(self, settings):
        self.settings = settings
        self.base = 'https://graph.facebook.com/' + settings.meta_graph_version
        self.headers = {'Authorization': 'Bearer ' + settings.whatsapp_access_token}

    def send(self, thread, message, media, outbox_id):
        number = str(thread['channel_number_id'])
        recipient = str(thread.get('external_user_id') or '')
        if not number.isdigit() or not recipient.isdigit():
            raise SendRejected('invalid_recipient')
        payload = {'messaging_product': 'whatsapp', 'recipient_type': 'individual', 'to': recipient,
                   'biz_opaque_callback_data': str(outbox_id)}
        quoted=(message.get('metadata') or {}).get('reply_to_external_id')
        if quoted:payload['context']={'message_id':str(quoted)}
        template_payload = None
        if message.get('kind') == 'template':
            from .inbox_templates import verified_template, TemplateError
            meta = message.get('metadata') or {}
            if media or meta.get('opt_in') is not True:
                raise SendRejected('invalid_template_message')
            try:
                _, rendered = verified_template(self.settings,number,meta.get('template'))
            except TemplateError as exc:
                # Catalog failure occurs before any messages POST: definitely unsent.
                raise SendRejected(str(exc)) from exc
            template_payload = rendered['payload']
        with httpx.Client(timeout=30.0, follow_redirects=False) as client:
            if template_payload is not None:
                payload.update(type='template',template=template_payload)
            elif media:
                content = bytes(media['content'] or b'')
                mime, name, kind = validate_media(content, media['mime'], media['name'])
                upload = client.post(self.base + '/' + number + '/media', headers=self.headers,
                    data={'messaging_product': 'whatsapp', 'type': mime}, files={'file': (name, content, mime)})
                # Upload does not send a message. A failure here is definitely unsent.
                if not 200 <= upload.status_code < 300:
                    raise SendRejected('media_upload_failed')
                try:
                    media_id = str(upload.json()['id'])
                except (ValueError, KeyError, TypeError) as exc:
                    raise SendRejected('media_upload_invalid') from exc
                payload['type'] = kind
                payload[kind] = {'id': media_id}
                if kind == 'audio' and media.get('is_voice') is True and mime == 'audio/ogg':
                    payload[kind]['voice'] = True
                if kind == 'document':
                    payload[kind]['filename'] = name
                if message['body'] and kind in {'image', 'video', 'document'}:
                    payload[kind]['caption'] = message['body'][:1024]
            else:
                payload.update(type='text', text={'body': message['body'], 'preview_url': False})
            response = client.post(self.base + '/' + number + '/messages', headers=self.headers, json=payload)
        if 400 <= response.status_code < 500:
            raise SendRejected('meta_rejected_' + str(response.status_code))
        # 5xx, timeout, invalid/missing message ID are ambiguous. Do not retry.
        response.raise_for_status()
        remote_id = response.json()['messages'][0]['id']
        if not isinstance(remote_id, str) or not remote_id:
            raise ValueError('missing_message_id')
        return remote_id

    def download(self, remote_id, number_id):
        if not str(remote_id).isdigit() or not str(number_id).isdigit():
            raise MediaError('invalid_remote_media')
        with httpx.Client(timeout=30.0, follow_redirects=False) as client:
            response = client.get(self.base + '/' + str(remote_id), headers=self.headers,
                                  params={'phone_number_id': str(number_id)})
            response.raise_for_status()
            info = response.json()
            if int(info.get('file_size') or 0) > MAX_MEDIA:
                raise MediaError('media_too_large')
            url = str(info.get('url') or '')
            parsed = urlparse(url)
            host = (parsed.hostname or '').lower()
            if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in {None, 443} or not any(
                host == root or host.endswith('.' + root) for root in ('facebook.com', 'fbcdn.net', 'lookaside.fbsbx.com')):
                raise MediaError('unsafe_media_url')
            data = bytearray()
            with client.stream('GET', url, headers=self.headers) as remote:
                remote.raise_for_status()
                if int(remote.headers.get('content-length') or 0) > MAX_MEDIA:
                    raise MediaError('media_too_large')
                for chunk in remote.iter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_MEDIA:
                        raise MediaError('media_too_large')
            return bytes(data), str(info.get('mime_type') or '')
