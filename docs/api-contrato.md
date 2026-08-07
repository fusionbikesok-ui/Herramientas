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

Nota: ante error de la API de ML/Woo el comportamiento por defecto es fail-closed (no se
inventan precios ni se crean pedidos sin datos; se registra el error y se reintenta en el
próximo ciclo), con dos excepciones fail-open explícitas dentro del mismo POST /orders:

- **Precio de línea (2026-08-03, decisión del usuario):** el pedido WC **nunca** lleva el
  precio de venta de ML (`unit_price`) como precio de línea. El precio de cada línea es el
  **precio de contado de la web propia** (`precioContado()` de `lib/mlPrecios.js`, 2/3 sobre
  `catalogo_cache.regular_price`, el precio de LISTA — **nunca** sobre `catalogo_cache.precio`,
  que es el VIGENTE y puede ser un `sale_price` de oferta; usar `precio` ahí "acumularía" el
  descuento de oferta con el de contado). Mientras `regular_price` esté NULL (catálogo sin
  refrescar todavía tras este despliegue — **hace falta un refresco de catálogo antes de que
  el precio de contado sea exacto para productos en oferta**) se usa `precio` como fallback
  transitorio. Si el SKU del caché no tiene ningún precio, la línea se crea igual
  (`product_id`/`variation_id` + `quantity`, sin `subtotal`/`total`) y Woo aplica el precio
  que tenga cargado — **fail-open**: no perder la venta por un dato de precio faltante. Se
  deja un `sync_log` de aviso (`estado='error'`, no marca la orden como `parcial`).
- **Envío/destinatario:** si la orden ML tiene `shipping.id`, se consulta
  `GET /shipments/{id}` de ML (antes de reservar la orden, mismo POST final) para volcar
  destinatario, dirección y método de envío en el campo `shipping` del pedido WC. **Fail-open**:
  si la consulta falla, devuelve un status distinto de 200 (`mlFetch` no lanza por HTTP status,
  hay que chequearlo a mano) o la orden no tiene envío, el pedido se crea igual sin esos datos
  (aviso en `sync_log`, la reserva no se retiene ni se libera de más por esto).
- **Facturación (`billing`) replica el envío (2026-08-05):** con los mismos datos de envío de
  arriba, `billing` del pedido WC replica nombre y dirección del destinatario en vez del
  nickname de ML — las facturas de una venta ML se emiten por otro medio (no por Woo), así que
  la facturación acá no tiene consecuencia fiscal y es más útil con el destinatario real.
  Fallback explícito, siempre nickname + `'MercadoLibre'` como apellido (nunca vacío, para no
  dejar el pedido titulado "de " sin nadie en el admin de Woo):
  - Sin `shipping` (fail-open de la consulta a ML, o la orden no tiene envío): `billing` completo
    cae a `{ first_name: nickname || 'Comprador', last_name: 'MercadoLibre' }`, igual que antes
    de este cambio.
  - Con `shipping` presente pero sin nombre (ML solo dio la calle, `receiver_name` vacío):
    `billing.first_name`/`last_name` caen al mismo fallback de nickname, pero **la dirección
    real del envío se conserva** (`shipping` del pedido WC, en cambio, sigue reflejando
    fielmente lo que dijo ML, incluido el nombre vacío si así vino).

Datos informativos que se agregan en el mismo POST de creación (nunca en un PUT/PATCH
posterior — el único cambio permitido a un pedido WC creado desde ML es la cancelación, ver
`procesarCancelacionesMl`): `meta_data` con `_ml_order_id`, `_ml_precio_pagado_total` (suma de
`unit_price × cantidad` de la orden ML COMPLETA, incluidos ítems sin mapeo que no llegaron al
pedido WC — se omite si algún `unit_price` vino null, para no grabar un total parcial como si
fuera completo), `_ml_neto_estimado` (solo si TODOS los `order_items` traen `sale_fee` Y
todos tienen `quantity<=1` — no está confirmado si `sale_fee` es por unidad o ya multiplicado
por la cantidad, así que con más de una unidad se omite entero antes que arriesgar un neto
falso) y `_ml_metodo_envio`.

Además, **después** de creado el pedido (no es un PUT/PATCH del pedido: es un POST a un
sub-recurso, `POST /orders/{id}/notes` con `customer_note:false`) se agrega una **nota
PRIVADA** (no visible al cliente, a diferencia de `customer_note`) con Nº de orden ML, fecha
en hora local, nickname del comprador y link directo a la venta
(`https://www.mercadolibre.com.ar/ventas/{id}/detalle`). **Fail-open**: si falla, el pedido ya
existe y queda tal cual — no se reintenta, no afecta la reserva ni el sellado en
`ordenes_ml_procesadas`. **Excepción conocida, aceptada** (no es un hueco a cerrar): en el
camino de recuperación donde el POST /orders timeoutea pero el pedido YA existía en Woo
(`wcExistente`, ver más abajo), la nota privada NO se agrega — ese pedido queda sin la nota
informativa, aunque sí con todos los demás datos (line_items, billing, shipping, meta_data).

Caso especial — POST /orders a Woo que falla sin respuesta (timeout, corte de red, 5xx,
429): antes de liberar la reserva y permitir un reintento, el backend verifica contra la
API de Woo si el pedido ya se creó (busca por `after=<fecha de la reserva>` paginando y
matcheando el meta `_ml_order_id` localmente; reintentos con backoff 500/1500/4000ms).
- Si el pedido existe → se adopta ese `wc_order_id`, no se crea otro.
- Si con certeza no existe → se libera la reserva y se reintenta en el próximo ciclo.
- Si la verificación no es concluyente (Woo caída, respuesta con forma inesperada) →
  **fail-closed**: la reserva queda RETENIDA (`retenido_en` seteado), no se reintenta sola
  y requiere intervención manual. Se expone en `GET /api/sync/estado` (ver abajo).
Un rechazo 4xx (salvo 429) no dispara verificación: la request llegó a Woo y fue
rechazada, no hay pedido creado.

### GET /api/sync/estado (campo agregado)
Además de lo que ya devolvía, la respuesta ahora incluye `cooldownMl` (aditivo, no rompe el
contrato existente):

```
"cooldownMl": { "activo": false, "hasta": null, "nivel": -1 }
```

`activo`: true si hay un cooldown global de rate-limit (429) de ML vigente ahora mismo.
`hasta`: ISO string de cuándo vence (null si no está activo). `nivel`: índice en la escala
de backoff 60s/120s/300s/600s (-1 = sin backoff acumulado). Sirve para distinguir "ML en
cooldown hasta las HH:MM" de un sync realmente colgado — ver incidente 2026-08-04.

Además, `pedidos` ahora incluye:

```
"pedidos": {
  "total": 0, "cancelados": 0, "ultimos": [...],
  "reservasRetenidas": {
    "total": 0,
    "ordenes": [{ "ml_order_id": "...", "creado_en": "...", "retenido_en": "..." }]
  }
}
```

`reservasRetenidas` lista (máx. 20) las órdenes de ML cuya creación de pedido en Woo quedó
en estado no verificable. Requieren acción manual:
- si el pedido SÍ existe en Woo:
  `UPDATE ordenes_ml_wc_pedidos SET wc_order_id=<id>, retenido_en=NULL WHERE ml_order_id=<orden>`
- si NO existe: `DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id=<orden>` — con eso
  alcanza, la orden nunca se marca como procesada mientras está retenida, así que el cron
  la reintenta sola en el próximo ciclo.

