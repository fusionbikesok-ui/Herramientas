# Buenas prácticas para Gestión de pedidos y Gestión de envíos

## Resumen ejecutivo

FusionBikes debería separar dos experiencias sobre un mismo modelo de datos:

- **Gestión de pedidos:** universo completo importado, ventas físicas, clientes, productos, edición permitida, incidencias y decisión de envío.
- **Gestión de envíos:** trabajo físico ejecutable: buscar productos, preparar pedidos, embalar, asociar tracking, formar grupos y confirmar salida.

La importación no debe crear trabajo automáticamente. Primero conserva el universo comercial; después una regla de elegibilidad deriva solo los pedidos que requieren operación logística. Este patrón coincide con los sistemas WMS que separan consultas, creación de trabajo y procesamiento de trabajo existente en el dispositivo móvil. [1]

## 1. Principios de arquitectura

### Fuente permanente y colas derivadas

El pedido, cliente, líneas, productos, envíos y eventos deben vivir en tablas relacionales permanentes. Las colas son vistas o tareas derivadas, no la fuente de verdad. Así una venta física puede permanecer visible sin aparecer en preparación, y un pedido que cambia de estado puede cambiar de cola sin desaparecer.

`pedidos_cache` puede mantenerse como adaptador temporal durante la migración, pero no debe decidir qué existe históricamente.

### Estado externo frente a intención operativa

Hay que conservar por separado:

- estado informado por WooCommerce o MercadoLibre;
- intención local: no requiere envío, requiere envío, retenido o enviado manualmente;
- estado físico: preparación, listo, agrupado, retirado y confirmado.

No se debe inferir que un pedido fue preparado porque el canal dice que fue enviado. La interfaz debe mostrar el origen de cada afirmación.

### Permisos por tarea

Los menús disponibles deben depender del rol. Los sistemas WMS exponen a cada trabajador solo los menús y tipos de trabajo que puede ejecutar, mientras las consultas y funciones administrativas quedan diferenciadas. [1]

## 2. Diseño de Gestión de pedidos

### Home orientado a decisiones

La vista inicial debe responder rápidamente:

1. ¿Qué pedidos entraron?
2. ¿Cuáles requieren una decisión?
3. ¿Cuáles requieren envío?
4. ¿Cuáles tienen incidencias?
5. ¿Cuáles ya salieron?

La pantalla puede tener indicadores breves y una tabla/lista filtrable, pero no debe mezclar acciones físicas con edición comercial.

### Tabla/lista recomendada

Columnas visibles en escritorio:

- número de pedido;
- canal;
- fecha;
- cliente;
- tipo: envío, retiro local o venta física;
- estado externo;
- estado operativo;
- estado de preparación;
- estado de despacho;
- última actualización.

En móvil, cada fila se convierte en tarjeta con número, canal, cliente, estado principal y una única acción contextual. El resto aparece en el detalle.

### Acciones peligrosas

“Requiere envío” y “Enviar ahora” son acciones distintas:

- **Requiere envío:** crea intención local y deriva a Gestión de envíos.
- **Enviar ahora:** confirma una decisión autorizada, actualiza el canal mediante una operación durable e idempotente y registra el actor.

La interfaz debe explicar el efecto antes de confirmar. Si Woo no responde, el pedido queda “pendiente de confirmación externa”, no “enviado”.

### Ventas físicas

Las ventas del local deben ser visibles como pedidos normales, pero con tipo de cumplimiento `retiro_local` o `venta_fisica`. No deben entrar a preparación ni despacho salvo derivación manual autorizada.

## 3. Diseño de Gestión de envíos

### Navegación principal

La navegación móvil debe tener cuatro espacios:

1. **Productos a buscar** — lista consolidada por SKU, imagen, ubicación y cantidad.
2. **Pedidos a preparar** — checklist por pedido, fotos y embalaje.
3. **Listos para despachar** — paquetes completos y aprobados.
4. **Despachos** — grupos, reconciliación y salida.

Historial, seguimientos, perfiles, horarios y regularizaciones deben estar en una sección secundaria o depender del rol. La investigación de NN/g recomienda exponer solo 4–5 opciones principales en móvil y usar navegación combinada para el resto. [2]

### Flujo scan-first

El foco debe permanecer en el campo de escaneo. Cada lectura debe producir inmediatamente:

- aceptación o rechazo inequívoco;
- cantidad actualizada;
- feedback visual y sonoro;
- siguiente acción clara.

Los sistemas WMS permiten configurar campos como “preferentemente escaneables”, requieren confirmar producto, ubicación y cantidad, y ofrecen entrada manual solo como recuperación cuando el código no se puede leer. [1][3]

### Recolección consolidada y checklist

La lista consolidada es adecuada para recorrer el depósito; la checklist por pedido es la fuente de control antes de embalar. No se debe marcar una cantidad completa solo porque se escaneó el SKU una vez: cada lectura representa una unidad o una cantidad explícitamente confirmada.

