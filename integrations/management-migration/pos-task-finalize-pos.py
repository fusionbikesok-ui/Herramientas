from pathlib import Path
import hashlib,json,os,shutil,sqlite3,subprocess
r=Path('/opt/fusion-management-migration');stage=r/'pos-stage-v2';repo=Path('/opt/fusionbikes/herramientas');dest=repo/'integrations/management-migration'
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
for name in ['gateway.mjs','pos-vps.mjs','pos-vps.test.mjs','local-catalog.mjs','assets/pos.js','assets/catalog-ui.js','mu-plugins/fusion-management.php']:
 target=dest/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/name,target)
shutil.copy2(stage/'README-POS.md',dest/'README-POS.md')
bridge=dest/'pos-bridge';bridge.mkdir(exist_ok=True)
shutil.copy2(stage/'bridge-v2.php',bridge/'fusion-pos-vps-bridge.php')
assert '__FUSION_POS_VPS_KEY__' in (bridge/'fusion-pos-vps-bridge.php').read_text()
note='\n\n- 2026-10-06: POS VPS activado con puente seguro 0.2.0 en tienda. Catálogo/directorio locales y borrador SQLite por operador; checkout, precio final y pedido en origen, Master Control intacto. HMAC de cuerpo/tiempo, CSRF y operación idempotente; no liberar pedidos existentes. Recorrido FB-70394 ARS 4.450.000 comprobado hasta checkout, luego preparación liberada/tablero limpio; ningún pedido/pago/factura de prueba. 20 pruebas Node y controles PHP aprobados. ARCA continúa en producción punto15; restauradas sus rutas antes de activar POS. Presupuestos nuevos, conversión y cobros manuales siguen pendientes de traslado. Fuente y límites: integrations/management-migration/README-POS.md. Backup de activación pos-active-20261006T104541Z.\n'
for rel in ['docs/memory/modules/operations-vps.md','docs/memory/modules/integrations-ml-woo.md']:
 p=repo/rel;old=p.read_text()
 if 'POS VPS activado con puente seguro 0.2.0' not in old:p.write_text(old.rstrip()+note)
# Add a consistent SQLite snapshot to the existing private daily recovery backup.
script=r/'scripts/arca-backup.py';original=script.read_bytes()
expected='8554d930cba395fcc74a95d19bafe3e9f59d7321a75c008e7f0e2748f3740695'
assert hashlib.sha256(original).hexdigest()==expected,'Backup script changed; inspect before updating'
backup=r/'backups/pos-active-20261006T104541Z/arca-backup.py';backup.write_bytes(original);backup.chmod(0o600)
source=original.decode().replace('import datetime,gzip,hashlib,os,re,subprocess,tarfile,tempfile','import datetime,gzip,hashlib,os,re,sqlite3,subprocess,tarfile,tempfile')
source=source.replace(" pending=Path(task)/'archive.tar.gz'", " pos_snapshot=Path(task)/'pos.sqlite'\n pos_source=Path('/var/lib/fusion-management-validation/pos.sqlite')\n if pos_source.exists():\n  with sqlite3.connect('file:'+str(pos_source)+'?mode=ro',uri=True) as src, sqlite3.connect(pos_snapshot) as dst:src.backup(dst);assert dst.execute('PRAGMA quick_check').fetchone()[0]=='ok'\n pending=Path(task)/'archive.tar.gz'")
source=source.replace("  archive.add(sql,arcname='database.sql');", "  if pos_snapshot.exists():archive.add(pos_snapshot,arcname='state/pos.sqlite')\n  archive.add(sql,arcname='database.sql');")
source=source.replace("['runtime.env','compose.json'", "['gateway.env','gateway.mjs','pos-vps.mjs','assets/pos.js','assets/catalog-ui.js','runtime.env','compose.json'")
compile(source,str(script),'exec');script.write_text(source);script.chmod(0o700)
shutil.copy2(script,dest/'arca/arca-backup.py')
subprocess.run(['systemctl','start','fusion-arca-backup.service'],check=True,timeout=240)
state=Path('/var/lib/fusion-management-validation/pos.sqlite')
with sqlite3.connect('file:'+str(state)+'?mode=ro',uri=True) as db:
 assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
 drafts=[json.loads(row[0]) for row in db.execute('SELECT sale FROM drafts')]
 print(json.dumps({'local_database_ok':True,'drafts':len(drafts),'open_drafts':sum(bool(d.get('items') or d.get('operation')) for d in drafts),'released_operations':db.execute('SELECT count(*) FROM operations WHERE released=1').fetchone()[0]}))
print(json.dumps({'documented':True,'backup_timer':subprocess.check_output(['systemctl','is-active','fusion-arca-backup.timer'],text=True).strip(),'gateway':subprocess.check_output(['systemctl','is-active','fusion-management-validation.service'],text=True).strip(),'pos_snapshot_in_daily_backup':True}))
