"""Bounded, WABA-scoped text templates; no caller supplied Graph payloads."""
from __future__ import annotations
import hashlib
import json
import re
import time

import httpx


class TemplateError(ValueError):
    pass


def template_view(raw):
    view = {key: str(raw.get(key) or '') for key in ('id', 'name', 'language', 'category', 'status')}
    view.update(supported=True, unsupported_reason='', header='', body='', footer='', variables={'header': [], 'body': []})
    reason = ''
    if not re.fullmatch(r'[0-9]{1,40}', view['id']) or not re.fullmatch(r'[a-z0-9_]{1,512}', view['name']) or not re.fullmatch(r'[a-z]{2,3}(?:_[A-Za-z]{2,4})?', view['language']):
        reason = 'invalid_template_definition'
    if view['status'] != 'APPROVED':
        reason = 'template_not_approved'
    if raw.get('parameter_format', 'POSITIONAL') != 'POSITIONAL':
        reason = 'named_parameters_unsupported'
    seen = set()
    parts = raw.get('components') or []
    if not isinstance(parts,list) or len(parts)>10:
        parts=[]
        reason='unsupported_template_component'
    for component in parts:
        if not isinstance(component, dict):
            reason = 'unsupported_template_component'
            continue
        kind = str(component.get('type') or '').lower()
        if kind not in {'header', 'body', 'footer'} or kind in seen:
            reason = 'unsupported_template_component'
            continue
        seen.add(kind)
        if kind == 'header' and component.get('format') != 'TEXT':
            reason = 'media_template_unsupported'
        text = component.get('text')
        if not isinstance(text, str) or len(text) > (1024 if kind == 'body' else 120):
            reason = 'invalid_template_definition'
            continue
        view[kind] = text
        placeholders = re.findall(r'\{\{([^{}]+)\}\}', text)
        remainder = re.sub(r'\{\{[^{}]+\}\}', '', text)
        if '{{' in remainder or '}}' in remainder or any(not re.fullmatch(r'[1-9][0-9]?', x) for x in placeholders):
            reason = 'unsupported_template_variables'
            continue
        indexes = sorted({int(x) for x in placeholders})
        maximum = 1 if kind == 'header' else 20 if kind == 'body' else 0
        if len(indexes) > maximum or indexes != list(range(1, len(indexes) + 1)):
            reason = 'unsupported_template_variables'
        if kind in view['variables']:
            view['variables'][kind] = [str(x) for x in indexes]
    if 'body' not in seen or not view['body']:
        reason = 'invalid_template_definition'
    view['supported'], view['unsupported_reason'] = not reason, reason
    # Include all components: silently changed buttons/media can never retain a preview hash.
    canonical = {k: raw.get(k) for k in ('id', 'name', 'language', 'status', 'category', 'parameter_format', 'components')}
    view['fingerprint'] = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    return view


def render_template(view, parameters):
    if not view['supported']:
        raise TemplateError(view['unsupported_reason'])
    if not isinstance(parameters, dict) or set(parameters) - {'header', 'body'}:
        raise TemplateError('invalid_template_parameters')
    components, rendered = [], []
    clean = {}
    for section in ('header', 'body'):
        values = parameters.get(section, [])
        if not isinstance(values, list) or len(values) != len(view['variables'][section]):
            raise TemplateError('invalid_template_parameters')
        if any(not isinstance(x, str) or not x.strip() or len(x) > 500 or re.search(r'[\x00-\x1f\x7f]', x) or '{{' in x or '}}' in x for x in values):
            raise TemplateError('invalid_template_parameters')
        clean[section] = [x.strip() for x in values]
        text = view[section]
        for index, value in enumerate(clean[section], 1):
            text = text.replace('{{' + str(index) + '}}', value)
        if text:
            rendered.append(text)
        if values:
            components.append({'type': section, 'parameters': [{'type': 'text', 'text': x} for x in clean[section]]})
    if view['footer']:
        rendered.append(view['footer'])
    preview = '\n\n'.join(rendered)
    if len(preview) > 4096:
        raise TemplateError('template_message_too_long')
    return {'preview': preview, 'parameters': clean, 'payload': {'name': view['name'], 'language': {'code': view['language']}, 'components': components}}


class TemplateCatalog:
    def __init__(self, settings):
        self.settings = settings

    def list(self, number_id, name=None):
        config = self.settings.whatsapp_numbers.get(str(number_id)) or {}
        waba = str(config.get('waba_id') or '')
        if not re.fullmatch(r'[0-9]{1,40}', waba):
            raise TemplateError('templates_not_configured')
        url = 'https://graph.facebook.com/' + self.settings.meta_graph_version + '/' + waba + '/message_templates'
        params = {'fields': 'id,name,language,status,category,parameter_format,components', 'limit': 100}
        if name:
            params['name'] = name
        results, more = [], False
        deadline = time.monotonic() + 14
        try:
            with httpx.Client(timeout=8.0, follow_redirects=False) as client:
                for _ in range(5):
                    remaining = deadline-time.monotonic()
                    if remaining <= 0:
                        raise TemplateError('templates_unavailable')
                    response = client.get(url, headers={'Authorization': 'Bearer ' + self.settings.whatsapp_access_token}, params=params,timeout=min(8.0,remaining))
                    if response.status_code != 200 or len(response.content) > 2 * 1024 * 1024:
                        raise TemplateError('templates_unavailable')
                    data = response.json()
                    if not isinstance(data.get('data'), list):
                        raise TemplateError('templates_unavailable')
                    results.extend(template_view(r) for r in data['data'] if isinstance(r, dict))
                    paging = data.get('paging') or {}
                    cursor = (paging.get('cursors') or {}).get('after')
                    more = bool(paging.get('next') and cursor)
                    if not more:
                        break
                    if not isinstance(cursor, str) or len(cursor) > 2000:
                        raise TemplateError('templates_unavailable')
                    # Never follow a server supplied next URL or token in that URL.
                    params['after'] = cursor
        except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
            if isinstance(exc, TemplateError):
                raise
            raise TemplateError('templates_unavailable') from exc
        return {'ok': True, 'templates': results, 'more': more}

    def resolve(self, number_id, template_id, language, name=None):
        if not re.fullmatch(r'[0-9]{1,40}', str(template_id)) or not isinstance(language, str):
            raise TemplateError('invalid_template')
        result = self.list(number_id, name=name)
        matches = [t for t in result['templates'] if t['id'] == str(template_id) and t['language'] == language]
        if len(matches) != 1:
            raise TemplateError('template_not_available')
        if not matches[0]['supported']:
            raise TemplateError(matches[0]['unsupported_reason'])
        return matches[0]


def verified_template(settings, number_id, value, catalog=None):
    if not isinstance(value, dict) or set(value) - {'id', 'language', 'parameters', 'fingerprint', 'name'}:
        raise TemplateError('invalid_template')
    view = (catalog or TemplateCatalog(settings)).resolve(number_id, value.get('id'), value.get('language'), name=value.get('name'))
    if value.get('fingerprint') != view['fingerprint']:
        raise TemplateError('template_changed')
    rendered = render_template(view, value.get('parameters'))
    stored = {'id': view['id'], 'name': view['name'], 'language': view['language'], 'fingerprint': view['fingerprint'], 'parameters': rendered['parameters']}
    return stored, rendered
