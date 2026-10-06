from pathlib import Path
import datetime,json,shutil,subprocess,sys
r=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve();assert stage.parent==r and stage.name.startswith('metrics-stage-');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
for name in ['sync-directory-test.py','sync-metrics-test.py']:subprocess.run(['python3',str(stage/name)],check=True,timeout=25)
subprocess.run(['systemctl','stop','fusion-management-directory-sync.service','fusion-management-metrics-sync.service'],check=True,timeout=50)
backup=r/'backups'/('precision-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
for name in ['sync-directory.py','sync-directory-test.py','sync-metrics.py','sync-metrics-test.py']:
 shutil.copy2(r/name,backup/name);shutil.copyfile(stage/name,r/name)
subprocess.run(['systemctl','start','--no-block','fusion-management-directory-sync.service','fusion-management-metrics-sync.service'],check=True)
print(json.dumps({'precision_upgrade_started':True,'backup':str(backup)}))
