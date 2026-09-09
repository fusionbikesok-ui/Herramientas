# GP2: Modelo relacional e importación base

**Estado:** planificada  
**Superficie:** VPS  
**Dependencia:** GP1 aceptada

## Objetivo

Construir el modelo persistente que reemplazará la dependencia de pedidos cache como fuente operativa, conservando el historial y permitiendo gestionar pedidos de WooCommerce, MercadoLibre y ventas físicas.

## Alcance

- Tablas relacionales para pedidos, clientes, direcciones/entregas, productos, ítems, fuentes y estados.
- Eventos de estado y auditoría de cambios.
- Identificadores externos de WooCommerce y MercadoLibre con restricciones de unicidad.
- Importación idempotente del último mes disponible de WooCommerce y MercadoLibre.
- Inclusión de pedidos físicos registrados en WooCommerce.
- Inclusión de pedidos cancelados y pedidos que todavía no llegaron a “listo para enviar”.
- Separación entre estado comercial del pedido y estado operativo de preparación/despacho.
- Contrato para que la cola de envíos consuma sólo pedidos habilitados para despacho.

## Fuera de alcance

- No se habilita todavía el despacho real.
- No se elimina información histórica ni se borra `pedidos_cache` hasta completar verificación y migración.
- No se ejecuta la suite completa hasta cerrar esta ficha.

## Criterios de aceptación

- La importación puede ejecutarse nuevamente sin duplicar pedidos, clientes ni ítems.
- Se conserva la fuente y el identificador externo de cada pedido.
- Los pedidos cancelados permanecen consultables y no se confunden con pedidos despachables.
- Los estados permiten distinguir atención, preparación, despacho, cancelación y cierre.
- Las relaciones permiten consultar un pedido con cliente, productos, cantidades, importes, entrega y eventos.
- La cola de envíos no incluye pedidos sólo por estar importados: exige el estado operativo correspondiente.
- Se documentan migración, rollback, índices y datos no importables.

## Gates

- Pruebas focalizadas de esquema, idempotencia, relaciones y casos Woo/ML/físicos/cancelados.
- Revisión de datos importados en una muestra controlada.
- Suite completa únicamente al cerrar la entrega; verde habilita merge directo y GP3.