### POST /api/sync/wc-ml
Dispara manualmente la sincronización de stock de WooCommerce hacia MercadoLibre.
Protegida por el candado `_wcToMlEnCurso`.

Tope por corrida (2026-08-07, revisor M3; corregido a "tope por llamadas a ML" en la ronda 2,
B1 revisor): procesa como máximo `SYNC_WC_ML_MAX_LLAMADAS_ML_POR_CORRIDA` (200) LLAMADAS a ML
(el GET de status de fallback + el PUT de stock), no filas leídas. La query de diffs ya NO
tiene LIMIT: se recorre entera, ordenada por `ml_stock_estado.actualizado_en` ascendente
(NULL/nunca registrado primero), pero los skips (publicación no activa, status desconocido,
bloqueada por límite de fotos) no gastan llamada ni tiempo, así que no pueden agotar el tope
por sí solos. Motivo del cambio: un tope sobre filas leídas podía quedar monopolizado para
siempre por publicaciones pausadas de verdad y sin `ml_stock_estado` — "procesar" una fila solo
envejece el timestamp en el camino feliz (PUT 200), así que esas filas nunca salían de la
cabeza de la cola y el sync quedaba muerto en silencio, sin empujar un solo stock real. Los
diffs/llamadas que no entran no se pierden — la query se recalcula entera cada corrida
(idempotente) y quedan para la siguiente, con el orden garantizando que rotan (no favorece
siempre a las mismas claves). Con el `ML_CALL_DELAY_MS=500`, el peor caso es ~100s por corrida,
muy por debajo del cron de 10 min. Se agregó tras alinear el status de `ml_publicaciones_cache`
con ML real (ver `/api/sync/reconciliar-stock` abajo), que hizo que este flujo dejara de
saltear una masa grande de publicaciones que antes creía pausadas.

- Request: sin body.
- Response 200:
  - `{ "ok": true, "omitido": false }` — corrió la sincronización (hasta el tope de diffs).
  - `{ "ok": true, "omitido": true }` — se salteó por candado activo o config de ML no
    lista; NO sincronizó.
- Response 500: `{ "ok": false, "error": "<mensaje>" }`.

### POST /api/sync/reconciliar-stock
Dispara manualmente un lote de la reconciliación incremental de stock contra ML real
(`reconciliarStockMl`, cron cada 10 min en `:09`, ver `server.js`). Compara
`ml_stock_estado.cantidad_ml` (lo que recordamos haber empujado) contra el `available_quantity`
REAL de ML para publicaciones mapeadas, con multiget en chunks de 20 y pausa de
~1.5s entre chunks (medido: ML devuelve 429 sin esa pausa). Corrige divergencias en
`ml_stock_estado` en ambos sentidos y registra cada una en `sync_log` (`estado: 'reconciliado'`).

**No escribe stock en ML** (la corrección real hacia ML la sigue haciendo `syncWcToMl` en su
próxima corrida, por su camino ya probado), **pero desde 2026-08-07 SÍ escribe**
`status`/`sub_status` **en `ml_publicaciones_cache`** con el dato vivo del mismo multiget —
antes esa tabla era solo-lectura para este flujo. Antes de escribir, toma un snapshot del
status/sub_status guardado por CADA fila/clave (antes de arrancar el multiget, m1 ronda 2
revisor — no un único snapshot por item_id, que dejaba filas divergentes sin poder
actualizarse nunca) y condiciona el UPDATE de esa fila a que siga siendo ese valor
(compare-and-swap por `clave`): si otro flujo (reactivación manual/automática, refresh del
matcher) cambió el status en el medio, su dato es más fresco y gana, no se pisa. Si ML no informó
`sub_status` en la respuesta (atributo ausente), no se toca el valor guardado — nunca se pisa
con `''`. **Deliberadamente NO toca `actualizado_en`** de `ml_publicaciones_cache`: esa columna
es la firma de invalidación del caché de candidatos del matcher (`firmaCandidatos`,
`routes/matcher.js`), que no depende de status/sub_status — tocarla invalidaría ese caché
(recómputo O(publicaciones × catálogo), >120s) en cada corrida del cron sin necesidad.

Fail-closed: si un item queda ausente del multiget (incluye elemento con `code !== 200` dentro
del array, chunk con excepción de red, cooldown 429 — corta el resto de los chunks de la
corrida igual que `syncWcToMl` —, o la respuesta 200 omite el atributo `status`), la cantidad
devuelta no es un número finito, esa fila de `ml_stock_estado` se deja intacta y cuenta como
`sinDato` (no avanza el cursor por esa fila). Si la fila no tiene sku resuelto en la decisión
del matcher, cuenta aparte como `sinSku` (no es una falla de ML, requiere completar el sku).

Divergencias corregidas contra un `ml_stock_estado` ya existente cuentan como `corregidas`.
Filas del universo que todavía NO tenían fila en `ml_stock_estado` (LEFT JOIN, punto ciego
original) se dan de alta directo con el valor real de ML y cuentan aparte como `altas` — no
sumadas a `corregidas`, para no ahogar la señal de sobreventa real detrás del ruido de puesta
al día del primer barrido (~1061 filas la primera vez).

Universo: TODAS las publicaciones con decisión de matcher (`asignar`/`confirmar`) presentes en
`ml_publicaciones_cache`, sin filtrar por `status` (cambio 2026-08-07, caso Starvos: la caché
de status solo se refresca a mano o por este mismo write-back, no hay cron que la mantenga al
día por su cuenta — filtrar el universo por ella dejaba publicaciones activas-y-vendiendo
invisibles para la reconciliación). El multiget resuelve el status real de cada una.

Nota sobre el write-back de status (ronda 2, M2 revisor): el cruce de candidatos del matcher en
sí (`candidatosDeItem`, `lib/matcherEngine.js`) no usa status/sub_status. Pero sí viaja como
`ml_status` en el payload cacheado de `/api/matcher/candidatos` (lo agrega
`construirMLdesdeApi`), y ese campo alimenta el badge/filtro/orden de estado en la grilla del
matcher — `routes/matcher.js` (`remarcarStockResueltos`) re-lee el status vivo de
`ml_publicaciones_cache` en cada request para que ese write-back no quede visible recién en el
próximo refresh manual/restart.

Protegida por el candado `_reconciliarStockEnCurso`. Cursor circular persistido en
`sync_estado` (clave `cursor_reconciliacion_stock`): cada corrida toma el siguiente lote de
hasta 150 publicaciones (`RECONCILIACION_LOTE`, subido de 100 el 2026-08-07 al duplicarse el
universo por sacar el filtro de status) y, al llegar al final del universo, vuelve a empezar.
Si la clave del cursor ya no está en el universo actual, retoma en la siguiente clave
lexicográficamente mayor (no en 0) para no perder la posición del barrido cuando el universo
cambia entre corridas. El cursor solo avanza hasta la última publicación del lote que
efectivamente tuvo dato de ML: si el multiget no devolvió nada útil (429 sostenido, etc.), el
cursor no avanza y la corrida siguiente reintenta el mismo lote en vez de darlo por revisado.

