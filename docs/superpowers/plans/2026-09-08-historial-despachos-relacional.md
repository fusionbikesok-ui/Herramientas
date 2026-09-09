# Plan específico: historial relacional de despachos

**Fecha:** 2026-09-08  
**Estado:** planificado  
**Alcance:** separar Gestión de pedidos de Gestión de envíos y reemplazar el uso histórico de `pedidos_cache` por un modelo relacional permanente, manteniendo compatibilidad durante la migración.

## Decisión operativa

La operación se separa en dos herramientas sobre el mismo modelo: **Gestión de pedidos**, accesible desde Home para administrar pedidos, clientes, ventas físicas e intención de envío; y **Gestión de envíos**, que ejecuta recolección, preparación, evidencia, embalaje, tracking, grupos y salida física. Dentro de Gestión de envíos existen cuatro espacios: **Productos a buscar**, **Pedidos a preparar**, **Listos para despachar** y **Despachos**. El historial no depende de haber pasado por “listo para despachar”: un pedido informado como enviado por el canal puede existir sin preparación local y debe mostrarse como **despachado sin registro local**.

La navegación de **Gestión de pedidos** tendrá solo tres pills, en este orden: **Requieren atención**, **Recuperar ventas** y **Todos los pedidos**. La primera será la vista inicial. Las etapas físicas de preparación y despacho no se muestran como pills aquí, porque pertenecen a Gestión de envíos.

**Requieren atención** incluirá todos los pedidos activos que todavía no tienen un cierre confirmado, no solo las excepciones. Esto contempla pedidos confirmados pendientes de decidir o derivar, retiros en local pendientes de marcar como retirados y pedidos con pago, datos, sincronización o incidencia pendiente. Un pedido de retiro sale de esta vista únicamente cuando queda registrado como **retirado/completado**. Cancelados y carritos abandonados se gestionan en Recuperar ventas; pedidos cerrados permanecen en Todos.

Los contadores **En preparación** y **Despachos** abrirán vistas filtradas dentro de Gestión de pedidos, sin redirigir a otra pantalla. Mantendrán la misma lista, buscador y vista rápida derecha, mostrando los pedidos en esos estados. Las acciones físicas detalladas y el procesamiento de lotes continuarán ejecutándose en Gestión de envíos.

### Buscador de Gestión de pedidos

El buscador será global y funcionará desde cualquiera de las tres pills. Permitirá buscar por número de pedido, identificador externo de WooCommerce o MercadoLibre, nombre o apellido, email, teléfono, SKU, **EAN** y nombre de producto. Los resultados indicarán el campo coincidente, canal, cliente, fecha, estado e importe. La búsqueda no cambiará automáticamente de pill: si encuentra un pedido fuera de la vista actual, ofrecerá abrirlo en **Todos los pedidos**.

La selección múltiple de la lista tendrá como acción principal inicial **Enviar a preparación**. No se incluirá todavía una acción de asignación. Antes de crear el lote, el sistema validará la elegibilidad de cada pedido, informará cuántos serán enviados y señalará los excluidos con su motivo. La operación será confirmable, idempotente y auditable.

### Vista rápida y pantalla específica del pedido

La vista rápida lateral mostrará toda la información relevante para consultar el pedido sin abandonar el listado: identificadores y canal, fechas, cliente y contacto, tipo de entrega, dirección o retiro, estado externo y operativo, pago e importe, productos con cantidades, notas visibles, tracking si existe, fotos de preparación disponibles y línea de tiempo resumida. Será principalmente de lectura y tendrá pocas acciones seguras: abrir el pedido completo, contactar al cliente o acceder a una evidencia.

La pantalla específica del pedido será el lugar de trabajo detallado. Allí se podrán ejecutar acciones autorizadas, modificar datos, cambiar la intención de envío, registrar decisiones, consultar la línea de tiempo completa y gestionar incidencias. La vista rápida no duplicará esos formularios ni permitirá cambios complejos.

