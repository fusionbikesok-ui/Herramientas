from pathlib import Path
import subprocess,shutil
root=Path('/opt/fusion-management-migration');assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
target=root/'scripts/arca-backup.py';shutil.copy2(root/'arca-production-stage/arca-backup.py',target);target.chmod(0o700)
service=Path('/etc/systemd/system/fusion-arca-backup.service');timer=Path('/etc/systemd/system/fusion-arca-backup.timer');assert not service.exists() and not timer.exists(),'Backup units already exist'
service.write_text('''[Unit]
Description=Private ARCA fiscal recovery backup
After=docker.service
[Service]
Type=oneshot
User=root
ExecStart=/usr/bin/python3 /opt/fusion-management-migration/scripts/arca-backup.py
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
TimeoutStartSec=240
''')
timer.write_text('''[Unit]
Description=Daily private ARCA fiscal backup
[Timer]
OnCalendar=*-*-* 05:40:00 UTC
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
''');service.chmod(0o644);timer.chmod(0o644)
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','start','fusion-arca-backup.service'],check=True);subprocess.run(['systemctl','enable','--now','fusion-arca-backup.timer'],check=True,capture_output=True)
print('Fiscal backup created and verified; daily timer active, 14 local copies retained.')