- Request: sin body.
- Response 200: `{ "ok": true, "omitido": false, "revisadas": <n>, "corregidas": <n>, "altas": <n>, "sinDato": <n>, "sinSku": <n>, "statusRefrescados": <n> }`.
  `sinDato` son publicaciones del lote que quedaron sin dato real de ML (fail-closed); no
  cuentan como revisadas a efectos de avance de cursor. `sinSku` son publicaciones sin sku
  resuelto en la decisión del matcher (ML sí contestó). `altas` son publicaciones dadas de alta
  en `ml_stock_estado` por no tener fila todavía (ver arriba); no suman a `corregidas`.
  `statusRefrescados` cuenta items (no filas/variaciones) cuyo status/sub_status se escribió en
  `ml_publicaciones_cache` esta corrida. `omitido: true` cuando no corrió, con
  `motivo: 'en_curso' | 'sin_config'` — no revisó nada.
- Costo: cada POST efectivo dispara hasta 8 llamadas a ML (multiget en chunks de 20 para un
  lote de 150) y bloquea la respuesta ~10.5s (pausa de 1.5s entre chunks).
- Response 500: `{ "ok": false, "error": "<mensaje>" }`.

### GET /api/sync/dashboard (campo agregado)
Además de lo que ya devolvía, incluye:

```
"frenadas": 0,
"vinculos_sospechosos": 0
```

`frenadas`: cantidad de publicaciones que la reactivación automática frenó por precio (ver
`GET /api/sync/frenadas`).

`vinculos_sospechosos`: cantidad de vínculos WC↔ML con al menos una señal vigente de posible
mal matcheo (ver `GET /api/sync/vinculos-sospechosos`).

### GET /api/sync/dashboard — `stock.maxLlamadasPorCorrida` (campo agregado, m3 ronda 2 revisor)
`stock.pendientes` no tiene tope (es el backlog total real), pero `syncWcToMl` solo drena hasta
`SYNC_WC_ML_MAX_LLAMADAS_ML_POR_CORRIDA` llamadas a ML por corrida (ver `/api/sync/wc-ml`
arriba). Sin este dato el panel no puede distinguir "hay backlog grande, drena de a tope cada
10 min" de "el sync está roto y no procesa nada" cuando `pendientes` queda en cientos. Se agrega
`stock.maxLlamadasPorCorrida` (número, valor de la constante) para que el frontend lo muestre si
quiere — no requiere cambios en `public/` de por sí.

### GET /api/sync/frenadas
Publicaciones pausadas por falta de stock que recuperaron stock pero la reactivación
automática NO las reactivó porque el neto de ML queda por debajo del precio de contado
(ver `ml_reactivacion_frenada`, poblada por el cron de reactivación automática).

- Request: sin body.
- Response 200: `{ "ok": true, "data": [{ "clave", "sku", "motivo", "neto", "precio_contado",
  "deficit_pct", "detectado_en", "item_id", "titulo", "thumbnail", "permalink",
  "variations_texto" }] }`, ordenado por déficit descendente y luego por más reciente.
  `variations_texto` viene directo de `ml_publicaciones_cache` (puede ser `null` en
  publicaciones sin variaciones).

### POST /api/sync/frenadas/forzar
Reintenta AHORA la reactivación de las publicaciones frenadas indicadas, sin esperar al
próximo ciclo del cron (caso típico: el usuario acaba de corregir el precio en ML). Reutiliza
`reactivarItems`, que **siempre** aplica el chequeo de neto contra el precio de contado — este
endpoint no es un "forzar a pérdida": si el precio sigue mal, la publicación vuelve a quedar
frenada. Fail-closed deliberado, no se saltea la guarda de precio bajo ningún flag.

- Request: `{ "itemIds": ["MLA123", ...] }`.
- Response 200: `{ "ok": true, "pedidos": N, "procesados": M, "truncado": bool, "resultados":
  [...] }` (`resultados` con el mismo shape que `POST /api/sync/reactivar`).
  - `pedidos`: cantidad de `itemIds` recibidos en el request.
  - `procesados`: cantidad efectivamente procesada. `reactivarItems` trunca internamente a
    un lote máximo de 50 (`LOTE_MAX`); si se piden más de 50, `procesados` va a ser 50 y
    `truncado` va a ser `true` — el cliente tiene que avisar al usuario que quedaron
    `pedidos - procesados` sin tocar (van a entrar en el próximo pedido/ciclo).
  - Las claves de `ml_reactivacion_frenada` correspondientes a los `item_id` que salieron OK
    se borran; las que siguieron bloqueadas quedan (y su `motivo`/`deficit_pct` se actualiza
    en el próximo ciclo del cron).
- Response 400: `{ "ok": false, "error": "MercadoLibre no configurado" }` o
  `{ "ok": false, "error": "itemIds requerido" }`.

## Vínculos WC↔ML

Auditoría de qué publicaciones de ML están mapeadas a cada producto de WC, señales de posible
mal matcheo (`lib/vinculosSenales.js`: `seller_sku`, `atributos`, `precio`) y las acciones para
corregirlas. Que un SKU tenga varias publicaciones NO es señal (multi-publicación intencional
por condiciones de venta distintas).

### GET /api/sync/vinculos/:sku
Detalle de un producto de WC y TODAS las publicaciones de ML mapeadas a su SKU (`sku_matcher_decisiones`
con `accion` en `asignar`/`confirmar`).

- Request: sin body. `:sku` en la URL.
- Response 200: `{ "ok": true, "producto": { "sku", "nombre", "stock", "img", "precio_lista",
  "precio_contado" }, "publicaciones": [{ "clave", "item_id", "variation_id", "titulo",
  "status", "sub_status", "color", "talle", "variations_texto", "seller_sku", "thumbnail",
  "permalink", "precio_ml", "precio_actualizado_en", "stock_ml", "stock_sincronizado",
  "senales": [{ "senal", "peso", "detalle", "valor" }] }] }`.
  `senales` ya viene filtrada de las que el usuario descartó con el mismo valor concreto
  (ver `POST /vinculos/revisado`). `precio_lista` y `precio_contado` salen ambos de
  `catalogo_cache.regular_price` (precio de LISTA), nunca de `precio` (VIGENTE) — ver el
  porqué en el comentario de `precioWebClave()` en `lib/mlPrecios.js`. Ambos son `null` si
  `regular_price` es NULL.
- Response 400: `{ "ok": false, "error": "sku requerido" }`.
- Response 404: `{ "ok": false, "error": "SKU no encontrado en el catálogo" }`.

### GET /api/sync/vinculos-sospechosos
Listado de todos los vínculos con al menos una señal vigente, ordenados por severidad
(los que tienen alguna señal de peso `alta` primero, después por cantidad de señales).

- Request: sin body.
- Response 200: `{ "ok": true, "data": [{ "clave", "sku", "item_id", "titulo", "wc_nombre",
  "thumbnail", "permalink", "precio_ml", "precio_wc", "senales": [...] }] }`.

### POST /api/sync/vinculos/revisado
Marca una señal puntual como revisada y correcta ("descartar"). Persiste el **valor** que
disparó la señal, no solo la clave: si el dato concreto vuelve a cambiar, el descarte deja de
aplicar y la señal reaparece — descartar significa "esta discrepancia concreta está bien",
no "no me muestres más esta publicación". El cliente debe reenviar el `valor` **tal cual** lo
recibió en la señal (comparación por igualdad estricta, no por contención/substring: un
descarte parcial podría tapar en silencio una discrepancia nueva y distinta).