Un excedente, código desconocido, código ajeno o faltante debe detener solo la línea afectada y ofrecer recuperación. Nunca debe modificar silenciosamente otra línea.

### Embalaje y tracking

Para Web/Andreani, el preparador debe escanear:

1. código interno del paquete;
2. tracking de la etiqueta generada fuera del VPS;
3. confirmación de asociación.

Como FusionBikes no conoce previamente la relación externa, el sistema puede validar formato, duplicado, conflicto y actor, pero debe presentar la asociación como confirmada por el operador, no como una validación automática del transportista.

MercadoLibre no recibe tracking desde FusionBikes; se conserva el shipment y estado que informa ML.

### Grupos de despacho

Un grupo reúne paquetes compatibles por transportista, canal, jornada y condiciones de retiro. No fusiona pedidos: cada pedido mantiene cliente, líneas, paquete y tracking propios.

El grupo debe congelar sus miembros antes de la reconciliación. En el retiro, despacho escanea solo el código interno y el sistema compara esperados, escaneados, faltantes, duplicados y ajenos.

## 4. Historial e integración de canales

### MercadoLibre

El historial debe importar órdenes y shipments del último mes, incluyendo `pack_id`, `shipment_id`, tracking, estado, subestado y `status_history`. La documentación de ML define estados como `ready_to_ship`, `shipped`, `delivered`, `not_delivered` y `cancelled`, y permite recuperar el shipment asociado a una orden. [4]

El estado del shipment es la fuente para saber si el envío salió o fue entregado. Las devoluciones deben conservarse como shipments separados y no mezclarse con el envío de ida.

### WooCommerce

El historial debe importar todos los pedidos del último mes, incluidos los de venta física. La API de Woo admite filtrar por estado, fechas, paginación y actualización; también permite actualizar el estado mediante `PUT`, por lo que toda acción de envío debe quedar protegida por idempotencia y auditoría. [5]

La clasificación local decide si el pedido requiere logística. Solo “listo para enviar Andreani” o una derivación manual autorizada entra a Gestión de envíos.

### Fotos después del despacho

Desde Gestión de pedidos debe poder consultarse la preparación de un pedido ya enviado:

- fotos de productos;
- foto de paquete abierto;
- foto de paquete cerrado y etiqueta;
- checklist y actividad.

La consulta es de solo lectura después del despacho. Una corrección o eliminación requiere permiso elevado, motivo y evento de auditoría.

## 5. Excepciones y confiabilidad

- Importación parcial: conservar lo importado y mostrar frescura por fuente.
- API caída: no transformar una intención en estado enviado.
- Doble escaneo: operación idempotente.
- Doble click o reintento: mismo resultado, sin duplicar eventos.
- Tracking duplicado: bloqueo.
- Pedido cancelado durante preparación: bloquear la línea y pedir resolución.
- Pedido sin preparación local: mostrar “despachado sin registro local”.
- Grupo con paquete ajeno o faltante: no confirmar salida sin excepción autorizada.
- Dispositivo perdido: revocar sesión y lease del dispositivo.

## 6. Métricas de aceptación

Medir por etapa, no solo el tiempo total:

- tiempo de decisión comercial a derivación logística;
- tiempo de recolección por unidad;
- escaneos rechazados;
- confirmaciones manuales;
- pedidos que vuelven a cola;
- fotos faltantes;
- asociaciones de tracking conflictivas;
- diferencias de grupos de despacho;
- tiempo de confirmación de salida a actualización del canal;
- pedidos despachados sin registro local.

No publicar rankings personales en el primer período. Primero establecer una línea base y detectar fricción del proceso.

## 7. Orden recomendado de diseño y entrega

1. Shell móvil y navegación de cuatro espacios.
2. Home de Gestión de pedidos con lista relacional y filtros.
3. Detalle de pedido con timeline, productos, estados y consulta de fotos.
4. Productos a buscar y checklist scan-first.
5. Embalaje y asociación de tracking Web/Andreani.
6. Listos para despachar y grupos.
7. Reconciliación y confirmación de salida.
8. Importadores históricos y migración progresiva de `pedidos_cache`.
9. Pruebas con datos genéricos y luego prueba operativa controlada.

## Fuentes

1. Microsoft Learn, [Set up mobile devices for warehouse work](https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/configure-mobile-devices-warehouse), consultado 2026-09-08.
2. Nielsen Norman Group, [Beyond the Hamburger: What Makes Navigation Discoverable on Mobile](https://www.nngroup.com/articles/find-navigation-mobile-even-hamburger/), 2016.
3. Microsoft Learn, [Scan bar codes using a camera in the Warehouse Management mobile app](https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/scan-bar-codes-using-a-camera), consultado 2026-09-08.
4. MercadoLibre Developers, [Órdenes y shipments](https://developers.mercadolibre.com.ar/es_ar/gestiona-ventas/gestiona-ventas), consultado 2026-09-08.
5. WooCommerce, [REST API v3 — Orders](https://woocommerce.github.io/woocommerce-rest-api-docs/), consultado 2026-09-08.

