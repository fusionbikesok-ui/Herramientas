# GP8: Integraciones, cuotas, stock y permisos

**Estado:** publicada  
**Superficie:** Gestión de pedidos / VPS  
**Dependencia:** GP4, GP5, GP6 y GP7 publicadas

## Objetivo

Completar las reglas que conectan la gestión de pedidos con WooCommerce y el inventario, manteniendo control de permisos y trazabilidad de los cambios.

## Alcance

- Enlace administrativo directo al pedido de WooCommerce.
- Lectura de cuotas realmente pagadas desde los datos importados del pedido/plugin, sin inferirlas del texto genérico “hasta 24 cuotas”.
- Cálculo de diferencias de precio según método de pago y cantidad de cuotas.
- Cambios de productos con impacto de stock, motivo obligatorio y auditoría.
- Registro de reintegros sin borrar el pedido original.
- Permisos para editar datos de cliente/entrega y productos.
- Sincronización controlada del estado de envío a WooCommerce cuando el usuario lo confirma.
- No subir tracking a MercadoLibre.

## Entregas internas

1. Permisos y enlace WooCommerce.
2. Cuotas y cálculo de diferencias.
3. Stock, remociones, adiciones y reintegros.
4. Confirmación y sincronización de cambios con WooCommerce.
5. Preview y validación operativa.

## Criterios de aceptación

- Un usuario sin permiso no puede editar datos ni productos.
- El importe adicional o a favor usa las cuotas reales del pedido.
- Toda remoción exige motivo y todo cambio queda auditado.
- Una falta de stock libera o descuenta stock de forma consistente.
- El reintegro se puede marcar como realizado sin ocultar el pedido.
- El enlace WooCommerce sólo se muestra para pedidos WooCommerce.
- Suite focalizada verde antes del gate.
- Suite completa sólo al cerrar GP8; si queda verde, se publica GP8 y se abre GP9.

## Gate

Entregas internas completadas. Evidencia focalizada:

- Permisos `pedidos` aplicados en servidor.
- Cuotas explícitas de WooCommerce/MercadoLibre persistidas.
- Cálculo de diferencias por cuotas sin inventar tasas.
- Cambios, stock por falta de stock y reintegros auditables.
- Actualización de WooCommerce antes de confirmar envío local.
- Suite focalizada de Gestión de pedidos: `15/15` verdes.

Suite completa ejecutada al cerrar GP8:

- `128` archivos pasaron.
- `2416` tests pasaron.
- `51` tests quedaron omitidos.
- Duración: `2033,86 s`.

Resultado: **verde**. GP8 queda publicada y habilita GP9.
