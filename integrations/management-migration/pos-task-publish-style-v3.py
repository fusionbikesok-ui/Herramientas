from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess
r=Path('/opt/fusion-management-migration');stage=r/'pos-stage-v3'
assert hashlib.sha256((r/'assets/pos.js').read_bytes()).hexdigest()=='42b5cfd0b0743e062163158113564c30c8d4d9ca09a3155bf5ba1760df118e34'
assert (r/'assets/management.css').read_bytes()==(stage/'assets/management.css').read_bytes()
subprocess.run(['node','--check',str(r/'pos-v3-styled.js')],check=True)
backup=r/'backups'/('pos-style-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
for name,source in [('assets/pos.js','pos-v3-styled.js'),('assets/management.css','pos-v3-styled.css')]:
 shutil.copy2(r/name,backup/Path(name).name);os.replace(r/source,r/name)
repo=Path('/opt/fusionbikes/herramientas');dest=repo/'integrations/management-migration'
for name in ['gateway.mjs','pos-vps.mjs','pos-vps.test.mjs','assets/pos.js','assets/management.css','mu-plugins/fusion-management.php']:
 target=dest/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/name,target)
bridge=(r/'pos-source-v3.php').read_text();assert '__FUSION_POS_VPS_KEY__' in bridge
(dest/'pos-bridge/fusion-pos-vps-bridge.php').write_text(bridge)
note='''

## POS VPS 0.3.0 — cuotas y factura integrada (2026-10-06)

El puente POS 0.3.0 conserva Master Control sin modificaciones. Busca productos/clientes en el VPS y consulta por HMAC las condiciones de los productos seleccionados: contado, promoción elegible y 3/6/9/12/18/24 cuotas, con caché de 60 segundos por canasta. No usa precios MercadoLibre. La preparación revalida plan e importe revisado; conserva la operación idempotente. El checkout abre completo, sin fbpos_embed, para que funcione el selector original de Master Control y conserve el plan elegido.

El POS permite recuperar un pedido de su operador, confirmar explícitamente dinero recibido para medios manuales y registrar retiro/envío usando los métodos del POS original. El puente verifica actor firmado, identidad del operador original, capacidades vigentes y propiedad del pedido. No confirma automáticamente pagos ni modifica pedidos de otro operador. Después del cobro y entrega abre ARCA VPS dentro del POS; emitir sigue siendo una acción manual del operador en producción, punto 15. No se reactiva la emisión fiscal en la tienda.

GET /fbpos/v2/session renueva CSRF después de autenticar al administrador. El frontend reintenta una sola vez exclusivamente ante pos_csrf, rechazado antes de ejecutar acciones. Un error de red o de emisión no dispara reintentos ciegos.

Validación: 22 pruebas Node, controles PHP del puente y sintaxis; interfaz aislada confirmó renovación CSRF y conservación del plan/importe. Checkout real verificado hasta el selector de seis cuotas y campos de tarjeta; preparación liberada, carrito de prueba vacío, sin crear pedido, cobrar ni emitir factura. Editor fiscal integrado verificado en lectura. Pedidos existentes conservados. Presupuestos nuevos, USD desde la vista previa, Posnet y cobros combinados continúan fuera de esta entrega.

Rollback de esta entrega: backups/pos-flow-20261006T125212Z contiene los archivos previos; la tienda puede conservar el puente 0.3.0 porque admite preparaciones antiguas de contado. Los respaldos siguientes pos-flow-ui y pos-style contienen los ajustes de presentación. No restaurar ni desactivar el gateway fiscal antiguo para revertir únicamente POS.
'''
p=dest/'README-POS.md';p.write_text(p.read_text().rstrip()+note)
memory='\n\n- 2026-10-06: POS VPS 0.3.0 restaura comparación previa de cuotas, checkout completo con plan seleccionado y cobro manual/entrega delegados al POS original antes del facturador ARCA integrado. Master Control intacto; búsquedas locales, cotización HMAC por canasta con caché 60s y revalidación al preparar. Recuperación de pedidos vinculada a actor. Renovación CSRF autenticada y reintento solo si pos_csrf. Ver integrations/management-migration/README-POS.md para contratos, validación y límites.\n'
for rel in ['docs/memory/modules/operations-vps.md','docs/memory/modules/integrations-ml-woo.md']:
 p=repo/rel;old=p.read_text()
 if 'POS VPS 0.3.0 restaura' not in old:p.write_text(old.rstrip()+memory)
print(json.dumps({'styles_published':True,'sources_preserved':True,'memory_updated':True,'backup':str(backup)}))
