"""Run the unchanged original unit tests against the source already in the production image, without writes or network."""
import json
import subprocess

root = '/opt/fusion-chat-migration-qa'
image = subprocess.check_output(['docker','inspect','--format','{{.Image}}','fusion-chatbot-api-1'],text=True).strip()
result = subprocess.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges:true','--memory','160m','--cpus','0.5',
    '--env','PYTHONDONTWRITEBYTECODE=1','-v',root+'/tests/test_core.py:/srv/fusion-chatbot/tests/test_core.py:ro',
    image,'python','-m','unittest','discover','-s','tests','-p','test_core.py','-v'],capture_output=True,text=True,timeout=60)
print(result.stdout+result.stderr)
print(json.dumps({'unchanged_production_image':image,'exit_status':result.returncode,'network':'none','production_data_mounted':False}))
