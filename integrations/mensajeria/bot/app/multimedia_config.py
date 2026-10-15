"""Private provider configuration. Secrets never enter settings, audit or responses."""
from __future__ import annotations
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile
import httpx
from .ai_budget import usage

IMAGE_MODEL = 'gpt-6.1-sol'
AUDIO_MODEL = 'gpt-transcribe'
DEFAULT = {'key': '', 'images': False, 'audio': False, 'monthly_usd': 0, 'revision': 0}

class MultimediaError(Exception):
    pass

def config_path():
    return Path(os.environ.get('MULTIMEDIA_CONFIG_PATH', '/private-ai/multimedia.json'))

def read_config():
    path = config_path()
    try:
        if path.stat().st_mode & 0o077:
            raise MultimediaError('multimedia_private_file')
        data = json.loads(path.read_text())
        if not isinstance(data, dict): raise ValueError()
        return {**DEFAULT, **data}
    except FileNotFoundError:
        return dict(DEFAULT)
    except (ValueError, OSError):
        raise MultimediaError('multimedia_config_unavailable') from None

def public_config():
    config = read_config()
    from .storage import connection
    with connection() as conn:
        used = usage(conn)['images']
    return {'ok': True, 'configured': bool(config['key']), 'images': config['images'], 'audio': config['audio'],
            'monthly_usd': config['monthly_usd'], 'used_usd': float(used)/1_000_000,
            'budget_scope': 'images', 'image_model': IMAGE_MODEL, 'audio_model': AUDIO_MODEL, 'revision': config['revision']}

def save_config(payload):
    path = config_path()
    # Directory is provisioned by deployment, not derived from user input.
    with (path.parent/'config.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = read_config()
        if type(payload.get('revision')) is not int or payload['revision'] != current['revision']:
            raise MultimediaError('multimedia_config_changed')
        if any(type(payload.get(k)) is not bool for k in ('images','audio')):
            raise MultimediaError('multimedia_invalid_config')
        amount = payload.get('monthly_usd')
        if type(amount) is not int or amount < 0 or amount > 200:
            raise MultimediaError('multimedia_invalid_budget')
        key = payload.get('api_key', '')
        if not isinstance(key, str) or len(key)>512:
            raise MultimediaError('multimedia_invalid_key')
        key = key.strip()
        if key and not re.fullmatch(r'sk-[A-Za-z0-9_-]{20,500}', key):
            raise MultimediaError('multimedia_invalid_key')
        if payload.get('remove_key') is True:
            key = ''
        else:
            key = key or current['key']
        if ((payload['images'] or payload['audio']) and not key) or (payload['images'] and not amount):
            raise MultimediaError('multimedia_setup_required')
        data = dict(key=key, images=payload['images'], audio=payload['audio'], monthly_usd=amount, revision=current['revision']+1)
        fd, name = tempfile.mkstemp(prefix='.ai-', dir=path.parent)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(data, out);out.flush();os.fsync(out.fileno())
            os.replace(name, path)
        finally:
            if os.path.exists(name):os.unlink(name)
    return public_config()

def check_key():
    config = read_config()
    if not config['key']:raise MultimediaError('multimedia_setup_required')
    # Model access check only. No customer files and no inference charge.
    try:
        with httpx.Client(timeout=8, follow_redirects=False, trust_env=False) as client:
            for model in (IMAGE_MODEL, AUDIO_MODEL):
                r = client.get('https://api.openai.com/v1/models/'+model, headers={'Authorization':'Bearer '+config['key']})
                if r.status_code != 200:
                    raise MultimediaError('multimedia_key_rejected' if r.status_code in (401,403) else 'multimedia_model_unavailable')
        return {'ok': True, 'message': 'Clave y acceso a modelos confirmados. El saldo y una prueba real se comprueban al procesar un archivo.'}
    except httpx.HTTPError:
        raise MultimediaError('multimedia_provider_unavailable') from None
