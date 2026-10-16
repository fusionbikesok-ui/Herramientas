from pathlib import Path
import json,urllib.request,urllib.error,sqlite3
r=Path('/opt/fusion-management-migration')
try:urllib.request.urlopen('http://127.0.0.1:8212/herramientas/gestion-vps/ventas/',timeout=5)
except urllib.error.HTTPError as e:print(json.dumps({'gateway_status':e.code,'gateway_headers':dict(e.headers)}))
try:urllib.request.urlopen('https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/ventas/',timeout=10)
except urllib.error.HTTPError as e:print(json.dumps({'public_status':e.code,'public_headers':dict(e.headers)}))
for f in Path('/etc/nginx').rglob('*.conf'):
 if f.is_file() and 'gestion-vps' in f.read_text():
  text=f.read_text();print(json.dumps({'nginx_file':str(f),'relevant_lines':[l for l in text.splitlines() if any(k in l for k in ['gestion-vps','sandbox','Content-Security','8212'])]}))
print((r/'directory-cache/status.json').read_text())
