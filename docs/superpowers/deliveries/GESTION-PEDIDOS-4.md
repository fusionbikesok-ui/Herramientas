# GP4: Gestión funcional de pedidos

**Estado:** desarrollo  
**Superficie:** Home / VPS  
**Dependencia:** GP2 y GP3 publicadas

## Objetivo

Hacer que la Gestión de pedidos permita encontrar y consultar cualquier pedido importado desde un único Home, conservando separados el listado, la vista rápida y la pantalla específica del pedido.

## Alcance de esta entrega

- API relacional de listado con paginación y filtros por estado comercial, estado operativo y fuente.
- Búsqueda por número visible, ID externo, cliente, email, teléfono, nombre de producto, SKU y EAN.
- Conteo de productos y unidades para la lista compacta.
- API de detalle con cliente, entrega, ítems, importes, estados y timeline de eventos.
- Respuesta 404 clara para pedidos inexistentes.
- La preview mantiene las cinco vistas, los contadores clickeables y la URL específica `/gestion-pedidos/pedidos/:id`.
- Lectura sin acciones destructivas; edición, cambios de productos, stock y permisos se implementan en entregas posteriores.

## Criterios de aceptación

- El listado no depende de `pedidos_cache`.
- Buscar por EAN devuelve el pedido que contiene el ítem correspondiente.
- El detalle devuelve todos los ítems y eventos ordenados, sin exponer credenciales.
- Los filtros pueden combinarse y la paginación está limitada para proteger el VPS.
- Un pedido cancelado o físico permanece consultable en Todos los pedidos.
- Pruebas focalizadas verdes; suite completa sólo al cerrar GP4.

## Gate

Antes de cerrar se verificará la navegación de los cinco contadores, búsquedas por cada campo, detalle por URL y responsive móvil. Con la evidencia completa se ejecutará la suite total; si queda verde, se publica GP4 y se avanza a GP5.
