# GP10: Publicación controlada

**Estado:** planificada  
**Superficie:** VPS / operación de tienda  
**Dependencia:** GP9 publicada

## Objetivo

Habilitar la Gestión de pedidos para operación real mediante un despliegue controlado, con acceso restringido, observabilidad y rollback listo.

## Alcance

- Preflight determinista de configuración, backup, migraciones, muestra, permisos y smoke.
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

Preflight implementado en `lib/gestionPedidosPublicacion.js`, con pruebas focalizadas en `test/gestionPedidosPublicacion.test.js`.

GP10 en desarrollo. Suite completa: no ejecutada para GP10.
