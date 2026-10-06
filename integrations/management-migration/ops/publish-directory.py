from pathlib import Path
import datetime,hashlib,json,os,shutil,sqlite3,subprocess,sys,time,urllib.request,urllib.error
root=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve()
assert stage.parent==root and stage.name.startswith('directory-stage-')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
baseline=json.loads((stage/'baseline.json').read_text(encoding='utf-8-sig'))
for name,sha in baseline.items():assert hashlib.sha256((root/name).read_bytes()).hexdigest()==sha,'Concurrent change: '+name
subprocess.run(['node','--test','gateway.test.mjs','local-catalog.test.mjs','directory.test.mjs'],cwd=stage,check=True,timeout=40)
subprocess.run(['python3',str(stage/'sync-directory-test.py')],check=True,timeout=30)
for name in ['assets/directory.js','assets/catalog-ui.js']:
 subprocess.run(['node','--check',str(stage/name)],check=True,timeout=10)
db=sqlite3.connect(f'file:{root}/directory-cache/directory.sqlite?mode=ro',uri=True)
assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
customers=db.execute('SELECT COUNT(*) FROM customers').fetchone()[0]
assert customers>0;db.close()
names=[n for n in json.loads((stage/'files.json').read_text()) if not n.startswith('ops/')]
backup=root/'backups'/('directory-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
existing=[]
for name in names:
 if (root/name).exists():
  dest=backup/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/name,dest);existing.append(name)
drop=Path('/etc/systemd/system/fusion-management-validation.service.d');drop.mkdir(exist_ok=True)
group_file=drop/'directory-read.conf'
if group_file.exists():shutil.copy2(group_file,backup/'directory-read.conf')
group_file.write_text('[Service]\nSupplementaryGroups=fusion-management-read\n')
def restart():
 subprocess.run(['systemctl','daemon-reload'],check=True)
 subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=25)
 for _ in range(30):
  try:urllib.request.urlopen('http://127.0.0.1:8212/herramientas/gestion-vps/directory/api?kind=status',timeout=2)
  except urllib.error.HTTPError as e:
   if e.code==401:return
  except OSError:pass
  time.sleep(.25)
 raise RuntimeError('gateway_not_ready')
try:
 for name in names:
  dest=root/name;dest.parent.mkdir(parents=True,exist_ok=True);temp=dest.with_name(dest.name+'.release');shutil.copyfile(stage/name,temp);temp.chmod(0o644);os.replace(temp,dest)
 restart()
 # The DynamicUser must be able to read the cache, without Woo credentials.
 subprocess.run(['runuser','-u','fusion-management-validation','-g','fusion-management-read','--','node','--input-type=module','-e',"import {createDirectory} from '/opt/fusion-management-migration/directory.mjs';const s=createDirectory()({kind:'status'});if(!s.counts.customers)process.exit(1);console.log(JSON.stringify({directory_readable:true,counts:s.counts}));"],check=True,timeout=15)
except Exception:
 for name in existing:shutil.copy2(backup/name,root/name)
 if (backup/'directory-read.conf').exists():shutil.copy2(backup/'directory-read.conf',group_file)
 else:group_file.unlink(missing_ok=True)
 restart();raise
subprocess.run(['systemctl','enable','--now','fusion-management-directory-sync.timer'],check=True,timeout=15)
report={'published':True,'backup':str(backup),'customers':customers,'tests_node':17,'tests_python':5,'main_application_restarted':False,'master_control_changed':False,'directory':'/herramientas/gestion-vps/directory/','history_may_still_be_loading':True}
(root/'directory-release.json').write_text(json.dumps(report,indent=2))
repo=Path('/opt/fusionbikes/herramientas')
for name in names:
 dest=repo/'integrations/management-migration'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/name,dest)
for module,line in {
 'ui-ux.md':'- Gestión VPS tiene directorio compartido `/herramientas/gestion-vps/directory/`: búsqueda local de clientes registrados/invitados y pedidos históricos, origen Woo/espejo ML, fecha y cobertura de sincronización. Usa tokens existentes y controles de 44 px. Accesos desde inicio de Gestión y banners POS/ARCA/Taller. Los GET de clientes POS/Taller usan IDs de la tienda; no habilitar escrituras hasta mapearlos con las identidades del runtime.',
 'integrations-ml-woo.md':'- Índice reconstruible `directory-cache/directory.sqlite` en el runtime privado de migración: clientes Woo con rol customer y pedidos Woo, JSON con lista explícita de campos, sin contraseñas/roles/credenciales ni metadatos arbitrarios. Invitados vinculados por pedido, nunca por nombre. Una copia Woo de ML queda marcada con `_ml_order_id`; no sumar como segunda venta. Consentimiento comercial desconocido. Las consultas no llaman a Woo. POS/Taller comparten GET clientes; ARCA accede al directorio. Esto no sustituye los escritores originales, los leads del chat ni la captura de carritos. Panel de ventas requiere detalle de devoluciones por ítem y taxonomías para equivalencia completa.',
 'operations-vps.md':f'- Directorio compartido publicado 2026-10-05. Respaldo `{backup}`; sólo se reinició gateway de validación. `fusion-management-directory-sync.service` hace GET con credenciales Woo preexistentes; timer cada 15 min para pedidos modificados con solapamiento 10 min, clientes cada 24 h y conciliación completa semanal. Descarga histórica con checkpoints privados y reanudación; primero publica clientes y marca pedidos incompletos, luego publica historial completo atómicamente. Gateway DynamicUser lee mediante grupo limitado `fusion-management-read`; credenciales siguen fuera. Última copia válida ante fallo. Pruebas 17 Node y 5 Python (incluye interrupción/reanudación), sintaxis JS y control de lectura bajo cuenta del gateway. Ver `directory-cache/status.json` para cobertura actual; no inferir fin de carga de la publicación de UI.'
}.items():
 p=repo/'docs/memory/modules'/module;p.write_text(p.read_text().rstrip()+'\n\n'+line+'\n')
print(json.dumps(report))
