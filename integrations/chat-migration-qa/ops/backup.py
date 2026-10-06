"""Run on VPS. Backups stay root-only on that VPS; stdout is metadata only."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess

os.umask(0o077)
root = Path('/opt/fusion-chatbot')
destination = Path('/opt/fusionbikes/backups/chat-migration') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
destination.mkdir(parents=True, exist_ok=False, mode=0o700)
names = ['app', 'knowledge', 'tests', 'requirements.txt', 'Dockerfile', 'docker-compose.yml', 'docker-compose.override.yml', '.env']
names = [n for n in names if (root / n).exists()]
subprocess.run(['tar', '-czf', str(destination / 'bot-code-config.tar.gz'), '-C', str(root), *names], check=True, timeout=90)
with (destination / 'bot-postgres.dump').open('wb') as output:
    subprocess.run(['docker', 'exec', 'fusion-chatbot-postgres-1', 'sh', '-c', 'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], stdout=output, check=True, timeout=180)
subprocess.run(['gzip', '-t', str(destination / 'bot-code-config.tar.gz')], check=True)
with (destination / 'bot-postgres.dump').open('rb') as source:
    checked = subprocess.run(['docker', 'exec', '-i', 'fusion-chatbot-postgres-1', 'pg_restore', '--list'], stdin=source, capture_output=True, check=True, timeout=30)
manifest = {'path': str(destination), 'database_dump_index_readable': True, 'dump_index_lines': len(checked.stdout.splitlines()), 'restore_tested': False, 'files': []}
for name in ['bot-code-config.tar.gz', 'bot-postgres.dump']:
    data = (destination / name).read_bytes()
    manifest['files'].append({'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
(destination / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest))
