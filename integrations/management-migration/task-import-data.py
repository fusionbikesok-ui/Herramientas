import subprocess,os,json,datetime
from pathlib import Path
root=Path('/opt/fusion-management-migration');os.umask(0o077)
source=Path((root/'data/latest-path').read_text()).resolve()
assert source.is_relative_to((root/'data').resolve()) and (source/'manifest.json').is_file()
backup=root/'backups'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup.mkdir(parents=True,mode=0o700)
with (backup/'before-import.sql').open('wb') as out:
    result=subprocess.run(['docker','exec','fusion-management-migration-db-1','sh','-c','MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump --user=root --single-transaction "$MYSQL_DATABASE"'],stdout=out,stderr=subprocess.PIPE,timeout=60)
    if result.returncode:raise RuntimeError('Destination backup failed')
subprocess.run(['docker','cp',str(source)+'/.','fusion-management-migration-php-1:/tmp/fusion-management-import'],check=True,capture_output=True)
result=subprocess.run(['docker','exec','fusion-management-migration-php-1','php','/opt/fusion-scripts/import.php'],capture_output=True,text=True,timeout=120)
(root/'import-result.log').write_text(result.stdout+result.stderr)
if result.returncode:raise RuntimeError('Import failed; transaction rolled back, inspect import-result.log')
print(result.stdout)
print(json.dumps({'destination_backup':str(backup),'source':str(source),'shop_writes':False}))
