from pathlib import Path
import subprocess,datetime,shutil
root=Path('/opt/fusion-management-migration');stage=root/'arca-production-stage';assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
backup=root/'backups'/('arca-helper-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
for src,dest in [('fusion-arca-vps.php',root/'mu-plugins/fusion-arca-vps.php'),('arca-outbox.php',root/'scripts/arca-outbox.php'),('arca-source.py',Path('/opt/fusion-arca-egress/arca-source.py'))]:
 shutil.copy2(dest,backup/dest.name);temp=dest.with_suffix('.tmp');temp.write_bytes((stage/src).read_bytes());temp.chmod(0o644);temp.replace(dest)
unit=Path('/etc/systemd/system/fusion-arca-source.service');shutil.copy2(unit,backup/unit.name);s=unit.read_text()
if 'SupplementaryGroups=' not in s:unit.write_text(s.replace('DynamicUser=yes','DynamicUser=yes\nSupplementaryGroups=fusion-management-read'))
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','fusion-arca-source.service'],check=True)
print('Helpers updated; production remains disabled; backup '+str(backup))
