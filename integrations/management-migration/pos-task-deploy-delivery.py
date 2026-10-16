from pathlib import Path
import subprocess,hashlib,datetime,json,shutil,urllib.request,urllib.error,os
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
baseline={'gateway.mjs':'b01e0e87c0fe97cbdcbc2c8fe27d8a7c21f587d6d0d13bc018ea918e52e71238','assets/facturador.js':'6f044ce556fd2f4bd1460f27fca9a84be950786d4225aba1a5c5e305fc519502','assets/management.css':'1bc76e5f23cbffe7647bbade90025cf4b30c6d6237244cecd224f5c8f0807577'}
for n,digest in baseline.items():assert hashlib.sha256((r/n).read_bytes()).hexdigest()==digest,'Live file changed: '+n
protected={n:hashlib.sha256((r/n).read_bytes()).hexdigest() for n in ['mu-plugins/fusion-management.php','mu-plugins/fusion-arca-vps.php','pos-vps.mjs','assets/pos.js']}
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup=r/'backups'/('arca-delivery-'+stamp);backup.mkdir(mode=0o700)
names=list(baseline)+['delivery.mjs','delivery.test.mjs','arca-transport.test.mjs']
existed=[]
for n in names+['scripts/arca-backup.py']:
 if (r/n).exists():(backup/n).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/n,backup/n);existed.append(n)
try:
 for n in names:
  staged=(r/n).with_name(Path(n).name+'.delivery-new');shutil.copy2(r/'delivery-qa'/n,staged);staged.chmod(0o644);staged.replace(r/n)
 script=r/'scripts/arca-backup.py';s=script.read_text()
 assert 'delivery_snapshot' not in s
 s=s.replace(" pending=Path(task)/'archive.tar.gz'", " delivery_snapshot=Path(task)/'delivery.sqlite'\n delivery_source=Path('/var/lib/fusion-management-validation/delivery.sqlite')\n if delivery_source.exists():\n  with sqlite3.connect('file:'+str(delivery_source)+'?mode=ro',uri=True) as src, sqlite3.connect(delivery_snapshot) as dst:src.backup(dst);assert dst.execute('PRAGMA quick_check').fetchone()[0]=='ok'\n pending=Path(task)/'archive.tar.gz'")
 s=s.replace("  if pos_snapshot.exists():", "  if delivery_snapshot.exists():archive.add(delivery_snapshot,arcname='state/delivery.sqlite')\n  archive.add('/etc/fusion-management-delivery-mail.json',arcname='delivery-mail.json')\n  if pos_snapshot.exists():")
 s=s.replace("'gateway.env','gateway.mjs'", "'gateway.env','delivery.mjs','assets/facturador.js','assets/management.css','gateway.mjs'")
 compile(s,str(script),'exec');script.write_text(s)
 subprocess.run(['systemctl','restart','fusion-management-validation'],check=True,timeout=25)
 subprocess.run(['systemctl','is-active','fusion-management-validation'],check=True,timeout=15)
 import time
 for attempt in range(15):
  try:
   urllib.request.urlopen('http://127.0.0.1:8212/herramientas/gestion-vps/',timeout=3)
  except urllib.error.HTTPError as e:
   if e.code==401:break
   raise
  except urllib.error.URLError:
   time.sleep(.3)
 else:raise RuntimeError('Gateway did not start')
 for n,digest in protected.items():assert hashlib.sha256((r/n).read_bytes()).hexdigest()==digest
 print(json.dumps({'deployed':names,'backup':str(backup),'protected_modules_unchanged':True,'smtp_messages_sent':0}))
except:
 for n in names+['scripts/arca-backup.py']:
  if n in existed:shutil.copy2(backup/n,r/n)
  elif (r/n).exists():(r/n).unlink()
 subprocess.run(['systemctl','restart','fusion-management-validation'],timeout=25)
 raise
