import zipfile,subprocess,json
from pathlib import Path
r=Path('/opt/fusion-management-migration');s=r/'pos-stage-v2';s.mkdir(exist_ok=True,mode=0o700)
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
with zipfile.ZipFile(r/'pos-vps-runtime-v2.zip') as z:
 assert all(not n.startswith('/') and '..' not in Path(n).parts for n in z.namelist());z.extractall(s)
subprocess.run(['node','--test','pos-vps.test.mjs','gateway.test.mjs','arca-transport.test.mjs','local-catalog.test.mjs'],cwd=s,check=True,timeout=45)
subprocess.run(['node','--check',str(s/'assets/pos.js')],check=True)
for name in ['plugin-under-test.php','mu-plugins/fusion-management.php']:
 subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php','-l'],input=(s/name).read_bytes(),check=True,timeout=20)
for name in ['plugin-under-test.php','bridge-test.php']:
 subprocess.run(['docker','cp',str(s/name),'fusion-management-migration-php-1:/tmp/pos-'+name],check=True)
subprocess.run(['docker','exec','fusion-management-migration-php-1','php','/tmp/pos-bridge-test.php','/tmp/pos-plugin-under-test.php'],check=True,timeout=20)
print(json.dumps({'staged':True,'published':False,'tests':19,'php_bridge_tests':True}))
