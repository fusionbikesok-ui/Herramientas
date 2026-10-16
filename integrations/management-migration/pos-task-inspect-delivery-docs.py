from pathlib import Path
import hashlib,json
r=Path('/opt/fusionbikes/herramientas/integrations/management-migration')
print('Documentation:',[p.name for p in r.glob('README*')])
for p in r.glob('README*'):
 text=p.read_text()
 for line in text.splitlines():
  if any(word in line.lower() for word in ['mail','whatsapp','correo','entrega','mensaj','arca']):print(p.name+': '+line)
print('memory tail')
print('\n'.join(Path('/opt/fusionbikes/herramientas/docs/memory/modules/operations-vps.md').read_text().splitlines()[-80:]))
for n in ['gateway.mjs','assets/facturador.js','assets/management.css','scripts/arca-backup.py']:
 p=r/n
 print(json.dumps({'canonical_file':n,'sha256':hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None}))
