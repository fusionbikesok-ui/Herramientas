# GP3: Importación inicial WooCommerce/MercadoLibre

**Estado:** desarrollo  
**Superficie:** VPS  
**Dependencia:** GP2 publicada

## Objetivo

Importar de forma controlada el último mes de pedidos de WooCommerce y MercadoLibre al modelo `gestion_*`, incluyendo ventas físicas registradas en WooCommerce, pedidos cancelados y pedidos que nunca llegaron a “listo para enviar”.

## Alcance

- Ejecutar la ventana por defecto de 30 días mediante `POST /api/gestion-pedidos/importar`.
- Permitir `desde` y `hasta` explícitos para una corrida controlada.
- Mantener paginación, deduplicación e idempotencia.
- Registrar fuente, ID externo, cliente, ítems, estados e importes disponibles.
- Separar estado comercial de estado operativo.
- Registrar resumen de creados, actualizados y errores.
- No enviar pedidos a preparación ni despacho sólo por importarlos.
- Mantener `pedidos_cache` sin borrado ni mutación destructiva.

## Criterios de aceptación

- La importación de WooCommerce consulta el último mes y conserva pedidos físicos y cancelados.
- MercadoLibre recorre todos los estados configurados y no duplica una orden que aparezca en más de un filtro.
- Una segunda corrida produce cero duplicados y sólo actualiza cambios.
- Un fallo de una fuente no borra ni invalida los datos previamente importados de la otra.
- Un pedido importado queda fuera de la cola de despacho hasta tener estado operativo habilitante.
- El resumen de la corrida permite auditar ventana, fuentes, cantidades y errores.
- Se valida una muestra de datos importados antes de habilitar la siguiente entrega.

## Gates

- Pruebas focalizadas de paginación, estados, duplicados entre filtros, fallo parcial y resumen.
- Corrida controlada read-only o sobre muestra antes de escribir datos reales.
- Suite completa sólo al cerrar la ficha; verde habilita merge directo y GP4.
