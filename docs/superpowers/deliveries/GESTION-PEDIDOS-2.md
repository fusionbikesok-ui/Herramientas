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

## Avance reproducible 2026-09-09

Se agregó la migración `095_gestion_pedidos_relacional.sql` y su registro idempotente en `db/index.js`. La prueba focalizada sobre una base SQLite temporal confirmó la creación de las cinco tablas, el marcador de migración y una inserción relacional de cliente, pedido, ítem y evento.

Comando ejecutado:

```text
node --input-type=module - <<'NODE' ... NODE
```

Resultado: `OK: GP2 migration tables, marker and relational insert`.

Se agregó `lib/gestionPedidos.js` como servicio de persistencia de órdenes normalizadas y la prueba `test/gestionPedidos.test.js`. La importación usa la clave `(fuente, external_id)`, actualiza ítems de forma determinista, conserva cancelados y registra eventos sólo cuando cambia el estado.

Pruebas focalizadas:

```text
npx vitest run test/gestionPedidos.test.js --reporter=dot --no-file-parallelism
npx eslint lib/gestionPedidos.js test/gestionPedidos.test.js
```

Resultado: `1` archivo y `2` pruebas aprobados; ESLint aprobado. La segunda prueba verifica paginación independiente de Woo/ML y que la segunda importación no duplica pedidos.

Se conectó la importación administrativa en `POST /api/gestion-pedidos/importar`. Por defecto toma los últimos 30 días; acepta `desde` y `hasta`, consulta WooCommerce con `status=any`, consulta MercadoLibre para los estados configurados y conserva la deduplicación relacional. El endpoint está detrás del guard general de `/api`, por lo que requiere sesión y permisos del panel.

Validación adicional: ESLint aprobado para `lib/gestionPedidos.js`, `routes/gestionPedidos.js` y `server.js`; las `2` pruebas relacionales siguen aprobadas.

## Gates

- Pruebas focalizadas de esquema, idempotencia, relaciones y casos Woo/ML/físicos/cancelados.
- Revisión de datos importados en una muestra controlada.
- Suite completa únicamente al cerrar la entrega; verde habilita merge directo y GP3.
