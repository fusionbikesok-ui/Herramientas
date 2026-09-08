# Plan específico: historial relacional de despachos

**Fecha:** 2026-09-08  
**Estado:** planificado  
**Alcance:** reemplazar el uso histórico de `pedidos_cache` por un modelo relacional permanente, manteniendo compatibilidad durante la migración.

## Decisión operativa

La operación se separa en cuatro espacios: **Productos a buscar**, **Pedidos a preparar**, **Listos para despachar** y **Despachos**. El historial no depende de haber pasado por “listo para despachar”: un pedido informado como enviado por el canal puede existir sin preparación local y debe mostrarse como **despachado sin registro local**.

## Importación inicial

- MercadoLibre: órdenes y shipments de los últimos 30 días.
- WooCommerce: únicamente pedidos con estado `enviadoandreani` de los últimos 30 días.
- No se importan otros estados Woo en esta entrega.
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

Consultar únicamente `status=enviadoandreani` dentro de la ventana de 30 días; guardar pedido, cliente, líneas y tracking; y cruzar con `preparaciones` por `web:{wc_order_id}`. No inferir preparación porque Woo esté enviado.

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
- Un pedido Web `enviadoandreani` aparece aunque no haya pasado por “listo para despachar”.
- Un pedido con preparación verificada conserva el cruce y sus evidencias.
- Un pedido sin preparación se muestra como “sin registro local”, no como “verificado”.
- Un pack ML con varias órdenes conserva sus relaciones.
- Un shipment de devolución no se mezcla con el envío de ida.
- Repetir la sincronización no duplica pedidos, items, shipments ni eventos.
- Un fallo parcial conserva lo importado y muestra la frescura por fuente.
- La cola operativa no muestra históricos como pendientes.

## Fuera de alcance

- Importar Woo `completed`, `processing` u otros estados en esta entrega.
- Cargar tracking de MercadoLibre desde FusionBikes.
- Reconstruir evidencia fotográfica inexistente.
- Convertir automáticamente un despacho histórico en una preparación.