Las ediciones de productos deben generar movimientos de inventario idempotentes y auditables. Quitar una línea libera la reserva o concilia la cantidad ya descontada, sin doble descuento. Reemplazar un producto libera el original y descuenta el reemplazo. Si se confirma que el stock físico estaba mal contado, se registra un ajuste negativo separado con motivo, usuario, fecha, stock anterior y posterior. El detalle completo mostrará imágenes de producto grandes para facilitar la identificación.

La edición del pedido se separa en dos acciones: **Editar datos**, que permite modificar en un mismo formulario los datos del cliente y de la entrega; y **Editar productos**, que abre un buscador independiente. El buscador permitirá localizar por nombre, SKU o EAN y mostrará productos con fotos grandes, miniaturas, stock disponible, precio y cantidades. Agregar, reemplazar o quitar una línea requerirá confirmar el impacto en totales y stock antes de guardar.

En la lista de líneas existentes cada producto tendrá su propio botón **Remover**. La ventana de búsqueda tendrá únicamente **Agregar producto**; no habrá un reemplazo implícito. Para cambiar un producto se removerá la línea anterior y se agregará la nueva, dejando ambos cambios en la revisión previa.

### Cancelados y recuperación comercial

Los cancelados permanecen en **Todos** para consulta, pero nunca entran en preparación, despacho ni agrupación. **Recuperar ventas** combina cancelados y carritos abandonados. La oportunidad permanece visible hasta el cierre del día hábil siguiente a su detección o cancelación; la interfaz debe mostrar explícitamente si el vencimiento es **hoy** o **mañana**, calculándolo desde la fecha del pedido/abandono y el calendario de la tienda. Después sale de esta vista y permanece en el historial. En esta primera versión no se guarda el motivo de cancelación. Contactar no reactiva el pedido original: una venta recuperada crea o vincula un pedido nuevo.

La vista consolida los intentos por cliente usando identificador de cliente, email o teléfono. Si una persona tiene varios carritos o pedidos fallidos, muestra una sola oportunidad con el último intento y la cantidad de intentos acumulados. Si se detecta un pedido exitoso del mismo cliente durante la jornada, se retira la oportunidad de Recuperar ventas y no se muestran sus intentos fallidos.

La recuperación solo podrá iniciarse mediante **WhatsApp** o **Email**, con un botón independiente para cada canal. Un tercer botón, **Marcar contactado**, confirmará que la comunicación efectivamente se realizó. Se conservará si nunca se contactó, quién confirmó el contacto, fecha, hora y canal; hacer clic en el canal registra el intento/canal elegido, pero no confirma el contacto hasta la acción explícita.

WhatsApp no enviará mensajes desde el VPS: validará el teléfono argentino y copiará el número en formato nacional, sin `+54`. Email abrirá un recuadro con destinatario, asunto y mensaje completo del carrito para copiar manualmente. El mensaje usará plantillas rotativas controladas; la generación asistida por Gemini queda como mejora posterior y siempre requerirá revisión antes de copiar o enviar.

## Importación inicial

- MercadoLibre: todas las órdenes y shipments de los últimos 30 días.
- WooCommerce: todos los pedidos desde un mes atrás hasta hoy, incluidas ventas físicas del local.
- Importar no crea tareas de preparación ni cambia estados externos.
- ML no recibe tracking desde FusionBikes; se conserva el tracking informado por MercadoLibre.
- Web/Andreani asocia tracking durante el embalaje y lo informa a Woo solo después de confirmar la salida.

## Modelo relacional objetivo

### `clientes_despacho`

Cliente por canal e identificador externo, con nombre y ubicación mínimos. No duplica clientes maestros sin una regla de identidad aprobada.

### `pedidos_despacho`

Pedido externo, canal, número visible, `order_id`, `pack_id`, cliente, estado del canal, fechas y timestamps de sincronización. Índice único `(canal, order_id)`.

### `pedido_despacho_items`

Pedido, producto relacionado si existe, SKU, nombre capturado, cantidad y snapshot comercial.

### `envios_despacho`

Pedido, `shipment_id`, transportista, tipo ida/devolución, tracking, estado, subestado, fechas relevantes y última actualización. Índice único `(canal, shipment_id, tipo)`.

### `envio_eventos`

