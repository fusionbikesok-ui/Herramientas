# C2 — Subir el EAN a Woo desde Consulta de Precios

## Objetivo

Cuando el operador enseña un EAN a un SKU desde Consulta de Precios, conservar el puente
local `ean_sku` y, si el código es un GTIN válido, intentar escribirlo también en Woo como
`global_unique_id`.

## Decisiones

1. Un código que no pasa la validación GS1 se puede enseñar localmente, pero nunca dispara
   una llamada a Woo y devuelve `codigo.estado = "no_valido"`.
2. Un producto con el mismo GTIN devuelve `sin_cambio`.
3. Un producto con otro GTIN devuelve `conflicto` sin modificar Woo ni el mapa local; el
   operador confirma el reemplazo con `pisar_codigo: true`.
4. Si Woo rechaza o no responde, el mapa local se conserva y la respuesta devuelve `fallo`
   con el motivo visible; `catalogo_cache.gtin` solo cambia después de un PATCH exitoso.
5. Un SKU homónimo exige `id_woo`; nunca se elige una fila arbitrariamente.

## Alcance

- `lib/gtinWoo.js`: compartir la validación GS1 con las tres herramientas.
- `routes/consultaPrecios.js` y `server.js`: endpoint de asociación con Woo.
- `public/consulta-precios/index.html`: acción de enseñar y subir, con confirmación de
  conflicto y estado de fallo.
- Tests de contrato y API; E2E queda como gate posterior.

## Aceptación

- Hay tests para no-GTIN, subida exitosa, sin cambio, conflicto, reemplazo, fallo de Woo y
  SKU homónimo.
- La suite dirigida de Consulta de Precios y los tests de Códigos/Inventario siguen verdes.
- El cambio queda documentado, commiteado y publicado antes de pasar a C3.
