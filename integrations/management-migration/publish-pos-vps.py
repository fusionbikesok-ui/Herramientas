import datetime,json,os,shutil,subprocess,sys,time,urllib.request,urllib.error,zipfile
from pathlib import Path
r=Path('/opt/fusion-management-migration'); assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
stage=r/'pos-vps-stage'; shutil.rmtree(stage,ignore_errors=True); stage.mkdir(mode=0o700)
with zipfile.ZipFile(r/'pos-vps-stage.zip') as z:
    assert all(not n.startswith('/') and '..' not in Path(n).parts for n in z.namelist()); z.extractall(stage)
subprocess.run(['node','--check',str(stage/'gateway.mjs')],check=True,timeout=15)
subprocess.run(['node','--check',str(stage/'assets/pos.js')],check=True,timeout=15)
subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php','-l'],input=(stage/'mu-plugins/fusion-management.php').read_bytes(),check=True,timeout=20)
subprocess.run(['node','--test','gateway.test.mjs','pos-bridge.test.mjs'],cwd=stage,check=True,timeout=40)
backup=r/'backups'/('pos-vps-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')); backup.mkdir(mode=0o700)
names=['gateway.mjs','gateway.test.mjs','pos-bridge.test.mjs','local-catalog.mjs','assets/pos.js','mu-plugins/fusion-management.php']
for name in names:
    p=r/name
    if p.exists(): (backup/name).parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,backup/name)
envfile=r/'gateway.env'; shutil.copy2(envfile,backup/'gateway.env')
for name in names:
    dest=r/name; dest.parent.mkdir(parents=True,exist_ok=True); tmp=dest.with_name(dest.name+'.release'); shutil.copyfile(stage/name,tmp); tmp.chmod(0o644); os.replace(tmp,dest)
key=(r/'pos-vps-bridge.key').read_text().strip(); assert len(key)>=64 and all(c in '0123456789abcdef' for c in key)
lines=[x for x in envfile.read_text().splitlines() if not x.startswith('FUSION_POS_VPS_BRIDGE_KEY=') and not x.startswith('FUSION_POS_VPS_ENABLED=')]
lines += ['FUSION_POS_VPS_BRIDGE_KEY='+key,'FUSION_POS_VPS_ENABLED=0']; envfile.write_text('\n'.join(lines)+'\n'); envfile.chmod(0o600)
(r/'pos-vps-bridge.key').unlink(); (r/'pos-vps-stage.zip').unlink()
subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=25)
subprocess.run(['systemctl','is-active','--quiet','fusion-management-validation.service'],check=True)
for _ in range(20):
    try: urllib.request.urlopen('http://127.0.0.1:8212/herramientas/gestion-vps/',timeout=2)
    except urllib.error.HTTPError as e:
        if e.code==401: break
    except OSError: time.sleep(.25)
else: raise RuntimeError('gateway_not_ready')
report={'staged':True,'enabled':False,'backup':str(backup),'main_application_restarted':False,'master_control_changed':False}
(r/'pos-vps-release.json').write_text(json.dumps(report,indent=2)); print(json.dumps(report))
