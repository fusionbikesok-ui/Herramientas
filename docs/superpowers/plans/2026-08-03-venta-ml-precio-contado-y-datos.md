# Venta ML → pedido WC: precio de contado y datos completos de la venta

Fecha: 2026-08-03. Origen: pedido explícito del usuario (segunda vez que lo pide para el precio).

## Problema

`_procesarOrden` en `routes/sync.js` (~líneas 384-460) crea el pedido de WooCommerce a partir
de una venta de ML fijando `subtotal`/`total` de cada línea con el `unit_price` de la orden ML.
El usuario **no quiere el precio de ML en el pedido**: quiere que se registren los productos y
que el precio sea el **precio de contado de la web**.

Además, del comprador hoy solo queda el nickname (`billingWcDesdeOrdenMl`), y no queda registrado
ningún otro dato de la venta.

## Decisiones ya tomadas con el usuario (no re-preguntar)

1. **Precio = contado explícito.** No alcanza con mandar `product_id` + `quantity`: el `price` de
   Woo es el precio de **LISTA**; el de contado es 2/3 (`precioContado()` en `lib/mlPrecios.js`,
   ver memoria `precios-y-errores-sync`). Hay que calcular el contado desde `catalogo_cache.precio`
   del producto ya resuelto y fijarlo en la línea.
2. **Datos a registrar en el pedido, todos escritos UNA SOLA VEZ al crearlo:**
   - envío y destinatario (nombre + dirección de entrega, vía API de shipments de ML);
   - precio pagado en ML y neto, como dato **informativo** (meta/nota), nunca como precio de línea;
   - Nº de orden ML, fecha, nickname y link directo a la venta en ML;
   - método de envío (Flex / colecta / a domicilio).
3. **PROHIBIDO** cualquier actualización posterior del pedido WC que no sea la **cancelación**
   de la compra (la que ya existe en `procesarCancelacionesMl`). Nada de estado de envío, nada
   de tracking que se refresque, nada de polling que toque el pedido.

## Pasos

### 1. Precio de contado en las líneas (`routes/sync.js`, armado de `line_items`)

- Sacar el uso de `item.unit_price` como precio de la línea y el bloque fail-closed asociado
  ("Orden ML sin unit_price…").
- Usar el precio del producto ya resuelto en el caché (`prod`, que sale de `buscarEnCache(db, sku)`)
  → `precioContado(prod.precio)` de `lib/mlPrecios.js`.
- **Sin precio en el caché → NO se pierde la venta (decisión explícita del usuario, 2026-08-03).**
  Si el producto del caché no tiene precio (`null`/0), la línea va igual, con `product_id` /
  `variation_id` + `quantity` y **sin** `subtotal`/`total`: que Woo aplique el precio que tiene
  registrado. No se saltea el ítem, no se aborta el pedido, y **nunca** se cae al precio de ML.
  Se deja un `logSync(..., estado:'error', error:'SKU sin precio en catalogo_cache — línea creada
  con el precio registrado en WC (de lista, no de contado)')` para poder detectar esos casos.
  Ojo: `algunSinMapeo` NO debe marcarse por esto — la línea sí se creó.
- `subtotal`/`total` = `(precioContado * qty).toFixed(2)`.
- Comentario en el código que explique la regla (precio propio de la web, no el de ML) y por qué
  hay que fijarlo a mano en vez de dejar que Woo lo ponga (Woo pondría el de lista).

### 2. Datos de la venta en el pedido

En el mismo POST `/orders` que ya se hace (no agregar un PUT posterior):

- **Envío/destinatario:** si `orden.shipping?.id`, consultar `GET /shipments/{id}` con
  `mlFetch(db, mlCfg, 'GET', ...)`. De la respuesta: `receiver_address` (nombre del receptor,
  calle+número, piso/depto, ciudad, provincia, CP) → objeto `shipping` del pedido WC;
  `logistic_type` / `shipping_option.name` → método de envío.
  **Fail-open a propósito:** si la consulta de shipments falla o la orden no tiene envío, el
  pedido se crea igual sin esos datos (con un `logSync` de aviso). Perder la venta por un dato
  accesorio sería peor que crearla incompleta. Documentarlo en el código.
- **Meta/nota informativa:** `meta_data` con el id de orden ML (el `_ml_order_id` que ya existe),
  precio pagado en ML por ítem y total de la orden, neto estimado y método de envío; más una
  `customer_note` (o nota de pedido) legible con Nº de orden ML, fecha, nickname y link
  `https://www.mercadolibre.com.ar/ventas/{orderId}/detalle`.
  Neto: usar `sale_fee` de `order_items` si viene; **si no viene, no inventarlo** — se omite ese
  dato, no se estima.
- Mantener `billingWcDesdeOrdenMl` para el billing (ML restringe la PII del comprador).

### 3. Tests (vitest, `test/sync.test.js`)

- Una orden ML con `unit_price` distinto del precio del catálogo → el pedido WC se crea con
  `precioContado(catalogo)`, no con el de ML.
- Producto sin precio en `catalogo_cache` → la línea se crea igual, sin `subtotal`/`total`, y
  queda el aviso en el log. El pedido se crea.
- En ningún caso el `unit_price` de ML termina como `subtotal`/`total` de una línea.
- Orden sin envío / shipments que falla o tira error → el pedido se crea igual, con los demás
  datos, y la reserva no queda retenida ni liberada de más.
- Verificar que no se emite ningún PUT/UPDATE al pedido fuera de la cancelación.

**Regresión obligatoria (esto es crítico para el negocio):** los tests existentes de
idempotencia / anti-duplicados de `_procesarOrden` tienen que seguir verdes sin tocarlos, y hay
que cubrir explícitamente que el comportamiento de la reserva atómica (`ordenes_ml_wc_pedidos`,
`retenido_en`, verificación tras POST fallido) no cambió. Si un test viejo hay que modificarlo,
es señal de alarma: reportalo en vez de adaptarlo.

## Criterio de aceptación

- Ningún pedido WC creado desde ML lleva el precio de ML como precio de línea.
- El precio de línea es exactamente 2/3 del `catalogo_cache.precio` del SKU.
- El pedido creado incluye destinatario, dirección, método de envío, Nº/link de orden ML y el
  precio ML como dato informativo.
- `npm test` verde.
- No existe ninguna ruta de código que modifique un pedido WC ya creado, salvo la cancelación.
