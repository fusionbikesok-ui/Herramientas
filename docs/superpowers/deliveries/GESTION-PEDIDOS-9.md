# GP9: Validación operativa controlada

**Estado:** desarrollo  
**Superficie:** VPS / operación de tienda  
**Dependencia:** GP8 publicada

## Objetivo

Validar el flujo completo con una muestra acotada y reversible antes de habilitar la operación diaria.

## Alcance

- Backup verificable antes de importar o modificar datos reales.
- Muestra controlada de WooCommerce y MercadoLibre.
- Verificación de importación idempotente y pedidos físicos.
- Prueba observada de atención, preparación, despacho y recuperación de ventas.
- Validación de permisos con perfiles reales.
- Registro de incidencias y decisiones durante la jornada.
- Procedimiento de rollback documentado y probado sobre staging/copia.
- Capacitación breve y checklist de apertura/cierre.

## Entregas internas

1. Backup, snapshot y restauración controlada.
2. Importación de muestra y reconciliación.
3. Jornada observada de pedidos y envíos.
4. Prueba de recuperación, permisos y excepciones.
5. Informe de aceptación y decisión de publicación.

## Criterios de aceptación

- Se puede restaurar la copia sin pérdida de datos.
- No se duplican pedidos al repetir la importación.
- Todo pedido de la muestra termina en el estado operativo esperado.
- Los cambios sensibles quedan limitados por permisos.
- Las excepciones tienen responsable y resolución documentada.
- Suite focalizada verde antes del gate.
- Suite completa sólo al cerrar GP9; si queda verde y la jornada es aceptada, se publica GP9 y se abre GP10.

## Gate

No ejecutado todavía. GP9 acaba de abrirse tras el gate verde de GP8.
