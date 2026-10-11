## Operación vigente POS y ARCA — regreso a la web, 2026-10-06

POS y Facturador ARCA vuelven a operar exclusivamente en fusionbikes.com.ar, por decisión del usuario. Herramientas ofrece accesos directos; los informes, directorio y etiquetas Andreani/corrector PDF permanecen en el VPS. Los enlaces antiguos ?fm_module=pos/facturador redirigen a la web. El gateway con FUSION_SALES_LOCATION=web bloquea las API antiguas de POS, facturación y envíos manuales del VPS; los enlaces PDF ya compartidos conservan su vigencia original.

Antes de habilitar la web se deshabilitó fusion_arca_vps_enabled y production_enabled en la copia privada y FUSION_POS_VPS_ENABLED en gateway.env; se conciliaron 173 comprobantes, 14 series, 225 ventas ML y 6 registros WhatsApp sin diferencias fiscales. La factura nueva 173/pedido 70706 ya estaba archivada en Woo. Numeración confirmada con ARCA: punto 15 A1/B15/NC_A0/NC_B1; punto16 A7/B135/NC_A0/NC_B0. Ningún pendiente ni CAE solicitado durante las pruebas. El autor del recibo 173 es 0 en la tienda por el contrato del archivo original.

En la web fusion_arca_vps_cutover queda vacío, respaldado junto con settings/ML en opciones fusion_return_web_20261006_*. La emisión manual del punto15 está habilitada y el usuario autorizó recuperar el automatismo ML del punto16. La automatización web por cambio de estado conserva su pausa. Certificados originales y conexión Meta for WooCommerce permanecen en la web. No se cambió Master Control ni precios.

Servicios privados VPS fusion-arca-egress/source y timer outbox detenidos y deshabilitados. El backup fiscal diario conserva el archivo y los borradores/operaciones anteriores. Respaldo del regreso: /opt/fusion-management-migration/backups/return-web-20261006T184545Z. No volver a habilitar VPS ni restaurar una base antigua después de nuevas emisiones web sin otro corte y conciliación. Historial anterior de migración que contradiga esta sección queda superado.



Verificación del regreso: 33 pruebas focalizadas de gateway, desvíos, bloqueo de API, POS, catálogo, transporte fiscal y entrega aprobadas en copia aislada sin credenciales productivas. UI real: WordPress WSFE y Padrón conectados; POS encuentra FB-70394 con stock1/contado ARS4.450.000 y ofrece 3/6/9/12/18/24 cuotas antes del cobro. Se retiró el producto de prueba, borrador web guardado vacío; no se creó un pedido ni se solicitó CAE de prueba. SQL confirmó ML enabled/automatic true, punto16, producción web true; tareas ML recientes completas. Informes VPS cargan 10.140 líneas y Andreani consulta el historial sincronizado. No se probó un envío real de correo/WhatsApp ni un cobro. Las 33 pruebas no constituyen la suite completa del proyecto.

## Archivo del traslado anterior

# POS VPS activo — 2026-10-06

Entrada: https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/?fm_module=pos

Productos, stock, precios de referencia y clientes se consultan en el catálogo/directorio sincronizado del VPS. Borradores versionados por operador y operaciones se guardan en `/var/lib/fusion-management-validation/pos.sqlite`. El pedido, su validación de stock, precio definitivo y pago se completan en el checkout original de WooCommerce; Master Control no fue modificado.

El plugin de origen `fusion-pos-vps-bridge` versión 0.2.0 está activo. Recibe comandos HMAC del gateway, con firma ligada al cuerpo y tiempo, operación UUID e identidad del operador. Devuelve un enlace aleatorio sin datos personales en la URL. Abrirlo requiere una sesión de gestión en la tienda. Usa los controles nativos del POS, con registro de operación en su formato original, reutilización del mismo pedido y bloqueo de liberación si ya existe. El navegador conserva CSRF y sesión administrador de Herramientas para las escrituras del VPS.

Las condiciones de cuotas/dólares y los medios de pago se eligen en el checkout. Presupuestos nuevos/conversión, cobros manuales Posnet/combinados y edición de pedidos siguen pendientes de traslado; no se habilitan escritores parciales para esas funciones. Los datos de un cliente nuevo cargados aquí pertenecen a la venta; no crean una cuenta de Woo antes del checkout. El botón de facturar abre el facturador de producción del VPS tras confirmar el pago.

