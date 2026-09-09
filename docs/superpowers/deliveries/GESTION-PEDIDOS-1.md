# GP1: Diseño aprobado de Gestión de pedidos

**Estado:** desarrollo  
**Superficie:** VPS, preview aislada  
**Rama:** `conteo-confiable`

## Objetivo

Cerrar el diseño navegable de Gestión de pedidos antes de implementar el modelo real y las integraciones WooCommerce/MercadoLibre.

## Alcance

- Vistas internas: Requieren atención, En preparación, Despachos, Recuperar ventas y Todos los pedidos.
- Lista compacta con selección múltiple y envío masivo a preparación.
- Buscador por pedido, cliente, teléfono, SKU, EAN y producto.
- Vista rápida derecha de consulta.
- Detalle completo con URL persistente `/gestion-pedidos/pedidos/{id}`.
- Edición separada de datos y productos.
- Añadir productos con buscador visual.
- Remover productos con motivo obligatorio y auditoría.
- Revisión general de cambios, diferencia económica, cuotas, stock y reintegro.
- Recuperación comercial por WhatsApp/Email sin marcar contacto automáticamente.
- Botón para abrir el pedido en WooCommerce mediante URL generada por WordPress.
- Permisos por acción.

## Evidencia disponible

- Preview aislada: `http://179.197.74.83:4173/gestion-pedidos/`
- Detalle de ejemplo: `http://179.197.74.83:4173/gestion-pedidos/pedidos/1001`
- Datos de acceso: `preview-admin` / `preview-only-123!`
- Commits de diseño en `conteo-confiable`, último cambio registrado en `git log`.

### Smoke focalizado 2026-09-09

Comando ejecutado con Playwright/Chromium `--no-sandbox` contra la preview local:

```text
npx eslint scripts/gestion-pedidos-preview-smoke.mjs
node scripts/gestion-pedidos-preview-smoke.mjs
```

Resultado: lint focalizado aprobado para el script y smoke Playwright aprobado: login correcto; `/gestion-pedidos/` cargó; las vistas **Recuperar ventas**, **En preparación**, **Despachos** y **Todos los pedidos** abrieron; `/gestion-pedidos/pedidos/1001` mantuvo URL propia, mostró el detalle y el acceso a WooCommerce; no hubo errores de página. La instalación local de dependencias se hizo sin modificar el lockfile versionado. Captura: `output/playwright/gestion-pedidos-detail-final.png`.

## Criterios de aceptación

- La vista rápida no duplica el formulario de edición.
- El detalle completo mantiene una URL propia y navegación de regreso.
- Los pedidos activos sin cierre confirmado aparecen en Requieren atención.
- Los pedidos en espera de más de un día muestran atención especial.
- Recuperar ventas consolida intentos por cliente y vence al cierre del día hábil siguiente.
- WhatsApp solo copia el teléfono; Email prepara contenido copiable; ninguno confirma el contacto.
- La edición usa cambios pendientes y una confirmación general.
- Remover exige uno de: No lo quiso, No apto para la venta, Falla de stock o Cambio.
- La revisión muestra diferencia según método de pago y cuotas reales.
- El detalle muestra imágenes grandes, SKU, EAN, cantidad y precio.
- La suite completa se ejecuta solo al cerrar esta ficha y habilita merge únicamente si queda verde.

## Pendientes antes del gate

- Revisión visual final en escritorio y móvil.
- Verificación manual de todas las rutas y modales de la preview.
- Evidencia reproducible de autenticación y URL persistente.
- Implementar o registrar el comando exacto de suite aplicable a esta entrega.
- Ejecutar suite completa; si falla, corregir antes de merge.

## Siguiente entrega

**GP2 — Modelo relacional e importación:** tablas de pedidos, clientes, items, estados, fuentes, eventos y sincronización inicial WooCommerce/MercadoLibre.
