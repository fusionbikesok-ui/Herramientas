import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.request

root = Path('/opt/fusion-chat-migration-qa')
base = ['docker','compose','--env-file',str(root/'qa.env'),'-f',str(root/'compose.qa.json'),'-p','fusion-chat-migration-qa']
def counts():
    code = "from app.native_store import require_sandbox; from app.storage import connection; import json; require_sandbox();\nwith connection() as c: print(json.dumps(c.execute('SELECT (SELECT count(*) FROM native_sessions) AS sessions,(SELECT count(*) FROM messages) AS messages').fetchone()))"
    return json.loads(subprocess.check_output(base+['exec','-T','api','python','-c',code],text=True))
before = counts()
subprocess.run(base+['restart','api'],check=True,capture_output=True,timeout=30)
subprocess.run(base+['up','-d','--wait','api'],check=True,capture_output=True,timeout=60)
after = counts()
if before != after: raise RuntimeError('QA persistence changed across restart')
network = json.loads(subprocess.check_output(['docker','network','inspect','fusion-chat-migration-qa_default'],text=True))[0]
api = json.loads(subprocess.check_output(['docker','inspect','fusion-chat-migration-qa-api-1'],text=True))[0]
assert network['Internal'] is True and not api['HostConfig']['PortBindings']
assert len(api['NetworkSettings']['Networks']) == 1
probe = "import socket; s=socket.socket(); s.settimeout(2);\ntry:\n s.connect(('1.1.1.1',443)); print('unexpected_egress')\nexcept OSError:\n print('blocked')\nfinally: s.close()"
egress = subprocess.check_output(base+['exec','-T','api','python','-c',probe],text=True).strip()
assert egress == 'blocked'
source = json.loads((root/'original-source-manifest.json').read_text())
changed = [entry['path'] for entry in source if hashlib.sha256((Path('/opt/fusion-chatbot')/entry['path']).read_bytes()).hexdigest()!=entry['sha256']]
health = {}
for name,url in [('bot','http://127.0.0.1:8091/health'),('herramientas','http://127.0.0.1:3001/healthz')]:
    try:
        with urllib.request.urlopen(url,timeout=8) as response:
            data=json.load(response)
            health[name]={'http':response.status,'ok':data.get('ok'),'version':data.get('version')}
    except Exception as exc:
        health[name]={'error':type(exc).__name__}
result={'qa_history_before_restart':before,'qa_history_after_restart':after,'isolated_network':network['Internal'],
        'published_ports':api['HostConfig']['PortBindings'],'outbound_internet':egress,'production_source_files_checked':len(source),
        'production_source_files_changed':changed,'production_health':health,
        'qa_resource_limits':{'api_memory_bytes':api['HostConfig']['Memory'],'api_nano_cpus':api['HostConfig']['NanoCpus']}}
(root/'environment-verification.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