- Request: `{ "clave", "senal", "valor" }` — los tres strings no vacíos.
- Response 200: `{ "ok": true }`.
- Response 400: `{ "ok": false, "error": "clave requerida" }`,
  `{ "ok": false, "error": "senal requerida" }`,
  `{ "ok": false, "error": "valor requerido" }` (sin `valor` se guardaría `null`, que nunca
  coincide con ningún valor real y el cliente creería que descartó sin lograrlo — fail-open
  deliberado del lado de la señal, pero el request debe rechazarse), o
  `{ "ok": false, "error": "La clave no existe en el caché de publicaciones" }` (evita
  descartes huérfanos de claves con typo o publicaciones ya borradas de ML).

### POST /api/sync/vinculos/reasignar
Reasigna manualmente el vínculo (`clave`) a otro SKU de WC. Escribe con el mismo statement
que usa el matcher (`INSERT OR REPLACE INTO sku_matcher_decisiones ... accion='asignar'`) para
no tener un segundo camino de escritura que pueda divergir. Borra los descartes de esa clave
en la MISMA transacción que la reasignación: valían para el vínculo anterior, no para el
nuevo, y si el borrado quedara fuera de la transacción un fallo a mitad de camino dejaría
descartes viejos tapando señales legítimas del vínculo nuevo.

- Request: `{ "clave", "sku" }` — ambos strings no vacíos.
- Response 200: `{ "ok": true }`.
- Response 400: `{ "ok": false, "error": "clave requerida" }`,
  `{ "ok": false, "error": "sku requerido" }`,
  `{ "ok": false, "error": "La clave no existe en el caché de publicaciones" }` (evita crear un
  vínculo fantasma en `sku_matcher_decisiones` que no aparece en ningún listado pero ensucia
  el contador de "necesitan atención" del home), o
  `{ "ok": false, "error": "El SKU no existe en el catálogo" }`.

Nota: `POST /api/sync/desvincular` (ya existente) también borra los descartes de esa clave
en la misma transacción que el borrado del mapeo, por la misma razón de atomicidad.
## Config ML (reservas locales) — configuración masiva

Endpoints agregados para configurar `skus_config_ml` (modo `solo_local`/`reserva`) de a
muchos SKUs de una, además del alta unitaria ya existente (`POST/DELETE /api/sync/config-ml`).
No llaman a ML ni a Woo — operación 100% local sobre sqlite, no aplica la política
fail-closed/fail-open de reintentos externos, solo transaccionalidad local (todo el lote en
una única `db.transaction`, o no se aplica nada).

### GET /api/sync/catalogo-config
Lista paginada del catálogo WC con la config ML de cada SKU (haya o no config), para el
selector masivo del frontend.

- Query params (todos opcionales):
  - `q` — busca en sku o nombre (LIKE, case-insensitive).
  - `marca` — coincidencia exacta de `catalogo_cache.marca`.
  - `categoria` — coincidencia exacta contra alguno de los elementos del array
    `catalogo_cache.categorias_json` (ej. `["Cascos","Indumentaria"]`).
  - `estado` — `sin_config` | `solo_local` | `reserva` (filtra por estado de config).
  - `orden` — `nombre` | `stock` | `sku` | `marca` (default `nombre`).
  - `dir` — `asc` | `desc` (default `asc`).
  - `limite` — default 100, máximo 500.
  - `offset` — default 0.
  - `facetas` — `1` para incluir `marcas`/`categorias` en la respuesta (ver abajo). Sin este
    param no vienen: armarlas es un full scan del catálogo (~3-4ms medidos) que no cambia
    con el filtro ni la página, así que el frontend las pide solo en la primera carga.
- Response 200 (sin `?facetas=1`):
  ```json
  { "ok": true,
    "data": [ { "sku":"X", "nombre":"...", "marca":"...", "stock_wc":5,
                "modo":"reserva"|"solo_local"|null, "reserva":2, "stock_disponible_ml":3 } ],
    "total": 1234 }
  ```
