Estado vigente de entrega de comprobantes: email con PDF adjunto y WhatsApp manual disponibles en el VPS desde 2026-10-06. Ver [README-DELIVERY.md](README-DELIVERY.md). Los apartados de preparación histórica que indican correo/WhatsApp pendientes no describen esta entrega. POS operativo: [README-POS.md](README-POS.md); emisión fiscal: [arca/README-ARCA.md](arca/README-ARCA.md).

# Integración de POS, Facturador y Taller — estado verificable

Solicitud del usuario: llevar la gestión al VPS, mantener tienda/checkout en su hosting y Master Control íntegro. Este directorio conserva la implementación de la **copia de consulta**; no representa el corte operativo completo.

## Disponible

- Runtime privado `/opt/fusion-management-migration`, WordPress 7.1.2, WooCommerce 11.1.2, PHP 8.2 con SOAP. Paquetes recibidos POS 3.4.6-beta.2, ARCA 0.1.0-beta.37 y Taller 0.2.0-beta.1. Sin Master Control instalado.
- Entrada `https://herramientas.fusionbikes.com.ar/herramientas/gestion-vps/`, sólo administradores autenticados de Herramientas. Se verifica la sesión en cada solicitud; la firma del gateway vincula usuario, método, URL y tiempo. No hay cookies WordPress ni claves de la tienda en el navegador.
- Runtime Docker en red interna sin puertos publicados; gateway Node separado, usuario dinámico de systemd y escucha en 127.0.0.1:8212. Cron, Action Scheduler, correo y HTTP externo bloqueados; tampoco hay salida SOAP por la red interna. POST/PUT/DELETE no habilitados.
- Copia real de las ocho tablas propias: 1 orden y 1 modelo de Taller, 2 constancias, 0 recordatorios; 153 comprobantes, 14 registros de series, 221 registros de integración ML y 6 estados de envío de ARCA. Además 27 presupuestos y 5 borradores POS conservados para mapear operadores.
- Páginas originales cargan bajo la sesión de Herramientas. Historias fiscal, Taller y presupuestos leen la base del VPS. Las vistas de operación muestran el aviso de consulta; el bloqueo efectivo está en el servidor.
- POS, Facturador y Taller consultan el catálogo sincronizado existente en `catalogo_cache` mediante el GET interno `/api/woo/catalogo`. Sus búsquedas ya no consultan WooCommerce ni disparan sincronizaciones; la caché RAM dura 5 segundos y cada solicitud valida sesión y administrador. El tema usa los tokens compartidos de Herramientas.
- Resultados de consulta: cantidad registrada, fecha por producto, SKU/GTIN, miniatura y contado desde el lector local de Consulta de Precios. La fuente no conserva todos los indicadores de disponibilidad ni las reglas comerciales: no se infiere disponibilidad de venta y estos resultados no se agregan a ventas/facturas. Un error local se informa; nunca se reemplaza con catálogo vacío o stock cero.
- Exportación limitada del puente 0.2.0, con HTTPS y permiso adicional de administrador, sin contraseñas ni secretos fiscales. Verificación SHA-256 de cada archivo y página; conciliación de cada columna/registro de las tablas. No se interpreta una extracción de una web activa como snapshot consistente de corte.

## Pendiente antes de trasladar la operación

1. Completar los campos comerciales del catálogo, clientes/pedidos y sus relaciones antes de operar. La búsqueda de productos y cantidades locales ya funciona en consulta. Mapear las identidades del POS; los 5 borradores no están asignados todavía a usuarios de Herramientas.
2. Adaptador de precios desde Master Control y cotización de dólares sin fallback. Mantener excepciones, variaciones, redondeo, impuestos y seriales. No utilizar precios REST proyectados como base.
3. Checkout en el hosting actual con sesión/permisos originales, preparación idempotente y confirmación de pago en servidor. Cobros manuales/mixtos, stock, series, entrega y vínculo fiscal deben conservar sus reglas.
4. Configuración completa, certificados/claves ARCA por transferencia privada, conexión comprobada y ensayos sin emisión real. Trasladar también estados pendientes, pedidos vinculados, OAuth ML, entregas PDF y secretos WhatsApp protegidos; no copiar sales globales de WordPress para desencriptarlos.
5. Documentos públicos nuevos, clientes y repuestos del Taller. Los enlaces antiguos se siguen resolviendo en el origen hasta su vencimiento. Recordatorios de origen estaban deshabilitados y permanecen así.
6. Corte coordinado con un único escritor/emisor, conciliación final bajo bloqueo, permisos del equipo, pruebas de funcionamiento y restauración ensayada. Los plugins originales siguen activos y son la autoridad operativa.
7. El Chat sigue en su ensayo aislado anterior; no se trasladó su tráfico real.

