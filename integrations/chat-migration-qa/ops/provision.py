"""Only creates/starts the task-owned QA compose project; never edits production services."""
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.request

ROOT = Path('/opt/fusion-chat-migration-qa')
PROJECT = 'fusion-chat-migration-qa'
os.umask(0o077)
if not (ROOT / 'PLAN.md').is_file() or not (ROOT / 'app/native_main.py').is_file():
    raise SystemExit('Upload the reviewed task source first')


def image(container):
    value = subprocess.check_output(['docker', 'inspect', '--format', '{{.Image}}', container], text=True).strip()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', value):
        raise RuntimeError('Unexpected image reference')
    return value


images = {'api': image('fusion-chatbot-api-1'), 'postgres': image('fusion-chatbot-postgres-1'), 'redis': image('fusion-chatbot-redis-1')}
env_path = ROOT / 'qa.env'
if not env_path.exists():
    password = secrets.token_hex(32)
    env = {
        'APP_ENV': 'migration-test', 'AI_ENABLED': 'false', 'NATIVE_BOT_MODE': 'simulated',
        'NATIVE_INTERNAL_KEY': secrets.token_hex(32), 'NATIVE_INTERNAL_SECRET': secrets.token_hex(32),
        'QA_POSTGRES_PASSWORD': password,
        'DATABASE_URL': f'postgresql://native_chat_qa:{password}@postgres:5432/native_chat_qa',
        'REDIS_URL': 'redis://redis:6379/0', 'REDIS_QUEUE': 'native:qa:unused',
        'WORDPRESS_BASE_URL': 'http://disabled.invalid', 'AI_BASE_URL': 'http://disabled.invalid',
        'FUSION_API_KEY': '', 'FUSION_CALLBACK_SECRET': '', 'META_APP_SECRET': '',
        'META_VERIFY_TOKEN': '', 'WHATSAPP_ACCESS_TOKEN': '', 'WHATSAPP_NUMBERS_JSON': '{}',
        'PYTHONDONTWRITEBYTECODE': '1', 'LOG_LEVEL': 'WARNING',
    }
    env_path.write_text(''.join(k+'='+v+'\n' for k,v in env.items()))
    env_path.chmod(0o600)

logging = {'driver': 'json-file', 'options': {'max-size': '5m', 'max-file': '2'}}
common = {
    'image': images['api'], 'pull_policy': 'never', 'env_file': ['qa.env'],
    'volumes': ['./app:/srv/fusion-chatbot/app:ro', './tests:/srv/fusion-chatbot/tests:ro'],
    'read_only': True, 'tmpfs': ['/tmp:size=16m,noexec,nosuid,nodev'],
    'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
    'restart': 'unless-stopped', 'logging': logging,
    'depends_on': {'postgres': {'condition': 'service_healthy'}, 'redis': {'condition': 'service_healthy'}},
}
compose = {
    'name': PROJECT,
    'services': {
        'api': {**common, 'command': ['uvicorn','app.native_main:app','--host','0.0.0.0','--port','8000','--no-access-log','--no-proxy-headers'],
                'mem_limit': '256m', 'cpus': 0.5,
                'healthcheck': {'test': ['CMD','python','-c',"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4)"], 'interval':'10s','timeout':'5s','retries':6}},
        'worker': {**common, 'command': ['python','-m','app.native_worker'], 'mem_limit':'160m','cpus':0.25},
        'postgres': {'image': images['postgres'], 'pull_policy':'never', 'environment': {'POSTGRES_DB':'native_chat_qa','POSTGRES_USER':'native_chat_qa','POSTGRES_PASSWORD':'${QA_POSTGRES_PASSWORD}'},
                     'volumes':['pgdata:/var/lib/postgresql/data'], 'mem_limit':'256m','cpus':0.3,'restart':'unless-stopped','logging':logging,
                     'healthcheck': {'test':['CMD','pg_isready','-U','native_chat_qa','-d','native_chat_qa'],'interval':'5s','timeout':'3s','retries':12}},
        'redis': {'image':images['redis'],'pull_policy':'never','command':['redis-server','--appendonly','yes','--maxmemory','48mb','--maxmemory-policy','noeviction'],
                  'volumes':['redisdata:/data'],'mem_limit':'96m','cpus':0.15,'restart':'unless-stopped','logging':logging,
                  'healthcheck':{'test':['CMD','redis-cli','ping'],'interval':'5s','timeout':'3s','retries':12}},
    },
    'volumes': {'pgdata':{},'redisdata':{}}, 'networks': {'default': {'internal':True}},
}
(ROOT / 'compose.qa.json').write_text(json.dumps(compose, indent=2))
(ROOT / 'images.json').write_text(json.dumps(images, indent=2))
base = ['docker','compose','--env-file',str(env_path),'-f',str(ROOT/'compose.qa.json'),'-p',PROJECT]
subprocess.run(base+['up','-d','--wait','postgres','redis','api'], check=True, timeout=120, stdout=subprocess.DEVNULL)
address = subprocess.check_output(['docker','inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',PROJECT+'-api-1'],text=True).strip()
with urllib.request.urlopen('http://'+address+':8000/health', timeout=5) as response:
    health = json.load(response)
if not health.get('ok') or health.get('production_traffic') is not False:
    raise RuntimeError('Unexpected health response')
print(json.dumps({'root':str(ROOT),'project':PROJECT,'health':health,'network_internal':True,'published_ports':[],'access':'SSH tunnel from local loopback only','worker_started':False,'images':images}))
