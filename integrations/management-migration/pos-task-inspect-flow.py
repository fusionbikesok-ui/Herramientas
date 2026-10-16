from pathlib import Path
import hashlib,json,subprocess,zipfile
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
names=['gateway.mjs','pos-vps.mjs','local-catalog.mjs','assets/pos.js','assets/facturador.js','assets/management.css','mu-plugins/fusion-management.php','mu-plugins/fusion-arca-runtime.php']
names=[n for n in names if (r/n).is_file()]
with zipfile.ZipFile(r/'pos-flow-baseline.zip','w',zipfile.ZIP_DEFLATED) as z:
 for n in names:z.write(r/n,n)
 for n in ['gateway.test.mjs','pos-vps.test.mjs','arca-transport.test.mjs','local-catalog.test.mjs']:
  if (r/n).is_file():z.write(r/n,n)
print(json.dumps({'files':{n:hashlib.sha256((r/n).read_bytes()).hexdigest() for n in names},'mu_files':[p.name for p in (r/'mu-plugins').iterdir() if p.suffix=='.php']}))
