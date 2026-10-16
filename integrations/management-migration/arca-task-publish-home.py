from pathlib import Path
import datetime,shutil,json
root=Path('/opt/fusion-management-migration');assert json.loads((root/'arca-cutover-release.json').read_text())['activation']['active'] is True
path=root/'home.html';before=path.read_text();after=before
pairs=[('POS, Facturador y Servicio técnico siguen en consulta: para vender, facturar o guardar trabajos, usá la tienda habitual.','Facturador ARCA permite emitir manualmente en producción, punto 15. POS y Servicio técnico siguen en consulta: para vender o guardar trabajos, usá la tienda habitual.'),('Revisá el historial de comprobantes y consultá productos del catálogo local.','Emití facturas y notas de crédito del punto 15, cargá pedidos y descargá los comprobantes. Mercado Libre sigue en consulta.')]
for old,new in pairs:
 assert after.count(old)==1,'Home changed; inspect before editing'
 after=after.replace(old,new)
backup=root/'backups'/('arca-home-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700);shutil.copy2(path,backup/'home.html');assert path.read_text()==before
temp=root/'home.html.arca-new';temp.write_text(after);temp.chmod(0o644);temp.replace(path);print('Home actualizado; backup '+str(backup))