Verificado: 20 pruebas Node de POS, gateway, catálogo y transporte ARCA; pruebas PHP de firma, propietario, idempotencia, protección de pedidos y formato nativo. Recorrido real: FB-70394, una unidad y ARS 4.450.000 tanto en el VPS como en el checkout, con miniatura y métodos originales. Se liberó la preparación y limpió el borrador; no se confirmó un pedido, pago ni factura de prueba. El facturador conservó `fusion_arca_vps_enabled=true`, producción activa y la UI del punto 15. Esta comprobación no prueba un cobro real ni declara verde la suite completa del proyecto.

## Publicación y recuperación

Runtime: `/opt/fusion-management-migration`. Se restauraron primero las rutas fiscales de producción que una preparación anterior del POS había reemplazado por la versión de consulta. No volver a publicar el antiguo `deploy_pos_vps.py` ni un gateway previo al corte ARCA.

Respaldo previo: `/opt/fusion-management-migration/backups/pos-active-20261006T104541Z`. Corrección de presentación/confirmaciones: `backups/pos-ui-20261006`. Sólo se reinició `fusion-management-validation.service` durante la activación; el cambio visual posterior no requirió reinicios.

Para deshabilitar únicamente POS: poner `FUSION_POS_VPS_ENABLED=0` en `gateway.env`, `fusion_pos_vps_enabled=false` en la copia privada y reiniciar el gateway. Conservar los datos locales y el plugin de origen para consultar operaciones pendientes. No restaurar una base fiscal, no retirar el corte ARCA ni modificar Master Control como parte de un rollback POS.

El código del puente guardado en el repositorio contiene un marcador, nunca su secreto. El ZIP instalado y `gateway.env` son privados. Las copias locales del VPS requieren respaldo externo para cubrir pérdida del servidor.

Cierre POS 2026-10-06: respaldo diario privado ampliado con snapshot consistente pos.sqlite/configuración gateway y primera ejecución verificada; borrador limpio y operación de prueba liberada. Contraste de tarjetas corregido con variables del tema; confirmaciones internas permiten limpiar/liberar la preparación.

## POS VPS 0.3.0 — cuotas y factura integrada (2026-10-06)

El puente POS 0.3.0 conserva Master Control sin modificaciones. Busca productos/clientes en el VPS y consulta por HMAC las condiciones de los productos seleccionados: contado, promoción elegible y 3/6/9/12/18/24 cuotas, con caché de 60 segundos por canasta. No usa precios MercadoLibre. La preparación revalida plan e importe revisado; conserva la operación idempotente. El checkout abre completo, sin fbpos_embed, para que funcione el selector original de Master Control y conserve el plan elegido.

El POS permite recuperar un pedido de su operador, confirmar explícitamente dinero recibido para medios manuales y registrar retiro/envío usando los métodos del POS original. El puente verifica actor firmado, identidad del operador original, capacidades vigentes y propiedad del pedido. No confirma automáticamente pagos ni modifica pedidos de otro operador. Después del cobro y entrega abre ARCA VPS dentro del POS; emitir sigue siendo una acción manual del operador en producción, punto 15. No se reactiva la emisión fiscal en la tienda.

GET /fbpos/v2/session renueva CSRF después de autenticar al administrador. El frontend reintenta una sola vez exclusivamente ante pos_csrf, rechazado antes de ejecutar acciones. Un error de red o de emisión no dispara reintentos ciegos.

Validación: 22 pruebas Node, controles PHP del puente y sintaxis; interfaz aislada confirmó renovación CSRF y conservación del plan/importe. Checkout real verificado hasta el selector de seis cuotas y campos de tarjeta; preparación liberada, carrito de prueba vacío, sin crear pedido, cobrar ni emitir factura. Editor fiscal integrado verificado en lectura. Pedidos existentes conservados. Presupuestos nuevos, USD desde la vista previa, Posnet y cobros combinados continúan fuera de esta entrega.

Rollback de esta entrega: backups/pos-flow-20261006T125212Z contiene los archivos previos; la tienda puede conservar el puente 0.3.0 porque admite preparaciones antiguas de contado. Los respaldos siguientes pos-flow-ui y pos-style contienen los ajustes de presentación. No restaurar ni desactivar el gateway fiscal antiguo para revertir únicamente POS.
