"""Local root-only recovery copy for the production fiscal database and credentials."""
from pathlib import Path
import datetime,gzip,hashlib,os,re,sqlite3,subprocess,tarfile,tempfile
root=Path('/opt/fusion-management-migration');assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004';os.umask(0o077)
dest=root/'backups/fiscal-daily';dest.mkdir(mode=0o700,exist_ok=True);dest.chmod(0o700)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');final=dest/('fiscal-'+stamp+'.tar.gz')
with tempfile.TemporaryDirectory(prefix='.fiscal-',dir=dest) as task:
 sql=Path(task)/'database.sql'
 with sql.open('wb') as output:
  r=subprocess.run(['docker','exec','fusion-management-migration-db-1','sh','-c','exec mysqldump --no-tablespaces --single-transaction --skip-comments -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'],stdout=output,stderr=subprocess.PIPE,timeout=180)
 if r.returncode or sql.stat().st_size<1000:raise RuntimeError('Fiscal backup failed')
 pos_snapshot=Path(task)/'pos.sqlite'
 pos_source=Path('/var/lib/fusion-management-validation/pos.sqlite')
 if pos_source.exists():
  with sqlite3.connect('file:'+str(pos_source)+'?mode=ro',uri=True) as src, sqlite3.connect(pos_snapshot) as dst:src.backup(dst);assert dst.execute('PRAGMA quick_check').fetchone()[0]=='ok'
 pending=Path(task)/'archive.tar.gz'
 with tarfile.open(pending,'w:gz') as archive:
  if pos_snapshot.exists():archive.add(pos_snapshot,arcname='state/pos.sqlite')
  archive.add(sql,arcname='database.sql');archive.add('/etc/fusion-arca-private',arcname='private')
  for name in ['gateway.env','gateway.mjs','pos-vps.mjs','assets/pos.js','assets/catalog-ui.js','runtime.env','compose.json','mu-plugins','scripts/arca-outbox.php','arca-cutover-release.json']:
   p=root/name
   if p.exists():archive.add(p,arcname='runtime/'+name)
 with tarfile.open(pending,'r:gz') as archive:
  names=archive.getnames();assert 'database.sql' in names and 'private/produccion.key' in names
 with gzip.open(pending,'rb') as stream:
  while stream.read(1024*1024):pass
 pending.chmod(0o600);pending.replace(final)
digest=hashlib.sha256(final.read_bytes()).hexdigest();final.with_suffix(final.suffix+'.sha256').write_text(digest+'  '+final.name+'\n')
# Delete only our dated backup files, only after a new archive has been verified.
archives=sorted(p for p in dest.iterdir() if p.is_file() and re.fullmatch(r'fiscal-\d{8}T\d{6}Z\.tar\.gz',p.name))
for old in archives[:-14]:
 assert old.resolve().parent==dest.resolve();old.unlink();old.with_suffix(old.suffix+'.sha256').unlink(missing_ok=True)
print('Fiscal recovery archive verified: '+final.name)
