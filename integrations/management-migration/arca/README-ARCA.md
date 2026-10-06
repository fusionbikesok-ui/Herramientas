## Operación vigente POS y ARCA — regreso a la web, 2026-10-06

POS y Facturador ARCA vuelven a operar exclusivamente en fusionbikes.com.ar, por decisión del usuario. Herramientas ofrece accesos directos; los informes, directorio y etiquetas Andreani/corrector PDF permanecen en el VPS. Los enlaces antiguos ?fm_module=pos/facturador redirigen a la web. El gateway con FUSION_SALES_LOCATION=web bloquea las API antiguas de POS, facturación y envíos manuales del VPS; los enlaces PDF ya compartidos conservan su vigencia original.

Antes de habilitar la web se deshabilitó fusion_arca_vps_enabled y production_enabled en la copia privada y FUSION_POS_VPS_ENABLED en gateway.env; se conciliaron 173 comprobantes, 14 series, 225 ventas ML y 6 registros WhatsApp sin diferencias fiscales. La factura nueva 173/pedido 70706 ya estaba archivada en Woo. Numeración confirmada con ARCA: punto 15 A1/B15/NC_A0/NC_B1; punto16 A7/B135/NC_A0/NC_B0. Ningún pendiente ni CAE solicitado durante las pruebas. El autor del recibo 173 es 0 en la tienda por el contrato del archivo original.

En la web fusion_arca_vps_cutover queda vacío, respaldado junto con settings/ML en opciones fusion_return_web_20261006_*. La emisión manual del punto15 está habilitada y el usuario autorizó recuperar el automatismo ML del punto16. La automatización web por cambio de estado conserva su pausa. Certificados originales y conexión Meta for WooCommerce permanecen en la web. No se cambió Master Control ni precios.

Servicios privados VPS fusion-arca-egress/source y timer outbox detenidos y deshabilitados. El backup fiscal diario conserva el archivo y los borradores/operaciones anteriores. Respaldo del regreso: /opt/fusion-management-migration/backups/return-web-20261006T184545Z. No volver a habilitar VPS ni restaurar una base antigua después de nuevas emisiones web sin otro corte y conciliación. Historial anterior de migración que contradiga esta sección queda superado.



Verificación del regreso: 33 pruebas focalizadas de gateway, desvíos, bloqueo de API, POS, catálogo, transporte fiscal y entrega aprobadas en copia aislada sin credenciales productivas. UI real: WordPress WSFE y Padrón conectados; POS encuentra FB-70394 con stock1/contado ARS4.450.000 y ofrece 3/6/9/12/18/24 cuotas antes del cobro. Se retiró el producto de prueba, borrador web guardado vacío; no se creó un pedido ni se solicitó CAE de prueba. SQL confirmó ML enabled/automatic true, punto16, producción web true; tareas ML recientes completas. Informes VPS cargan 10.140 líneas y Andreani consulta el historial sincronizado. No se probó un envío real de correo/WhatsApp ni un cobro. Las 33 pruebas no constituyen la suite completa del proyecto.

## Archivo del traslado anterior

Entrega manual de comprobantes habilitada en el VPS desde 2026-10-06: ver [README-DELIVERY.md](../README-DELIVERY.md). SMTP con PDF adjunto y WhatsApp por mensaje preparado; automáticos/API siguen deshabilitados.

# Facturador ARCA en producción VPS

Activado el 2026-10-05 para emisión manual en producción, punto 15, con el certificado de producción del titular. La tienda conserva checkout, precios/Master Control y el archivo fiscal; no emite. Entrada: `/herramientas/gestion-vps/?fm_module=facturador` con sesión de administrador de Herramientas.

## Estado y alcance

- Se reconciliaron 172 comprobantes, 14 registros de series, 225 ventas ML y 6 registros WhatsApp. Se agregaron los 19 comprobantes faltantes. Exportación doble posterior al bloqueo, hashes del origen y comparación exacta de filas/columnas; IDs conservados.
- Numeración consultada al habilitar: A 1, B 14, NC A 0, NC B 1, idéntica al archivo local. No se emitieron comprobantes reales durante la validación.
- Funciones habilitadas: borradores, emisión manual A/B punto 15, consulta y recuperación de pendientes, notas de crédito del punto 15, comprobantes internos, PDF y consulta de padrón.
- ML conserva el archivo importado, pero su emisión/sincronización, facturación masiva, automatismos, correo y WhatsApp no están habilitados. El OAuth del plugin ML es independiente y no debe reutilizar el refresh token de la app principal. POS/Taller continúan en consulta.

## Contratos operativos

