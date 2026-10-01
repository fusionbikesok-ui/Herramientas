# Vista previa de reparación de la preparación 446 / pedido 70312

Fecha de consulta: 2026-09-29 UTC. Consulta realizada en modo SQLite `readonly`; no se
ejecutaron llamadas de escritura ni se modificó la base.

## Estado encontrado

- Preparación `446`, clave `web:70312`, estado `completada`, sin filas en
  `preparacion_items`.
- Gestión de pedidos: external ID `70312`, estado de canal `enviadoandreani`, estado operativo
  `cerrado`.
- Cache Woo local: `estado_envio=enviado`; `items_json` contiene `line_item_id=39085`,
  `product_id=56672`, SKU `FB-56672`, Binavi Air, cantidad 1.
- Catálogo: `FB-56672` existe y su GTIN `6970817353054` es EAN-13 válido.
- Actividad de la preparación registra siete lecturas `escaneo_no_coincide`; cuatro identifican
  el producto como `FB-56672`. También constan dos fotos de paquete y evento `completado` por
  Joaco. No consta evento de escaneo válido ni confirmación manual.

## Reparación preparada, no aplicada

No se debe afirmar que el ítem fue escaneado o confirmado manualmente: los eventos no lo
respaldan. Antes de cambiar la historia, confirmar la línea con WooCommerce en vivo y revisar las
fotos originales. Si eso verifica inequívocamente que el producto estaba en el paquete, aplicar
una transacción auditada que:

1. Respalde la base y guarde la vista previa de las filas de preparación, eventos, fotos, pedido
   y línea `39085`.
2. Inserte el snapshot faltante en `preparacion_items` usando `line_item_id=39085`, `product_id=56672`,
   `sku=FB-56672`, cantidad esperada 1, `cantidad_escaneada=0`, `estado_item='pendiente'` y el perfil
   de evidencia calculado por el código vigente.
3. Registre un evento nuevo de corrección con operador, fecha, evidencia revisada y valores antes y
   después. No borre ni edite los eventos originales ni las fotos.
4. Deje la inconsistencia de cierre explícita para resolución supervisada; no marque la línea como
   escaneada, no reabra ni cierre otra vez el pedido y no cree una tarea retroactiva de etiquetas.

La consulta local no sustituye la confirmación live del pedido ni la revisión humana de las fotos.
Este documento es solo una vista previa/procedimiento; despliegue y reparación de producción siguen
siendo un paso operativo separado.