## Operación y reversión de esta copia

- Servicio `fusion-management-validation.service`; Compose `fusion-management-migration`. No reinicia Herramientas.
- `runtime.env` y `gateway.env` privados en el VPS. Nunca incorporarlos, ni los directorios `data/` o `backups/`, al repositorio.
- La IP privada de PHP se registra en `gateway.env`; si se recrea la red/contenedor, ejecutar `ops/start-gateway.py` para actualizarla antes de habilitar tráfico.
- Respaldo Nginx anterior a la entrada: `/opt/fusion-management-migration/backups/20261005T004439Z/herramientas.nginx.conf`. Para retirar la vista, restaurar ese archivo sólo si no hubo cambios posteriores, comprobar `nginx -t` y recargar; detener el gateway. Los datos originales no se alteraron.
- Datos de origen exportados en `/opt/fusion-management-migration/data/2026-10-04T23-06-05-446Z`; respaldo previo a la importación en `backups/20261005T004328Z/before-import.sql`. Conservarlos privados. No se probó aún una restauración completa.
- Gateway y catálogo: `node --test gateway.test.mjs local-catalog.test.mjs`, once pruebas aprobadas localmente y en VPS. Permisos, revocación, rutas/métodos, caché, errores, búsqueda/variantes y representación segura probados; HTTP local real verifica que las búsquedas sólo alcanzan el lector SQLite existente.
- Puente: 61 comprobaciones PHP con los servicios originales de Master Control en contenedor sin red. El origen negó el inventario anónimo y permitió la lectura con su API vigente.

## Paquetes originales

Los ZIP se mantienen en el área operativa privada, fuera de este código versionable:

| Paquete | SHA-256 |
|---|---|
| POS | b3e8b3bc4b145eb060fafe9db6d2a05d99f8255c313452e4b70787a3848be4bb |
| Facturador | b4258d5b13e0d28e7b1e0b1e1c4914ebaa371f33a96b19e6b758727c5290ed6f |
| Taller | 7b81c19ae80bc24f08b516edf11175cf347762fd46aa6d9c7a158ae660239c5f |

Verificar estos valores contra los ZIP antes de reutilizar una instalación; la presencia de archivos o pantallas no acredita el funcionamiento operativo completo.

## Cambio de catálogo y presentación — 2026-10-04

Ver `CATALOG-PLAN.md` y `catalog-release.json` privado para el respaldo de cada publicación. Antes de reemplazar se valida Node/PHP y se respaldan gateway, MU y assets; sólo se reinicia el gateway. Si falla el inicio se restauran esos archivos. Los JS de los tres módulos son adaptaciones acotadas del runtime privado; los plugins de la tienda y Master Control no se modifican.

Comprobación de lectura: SKU `FB-1045` (id Woo 1045), Pedales Shimano M520 Spd, devolvió 13 unidades en los tres módulos, igual al catálogo local inspeccionado. La fecha mostrada pertenece a la sincronización de esa fila; no garantiza una reserva ni disponibilidad al cobrar. La reducción de carga se limita a las búsquedas que se realicen aquí; no hay porcentaje de ahorro medido ni corte operativo completo.

## Precio al contado, imágenes y archivo Mercado Libre

El campo catalogo_cache.precio se dejó de mostrar: contiene la proyección REST, que para FB-70394 coincide con el total de 18 cuotas (6.675.000), mientras que el contado es 4.450.000. El gateway reutiliza GET /api/consulta-precios/buscar, sólo SQLite, valida ID/SKU y no duplica coeficientes ni usa listas ML. Si falla ese lector, el precio queda no disponible y el stock continúa visible. La paridad completa del motor comercial es obligatoria antes del corte. Las imágenes se leen de las URLs estáticas de uploads ya presentes en el catálogo, con herencia de padre y carga diferida.

Mercado Libre: la pestaña de archivo permite consultar los 221 registros copiados, bajo el entorno/CUIT configurado y un único vendedor importado. Los IDs WordPress de los permisos masivos no son los usuarios de Herramientas: sólo esta lectura se autoriza al administrador firmado del VPS. Paginación, filtros, acceso anónimo denegado y POST bloqueado verificados. No se copió OAuth ni se habilitó sincronización/automatización; la pantalla informa esa diferencia. Se preguntó por acceso a la aplicación y Client Secret para completar la conexión privada, sin pedir que se peguen secretos en chat.
# Actualización 2026-10-05: directorio compartido

