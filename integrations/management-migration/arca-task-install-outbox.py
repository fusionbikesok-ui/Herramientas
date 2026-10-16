from pathlib import Path
import subprocess,shutil
root=Path('/opt/fusion-management-migration');assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
source=root/'arca-production-stage/arca-outbox.php';assert source.is_file()
target=root/'scripts/arca-outbox.php';shutil.copy2(source,target);target.chmod(0o644)
unit=Path('/etc/systemd/system/fusion-arca-outbox.service');timer=Path('/etc/systemd/system/fusion-arca-outbox.timer')
assert not unit.exists() and not timer.exists(),'Outbox already installed'
unit.write_text('''[Unit]
Description=Synchronize authorized Fusion ARCA invoices to shop archive
After=docker.service fusion-arca-source.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/docker exec -u www-data fusion-management-migration-php-1 php /opt/fusion-scripts/arca-outbox.php
TimeoutStartSec=300
Nice=10
''');unit.chmod(0o644)
timer.write_text('''[Unit]
Description=Retry pending Fusion ARCA archive synchronization
[Timer]
OnBootSec=60
OnUnitInactiveSec=60
AccuracySec=10
[Install]
WantedBy=timers.target
''');timer.chmod(0o644)
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','enable','--now','fusion-arca-outbox.timer'],check=True,capture_output=True)
print('Outbox timer installed; no emission action exists in worker')
