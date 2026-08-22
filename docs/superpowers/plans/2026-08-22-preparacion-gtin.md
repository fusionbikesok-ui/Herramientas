# Plan: asociar EAN desconocido durante Preparación

## Objetivo

Cuando el operario escanea un GTIN/EAN válido que todavía no está relacionado con un
SKU de la preparación, la pantalla debe permitir elegir explícitamente el artículo correcto
sin contar un producto equivocado ni perder el trabajo físico si WooCommerce no responde.

## Alcance implementado

1. `POST /:id/escanear` conserva el flujo SKU existente, resuelve mapas `ean_sku` y GTIN de
   catálogo ya conocidos, y devuelve `necesita_asociacion` con candidatos pendientes para un
   GTIN válido desconocido.
2. `POST /:id/asociar-codigo` valida preparación, artículo y GTIN; frena conflictos de código
   hasta una confirmación explícita (`pisar_codigo`); registra el escaneo y siembra el mapa
   local únicamente para SKUs inequívocos.
3. Cuando WooCommerce está configurado, intenta actualizar `global_unique_id` usando el helper
   compartido. Si Woo falla o no está configurado, el conteo y el mapa local se conservan y la
   respuesta informa `codigo.estado='fallo'` para reintento operativo.
4. La UI de Preparación muestra candidatos como botones grandes, aptos para móvil, con nombre,
   SKU y unidades restantes; los títulos largos se envuelven y los conflictos piden confirmación
   antes de reemplazar el código vigente.

## Verificación

- Tests dirigidos de Preparación para candidatos, asociación local, subida Woo y conflicto.
- Suite completa de `test/preparacion.test.js` con un worker serial.
- Revisión E2E de navegador pendiente: la sesión local no tiene el paquete Playwright importable
  y el wrapper disponible no permite iniciar Chromium sin sandbox; no se publica a PM2 hasta
  cerrar esa puerta y la auditoría de Claude/revisor.
