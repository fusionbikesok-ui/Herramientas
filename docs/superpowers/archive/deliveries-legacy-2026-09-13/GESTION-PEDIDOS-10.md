# GP10: Publicación controlada

**Estado:** desarrollo  
**Superficie:** VPS / operación de tienda  
**Dependencia:** GP9 publicada

## Objetivo

Habilitar la Gestión de pedidos para operación real mediante un despliegue controlado, con acceso restringido, observabilidad y rollback listo.

## Alcance

- Preflight determinista de configuración, backup, migraciones, muestra, permisos y smoke.
- Health check `GET /healthz` para confirmar proceso y SQLite antes/después del despliegue.
- Configuración final del VPS y variables de entorno.
- Permisos y usuarios operativos definitivos.
- Migraciones y backup previo al despliegue.
- Importación inicial controlada de WooCommerce y MercadoLibre.
- Verificación de pedidos activos, recuperación de ventas, preparación y despacho.
- Validación de enlaces a WooCommerce y trazabilidad de cambios.
- Monitoreo de la primera jornada y checklist de cierre.
- Procedimiento de rollback y criterio de pausa.

## Criterios de aceptación

- El despliegue queda accesible únicamente para usuarios autorizados.
- Las migraciones y el backup se verifican antes de habilitar escritura.
- La muestra operativa coincide con WooCommerce/MercadoLibre sin duplicados.
- Las acciones sensibles respetan permisos y quedan auditadas.
- La primera jornada completa se observa sin incidencias bloqueantes.
- La suite completa se ejecuta sólo al cerrar GP10; si da verde, se publica la entrega final.

## Gate

Preflight implementado en `lib/gestionPedidosPublicacion.js`, con pruebas focalizadas en `test/gestionPedidosPublicacion.test.js`; health check agregado en `GET /healthz`.

## Evidencia actual

- Configuración del VPS: válida, con secreto fuerte y acceso restringido.
- Backup sobre copia sanitaria: íntegro, con `706` pedidos.
- Migraciones 095–098: aplicadas en la base del VPS; integridad SQLite `ok`.
- Conteos iniciales: `706` pedidos; oportunidades, cambios y reintegros nuevos en `0`.
- Smoke de salud real: `GET /healthz` respondió `200` y `{ ok: true, integridad: "ok" }`.
- Muestra controlada: `5/5` pedidos reconciliados, `0` faltantes y `0` duplicados; sin mutar estados.
- Smoke autenticado de preview: login, listado, las cuatro vistas operativas, detalle con URL persistente, enlace a WooCommerce y cero errores de página.
- Permisos: matriz de lectura/escritura y rutas de Gestión de pedidos verificadas con `39/39` tests focalizados verdes; las mutaciones requieren `pedidos:write`.
- Diagnóstico previo de jornada: `706` pedidos y `0` incompletos; `611` confirmados/importados, `68` cancelados/cerrados, `25` fallidos/cerrados y `2` reembolsados/cerrados; `706` eventos auditables.
- Historial de importación: una corrida fallida quedó seguida por una corrida completada de `706` pedidos; debe observarse la lectura operativa de este caso durante la jornada.
- Suite completa para GP10: no ejecutada.

Siguiente bloque: ejecutar la primera jornada observada y completar el checklist operativo; GP10 no se considera aceptada antes de esa evidencia.

## Runbook de jornada observada

El supervisor debe registrar fecha, usuario y hora de cada paso, usando un pedido de muestra que no tenga riesgo comercial:

1. Verificar el backup y abrir Gestión de pedidos con un usuario de lectura.
2. Consultar un pedido confirmado y validar cliente, productos, importes, imágenes y estado.
3. Pasar un pedido de muestra a preparación mediante la acción autorizada.
4. Completar el checklist de preparación y comprobar que el estado cambia una sola vez.
5. Simular el armado de despacho con tracking externo, verificando auditoría y no duplicación.
6. Consultar fotos de preparación desde el detalle del pedido.
7. Probar una acción de edición con usuario sin `pedidos:write` y confirmar rechazo.
8. Ejecutar una lectura de Recuperar ventas y confirmar que no contacta automáticamente.
9. Revisar el evento de cada acción y ejecutar el cierre/rollback de la muestra.

La jornada se acepta sólo si todos los pasos tienen evidencia, no hay duplicados ni mutaciones inesperadas y el supervisor firma el checklist. Hasta entonces GP10 permanece en `desarrollo`.

GP10 en desarrollo. Suite completa: no ejecutada para GP10.
