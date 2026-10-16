from pathlib import Path
import subprocess,json,os,zipfile,shutil,pwd,grp,hashlib
r=Path('/opt/fusion-management-migration');assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
q=r/'delivery-qa';q.mkdir(exist_ok=True)
for p in r.glob('*.mjs'):shutil.copy2(p,q/p.name)
shutil.copy2(r/'home.html',q/'home.html')
shutil.copytree(r/'assets',q/'assets',dirs_exist_ok=True)
(q/'andreani/data').mkdir(parents=True,exist_ok=True)
shutil.copy2(r/'andreani/data/catalog.json',q/'andreani/data/catalog.json')
with zipfile.ZipFile(r/'delivery-release.zip') as z:
 for name in z.namelist():
  assert not name.startswith('/') and '..' not in Path(name).parts
 z.extractall(q)
for n in ['gateway.mjs','delivery.mjs','assets/facturador.js']:subprocess.run(['node','--check',str(q/n)],check=True,timeout=20)
subprocess.run(['node','--test','delivery.test.mjs','gateway.test.mjs','pos-vps.test.mjs','arca-transport.test.mjs','local-catalog.test.mjs'],cwd=q,check=True,timeout=90)
# Copy only mail transport values into a service-readable private file; never expose the application .env.
config=Path('/etc/fusion-management-delivery-mail.json')
if not config.exists():
 code="""const fs=require('fs');const {parseEnv}=require('node:util');const c=parseEnv(fs.readFileSync('/opt/fusionbikes/herramientas/.env','utf8'));if(!c.SMTP_HOST||!c.SMTP_USER||!c.SMTP_PASS||!c.SMTP_FROM||!['465','587','2525'].includes(c.SMTP_PORT))process.exit(3);fs.writeFileSync('/etc/fusion-management-delivery-mail.json',JSON.stringify({host:c.SMTP_HOST,port:Number(c.SMTP_PORT),user:c.SMTP_USER,pass:c.SMTP_PASS,from:c.SMTP_FROM}),{mode:0o640,flag:'wx'});"""
 subprocess.run(['node','-e',code],check=True,timeout=20)
 os.chown(config,0,grp.getgrnam('fusion-management-validation').gr_gid);config.chmod(0o640)
verify="import {smtpTransport} from './delivery.mjs';try{await smtpTransport().verify();console.log('SMTP authenticated with TLS; no message sent');}catch(e){console.error('SMTP verification failed: '+String(e.code||'connection'));process.exit(1)}"
subprocess.run(['runuser','-u','fusion-management-validation','--','node','--input-type=module','-e',verify],cwd=q,check=True,timeout=80)
print('DELIVERY_READY_NO_MESSAGES_SENT')
