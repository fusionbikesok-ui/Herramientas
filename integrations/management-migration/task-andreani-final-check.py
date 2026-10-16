from pathlib import Path
import json,sqlite3,stat,subprocess,urllib.request,urllib.error
r=Path('/opt/fusion-management-migration');p=Path('/var/lib/fusion-management-validation/andreani.sqlite');db=sqlite3.connect(f'file:{p}?mode=ro',uri=True)
counts={n:db.execute('SELECT COUNT(*) FROM '+n).fetchone()[0] for n in ['drafts','exports','batches']};activity=db.execute('SELECT created_at,by_user FROM batches ORDER BY created_at DESC LIMIT 3').fetchall();db.close()
checks={}
for name,url in [('anonymous_public','https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/andreani/'),('anonymous_local','http://127.0.0.1:8212/herramientas/gestion-vps/andreani/')]:
 try:urllib.request.urlopen(url,timeout=15);checks[name]=200
 except urllib.error.HTTPError as e:checks[name]=e.code
 assert checks[name]==401
checks.update(state_directory_mode=oct(stat.S_IMODE(p.parent.stat().st_mode)),state_file_mode=oct(stat.S_IMODE(p.stat().st_mode)),existing_records=counts,activity_metadata=activity,diagnostic_removed='andreani_csrf_check' not in (r/'gateway.mjs').read_text())
assert checks['state_directory_mode']=='0o700' and checks['state_file_mode']=='0o600' and checks['diagnostic_removed']
checks['service_active']=subprocess.run(['systemctl','is-active','--quiet','fusion-management-validation.service']).returncode==0
assert checks['service_active'];print(json.dumps(checks))
