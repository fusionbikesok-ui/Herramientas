from pathlib import Path
import hashlib,json,subprocess,shutil
r=Path('/opt/fusion-management-migration');b=r/'backups/pos-vps-20261006T011857Z'
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
assert 'arcaWriteRoutes' in (b/'gateway.mjs').read_text()
assert 'fusion_arca_vps_enabled' in (b/'mu-plugins/fusion-management.php').read_text()
before=r/'backups/pos-restore-fiscal-20261006';before.mkdir(exist_ok=True,mode=0o700)
for name in ['gateway.mjs','mu-plugins/fusion-management.php']:
 dest=before/name;dest.parent.mkdir(parents=True,exist_ok=True)
 if not dest.exists():shutil.copy2(r/name,dest)
 shutil.copy2(b/name,r/name)
subprocess.run(['node','--check',str(r/'gateway.mjs')],check=True)
subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php','-l'],input=(r/'mu-plugins/fusion-management.php').read_bytes(),check=True)
subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=25)
subprocess.run(['systemctl','is-active','--quiet','fusion-management-validation.service'],check=True)
print(json.dumps({'fiscal_routes_restored':True,'pos_enabled':False,'files':{n:hashlib.sha256((r/n).read_bytes()).hexdigest() for n in ['gateway.mjs','mu-plugins/fusion-management.php']}}))
