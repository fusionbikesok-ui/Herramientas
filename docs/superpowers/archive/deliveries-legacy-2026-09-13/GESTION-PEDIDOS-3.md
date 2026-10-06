# GP3: Importación inicial WooCommerce/MercadoLibre

**Estado:** publicada  
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
- Persistir cada corrida en `gestion_pedido_importaciones` con ventana, estado, cantidades y error.
- Consultar las últimas corridas mediante `GET /api/gestion-pedidos/importaciones`.
- No enviar pedidos a preparación ni despacho sólo por importarlos.
- Mantener `pedidos_cache` sin borrado ni mutación destructiva.

## Criterios de aceptación

- La importación de WooCommerce consulta el último mes y conserva pedidos físicos y cancelados.
- MercadoLibre consulta por ventana de fechas para traer el universo vigente; si se configura `GESTION_PEDIDOS_ML_STATUSES`, recorre esos filtros y deduplica una orden que aparezca en más de uno.
- Una segunda corrida produce cero duplicados y sólo actualiza cambios.
- Un fallo de una fuente no borra ni invalida los datos previamente importados de la otra.
- Un pedido importado queda fuera de la cola de despacho hasta tener estado operativo habilitante.
- El resumen de la corrida permite auditar ventana, fuentes, cantidades y errores.
- Se valida una muestra de datos importados antes de habilitar la siguiente entrega.

## Avance reproducible 2026-09-09

Se agregó `gestion_pedido_importaciones` y el endpoint ahora registra cada corrida como `iniciada`, `completada` o `fallida`, con ventana, cantidades, resumen y error. La prueba HTTP conserva la persistencia de pedidos y la suite focalizada de esquema/importación quedó en `13/13` pruebas verdes; ESLint aprobado.

### Muestra controlada en VPS 2026-09-09

Se ejecutó una muestra de sólo 24 horas con lectura de WooCommerce/MercadoLibre y escritura únicamente en `gestion_*`:

- 27 pedidos importados: 20 WooCommerce y 7 MercadoLibre.
- 27 creados, 0 actualizados, 0 duplicados.
- WooCommerce: 16 confirmados, 2 cancelados y 2 fallidos.
- MercadoLibre: 6 confirmados y 1 cancelado.
- 34 ítems relacionados persistidos.
- `pedidos_cache` quedó con 449 filas y no fue modificado por el importador.
- Corrida auditada como `gestion_pedido_importaciones.id=1`.

La muestra no habilitó preparación ni despacho. El proceso activo debe reiniciarse antes de usar el endpoint administrativo, para cargar las migraciones 095/096 en memoria.

### Importación mensual controlada en VPS 2026-09-09

La primera tentativa fue registrada como corrida `id=2` fallida porque el filtro ML `partially_paid` devolvió `400`. Se corrigió el adaptador para consultar el universo por ventana de fechas y la segunda tentativa quedó completada como corrida `id=3`:

- 551 pedidos WooCommerce y 155 MercadoLibre recibidos.
- 706 órdenes procesadas; 679 creadas y 27 ya existentes de la muestra de 24 horas.
- 0 duplicados creados.
- Estados persistidos: WooCommerce confirmado, cancelado, fallido y reembolsado; MercadoLibre confirmado y cancelado.
- `pedidos_cache` permaneció en 449 filas.
- No se enviaron pedidos a preparación ni despacho.

### Gate final 2026-09-09

- Suite completa: `127` archivos pasaron, `1` omitido; `2401` pruebas pasaron, `51` omitidas.
- Duración: `2667.36s`.
- Resultado: verde; GP3 queda publicada y habilita GP4.

## Gates

- Pruebas focalizadas de paginación, estados, duplicados entre filtros, fallo parcial y resumen.
- Corrida controlada read-only o sobre muestra antes de escribir datos reales.
- Suite completa ejecutada al cerrar la ficha; verde habilita merge directo y GP4.