Disponible en `/herramientas/gestion-vps/directory/`, con enlaces desde Gestión y los tres módulos. La búsqueda nativa de clientes de POS/Taller usa el mismo índice. ARCA accede por el enlace del directorio; aún no se integró selección fiscal directa ni carga de pedidos en su formulario de emisión.

- Carga completa verificada: 1.593 clientes registrados, 13.888 pedidos Woo desde 2023-03-09. La primera actualización incremental incorporó dos pedidos más (13.890); estas cantidades son una evidencia puntual, no un límite fijo.
- Actualización por lotes: pedidos cada 15 minutos (modificaciones con solapamiento de 10 minutos), clientes cada 24 horas, reconstrucción completa semanal para conciliar bajas. Snapshot de consulta publicado atómicamente; ante fallo conserva el anterior y muestra aviso. Descarga inicial reanudable por página, con clientes disponibles antes de completar los pedidos.
- Índice derivado y reconstruible `directory-cache/directory.sqlite`: no es otra autoridad de ventas. Woo sigue siendo el escritor. No altera la base de Herramientas ni crea usuarios/pedidos en el WordPress privado. IDs devueltos por adaptadores son del origen: requieren mapeo antes de habilitar escrituras.
- Datos de compradores sin cuenta sincronizada se conservan por pedido. No son un conteo de personas únicas. No fusionar por nombre ni usar la tabla antigua `gestion_pedido_clientes` como audiencia: la auditoría encontró creación repetida de contactos sin email/teléfono durante reimportaciones; ese importador legado no fue modificado.
- Se conservan importes históricos y moneda, productos, referencias de devolución y 434 marcas de espejo ML. Los pedidos ML directos siguen en Gestión de pedidos; este índice contiene Woo y sus copias ML. El Panel de ventas necesita además detalle de devoluciones por línea y taxonomías del catálogo para una migración equivalente. No sumar espejos como ventas nuevas.
- Permiso de mailing desconocido. No se enviaron campañas ni se dedujeron suscripciones a partir de compras. Chat/popup y carritos tienen tablas propias pendientes de integrar.
- 17 pruebas Node + 5 Python, incluyendo sesión vigente, autorización, búsqueda, identidad, montos, interrupción y reanudación. Prueba UI: POS devuelve clientes; pedido #6115 abre sus líneas; SKU FB-1045 devuelve historial. Responsive 390/768/1440 sin desborde. Primera ejecución incremental real: dos GET y dos pedidos nuevos.
- Respaldo `/opt/fusion-management-migration/backups/directory-20261005T143651Z`. Gateway sólo lee caché por grupo `fusion-management-read`. Sincronizador root aislado por systemd; credenciales Woo permanecen en `.env` existente y no llegan al navegador/gateway. Servicios: `fusion-management-directory-sync.service` y `.timer`.
- Reversión: detener/deshabilitar sólo el timer nuevo y detener su servicio si está trabajando; restaurar gateway/home/catalog-ui desde el respaldo y reiniciar únicamente `fusion-management-validation.service`. El índice es derivado y puede conservarse privado para diagnóstico. No restaurar bases de la tienda ni de Herramientas.

Sigue pendiente el corte operativo: agregar productos a ventas persistentes, guardar/cobrar por checkout original, fiscalidad, certificados ARCA y OAuth ML. La consulta funcionando no equivale a esa habilitación. Master Control permanece intacto.

## Panel de ventas trasladado — 2026-10-05

Disponible en `/herramientas/gestion-vps/ventas/`, desde Gestión y Directorio. Ver `METRICS-PLAN.md` para reglas, pruebas, conciliación y reversión. Métricas, filtros, gráficos y CSV usan `directory-cache/metrics.sqlite` local, derivado de pedidos con precisión REST dp=8 más dimensiones/devoluciones del puente 0.3.0. No utilizan precios de listas de Mercado Libre. Importe neto de líneas después de descuentos/reembolsos, sin impuestos/envío/cargos, igual al Panel 1.1.0 original. Se mantienen separados los estados seleccionados, monedas y productos eliminados. Los espejos Woo no se suman a otro registro ML directo.

Los dos timers (directorio y métricas) se ejecutan cada 15 minutos; su desfase combinado puede acercarse a 30 minutos. Catálogo analítico diario. UI muestra fecha real y copia atrasada/fallo, no fecha de apertura como actualización de datos. Snapshot completo atómico; paginación y CSV fijan su generación y rechazan versiones mezcladas. Sólo administradores Herramientas vigentes; no se habilitaron operaciones financieras ni escrituras Woo.

