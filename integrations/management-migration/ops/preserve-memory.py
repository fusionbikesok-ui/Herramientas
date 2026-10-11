from pathlib import Path
import shutil,json,hashlib
r=Path('/opt/fusion-management-migration');repo=Path('/opt/fusionbikes/herramientas')
assert (r/'.task-owner').read_text()=='fusion-management-migration-20261004'
target=repo/'integrations/management-migration';count=0
allowed=['Dockerfile','php-migration.ini','PLAN.md','README.md','gateway.mjs','gateway.test.mjs','local-catalog.mjs','local-catalog.test.mjs','home.html','CATALOG-PLAN.md','pull-data.mjs']
for name in allowed:
    source=r/name;out=target/name;out.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,out);count+=1
for directory in ['mu-plugins','scripts','ops','assets']:
    for source in (r/directory).glob('*'):
        if source.is_file() and source.suffix in ['.py','.php','.js','.css']:
            out=target/directory/source.name;out.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,out);count+=1
plan=repo/'docs/superpowers/plans/2026-10-04-pos-arca-taller-vps.md';shutil.copyfile(r/'PLAN.md',plan)
ops=repo/'docs/memory/modules/operations-vps.md';s=ops.read_text()
heading='## POS, Facturador y Taller: consulta en VPS (2026-10-04)'
section='''## POS, Facturador y Taller: consulta en VPS (2026-10-04)

- Runtime independiente `/opt/fusion-management-migration`, WordPress 7.1.2/WooCommerce 11.1.2/PHP 8.2 con SOAP y los tres ZIP actuales. Master Control no se instaló ni modificó. Fuente propia en `integrations/management-migration/`; plan `docs/superpowers/plans/2026-10-04-pos-arca-taller-vps.md`.
- Entrada `/herramientas/gestion-vps/`, sesión vigente de Herramientas y administrador en cada solicitud. Gateway systemd `fusion-management-validation.service`, 127.0.0.1:8212, firma HMAC interna. PHP/DB en red interna Docker, sin puertos publicados; escrituras HTTP, cron, correo y salida externa bloqueados. Requiere actualizar IP de PHP con `ops/start-gateway.py` si se recrea su red/contenedor.
- Historial copiado y conciliado por página/hash y por columna: 153 comprobantes, 14 series, 221 estados ML y 6 estados WhatsApp; 27 presupuestos; 1 trabajo y 1 modelo de Taller, 2 constancias, 0 recordatorios. Cinco borradores conservados para mapear operadores, todavía no asignados. No se copiaron contraseñas, sales ni certificados fiscales.
- Origen privado: `data/2026-10-04T23-06-05-446Z`; respaldo destino previo a importación `backups/20261005T004328Z/before-import.sql`; respaldo Nginx previo al nuevo location `backups/20261005T004439Z/herramientas.nginx.conf`, todos dentro del runtime. No se ensayó restauración completa ni se obtuvo snapshot de corte con origen bloqueado.
- Puente WordPress actualizado a 0.2.0. Los dos GET de exportación/inventario exigen `manage_options` además del permiso Woo y HTTPS; recursos fijados, 50 filas/página, sin credenciales. 61 comprobaciones PHP. Gateway: tres pruebas HTTP integradas y comprobación real de sesión, firma vencida, bloqueo de métodos y acceso anónimo. Tienda y Herramientas respondieron 200. No se reinició la app principal.
- Las pantallas originales permiten consultar Taller, comprobantes y presupuestos con la sesión de Herramientas. Se adaptaron navegación y tabla móvil de Taller sólo en el envoltorio del VPS. La copia consulta el catálogo sincronizado local con cantidades y fechas; faltan campos comerciales/clientes/pedidos para operar y sus controles de negocio están bloqueados. No atribuirle un corte productivo ni ahorro medido de carga.
- Pendientes: completar campos comerciales del catálogo, clientes/pedidos e identidades; precios de Master Control/dólares; checkout POS original e idempotencia; configuración/certificados ARCA y conexiones ML/WhatsApp; documentos y recordatorios; corte con un solo escritor/emisor y rollback ensayado. Se consultó por SSH/SFTP del hosting para transferir certificados por canal privado. Los módulos originales continúan como autoridad y Chat sigue en QA.
'''
end_marker='<!-- end management validation memory -->'
section=section+'\n'+end_marker+'\n'
if heading in s:
    start=s.index(heading);end=s.index(end_marker,start)+len(end_marker)
    s=s[:start]+section.rstrip()+s[end:]
else:s=s.rstrip()+'\n\n'+section
s=s.replace('`fusion-herramientas-bridge` 0.1.0 instalado y activo','`fusion-herramientas-bridge` instalado y activo (actualizado a 0.2.0 abajo)')
ops.write_text(s)
index=repo/'docs/superpowers/INDEX.md';s=index.read_text()
line='- `plans/2026-10-04-pos-arca-taller-vps.md`: migración autorizada; copia de consulta desplegada, corte operativo pendiente. No modifica la aceptación del programa E0–E26.'
if line not in s:index.write_text(s.rstrip()+'\n\n'+line+'\n')
print(json.dumps({'source_files_preserved':count,'memory':str(ops),'plan':str(plan),'secrets_copied':False}))
