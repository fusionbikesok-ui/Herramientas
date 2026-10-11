from pathlib import Path
import json,shutil,subprocess,sys
root=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve()
assert stage.parent==root and stage.name.startswith('metrics-stage-')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
subprocess.run(['python3',str(stage/'sync-metrics-test.py')],check=True,timeout=20)
for name in ['sync-metrics.py','sync-metrics-test.py','METRICS-PLAN.md']:
 shutil.copyfile(stage/name,root/name);(root/name).chmod(0o644)
Path('/etc/systemd/system/fusion-management-metrics-sync.service').write_text('''[Unit]
Description=Fusion local sales metrics snapshot
After=network-online.target fusion-management-directory-sync.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/fusion-management-migration/sync-metrics.py
User=root
Group=fusion-management-read
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/fusion-management-migration/directory-cache
TimeoutStartSec=3600
MemoryMax=256M
CPUQuota=30%
''')
Path('/etc/systemd/system/fusion-management-metrics-sync.timer').write_text('''[Unit]
Description=Refresh Fusion sales metrics every fifteen minutes
[Timer]
OnBootSec=7min
OnUnitInactiveSec=15min
RandomizedDelaySec=30s
Persistent=true
[Install]
WantedBy=timers.target
''')
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','start','--no-block','fusion-management-metrics-sync.service'],check=True)
print(json.dumps({'sync_started':True,'timer_enabled':False}))