Paridad exacta: 452 líneas de septiembre 2026 y 23 líneas de marzo 2023, incluidos históricos con productos eliminados y reembolsos sin asignar. CSV descargado en VPS idéntico al original de septiembre. Corrección del directorio: dp=8 explícito, versión en checkpoint y recarga completa, para no perder decimales históricos. 22 pruebas Node, 10 Python y 87 aserciones PHP. Las limitaciones de operación de POS/ARCA/Taller y Chat descriptas arriba continúan; esta publicación completa el módulo de métricas.

## Generador Andreani trasladado — 2026-10-05

Funcional en `/herramientas/gestion-vps/andreani/`, desde Gestión: búsqueda local de pedidos, revisión y guardado de destinatario/domicilio/bultos y descarga de Excel original 1.1.2. Tres servicios y mismas reglas de plantilla; categoría de bicicletas predeterminada 62 editable. No contrata envíos: carga, pago y etiquetas en Andreani PyMEs. `ANDREANI-PLAN.md` detalla reglas, pruebas, persistencia y reversión.

Pedidos de directorio ampliados con DNI, métodos y borradores/marcas anteriores; puente 0.3.1 añade `virtual` a dimensiones. Sin escrituras a Woo ni cambios Master Control. El trabajo del panel y la generación XLSX ocurren íntegramente en VPS; la sincronización incremental sigue leyendo la tienda cada 15 min. Nuevas revisiones/exportaciones sólo en SQLite privado `/var/lib/fusion-management-validation/andreani.sqlite` (directorio 0700, umask 0077), que debe incluirse en copias operativas. Archivos descargables 24 h, registro de exportación permanente. Usar este panel para nuevas preparaciones: las marcas nuevas no regresan al plugin original.

Worker PHP privado en volumen wp_data `/var/www/html/fusion-andreani-worker`, sin WordPress bootstrap ni puertos públicos, HMAC por usuario/cuerpo/URI/método/tiempo. Gateway valida sesión admin, Origin y CSRF de `connect.sid`; cookie auxiliar variable no invalida revisión. Sólo POST Andreani habilitado. Conflictos, repeticiones, datos no revisados, pedidos no aptos y caché atrasada bloqueados. 31 pruebas Node (incluye roundtrip real con worker y bases sintéticas) y 22 aserciones PHP; seis filas en tres servicios mantienen todas las partes no editadas del XLSX. Datos reales abiertos en UI sin guardar/exportar para la prueba.

- 2026-10-05: Andreani Observaciones ahora agrega automáticamente el título histórico del primer producto a enviar (primera línea con cantidad positiva y no virtual), conservando aclaraciones de entrega y sin duplicarlo al reabrir o guardar. Regla aplicada en lectura de borradores nuevos/existentes, normalización y nuevas exportaciones. No reescribe archivos ya generados ni modifica la tienda. 27 aserciones PHP y validación del XML de Observaciones en las hojas domicilio/Llega hoy; plantilla de sucursal conserva su esquema original sin columna de observaciones.

- 2026-10-05: Corregida selección de bultos Andreani: borradores importados/locales con un único perfil predefinido conservaban other aunque el producto padre pertenecía a bicicletas. Perfil automático ahora se recalcula al abrir, guardar y exportar; no invalida por sí solo una revisión de destinatario existente. UI agrega Automático según los productos y conserva elecciones explícitas con profile_mode=fixed; medidas personalizadas, cajas guardadas y elecciones heredadas de varios bultos se respetan. Nuevos bultos automáticos llevan profile_mode=auto. Reglas configuradas: bicicletas 30×20×40 cm/9000 g; resto 12×25×30 cm/1000 g. 39 aserciones PHP, incluido Excel de borrador legado mal clasificado y casos manual/caja/múltiples. Tanda de 16 del 2026-10-05 15:03 ART: 11 bicicletas tenían perfil chico; se creó copia privada corregida modificando únicamente B–E (peso/medidas), sin cambiar destinatarios, referencias, observaciones, estados ni marcas originales. No se contrató/envió nada a Andreani. Archivo privado descargable 24 h para su autor, reporte en runtime andreani-package-correction.json.

- 2026-10-05: Por cambio solicitado, Andreani Observaciones ahora usa Pedido #<número visible Woo> en lugar del título. Aplicado permanentemente en la aplicación VPS al abrir borradores nuevos/existentes, guardar y generar nuevos Excel. Retira el antiguo título automático sólo como segmento completo, preserva aclaraciones de entrega y no duplica el número; menciones de productos dentro de frases manuales se conservan. 42 aserciones PHP y verificación XML de Observaciones; clasificación automática de bultos y medidas manuales conservadas. Archivos ya generados permanecen históricos; plantilla de sucursal sigue sin columna de observaciones. Fuentes en integrations/management-migration/andreani/worker.php.
