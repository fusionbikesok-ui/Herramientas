"""Publish the checked static Home link without restarting the application."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,urllib.request,zlib
root=Path('/opt/fusion-management-migration');repo=Path('/opt/fusionbikes/herramientas')
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
area=root/'home-navigation';result=json.loads((area/'result.json').read_text())
assert result['exit_code']==0 and result['success'] and result['numFailedTests']==0, 'Required test gate is not green'
home=repo/'public/home/index.html';candidate=(area/'candidate.html').read_bytes()
assert hashlib.sha256(home.read_bytes()).hexdigest()==result['original_sha256'], 'Home changed after preparation'
assert hashlib.sha256(candidate).hexdigest()==result['candidate_sha256']
assert len(zlib.compress(candidate))<20000, 'Home compressed size exceeds review budget'
for name in ['ui-ux.md','operations-vps.md']:
    src=repo/'docs/memory/modules'/name;shutil.copy2(src,area/('before-'+name))
tmp=home.with_name('index.html.migration-tmp');tmp.write_bytes(candidate);shutil.copystat(home,tmp);os.replace(tmp,home)
try:
    response=urllib.request.urlopen('http://127.0.0.1:3001/home/',timeout=10)
    served=response.read()
    assert response.status==200 and served==candidate, 'Static smoke failed'
except Exception:
    home.write_bytes((area/'before.html').read_bytes());raise
ui=repo/'docs/memory/modules/ui-ux.md';text=ui.read_text()
line='- La portada `/herramientas/home/` ofrece primero a administradores la tarjeta «Gestión VPS — POS, Facturador y Taller», enlazada a `/herramientas/gestion-vps/`. Indica «solo consulta» y que el historial copiado no se actualiza automáticamente; la operación sigue en la web habitual. Reutiliza tarjetas/estados y responsive de Home, sin alterar permisos ni el Taller previo.'
if line not in text:ui.write_text(text.rstrip()+'\n\n'+line+'\n')
ops=repo/'docs/memory/modules/operations-vps.md';text=ops.read_text()
line='- Acceso a Gestión VPS añadido a `public/home/index.html` el 2026-10-04 (Argentina), sólo como navegación de administradores. Publicación estática sin reinicio ni migraciones. Respaldo y candidato en `/opt/fusion-management-migration/home-navigation/{before,candidate}.html`; suite completa ejecutada en copia aislada sin red ni datos/credenciales de producción. Revertir sólo si el hash vigente sigue coincidiendo con `home-navigation/result.json`.'
if line not in text:ops.write_text(text.rstrip()+'\n\n'+line+'\n')
print(json.dumps({'published':True,'home_status':response.status,'sha256':hashlib.sha256(candidate).hexdigest(),'restart':False,'tests_passed':result['numPassedTests'],'backup':str(area/'before.html')}))
