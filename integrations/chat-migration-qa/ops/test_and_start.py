import json
from pathlib import Path
import subprocess
import urllib.request

root = Path('/opt/fusion-chat-migration-qa')
if (root/'.codex-migration-qa').read_text() != 'fusion-chat-migration-20261004':
    raise SystemExit('Unrecognized sandbox')
base = ['docker','compose','--env-file',str(root/'qa.env'),'-f',str(root/'compose.qa.json'),'-p','fusion-chat-migration-qa']
subprocess.run(base+['stop','worker'], check=True, capture_output=True)
result = subprocess.run(base+['exec','-T','api','python','-m','unittest','discover','-s','tests','-p','test_native_chat.py','-v'], capture_output=True, text=True, timeout=180)
(root/'test-result.txt').write_text(result.stdout+result.stderr)
print(result.stdout+result.stderr)
if result.returncode:
    raise SystemExit(result.returncode)
# Empty only synthetic data after tests; the schema guard aborts against all other databases.
cleanup = """from app.native_store import require_sandbox
from app.storage import connection
require_sandbox()
with connection() as c:
 c.execute('TRUNCATE native_audit,native_commands,native_jobs,native_sessions,messages,conversations RESTART IDENTITY CASCADE')
"""
subprocess.run(base+['exec','-T','api','python','-c',cleanup],check=True,capture_output=True)
subprocess.run(base+['restart','api'], check=True, timeout=30, stdout=subprocess.DEVNULL)
subprocess.run(base+['up','-d','--wait','api','worker'], check=True, timeout=90, stdout=subprocess.DEVNULL)
address = subprocess.check_output(['docker','inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}','fusion-chat-migration-qa-api-1'],text=True).strip()
with urllib.request.urlopen('http://'+address+':8000/health',timeout=5) as response:
    print(json.dumps({'health':json.load(response),'worker_started':True,'qa_data_cleared':True}))