- Productos/búsqueda/precio contado/miniaturas provienen del catálogo del VPS. No usar precios de ML. La selección conserva IVA y obligación de serie; USD y documentos manuales conservan las revisiones del plugin.
- Al cargar un pedido y antes de emitirlo se relee su estado vigente desde Woo para evitar duplicados, cambios de precio o de pedido. El adaptador materializa una copia nativa privada de productos, pedidos e ítems con IDs originales, sin eventos comerciales, correos ni movimientos de stock. HPOS se mantiene apagado en esta copia privada.
- El gateway sólo admite las rutas fiscales manuales enumeradas, con sesión administrador vigente, Origin exacto, CSRF ligado a sesión y HMAC de identidad/método/URL/cuerpo. No admite mutaciones fiscales por query. Otros módulos conservan su bloqueo.
- Se preservan los locks, revisión optimista, fingerprint, persistencia de `pending` antes de solicitar CAE y recuperación por consulta del plugin original. Ante timeout, consultar/recuperar el comprobante; no crear otra factura por el mismo pedido.
- El puente WordPress 0.4.0 registra `fusion_arca_vps_cutover=stopped`: apaga producción/automáticos, bloquea REST fiscal y escrituras de tablas ARCA en origen. Toma los locks de emisión y rechaza el corte con pendientes. No modifica Master Control.
- Cada factura autorizada nueva del punto 15 se archiva en origen y marca únicamente sus metadatos fiscales/series de pedido. No modifica importes, estado ni stock. El outbox durable reintenta fallos; también descubre autorizaciones persistidas antes de un fallo del hook. El ACK sólo se guarda tras recepción confirmada. Los comprobantes internos permanecen locales al VPS.
- El baseline `fusion_arca_vps_cutover.at` local usa UTC `Y-m-d H:i:s` y `last_source_id=172`. La emisión no se reactiva en origen mientras el VPS permanezca activo.

## Infraestructura privada

- Runtime: `/opt/fusion-management-migration`, WordPress/Woo en Docker interno, gateway loopback 8212. PHP SOAP reutiliza el plugin 0.1.0-beta.37; única extensión al cliente: filtro `fusion_arca_soap_options` sobre opciones SOAP.
- Certificado/clave y configuraciones secretas: `/etc/fusion-arca-private`, fuera del directorio web, montado sólo lectura en `/opt/fusion-arca-private`. Par de producción root:www-data 0440 y directorio 0750. Certificado validado hasta 2028-09-22. No copiar homologación de otro CUIT.
- `fusion-arca-egress.service`: proxy CONNECT autenticado en la interfaz Docker 172.16.6.1:8215, sólo hosts oficiales de producción ARCA y puerto443; validación TLS permanece activa.
- `fusion-arca-source.service`: puente HMAC privado 172.16.6.1:8216, acciones fijas `gate/order/products/sync_invoice`; Woo HTTPS con redirects bloqueados. Credencial privada, nunca navegador.
- `fusion-arca-outbox.timer`: cada minuto. No solicita CAE; sólo archiva autorizaciones ya existentes. Backoff por registro hasta una hora.
- `fusion-arca-backup.timer`: diario 05:40 UTC más hasta cinco minutos. Archivo local root-only de DB fiscal, certificados/configuración privada y configuración runtime; 14 copias. Es recuperación local, no respaldo externo frente a pérdida del VPS.
- Cron, Action Scheduler, WP HTTP y correos genéricos permanecen bloqueados en la copia privada; sólo existen los transportes fiscales específicos.

## Verificación y recuperación

Pruebas: 15 Node de gateway/catálogo/CSRF/Origin/HMAC, 28 aserciones del bridge, 44 del plan de espejo, 51 con Woo real aislado, 11 de borrador/lectura/revisión en DB descartable. Consultas reales WSFE/Padrón por PHP y UI; PDF de comprobante histórico. Sin FECAESolicitar de prueba.

Respaldo del corte: `/opt/fusion-management-migration/backups/arca-cutover-20261005T235059Z`, con `destination.sql`, configuración anterior de origen y exportación final privada. Metadatos no secretos en `arca-cutover-release.json`. Otros backups conservan versiones anteriores de gateway, MU, JS y configuración de conexión.

Para detener el VPS, poner `fusion_arca_vps_enabled=false` y `fusion_arca_settings.production_enabled=false`; conservar el corte del origen. No restaurar una base antigua después de emitir sin reconciliar CAEs y numeración. No quitar el bridge ni su flag para volver a facturar en la tienda: primero detener VPS, recuperar pendientes, conciliar su historial/ARCA y realizar un corte inverso coordinado. La copia de recuperación contiene secretos: acceso root y sin publicación.

Los scripts de `arca/` son herramientas de despliegue/reconciliación de este corte; no reejecutar instaladores no idempotentes ni `reconcile.php` sobre un destino activo. Los ZIP y certificados originales no forman parte del repositorio.

Verificación ampliada del 2026-10-05: suite aislada de Gestión 44 aprobadas, 8 fallos y 1 omitida; los 8 fallos pertenecen a ranking.test.cjs (funciones de agrupación/fechas no exportadas), reproducidos al correr ese archivo solo. No se modificaron ranking ni métricas durante el corte ARCA; no afirmar suite global verde. Las 15 pruebas de gateway/catálogo/transporte fiscal y las pruebas nativas ARCA sí pasan. UI WSFE/Padrón y apertura real de PDF histórico verificadas; recepción idempotente del comprobante manual 11 sin pedido ni nuevas facturas aceptada en origen. Captura de escritorio sin desborde; el override de viewport del navegador no cambió su ancho efectivo de 1265px, por lo que no se afirma nueva prueba móvil.
