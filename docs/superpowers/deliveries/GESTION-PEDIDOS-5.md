# GP5: Preparación por lote y checklist

**Estado:** desarrollo  
**Superficie:** Gestión de pedidos + Gestión de envíos  
**Dependencia:** GP4 publicada; catálogo y stock disponibles

## Objetivo

Enviar varios pedidos confirmados a preparación como lote y ejecutar una checklist por producto, con cantidades, imágenes y faltantes visibles para el preparador.

## Alcance

- Selección múltiple desde Todos los pedidos y Requieren atención.
- Endpoint de validación de lote que rechaza antes de mutar los pedidos cualquier cancelado, fallido, reembolsado, estado operativo incompatible o ID inexistente.
- Acción masiva “Enviar a preparación” con validación de estado y confirmación general.
- Registro del lote y de cada transición en eventos auditables.
- Checklist por ítem: pendiente, verificado, faltante o incidencia.
- Imagen de producto, nombre, SKU/EAN y cantidad solicitada en cada línea.
- Posibilidad de salir y volver a entrar al pedido/lote sin perder el progreso.
- Separación explícita entre pedido en preparación y despacho.
- No asignar preparador todavía; esa decisión queda fuera de alcance hasta definir permisos/roles.

## Criterios de aceptación

- La acción masiva no incluye cancelados, fallidos ni reembolsados.
- No se duplica un lote ni se pierde el progreso al reintentar.
- Una cantidad faltante queda registrada sin marcar el producto como verificado.
- La cola conserva el orden y permite reabrir un pedido en preparación.
- Cada cambio de estado registra actor, fecha y pedido afectado.
- Pruebas focalizadas y preview móvil verdes; suite completa sólo al cerrar GP5.

## Gate

Se validará el flujo con datos genéricos y luego con una muestra controlada: seleccionar varios, confirmar el lote, verificar productos, registrar faltantes, salir y volver a entrar. Con la evidencia completa se ejecutará la suite total; sólo si queda verde se publica GP5 y se avanza a GP6.
