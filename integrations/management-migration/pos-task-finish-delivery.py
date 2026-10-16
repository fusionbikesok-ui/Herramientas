from pathlib import Path
import shutil,subprocess,hashlib,datetime
r=Path('/opt/fusion-management-migration');c=Path('/opt/fusionbikes/herramientas/integrations/management-migration')
backup=r/'backups/arca-delivery-20261006T133734Z'
for n in ['gateway.mjs','assets/facturador.js','assets/management.css']:
 assert (c/n).read_bytes()==(backup/n).read_bytes(),'Canonical code changed: '+n
assert hashlib.sha256((c/'scripts/arca-backup.py').read_bytes()).hexdigest()=='8554d930cba395fcc74a95d19bafe3e9f59d7321a75c008e7f0e2748f3740695'
shutil.copy2(c/'scripts/arca-backup.py',backup/'canonical-arca-backup.py')
for n in ['gateway.mjs','assets/facturador.js','assets/management.css','scripts/arca-backup.py','delivery.mjs','delivery.test.mjs','arca-transport.test.mjs']:
 (c/n).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/n,c/n)
readme='''# Entrega manual de comprobantes en el VPS

Disponible desde 2026-10-06: Facturador → Comprobantes → Abrir → Enviar comprobante. También aparece para una factura autorizada abierta desde POS. Se pueden compartir comprobantes autorizados y sin CAE; los borradores y estados inciertos de emisión no se entregan.

- Email: PDF nativo adjunto, dirección revisable y confirmación antes de enviar. El transporte SMTP existente de Herramientas autentica con TLS; configuración privada seleccionada en `/etc/fusion-management-delivery-mail.json`, root/grupo del gateway 0640. La dependencia nodemailer se resuelve en `/opt/fusionbikes/herramientas/node_modules`. No hay credenciales en este repositorio ni nuevas salidas de WordPress.
- WhatsApp: prepara un enlace wa.me; el operador revisa el contacto y confirma el mensaje dentro de WhatsApp. No es Cloud API ni envío automático. Teléfono internacional con código de país, o vacío para elegir contacto.
- Enlace al PDF válido por siete días. Solo la ruta `/herramientas/gestion-vps/facturador/comprobante/<token>` admite descarga sin sesión: token aleatorio de 256 bits, guardado únicamente como SHA-256, vencimiento comprobado, PDF inmutable en SQLite privada, sin caché ni indexación. El adjunto de email no vence.
- `delivery.mjs` atiende email/share/estado; el gateway exige administrador actual, Origin y CSRF. Sólo la descarga con token es pública. La lectura del comprobante y la generación PDF nativa usan GET firmados hacia el WordPress aislado. No se habilitan REST mail/share nativos, configuración fiscal, automatismos, ML ni WhatsApp API.
- Estado durable en `/var/lib/fusion-management-validation/delivery.sqlite`. UUID de solicitud evita reenvío por repetición; exclusión y espera mínima de un minuto por comprobante/destinatario incluso entre operadores. Resultado SMTP incierto detiene el reintento hasta revisión explícita. “Aceptado por servidor” no equivale a entregado. Las solicitudes antiguas en curso se muestran inciertas luego de dos minutos.
- Backup fiscal diario ampliado con snapshot consistente delivery.sqlite, módulo/UI y configuración SMTP privada dentro del archivo root-only. Conservar estado de entrega al revertir código. El respaldo local no sustituye una copia externa.

Validación: 31 pruebas Node de entrega/gateway/ARCA/POS/catálogo; SMTP autenticado con TLS sin enviar mensajes; lectura de factura autorizada y PDF nativo; ruta pública HTTPS probada únicamente con PDF sintético y token de prueba retirado; UI real con consulta de estado y cancelación de confirmación. No se enviaron correos/WhatsApp a clientes ni se emitieron facturas de prueba. La entrega efectiva a una casilla real no se probó.

Runtime `/opt/fusion-management-migration`, servicio `fusion-management-validation`. Backup anterior: `backups/arca-delivery-20261006T133734Z`. Para revertir esta entrega restaurar sólo gateway, facturador.js y management.css de ese respaldo y reiniciar el gateway. Mantener delivery.sqlite/configuración para auditoría y futuras entregas; no restaurar base fiscal, reactivar emisión en origen ni cambiar Master Control.
'''
(c/'README-DELIVERY.md').write_text(readme)
main=c/'README.md';s=main.read_text();intro='''Estado vigente de entrega de comprobantes: email con PDF adjunto y WhatsApp manual disponibles en el VPS desde 2026-10-06. Ver [README-DELIVERY.md](README-DELIVERY.md). Los apartados de preparación histórica que indican correo/WhatsApp pendientes no describen esta entrega. POS operativo: [README-POS.md](README-POS.md); emisión fiscal: [arca/README-ARCA.md](arca/README-ARCA.md).

''';main.write_text(intro+s)
arca=c/'arca/README-ARCA.md'
if arca.exists():arca.write_text('Entrega manual de comprobantes habilitada en el VPS desde 2026-10-06: ver [README-DELIVERY.md](../README-DELIVERY.md). SMTP con PDF adjunto y WhatsApp por mensaje preparado; automáticos/API siguen deshabilitados.\n\n'+arca.read_text())
memory=Path('/opt/fusionbikes/herramientas/docs/memory/modules/operations-vps.md');s=memory.read_text();s=s.replace('ML/bulk/automáticos/correo/WhatsApp pendientes.','ML/bulk y automáticos pendientes. Correo y WhatsApp manual disponibles desde la actualización del 2026-10-06.')
s+='''

- 2026-10-06: Entrega manual recuperada en facturador VPS: email con PDF adjunto mediante SMTP existente (TLS verificado, confirmación de destinatario) y WhatsApp wa.me con enlace PDF siete días. Módulo Node delivery.mjs; persistencia privada delivery.sqlite, UUID/exclusión por comprobante/destinatario entre operadores, resultado incierto sin reintento automático. Solo descarga por token aleatorio expirable es pública; email/share/estado requieren administrador y escrituras Origin/CSRF. PDF nativo vía GET firmado, WordPress conserva bloqueo de correo/red genéricos. Backup fiscal incluye snapshot entrega/configuración SMTP privada. Validación funcional sin comunicaciones a clientes; entrega real de correo no probada. Contratos y rollback: integrations/management-migration/README-DELIVERY.md. Master Control y emisión ARCA sin cambios.
''';memory.write_text(s)
subprocess.run(['python3',str(r/'scripts/arca-backup.py')],check=True,timeout=180)
print('Canonical source and related operations memory updated; recovery backup verified')
