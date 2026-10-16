from pathlib import Path
import shutil,json,subprocess
root=Path('/opt/fusion-management-migration');repo=Path('/opt/fusionbikes/herramientas');stage=root/'arca-production-stage';dest=repo/'integrations/management-migration'
assert (root/'.task-owner').read_text()=='fusion-management-migration-20261004'
release=json.loads((root/'arca-cutover-release.json').read_text());assert release['activation']['active'] is True
for name in ['gateway.mjs','home.html','compose.json','assets/facturador.js','mu-plugins/fusion-management.php','mu-plugins/fusion-arca-vps.php','mu-plugins/fusion-arca-credentials.php','mu-plugins/arca-adapter/woo-mirror.php','scripts/arca-outbox.php','scripts/arca-backup.py']:
 p=dest/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(root/name,p);p.chmod(0o644)
ops=dest/'arca';ops.mkdir(exist_ok=True)
for name in ['reconcile.php','fiscal-cutover.test.php','arca-source.py','arca-egress.py','README-ARCA.md']:
 shutil.copy2(stage/name,ops/name);(ops/name).chmod(0o644)
for name in ['cutover-reconcile.py','enable-production.py','test-draft-native.py']:
 shutil.copy2(root/('arca-task-'+name),ops/name);(ops/name).chmod(0o644)
for name in ['fixture.php','test-plan.php','test-wordpress.php']:
 shutil.copy2(stage/'adapter'/name,dest/'mu-plugins/arca-adapter'/name);(dest/'mu-plugins/arca-adapter'/name).chmod(0o644)
for name in ['arca-transport.test.mjs']:
 shutil.copy2(stage/'runtime'/name,dest/name);(dest/name).chmod(0o644)
client=Path('/var/lib/docker/volumes/fusion-management-migration_wp_data/_data/wp-content/plugins/fusion-facturacion-arca/includes/class-client.php');shutil.copy2(client,ops/'class-client.php');(ops/'class-client.php').chmod(0o644)
bridge=repo/'integrations/wordpress/fusion-herramientas-bridge';shutil.copy2(stage/'fiscal-cutover.php',bridge/'fiscal-cutover.php');(bridge/'fiscal-cutover.php').chmod(0o644)
header=bridge/'fusion-herramientas-bridge.php';text=header.read_text()
if "const VERSION = '0.3.1';" in text:
 text=text.replace('Version: 0.3.1','Version: 0.4.0').replace("const VERSION = '0.3.1';","const VERSION = '0.4.0';")
 text=text.replace("require_once __DIR__ . '/metrics-read.php';","require_once __DIR__ . '/metrics-read.php';\nrequire_once __DIR__ . '/fiscal-cutover.php';")
 header.write_text(text)
else:assert "const VERSION = '0.4.0';" in text,'Unexpected bridge version'
notes={
'operations-vps.md': '\n\n## Corte ARCA al VPS — 2026-10-05\n\nEmisión manual de producción habilitada en punto 15; origen detenido con bridge 0.4.0. Historial reconciliado: 172 comprobantes (+19), 14 series, 225 ventas ML y 6 WhatsApp; IDs/hashes y numeración ARCA iguales (A1/B14/NC_A0/NC_B1). Ninguna factura emitida en validación. Certificados de producción privados fuera del webroot; SOAP con TLS y egress restringido. Servicios fusion-arca-egress/source, outbox durable cada minuto y backup fiscal local diario (14 copias) activos. POS/Taller siguen consulta; ML/bulk/automáticos/correo/WhatsApp pendientes. Manual de operación, contratos y rollback seguro: integrations/management-migration/arca/README-ARCA.md. Backup corte: /opt/fusion-management-migration/backups/arca-cutover-20261005T235059Z. No reactivar origen ni restaurar DB antigua después de emitir sin conciliar CAEs.\n',
'integrations-ml-woo.md': '\n\n## ARCA manual en VPS — 2026-10-05\n\nEl VPS es el emisor manual del punto 15 y la tienda quedó bloqueada fiscalmente. Catálogo/precio contado/miniaturas locales; cada carga/emisión de pedido revalida Woo y materializa copia nativa privada sin hooks comerciales. CAE nuevo se archiva en origen y marca sólo metadatos fiscales/series, con outbox durable, ACK y backoff. No cambia precios, stock, checkout ni Master Control. Se preservaron 172 comprobantes y 225 registros ML; ML es todavía archivo de consulta, su conexión fiscal y emisión no están migradas. OAuth independiente del facturador: no compartir refresh token de la app principal. Referencia: integrations/management-migration/arca/README-ARCA.md.\n',
'ui-ux.md': '\n\n## Facturador VPS en producción — 2026-10-05\n\n/herramientas/gestion-vps/?fm_module=facturador muestra emisión manual activa punto15. Selección de variante y precio contado local, series de bicicletas, carga de pedido, borradores con revisión y PDF privado. Configuración sólo consulta, pruebas WSFE/Padrón operativas; botones ML/bulk/mensajería permanecen bloqueados y explican pendiente. Home de Gestión actualizado. Sesión/admin/Origin/CSRF verificadas y cuerpos fiscales firmados; sin parámetros de mutación por query. Formularios privados con campos en español; ninguna factura real durante QA.\n'
}
for name,note in notes.items():
 path=repo/'docs/memory/modules'/name;text=path.read_text()
 if note.splitlines()[2] not in text:path.write_text(text.rstrip()+note)
print('Fuentes y memoria canónicas actualizadas sin secretos; no commit ni push.')