- Response 200 (con `?facetas=1`): agrega además
  `"marcas": ["Shimano", "..."], "categorias": ["Cascos", "..."]`.
  - `modo: null` cuando el SKU no tiene fila en `skus_config_ml` (`reserva:0`,
    `stock_disponible_ml` = `stock_wc`).
  - `total` = cantidad de filas que matchean el filtro SIN paginar (para "seleccionar todos
    los del filtro").
  - `marcas` = marcas distintas no vacías de TODO el catálogo (no del filtro), para el
    desplegable.
  - `categorias` = categorías distintas no vacías de TODO el catálogo (no del filtro),
    parseadas desde `categorias_json` con el mismo helper que usa Cobertura
    (`parseCategorias`, tolera NULL/JSON inválido), ordenadas alfabéticamente.
  - Excluye filas con `sku` NULL o vacío. Dedup por SKU: igual criterio que
    `COMPUTED_STOCK_CTE` (menor stock, menor id_woo) cuando un SKU aparece en más de una
    fila de `catalogo_cache` (dato sucio conocido).
- Response 400: `{ "ok": false, "error": "..." }` si `estado`/`orden`/`dir` no están en el
  enum permitido.
- Permiso: `anyOf: ['config-ml', 'sync-ml']`, nivel `read` (regla explícita en
  `lib/permisos.js`, antes del catch-all de `/sync`; mismo criterio que `/sync/buscar-sku`
  — sin esto, un usuario con solo `config-ml` recibiría 403 al abrir la pestaña, aunque el
  POST del lote sí acepte su permiso).
- Filtro de categoría: `categorias_json` es un array JSON embebido, no una columna propia.
  El filtro se resuelve con `json_each`/`json_valid` de sqlite (extensión JSON1) dentro del
  mismo WHERE — así no rompe la paginación/el `total` ni obliga a traer el catálogo entero a
  Node en cada request paginado. El listado de `categorias` del desplegable, en cambio, sí se
  arma parseando en JS (un solo recorrido del catálogo completo, que es chico): ahí no hay
  paginación que proteger y evita un `json_each`+`GROUP BY` extra en SQL.

### POST /api/sync/config-ml/lote
Aplica `reserva` / `solo_local` / `quitar` a muchos SKUs de una vez, por lista explícita o
por "todo lo que matchea el filtro actual".

- Request:
  ```json
  { "accion": "reserva" | "solo_local" | "quitar",
    "reserva": 1,
    "skus": ["A", "B"],
    "filtro": { "q": "", "marca": "", "categoria": "", "estado": "" },
    "vista_previa": true,
    "esperados": 812 }
  ```
  - `reserva` obligatoria y entero >= 0 (tipo `number` estricto: `""`, `null`, `[]` se
    rechazan con 400) solo si `accion==="reserva"`.
  - Se acepta `skus` **o** `filtro`, nunca ambos ni ninguno (400 si no se cumple).
  - `skus`: se normaliza (trim, se descartan vacíos, dedup preservando orden). Máximo 5000
    por request (400 si se pasa).
  - `filtro`: el backend resuelve los SKUs con la misma lógica de filtrado del GET, sin
    paginar (comparte función interna, no duplica SQL).
  - `vista_previa: true` (booleano estricto, no truthiness) no escribe nada — devuelve el
    mismo `resumen` que devolvería más `esperados` (la cantidad de SKUs resuelta en ese
    momento), para confirmar antes de aplicar un cambio grande.
  - `esperados` (opcional, en la confirmación real): si viene, debe coincidir con la
    cantidad de SKUs que el backend resuelve AHORA (mismo `filtro`/`skus`). Guard
    fail-closed contra la doble resolución: entre la vista previa y la confirmación puede
    correr un refresco de catálogo de Woo o los crons y cambiar el universo — si no
    coincide, responde **409** sin escribir nada (ver abajo) y el frontend debe
    re-previsualizar.
- Reglas de aplicación:
  - Un SKU que no existe en `catalogo_cache` **no se aplica** (fail-closed: no se crea
    config huérfana con nombre inventado) — va a `resumen.inexistentes`.
  - `reserva`/`solo_local` → upsert (mismo `ON CONFLICT` que el alta unitaria), pisa la
    config previa si existía; `reserva` se guarda en 0 para `solo_local`.
  - `quitar` → `DELETE` de `skus_config_ml`; los SKUs sin config previa cuentan como
    `sin_cambio`, no como error.
  - `nombre` sale de `catalogo_cache` (mismo dedup), igual que el alta unitaria.
- Response 200:
  ```json
  { "ok": true, "vista_previa": false,
    "resumen": { "solicitados": 120, "aplicados": 115, "pisados": 12,
                 "sin_cambio": 0, "inexistentes": ["ZZZ"] } }
  ```
  - `pisados` = de los aplicados, cuántos ya tenían config previa (solo aplica a
    `reserva`/`solo_local`, siempre 0 en `quitar`).
  - `sin_cambio` = de los aplicados, cuántos no tenían config previa (solo aplica a
    `quitar`, siempre 0 en `reserva`/`solo_local`).
  - En una vista previa (`vista_previa: true`), el response incluye además
    `"esperados": 812` (misma cantidad que `resumen.solicitados`).
- Response 400: `accion` fuera de enum, `reserva` inválida, `skus`+`filtro` ambos/ninguno,
  `filtro.estado` fuera de enum, o más de 5000 SKUs — siempre `{ "ok": false, "error": "..." }`.
- Response 409: `esperados` no coincide con lo resuelto ahora (el catálogo cambió desde la
  vista previa) — `{ "ok": false, "error": "..." }`. No escribe nada; hay que
  re-previsualizar y reintentar.
- Permiso: `anyOf: ['config-ml']`, nivel `write` (regla `^\/sync\/config-ml(\/|$)` de
  `lib/permisos.js`, ya existente — el POST cae ahí igual que el alta unitaria).

## Preparación de pedidos — perfiles de foto por SKU

Overrides de perfil de foto para un producto puntual. Prioridad de resolución del perfil
de un ítem: **SKU exacto → categoría (substring, `/api/preparacion/perfiles`) →
heurística por nombre**.

Perfiles válidos: `bici` | `kit_transmision` | `sellado`.

El `:sku` se normaliza siempre con `trim()` + mayúsculas (match exacto, no substring).

Los `requisitos_foto` que devuelve el detalle (`GET /api/preparacion/:id`) siguen la misma
prioridad: si existe regla para el SKU, esa regla decide y **no** se mira la categoría — con
`requisitos_json` propio se usa ese, y sin él (o si es JSON inválido) se usan los requisitos
base del perfil ya resuelto por SKU. Solo si el SKU no tiene regla se cae al
`requisitos_json` de la categoría, y en último lugar al del perfil.

### GET /api/preparacion/perfiles-sku
Lista las reglas por SKU, ordenadas por `sku`. Arranca vacía (sin seed).

- Request: sin body.
- Response 200:
  `{ "ok": true, "data": [ { "sku": "FB-52590", "perfil": "kit_transmision", "requisitos_json": null, "actualizado_en": "<ISO>" } ] }`

### PUT /api/preparacion/perfiles-sku/:sku
Upsert de la regla del SKU (no duplica: `ON CONFLICT(sku) DO UPDATE`).

- Request: `{ "perfil": "kit_transmision", "requisitos_json": { "default": ["articulo"] } }`
  (`requisitos_json` es opcional; si se omite queda `null` y se usan los requisitos del perfil).
- Response 200: `{ "ok": true }`.
- Response 400: `{ "ok": false, "error": "sku y perfil válidos requeridos" }` — sku vacío
  o perfil fuera de la lista permitida.

### DELETE /api/preparacion/perfiles-sku/:sku
Borra la regla del SKU. Idempotente: si no existía igual responde `ok`.

- Request: sin body.
- Response 200: `{ "ok": true }`.

Nota: estos tres endpoints son puramente locales (sqlite), no llaman a la API de ML ni de
Woo, así que no aplica decisión de fail-closed/fail-open.

## Preparación de pedidos — Actividad (auditoría por paso)

### GET /api/preparacion/:id (campo agregado)
`data.eventos` — historial completo de eventos de auditoría de la preparación, orden
`id DESC` (más reciente primero). Cada evento: `{ id, preparacion_id, item_id, tipo,
usuario, detalle_json, detalle, creado_en }`. `detalle` es `detalle_json` ya parseado; si
`detalle_json` es inválido o NULL, `detalle` viene como `{}` (nunca tira 500 — la Actividad
es auxiliar y no debe bloquear la apertura del pedido).

### GET /api/preparacion/:id/eventos
Refresco liviano de eventos, sin re-traer items/fotos (pensado para polling cada ~15s).

- Request: query param opcional `desde=<id>` (entero). Si viene y es válido, devuelve solo
  eventos con `id > desde`. Si no viene o no es un entero válido, devuelve todo el
  historial (mismo comportamiento que antes de agregar el filtro).
- Response 200: `{ "ok": true, "eventos": [ { ...igual formato que en GET /:id... } ] }`.
- Response 404: `{ "ok": false, "error": "no encontrada" }`.

### POST /api/preparacion/:id/heartbeat (campo agregado)
Además de `otros` (quién más está viendo la preparación), la respuesta incluye
`ultimo_evento_id`: el `MAX(id)` de `preparacion_eventos` para esa preparación (0 si no hay
eventos aún). Pensado para que el frontend sepa si conviene pedir `GET
/:id/eventos?desde=<ultimo_evento_id_previo>` en el próximo ciclo.

## Contador de Inventario (`/api/inventario`)

Todos los endpoints requieren sesión iniciada; las consultas de sesión están scopeadas
por `req.user.username` (una sesión de otro usuario responde 404, nunca 403 con datos).
El alcance de una sesión es **selección múltiple**: `categorias` y `marcas` son arrays.

Semántica de alcance (`productoEnAlcance`): **OR dentro** de cada dimensión y **AND entre
dimensiones** cuando ambas tienen selección (categoría "Cascos" + marca "Bell" → solo
cascos Bell). El anti-solape entre usuarios usa una función aparte (`productoEnAlcanceOr`)
con semántica OR, a propósito y más conservadora.

### GET /api/inventario/alcance-opciones
Opciones de alcance con cantidad de productos por opción (para los chips).

Query params opcionales `categorias` / `marcas` (varios valores separados por `|` o `,`,
o el mismo param repetido). Si vienen, el conteo queda **condicionado a la selección de
la otra dimensión** usando `productoEnAlcance()` (AND entre dimensiones): el conteo de
cada marca se calcula contra las categorías ya elegidas y viceversa. Una opción que no
intersecta devuelve `productos: 0` — el chip se muestra **deshabilitado, nunca oculto**.
Sin query params el conteo es global (comportamiento previo). La respuesta incluye
`seleccion: { categorias: [], marcas: [] }` con lo que se interpretó del query.

Ejemplo: `GET /api/inventario/alcance-opciones?categorias=Cascos|Cubiertas&marcas=Bell`

```json
{ "ok": true,
  "categorias": [{ "nombre": "Cascos", "productos": 42 }],
  "marcas": [{ "nombre": "Bell", "productos": 12 }] }
```
Ambas listas vienen ordenadas alfabéticamente (locale es). Base: productos con SKU y
`tipo <> 'variable'` (misma base que preview y pendientes).

### POST /api/inventario/alcance-preview
Request: `{ "categorias": ["Cascos"], "marcas": ["Bell"] }` (acepta también los
nombres legados `categoria` / `marca` como string suelto).

```json
{ "ok": true, "categorias": ["Cascos"], "marcas": ["Bell"],
  "productos": 2, "unidades_esperadas": 3,
  "con_stock": { "productos": 1, "unidades": 3 },
  "sin_stock": { "productos": 1 },
  "umbral": 300, "supera_umbral": false }
```
Sin selección devuelve todo en 0 (nunca el catálogo entero). Usa la misma función de
alcance que los pendientes, así el preview coincide exactamente con lo que se abre.

### POST /api/inventario/sesiones
Request: `{ "categorias": [], "marcas": [] }` (al menos una con contenido).
Respuesta 200: `{ ok, sesion }` con `sesion.categorias` / `sesion.marcas` como arrays.
Al crearse se **congela** el alcance (qué SKUs entran y en qué bloque `con_stock` /
`sin_stock`) en `inventario_sesion_alcance`.
- `400` sin categorías ni marcas.
- `409` si el usuario ya tiene una sesión abierta.
- `409` si el alcance se cruza con la sesión abierta de otro usuario:
  `{ ok:false, error, ocupada_por, categorias, marcas }`.

### GET /api/inventario/sesion-activa
`{ ok, sesion|null }` — la sesión abierta propia, con arrays.

### GET /api/inventario/sesiones/:id
```json
{ "ok": true, "sesion": { "...": "", "categorias": [], "marcas": [] },
  "items": [{ "id":1, "ean":"...", "sku":"FB-1", "cantidad":3, "nombre":"...",
              "stock_woo":5, "diferencia":-2, "bloque":"con_stock",
              "fuera_de_alcance": false, "confirmado_por_omision": false,
              "ajustado": false, "ajustado_en": null }],
  "pendientes": [{ "sku":"FB-1", "nombre":"...", "bloque":"con_stock", "marca":"Bell",
                   "categoria_principal":"Cascos", "stock_inicial":5, "stock_woo":5 }],
  "resumen": { "pendientes_con_stock": 2, "pendientes_sin_stock": 1,
               "fuera_de_alcance": 0, "codigos_desconocidos": 0 } }
```
`pendientes` viene ordenado: con-stock primero, después categoría → marca → nombre.
`bloque` está **congelado** al abrir la sesión: si el stock cambia por otra vía durante el
conteo, el ítem no salta de bloque (`stock_woo` sí muestra el valor actual).
`ajustado`/`ajustado_en` en cada ítem sirven para que el historial muestre (y el frontend
filtre) qué quedó sin ajustar en Woo tras un `confirmada_con_errores`; no filtra por estado
de sesión, así que este mismo endpoint sirve para abrir en modo lectura una sesión cerrada
y reintentarla desde `/confirmar`.
`sesion.confirmado_por` trae el usuario que ejecutó el último `/confirmar`; `null` si nunca
se confirmó. Hoy `getSesion()` solo permite operar sobre sesiones propias, así que
`confirmado_por` siempre coincide con `sesion.usuario` — la columna deja registro explícito
de la acción de confirmar/reintentar y queda lista por si en el futuro se habilita que otro
usuario (ej. un admin) reintente una sesión ajena.

### GET /api/inventario/sesiones
Historial de sesiones cerradas (`confirmada`, `confirmada_con_errores`, `descartada`) del
usuario logueado, más recientes primero. `{ ok, data: [sesion, ...] }`, cada `sesion` trae
además `fallidos`: cantidad de conteos con `ajustado_en IS NULL` (0 para `descartada`, que
nunca llegó a intentar el ajuste en Woo). Sirve para que la UI muestre qué sesiones tienen
pendiente un reintento.

### POST /api/inventario/sesiones/:id/escanear
Request `{ "codigo": "..." }` (EAN o SKU; igual desde cámara o lector HID).
Respuesta: `{ ok, item, aviso }`. El ítem trae `estado_codigo` con cuatro valores:

| `estado_codigo` | Qué pasó | Efecto |
|---|---|---|
| `ok` | producto real dentro del alcance | se cuenta y se ajusta en Woo |
| `fuera_de_alcance` | producto real, fuera del alcance elegido | **fail-open**: se cuenta igual y se ajusta; solo aviso |
| `sin_asociar` | EAN válido todavía no vinculado a un SKU | **fail-closed**: `/confirmar` corta con 409 |
| `desconocido` | el código no existe en `catalogo_cache` | **fail-closed**: se guarda con `sku=null`, `/confirmar` corta con 409 |

`fuera_de_alcance` y `codigo_desconocido` son flags separados y excluyentes: el primero es
un producto real que no entra en el alcance elegido (solo aviso), el segundo es un código
sin producto detrás, así que no hay stock que ajustar. Un código desconocido se resuelve
asociándolo a un SKU real (`/asociar`, que limpia el flag) o borrando el ítem.
`aviso` trae el texto listo para mostrar, o `null` si el estado es `ok`.

### POST /api/inventario/sesiones/:id/cerrar-sin-stock
Cierra en 0 los pendientes del bloque `sin_stock`. No es automático: se ofrece al cerrar
la sesión y el usuario elige.
Request: `{ "todos": true }` o `{ "skus": ["SIN-2"] }` — **intención explícita obligatoria**:
un body vacío o `{ "skus": [] }` responde `400` y no cierra nada (fail-closed, porque esto
termina escribiendo stock 0 en Woo al confirmar).
Respuesta: `{ ok, cerrados: 2, skus: [...] }`.
Las filas creadas quedan con `cantidad=0`, `bloque='sin_stock'` y
`confirmado_por_omision=1` (auditoría; se resetea a 0 si después se escanea o se edita
la cantidad a mano). Nunca pisa un conteo hecho a mano (`INSERT OR
IGNORE`) ni toca el bloque con-stock. `400` si la sesión no está abierta.

### POST /api/inventario/sesiones/:id/confirmar
Sin cambios: claim atómico (`UPDATE ... WHERE estado IN ('abierta','confirmada_con_errores')`),
**fail-closed por ítem** al escribir a Woo (un PUT fallido no aborta el resto; la sesión
queda en `confirmada_con_errores` y el reintento procesa solo los no ajustados).
`409` si hay ítems sin asociar a SKU (sin SKU no hay a qué ajustarle stock), con
`{ sin_asociar, codigos_desconocidos, codigos: [...] }` para que la UI explique cuáles son
códigos inexistentes. Corta **antes** de tocar Woo: ningún ítem de la sesión se ajusta.

## Estado del token ML (banner del Home)

Incidente 2026-08: un 429 (rate limit) de ML al refrescar el token se trataba igual que
un 400/401 ("verificar credenciales"), y 9 crons sin backoff reintentaban en loop cada
3-15min manteniendo el 429 — el token quedó vencido 16h. Fix en `lib/mlClient.js`:
clasificación transitorio/fatal, backoff compartido en memoria del módulo (1m→2m→5m→10m,
tope 10m — NO 30m: se comería el margen de renovación), margen de renovación de 60s, más el
presupuesto global de `lib/mlLimites.js` (85% del límite documentado), cron dedicado de
renovación proactiva cada 30min en `server.js`, y alerta por mail (una por episodio) vía
`lib/mailer.js` / `ALERTAS_EMAIL`.

### GET /api/ml/token-estado
Solo lectura, sin permiso de herramienta — cualquier usuario autenticado lo puede consultar
(pensado para el banner del Home). No pega a la API de ML: lee `ml_oauth_token` y el estado
en memoria del último refresh de `lib/mlClient.js`.

- Request: sin body ni query.
- Response 200:
```json
{
  "ok": true,
  "expires_at": "2026-08-04T18:00:00.000Z",
  "actualizado_en": "2026-08-04T12:00:00.000Z",
  "vencido": false,
  "minutos_restantes": 340,
  "motivo": null,
  "requiere_reautorizacion": false,
  "reautorizar_url": "/api/sync/ml-auth-url"
}
```
  - `ok`: `false` si el token está vencido (`vencido:true`) o si el último fallo de refresh
    fue fatal (`requiere_reautorizacion:true`). Un fallo transitorio (429/5xx) con el token
    todavía vigente deja `ok:true` con `motivo` informativo (no bloquea el banner en rojo).
  - `motivo`: mensaje del último error de refresh conocido, o `null` si el último refresh
    (o el actual, si nunca falló) fue exitoso.
  - `requiere_reautorizacion`: `true` únicamente si el último fallo fue 400/401 (refresh_token
    quemado o credenciales inválidas) — nunca ante un 429/5xx transitorio.
  - `reautorizar_url`: path de la ruta existente que arranca el flujo OAuth manual
    (`GET /api/sync/ml-auth-url`, requiere permiso `config-ml`) — para que el banner enlace ahí.
  - Si `ml_oauth_token` no tiene fila (nunca se hizo bootstrap): `vencido:true`,
    `requiere_reautorizacion:true`, `expires_at`/`actualizado_en` en `null`.
## Búsqueda con comodines SQL escapados (fix hallazgo E2E)

`GET /api/codigos/buscar?q=`, `GET /api/sync/buscar-sku?q=` y
`GET /api/consulta-precios/buscar-sku?q=` arman el patrón `LIKE` con `lib/busqueda.js#armarLike`,
que escapa `%`, `_` y la barra de escape antes de envolver el término entre `%...%`, y las
queries usan `LIKE ? ESCAPE '\\'`. Antes de este fix, `q=%` o `q=_` actuaban como comodín
total (devolvían cualquier fila) en vez de buscarse como texto literal. Sin cambio de forma
en la respuesta, solo de comportamiento de búsqueda.

## GET /api/precios (contrato de `total`/`truncado` agregado)

La query interna tiene `LIMIT 1000` (deliberado, se mantiene). Antes, `total` reportaba
`data.length` (el tope del LIMIT) como si fuera el total real, ocultando publicaciones sin
aviso ni paginación. Ahora:

```
{ "ok": true, "total": <COUNT real, sin LIMIT>, "truncado": <bool>, "data": [...] }
```

`truncado=true` cuando `total > data.length` (hay más filas de las que trajo esta
respuesta). El frontend debe mostrar "mostrando N de M" cuando `truncado` sea `true`.

Mismo contrato aplicado en `GET /api/sync/atencion/:cat` (también tenía `LIMIT 500`
reportado como `total: rows.length`): ahora `total` es el COUNT real de esa categoría y se
agregó `truncado`.

## GET/POST /api/auth/* — Cache-Control: no-store

Todas las respuestas de `authRouter` (`/login`, `/logout`, `/me`, `/forgot`, `/reset`,
`/reset/check`) llevan `Cache-Control: no-store` y `Pragma: no-cache`. Antes, `GET /me` sin
este header podía quedar cacheado por el navegador; tras un logout, el botón "atrás"
restauraba una respuesta vieja con el usuario todavía logueado (el servidor sí invalidaba la
sesión — un fetch manual daba 401 — pero el navegador nunca volvía a pedirlo).

## POST /api/auth/login — rate limiting fail-closed por usuario+IP

Nuevo: tras 5 intentos fallidos consecutivos (usuario+IP, en memoria del proceso), cada
falla adicional dispara un bloqueo temporal con backoff creciente (arranca en 1s, dobla por
intento, techo en 60s). Mientras está bloqueado, responde:

- `429 { "ok": false, "error": "Demasiados intentos fallidos. Esperá antes de reintentar." }`
  con header `Retry-After: <segundos>`.

El contador se resetea al primer login exitoso de esa clave, o solo por inactividad si pasan
15 minutos sin ningún intento (para no dejar una cuenta bloqueada de por vida por errores de
tipeo). No aplica límite por cuenta global — es por combinación usuario+IP, así una IP
compartida no bloquea a otro usuario. Ver `lib/auth.js` (`claveRateLimit`, `loginBloqueado`,
`registrarLoginFallido`, `registrarLoginExitoso`).
## Matcher: push automático de SKU a ML

Motor en `lib/matcherPush.js`, expuesto en `routes/matcher.js`. Corre también solo via
cron cada 10 min (server.js) — el botón manual y el cron comparten el mismo motor/mutex,
nunca hay dos corridas en simultáneo. Escribe tanto publicaciones **activas** como
**pausadas** (antes solo activas); las activas van primero en la cola.

Fail-open/fail-closed explícito: **429 de ML (rate limit) no es un fallo de la
publicación** — se reintenta con backoff 350/1000/3000/8000ms y, si persiste, se corta la
corrida ENTERA sin marcar fallo, dejando el resto para el próximo ciclo de cron (fail-open
respecto de esas publicaciones no intentadas). Cualquier otro error (400/403/etc., fallo
real de esa publicación puntual) SÍ se registra en `ml_sku_push_fallos` con backoff
exponencial por publicación (2^intentos horas, tope 24h) — fail-closed respecto de esa
publicación: no se reintenta hasta que venza el backoff.

### POST /api/matcher/push-skus-pendientes
Arranca la corrida en background (no bloquea el request; mismo patrón que
`POST /refrescar-ml`). Una corrida ya no procesa un único lote de 120: cicla tandas de 120
hasta agotar los pendientes, cortar por 429 persistente / error de config-red, o llegar al
tope de tiempo por corrida (5 min, deja margen contra el próximo ciclo de cron a los 10 min).

El cron automático (cada 10 min) aplica una **cuota de 10 publicaciones pausadas distintas
por CORRIDA completa** (las activas entran siempre, sin cuota) para no competir con el sync
por presupuesto de ML — la cuota se descuenta corrida a corrida, no tanda a tanda, así que
un `while` que encadena varias tandas de 120 no la ignora. **Este botón manual ignora esa
cuota** — el usuario disparó la acción a propósito y espera el resultado completo; responde
`cuota_pausadas_ignorada: true` para que quede explícito.

Sigue siendo 1 PUT por variación/publicación (no hay verificación previa ni agrupado en un
único PUT).
- Request: sin body.
- Response 202: `{ "ok": true, "running": true, "cuota_pausadas_ignorada": true }`.
- Response 409 (ya hay una corrida en curso, del botón o del cron):
  `{ "ok": false, "running": true, "error": "Ya hay un push en curso" }`.

### GET /api/matcher/push-skus-pendientes/estado
Sondeo del progreso/resultado de la corrida (en curso o la última terminada).
- Response 200:
  ```json
  {
    "ok": true,
    "running": false,
    "escritos": 12,
    "saltados": 3,
    "errores": 1,
    "restantes": 380,
    "fallos": [
      { "clave": "MLA1|", "sku": "FB-100", "error": "...", "status": 400, "intentos": 1, "proximo_intento_en": "2026-08-03T12:00:00.000Z" }
    ],
    "iniciado_en": "2026-08-03T10:00:00.000Z",
    "fin_en": "2026-08-03T10:00:42.000Z",
    "cortado_por_rate_limit": false,
    "cortado_por_cooldown_propio": false,
    "cortado_por_error": false,
    "cortado_por_cuota": false,
    "cortado_por_tiempo": false,
    "error": null
  }
  ```
- `restantes` se actualiza en vivo durante la corrida (decrementa por cada publicación
  intentada), no solo al terminar — antes quedaba en 0 todo el transcurso.
- `saltados` cuenta las claves que no generaron PUT porque ML ya tenía ese SKU cacheado
  (idempotencia de `escribirSkuEnMl`) — separado de `escritos` para que este último refleje
  llamadas reales a ML, no incluya lo saltado.
- `fallos` es un resumen (tope 20) de la corrida actual/última, no el historial completo
  (para eso, `GET /push-skus-pendientes/list` trae `ultimo_error`/`intentos` por clave desde
  `ml_sku_push_fallos`). Cada fallo con `status` distinto de `0` trae `intentos` y
  `proximo_intento_en` (cuándo se reintenta, según el backoff exponencial). Un fallo con
  `status: 0` (no hubo respuesta de ML: config faltante o error de red) no lleva esos dos
  campos porque no se registró backoff — ver `cortado_por_error`.
- `cortado_por_rate_limit: true` → la corrida se cortó por un 429 **REAL de ML**: se
  agotaron los reintentos cortos (`REINTENTOS_429_MS`, 350/1000ms) y se corta sin marcar
  fallo, para el próximo ciclo de cron. Importante (corrección 2026-08-06, ver docstring de
  `lib/matcherPush.js`): mlFetch activa su propio cooldown ANTES de devolver el 429 real, así
  que el intento siguiente de la misma publicación llega como `__cooldownSintetico` aunque el
  429 que lo originó fue real — ese sintético se sigue tratando como continuación del 429 real
  (consume `REINTENTOS_429_MS`, termina acá) y NO en `cortado_por_cooldown_propio`.
- `cortado_por_cooldown_propio: true` → la corrida se cortó por un 429 **NUESTRO heredado**:
  un `__cooldownSintetico` (cooldown global activado por OTRO de los 9 crons, sin que esta
  corrida haya visto un 429 real todavía) o un `__sinCupo` (presupuesto propio agotado,
  `lib/mlRateLimiter.js`, acotado a `MAX_REINTENTOS_SIN_CUPO` reintentos por publicación) cuya
  espera superaba lo que le quedaba a `TIEMPO_MAX_CORRIDA_MS` (5 min). Mientras la espera
  entra en ese margen, la corrida NO se corta: espera a que venza y reintenta la misma
  publicación. Fail-open igual que `cortado_por_rate_limit`, sin backoff registrado.
  2026-08-06: antes ambos casos caían en `cortado_por_rate_limit` sin distinción, lo que
  ocultó durante días que el push se cortaba solo por nuestro propio cooldown (activado por
  otro de los 9 crons) y nunca llegaba a hablar con ML. Corrección posterior el mismo día
  (commit `737d54a` y siguiente): la distinción original clasificaba mal el caso más común
  en producción (429 real → sintético en el intento siguiente, ver arriba); ahora
  `real429EstaPublicacion` (variable local a cada PUBLICACIÓN, no a la corrida entera, dentro
  de `pushSkusPendientes`) separa "429 real de ESTA publicación" de "cooldown heredado de
  otro cron". IMPORTANTE (corrección posterior, hallazgo del `revisor`): este flag ya NO se
  marca cuando la corrida corta simplemente porque se acabó `TIEMPO_MAX_CORRIDA_MS` sin que
  hubiera habido ningún cooldown/cupo esperando — ver `cortado_por_tiempo` más abajo, que es
  el flag correcto para ese caso.
- `cortado_por_error: true` → la corrida se cortó porque una llamada a ML devolvió
  `status: 0` (no llegamos a hablar con ML). Fail-open: esa/s publicación/es NO se
  penalizaron con backoff (no fueron rechazadas por ML, así que no corresponde tratarlas
  como una publicación con restricciones); se asume que la causa (ej. config de ML faltante,
  caída de red) afecta al resto del lote y se corta para reintentar en el próximo ciclo.
- `cortado_por_cuota: true` → la corrida terminó (procesó todas las activas y vació la
  cuota de pausadas) pero todavía quedan publicaciones pausadas pendientes que no entraron
  por la cuota de 10 por corrida del cron automático (nunca aplica al botón manual, que la
  ignora). No es un corte del `while` como los otros dos flags — la corrida sigue hasta el
  final vaciando activas — sino una explicación de por qué `restantes` no bajó a 0: sin este
  flag, el operador vería "restantes=N" sin ningún motivo, exactamente el riesgo de "cuota
  que esconde trabajo" que motivó la cuota. Se resuelve solo, corrida a corrida del cron.
- `cortado_por_tiempo: true` → la corrida se cortó porque se agotó `TIEMPO_MAX_CORRIDA_MS`
  (5 min) simplemente por volumen de publicaciones sanas (ML respondiendo 200 a todo, sin
  ningún cooldown/cupo propio esperando de por medio). Fail-open: el resto queda para el
  próximo ciclo de cron, sin marcar fallo en ninguna publicación. Se distingue de
  `cortado_por_cooldown_propio` (hallazgo del `revisor`, 2026-08-06): antes los dos
  chequeos del tope de tiempo DENTRO del `for` de publicaciones marcaban
  `cortado_por_cooldown_propio` aunque no hubiera habido ninguna espera real por cooldown/cupo
  — le mentía al operador con "(cortado por cooldown/cupo PROPIO, no es rechazo de ML)"
  cuando en realidad no hubo ningún 429 ni cupo agotado, solo se acabó el tiempo. Ambos flags
  son mutuamente excluyentes en una misma corrida.

### GET /api/matcher/push-skus-pendientes/count
**Cambio de contrato**: ahora incluye pausadas. Excluye claves en backoff (`en_espera`).
- Response 200: `{ "ok": true, "pendientes": 1083, "activas": 393, "pausadas": 690, "en_espera": 24 }`.
  (`pendientes = activas + pausadas`, listas para intentar ahora; `en_espera` son las que
  tienen un fallo reciente con `proximo_intento_en` futuro, no cuentan en `pendientes`).

### GET /api/matcher/push-skus-pendientes/list
**Cambio de contrato**: ya no filtra por `status='active'`; agrega `status` de la
publicación y, por LEFT JOIN a `ml_sku_push_fallos`, `intentos`/`ultimo_error`/
`proximo_intento_en` (todos `null` si nunca falló). Orden: activas primero, luego por
`d.actualizado_en DESC`.
- Response 200: `{ "ok": true, "data": [{ "clave", "sku", "titulo", "thumbnail", "item_id", "status", "intentos", "ultimo_error", "proximo_intento_en" }] }`.
