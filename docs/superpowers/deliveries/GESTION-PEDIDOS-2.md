# GP2: Modelo relacional e importación base

**Estado:** candidata  
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

Se conectó la importación administrativa en `POST /api/gestion-pedidos/importar`. Por defecto toma los últimos 30 días; acepta `desde` y `hasta`, consulta WooCommerce con `status=any`, y consulta MercadoLibre recorriendo el universo de estados (`confirmed`, `payment_required`, `payment_in_process`, `partially_paid`, `paid`, `partially_refunded`, `pending_cancel`, `cancelled` y `manually_cancelled`). La lista se puede ajustar con `GESTION_PEDIDOS_ML_STATUSES` y conserva la deduplicación relacional. El endpoint está detrás del guard general de `/api`, por lo que requiere sesión y permisos del panel.

La ruta `GET /api/gestion-pedidos/importar/config` expone únicamente indicadores booleanos de configuración, nunca credenciales, para verificar el VPS antes de lanzar la primera importación. Su prueba confirma que las credenciales no aparecen en la respuesta.

### Verificación de configuración efectiva del VPS 2026-09-09

Se inspeccionó únicamente la presencia de variables en el entorno del proceso activo `node /opt/fusionbikes/herramientas/server.js`, sin imprimir valores ni ejecutar la importación. Resultado: presentes `WOO_URL`, `WOO_CK`, `WOO_CS`, `ML_CLIENT_ID`, `ML_CLIENT_SECRET` y `ML_USER_ID`.

Validación adicional: la ruta acepta adaptadores inyectables para pruebas. `test/gestionPedidosRoute.test.js` verifica el GET de configuración sin secretos, el POST HTTP, el resumen JSON y la persistencia de dos pedidos sin red externa. En total, las pruebas focalizadas de GP2 son `4` aprobadas; ESLint aprobado para los módulos y pruebas de esta entrega.

### Suite completa 2026-09-09 — segundo gate

Comando:

```text
npm test -- --reporter=dot --no-file-parallelism
```

Resultado: **verde**. `127` archivos de test pasaron, `1` quedó omitido; `2400` pruebas pasaron y `51` quedaron omitidas (`2451` totales). Duración: `2246.08s`. El primer gate detectó y corrigió la expectativa explícita de tablas en `test/db.test.js`; esta segunda ejecución valida el estado corregido.

## Gates

- Pruebas focalizadas de esquema, idempotencia, relaciones y casos Woo/ML/físicos/cancelados.
- Revisión de datos importados en una muestra controlada.
- Suite completa únicamente al cerrar la entrega; verde habilita merge directo y GP3.