Transiciones observadas con estado anterior/nuevo, subestado, fecha del canal, fecha de importación, origen y referencia técnica. Nunca se borran.

### `despacho_preparacion_cruces`

Relación entre pedido externo y `preparaciones`, con estado de verificación, cantidad de fotos, tracking asociado, motivo de ausencia y fecha del cruce.

### `pedido_gestion_estado`

Intención operativa separada del estado externo: no requiere envío, requiere envío, enviado manualmente, en preparación, listo para despachar, despachado o retenido. El cambio manual debe ser idempotente y auditable.

### `grupos_despacho`

Agrupa pedidos y paquetes compatibles por transportista, canal, jornada y condiciones de retiro. No fusiona pedidos comerciales: cada pedido conserva cliente, items y tracking propios.

## Clasificación visible

- Preparado y verificado.
- Despachado sin evidencia.
- Despachado sin registro local de preparación.
- Cerrado sin evidencia.
- Tracking cargado manualmente.
- Entregado, devuelto, no entregado o cancelado.

La interfaz distingue el origen de cada afirmación: MercadoLibre, WooCommerce, FusionBikes o confirmación manual.

## Fuentes y sincronización

### MercadoLibre

Buscar órdenes del vendedor por fecha y paginar; obtener sus shipments; guardar `order_id`, `pack_id`, `shipment_id`, artículos, tracking, estado, subestado y `status_history`; cubrir `ready_to_ship`, `shipped`, `delivered`, `not_delivered` y `cancelled`; e incluir shipments de devolución.

### WooCommerce

Consultar todos los pedidos dentro de la ventana de un mes; guardar pedido, cliente, líneas y estado; y cruzar con `preparaciones` por `web:{wc_order_id}`. Solo un pedido que Woo marque “listo para enviar Andreani”, o que un usuario autorizado marque manualmente desde Gestión de pedidos, pasa a la cola de envíos. Una venta física puede quedar visible sin tarea logística.

## Migración desde `pedidos_cache`

1. Crear tablas y restricciones sin retirar la tabla actual.
2. Importar las filas existentes dentro del alcance histórico.
3. Crear una vista o adaptador compatible para consumidores antiguos.
4. Cambiar el historial para leer el modelo relacional.
5. Cambiar la cola de preparación para leer el modelo relacional.
6. Cambiar despachos y cruces de tracking.
7. Reconciliar conteos y consultas equivalentes.
8. Retirar la dependencia de `pedidos_cache` cuando ningún flujo la necesite.

La migración es idempotente, no borra evidencia y no convierte pedidos antiguos en preparaciones artificiales.

## Aceptación

- Un pedido ML enviado en los últimos 30 días aparece aunque nunca haya tenido preparación local.
- Un pedido Woo físico aparece en Gestión de pedidos sin entrar a la cola de envíos.
- Un pedido Woo en “listo para enviar Andreani” entra a la cola de envíos.
- Un usuario autorizado puede derivar manualmente un pedido y el cambio externo ocurre solo al indicar que se envía.
- Un pedido con preparación verificada conserva el cruce y sus evidencias.
- Desde Gestión de pedidos se pueden consultar las fotos de preparación de un pedido ya enviado en modo lectura.
- Un grupo de despacho conserva sus pedidos y paquetes sin fusionar datos comerciales.
- Un pedido sin preparación se muestra como “sin registro local”, no como “verificado”.
- Un pack ML con varias órdenes conserva sus relaciones.
- Un shipment de devolución no se mezcla con el envío de ida.
- Repetir la sincronización no duplica pedidos, items, shipments ni eventos.
- Un fallo parcial conserva lo importado y muestra la frescura por fuente.
- La cola operativa no muestra históricos como pendientes.
- Recuperar ventas muestra cancelados solo durante las últimas 24 horas hábiles y también carritos abandonados.
- Un cancelado vencido queda fuera de la cola comercial sin borrarse del historial.

## Fuera de alcance

- Cambiar automáticamente a enviado todos los pedidos importados.
- Cargar tracking de MercadoLibre desde FusionBikes.
- Reconstruir evidencia fotográfica inexistente.
- Convertir automáticamente un despacho histórico en una preparación.
