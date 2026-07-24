# Contrato de API — herramientas FusionBikes

Fuente de verdad del contrato entre el backend Express y el frontend interno (`public/`).
Texto simple, no OpenAPI. Documentar acá todo endpoint que se agregue o cambie.

## Sincronización ML ↔ WooCommerce

### POST /api/sync/ml-wc
Dispara manualmente la sincronización de ventas de MercadoLibre hacia pedidos de
WooCommerce (equivalente al ciclo del cron). Protegida por el candado `_mlToWcEnCurso`.

- Request: sin body.
- Response 200:
  - `{ "ok": true, "omitido": false }` — corrió la sincronización.
  - `{ "ok": true, "omitido": true }` — se salteó porque ya había una corrida en curso
    (candado activo) o la config de ML no está lista; NO sincronizó.
- Response 500: `{ "ok": false, "error": "<mensaje>" }`.

Nota: ante error de la API de ML/Woo el comportamiento es fail-closed (no se inventan
precios ni se crean pedidos sin datos; se registra el error y se reintenta en el próximo
ciclo).

### POST /api/sync/wc-ml
Dispara manualmente la sincronización de stock de WooCommerce hacia MercadoLibre.
Protegida por el candado `_wcToMlEnCurso`.

- Request: sin body.
- Response 200:
  - `{ "ok": true, "omitido": false }` — corrió la sincronización.
  - `{ "ok": true, "omitido": true }` — se salteó por candado activo o config de ML no
    lista; NO sincronizó.
- Response 500: `{ "ok": false, "error": "<mensaje>" }`.
