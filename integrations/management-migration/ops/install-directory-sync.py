from pathlib import Path
import datetime,grp,json,os,shutil,subprocess,sys
root=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve()
assert stage.parent==root and stage.name.startswith('directory-stage-')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
subprocess.run(['python3',str(stage/'sync-directory-test.py')],check=True,timeout=20)
subprocess.run(['python3','-m','py_compile',str(stage/'sync-directory.py')],check=True,timeout=20)
subprocess.run(['systemctl','stop','fusion-management-directory-sync.service'],check=False,timeout=55)
try:grp.getgrnam('fusion-management-read')
except KeyError:subprocess.run(['groupadd','--system','fusion-management-read'],check=True)
cache=root/'directory-cache';cache.mkdir(exist_ok=True);shutil.chown(cache,group='fusion-management-read');cache.chmod(0o2750)
for name in ['sync-directory.py','sync-directory-test.py','DIRECTORY-PLAN.md']:
 shutil.copyfile(stage/name,root/name);(root/name).chmod(0o644)
service=Path('/etc/systemd/system/fusion-management-directory-sync.service')
service.write_text('''[Unit]
Description=Fusion shared customer and order read index
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/fusion-management-migration/sync-directory.py
User=root
Group=fusion-management-read
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/fusion-management-migration/directory-cache
TimeoutStartSec=7200
MemoryMax=256M
CPUQuota=30%
''')
Path('/etc/systemd/system/fusion-management-directory-sync.timer').write_text('''[Unit]
Description=Refresh Fusion local directory every fifteen minutes
[Timer]
OnBootSec=5min
OnUnitInactiveSec=15min
RandomizedDelaySec=30s
Persistent=true
[Install]
WantedBy=timers.target
''')
subprocess.run(['systemctl','daemon-reload'],check=True)
# First run is finite; enable recurring refresh only after a verified successful import.
subprocess.run(['systemctl','start','--no-block','fusion-management-directory-sync.service'],check=True)
print(json.dumps({'sync_started':True,'timer_enabled':False,'root':str(root)}))
