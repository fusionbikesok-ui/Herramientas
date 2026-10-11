from pathlib import Path
import datetime,json,shutil,subprocess,sys
r=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve();assert stage.parent==r and stage.name.startswith('andreani-stage-');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
subprocess.run(['python3',str(stage/'sync-metrics-test.py')],check=True,timeout=25)
subprocess.run(['systemctl','stop','fusion-management-metrics-sync.service'],check=True,timeout=50)
backup=r/'backups'/('andreani-dimensions-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
shutil.copy2(r/'sync-metrics.py',backup/'sync-metrics.py');shutil.copyfile(stage/'sync-metrics.py',r/'sync-metrics.py')
subprocess.run(['systemctl','start','--no-block','fusion-management-metrics-sync.service'],check=True)
print(json.dumps({'virtual_dimensions_refresh_started':True,'backup':str(backup)}))
