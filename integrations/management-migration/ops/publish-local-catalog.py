from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess,sys,time,urllib.request,urllib.error
root=Path('/opt/fusion-management-migration');stage=Path(sys.argv[1]).resolve()
assert stage.parent==root and stage.name.startswith('catalog-stage-')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
names=json.loads((stage/'files.json').read_text())
assert all(not Path(n).is_absolute() and '..' not in Path(n).parts for n in names)
subprocess.run(['node','--test','gateway.test.mjs','local-catalog.test.mjs'],cwd=stage,check=True,timeout=30)
for name in ['assets/pos.js','assets/taller.js','assets/facturador.js']:
 subprocess.run(['node','--check',str(stage/name)],check=True,timeout=10)
subprocess.run(['docker','exec','-i','fusion-management-migration-php-1','php','-l'],input=(stage/'mu-plugins/fusion-management.php').read_bytes(),check=True,timeout=20)
backup=root/'backups'/('catalog-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(parents=True,mode=0o700)
existing=[]
for name in names:
 dest=root/name
 if dest.exists():
  target=backup/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(dest,target);existing.append(name)
for name in names:
 dest=root/name;dest.parent.mkdir(parents=True,exist_ok=True)
 temp=dest.with_name(dest.name+'.release');shutil.copyfile(stage/name,temp);temp.chmod(0o644);os.replace(temp,dest)
def restart():
 subprocess.run(['systemctl','restart','fusion-management-validation.service'],check=True,timeout=20)
 for attempt in range(20):
  try:urllib.request.urlopen('http://127.0.0.1:8212/herramientas/gestion-vps/',timeout=2)
  except urllib.error.HTTPError as error:
   if error.code==401:return
  except OSError:pass
  time.sleep(.25)
 raise RuntimeError('Gateway did not become ready')
try:restart()
except Exception:
 for name in existing:shutil.copy2(backup/name,root/name)
 restart();raise
report={'published':True,'backup':str(backup),'files':len(names),'tests':11,'catalog_source':'Existing GET /api/woo/catalogo and /api/consulta-precios/buscar (SQLite only)','main_application_restarted':False,'master_control_changed':False}
(root/'catalog-release.json').write_text(json.dumps(report,indent=2))
repo=Path('/opt/fusionbikes/herramientas')
for name in names:
 dest=repo/'integrations/management-migration'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/name,dest)
for module,line in {
 'ui-ux.md':'- Gestión VPS usa los tokens `theme.css`/`components.css` de Herramientas y `integrations/management-migration/assets/management.css` para entrada y envoltorios. Resultados de catálogo son tarjetas de consulta con cantidad registrada, SKU/GTIN, fecha por fila y precio web de referencia. Los JS adaptados existen sólo en el VPS; no se habilita agregar estos datos incompletos a ventas/facturas.',
 'integrations-ml-woo.md':'- Gestión VPS consulta `catalogo_cache` por `/api/woo/catalogo` y el contado por el lector local existente `/api/consulta-precios/buscar`, con identidad de producto validada, caché RAM 5 s y sesión/admin en cada solicitud. No usa listas ML ni consulta Woo por búsqueda. `precio` REST es proyectado: para FB-70394 era 6.675.000 (18 cuotas), mientras contado era 4.450.000, comprobado contra web y puente Master Control el 2026-10-04. Se reutiliza el criterio de Consulta de Precios (oferta vigente incluida), sin copiar coeficientes. Si no hay precio local válido se muestra faltante; no fallback a precio REST ni vencido. Sigue pendiente la paridad comercial completa del POS antes de cobrar. Imágenes HTTPS del catálogo, con fallback a padre; solicitudes estáticas, sin API Woo. Archivo ML visible en modo consulta, acotado a entorno/CUIT y único seller importado; OAuth y sincronización activa aún pendientes.',
 'operations-vps.md':f'- Catálogo local y estética de Gestión VPS publicados el 2026-10-04 (Argentina). Respaldos de gateway/MU/archivos previos en `{backup}`. Sólo se reinició `fusion-management-validation.service`; app principal, sincronizadores, tienda y Master Control sin cambios. Gateway/productos consumen loopback autenticado, sin credenciales Woo. Fuente versionable en `integrations/management-migration`; once pruebas HTTP/unitarias y lint PHP/JS. Falta conexión ML propia, validación comercial y corte operativo.'
}.items():
 p=repo/'docs/memory/modules'/module;s=p.read_text()
 if line not in s:p.write_text(s.rstrip()+'\n\n'+line+'\n')
print(json.dumps(report))
