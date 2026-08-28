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

**`nivel` ya NO baja al primer éxito** (corregido 2026-08-08: con los ~9 crons pegando a
recursos distintos, siempre hay un 200 barato entre dos 429, y bajar el nivel por eso hacía
que el backoff nunca escalara de verdad — medido: 0 veces llegó al techo en 4000 líneas de
log real). Ahora `nivel` solo decae por tiempo: 15 minutos sin que se arme un cooldown
nuevo. Consecuencia visible para quien lea este campo: combinaciones antes imposibles como
`{ "activo": false, "hasta": null, "nivel": 3 }` son normales — significa "ahora mismo no
estamos frenados, pero el próximo 429 va a costar 10 minutos porque venimos escalando".

También incluye `erroresMl` (2026-08-07, trazabilidad de errores — aditivo):

```
"erroresMl": {
  "sinteticos": { "cooldown_sintetico": 0, "sin_cupo": 0 },
  "porRecurso": { "lectura": { "cooldown_sintetico": 3, "sin_cupo": 0 }, ... }
}
```

Contadores **acumulativos desde que arrancó el proceso** (no por ventana) de los 429
sintéticos que `mlFetch` genera sin pegarle a ML: `cooldown_sintetico` (cortó porque el
cooldown global estaba activo) y `sin_cupo` (cortó por presupuesto agotado, ver
`lib/mlLimites.js`). `porRecurso` desglosa por `clasificarRecurso` (`lectura`/`escritura`/
`oauth`). Sirve para distinguir en vivo, sin gastar una sola llamada a ML, "ML nos
rechazó de verdad" (ver logs `[ML][error]` y `[ML] 429 real de ML — cooldown activado`)
de "nos frenamos solos" — ver `lib/mlClient.js` para el porqué de la distinción.

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

Espera-y-reintento ante 429: si un chunk devuelve 429, en vez de cortar la corrida directo, se
consulta `estadoCooldownMl().hasta` y, si el tiempo restante hasta esa expiración es ≤
`RECONCILIACION_ESPERA_MAX_COOLDOWN_MS` (90s), la corrida **espera** (nunca menos de
`RECONCILIACION_PAUSA_CHUNK_MS`, aunque el cooldown esté por vencer — evita salir en ráfaga) y
**reintenta ese mismo chunk una vez**. Un solo reintento por corrida (no por chunk): si el
reintento también da 429 (o falla por timeout/red), corta como antes
(`cortadoPor429`/`sinDato`, cursor no avanza para esa fila). Si el cooldown a esperar es mayor
a 90s, o si el 429 no tiene cooldown activo asociado (`hasta: null`, ver abajo), no espera y
corta directo. El candado `_reconciliarStockEnCurso` puede quedar tomado hasta 90s más por
esta espera, pero el ciclo siguiente es 10 min después, así que nunca se solapan.

Nota (evidencia medida, 2026-08-07): 108 corridas seguidas se vieron cortadas en el primer
chunk pese a que el cooldown estaba libre justo antes de arrancar — 429 intermitente real de
ML, cuota compartida fuera de nuestro control (ver `lib/mlLimites.js`). Este mecanismo no
aumenta la carga sobre ML: la llamada reintentada es la misma que se iba a hacer en el ciclo
siguiente, y `RECONCILIACION_PAUSA_CHUNK_MS`/la serialización de chunks no cambian.

- Request: sin body.
- Response 200: `{ "ok": true, "omitido": false, "revisadas": <n>, "corregidas": <n>, "altas": <n>, "sinDato": <n>, "sinSku": <n>, "statusRefrescados": <n>, "esperasCooldown": <0|1> }`.
  `sinDato` son publicaciones del lote que quedaron sin dato real de ML (fail-closed); no
  cuentan como revisadas a efectos de avance de cursor. `sinSku` son publicaciones sin sku
  resuelto en la decisión del matcher (ML sí contestó). `altas` son publicaciones dadas de alta
  en `ml_stock_estado` por no tener fila todavía (ver arriba); no suman a `corregidas`.
  `statusRefrescados` cuenta items (no filas/variaciones) cuyo status/sub_status se escribió en
  `ml_publicaciones_cache` esta corrida. `esperasCooldown` es 1 si la corrida esperó y
  reintentó un chunk tras un 429 (haya salido bien o mal el reintento), 0 si no hubo 429, si el
  cooldown a esperar superaba el tope, o si el 429 no tuvo cooldown activo asociado (429 por
  falta de cupo propio, `__sinCupo` en `lib/mlClient.js`, con `hasta: null`) — este último caso
  es el que más se va a ver en la práctica: un `esperasCooldown: 0` junto con `cortadoPor429`
  no implica que el cooldown superara los 90s, puede ser que no hubiera cooldown que esperar.
  `omitido: true` cuando no corrió, con
  `motivo: 'en_curso' | 'sin_config'` — no revisó nada.
- Costo: cada POST efectivo dispara hasta 8 llamadas a ML (multiget en chunks de 20 para un
  lote de 150) y bloquea la respuesta ~10.5s (pausa de 1.5s entre chunks); si hubo un 429 con
  reintento, hasta ~90s adicionales de espera (una sola vez por corrida).
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
mal matcheo (ver `GET /api/cobertura/vinculos-sospechosos`).

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

## Vínculos WC↔ML — MOVIDO a `/api/cobertura/vinculos*`

**Matcher unificado, entrega 1 (2026-08-14)** — ver la sección al final del documento.
`public/vinculos/index.html` se retira
(`/vinculos` ahora redirige). El motor (`filasDeVinculos`, `cargarDescartes`,
`senalesVigentes`, `logSync`) se mantiene en `routes/sync.js` (lo sigue usando `GET
/api/sync/dashboard` para `vinculos_sospechosos`) y se reusa por export, no se duplicó. El
texto de abajo describe el **comportamiento** (sigue vigente tal cual, cambiaron las rutas y
se sumó admin-only a desvincular) — se deja como referencia funcional.

Auditoría de qué publicaciones de ML están mapeadas a cada producto de WC, señales de posible
mal matcheo (`lib/vinculosSenales.js`: `seller_sku`, `atributos`, `precio`) y las acciones para
corregirlas. Que un SKU tenga varias publicaciones NO es señal (multi-publicación intencional
por condiciones de venta distintas).

### GET /api/cobertura/vinculos/:sku (antes `/api/sync/vinculos/:sku`)
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

### GET /api/cobertura/vinculos-sospechosos (antes `/api/sync/vinculos-sospechosos`)
Listado de todos los vínculos con al menos una señal vigente, ordenados por severidad
(los que tienen alguna señal de peso `alta` primero, después por cantidad de señales).

- Request: sin body.
- Response 200: `{ "ok": true, "data": [{ "clave", "sku", "item_id", "titulo", "wc_nombre",
  "thumbnail", "permalink", "precio_ml", "precio_wc", "senales": [...] }] }`.

### POST /api/cobertura/vinculos/revisado (antes `/api/sync/vinculos/revisado`)
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

### POST /api/cobertura/vinculos/reasignar (antes `/api/sync/vinculos/reasignar`)
Reasigna manualmente el vínculo (`clave`) a otro SKU de WC. **NO es admin-only** (a
diferencia de desvincular, ver abajo): corrige un vínculo equivocado apuntándolo al SKU
correcto, es trabajo normal de la cola, no una acción destructiva. Borra los descartes de esa
clave en la MISMA transacción que la reasignación: valían para el vínculo anterior, no para el
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

### POST /api/cobertura/vinculos/:clave/desvincular (nuevo, **ADMIN-ONLY**)
Borra el mapeo (`sku_matcher_decisiones` + descartes de `ml_vinculos_revisados`) para que la
publicación se vuelva a linkear. Equivalente conceptual de `POST /api/sync/desvincular` (que
**sigue existiendo tal cual, sin tocar** — lo usa `public/sync-detalle/index.html`, otra
herramienta con otro permiso; no se fusionaron para no acoplar dos consumidores distintos a
un único endpoint con reglas de acceso distintas). Rechaza con `403` si `req.user.is_admin`
no es `true` (`requireAdmin`, `lib/auth.js`) — Joaco (no-admin) puede reasignar pero no
desvincular.

- Request: sin body, `:clave` en la URL.
- Response 200: `{ "ok": true, "borradas": N }`.
- Response 403 (no-admin): `{ "ok": false, "error": "Requiere administrador" }`.

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

## Preparación de pedidos — fotos: subida instantánea + cola de procesamiento (2026-08-12)

Antes, `POST /:id/foto` convertía HEIC→JPEG de forma sincrónica dentro del request (`heic-
convert`, libheif compilado a JS puro — el sharp/libvips de este VPS no trae decoder HEIC por
la licencia HEVC). Eso bloqueaba el único hilo de Node **3-7 segundos enteros por foto**
(medido en el VPS con fotos reales de iPhone) — mientras duraba, la app no respondía a nadie,
no solo a quien subía la foto. Ahora el request solo guarda el archivo **tal como llegó** y
responde al instante; una cola en segundo plano (`lib/fotosPreparacionCola.js`), corriendo la
conversión en un worker thread aparte, genera una versión liviana. Medido: con el worker, el
hilo principal queda con ~9ms de atraso máximo durante la conversión (vs. ~5900ms bloqueado
corriendo en línea).

**Cambio de contrato en el objeto `foto`** (afecta `POST /:id/foto`, `GET /:id`,
`GET /:id/eventos` y cualquier lugar que liste `preparacion_fotos`):

- `url`: ahora es el archivo **original, tal cual se subió** (sin re-encodear) — nunca se
  toca ni se pierde. Antes era siempre un `.jpg` convertido; ahora conserva la extensión real
  (`.heic`, `.png`, `.jpg`, lo que haya mandado el cliente). Es servible por HTTP desde el
  instante de la subida.
- `url_liviana` (nueva): la versión procesada (JPEG, rotada por EXIF, lado largo ≤1600px,
  calidad 78) que llena la cola cuando termina. `NULL` hasta que `estado_proceso='listo'`.
  **Fotos que ya existían antes de este cambio quedan con `url_liviana=NULL` para siempre**
  (su `url` YA es el jpeg final del pipeline viejo) — el frontend debe mostrar `url_liviana ??
  url`, nunca asumir que `url_liviana` siempre está.
- `estado_proceso` (nueva): `'pendiente' | 'procesando' | 'listo' | 'error'`. Filas previas a
  este cambio migran a `'listo'`.
- `es_heic` (nueva): `0` o `1`, detectado en el momento de la subida.
- `intentos`, `ultimo_error`, `proximo_intento_en`, `procesado_en` (nuevas): estado de la cola
  para esa foto. `ultimo_error` es el mensaje de la librería (heic-convert/sharp), nunca
  contenido del archivo.

### POST /api/preparacion/:id/foto (comportamiento cambiado)
- Sigue aceptando `multipart/form-data` con campo `archivo` (límite 15MB), `item_id` y `tipo`
  opcionales en el body.
- El guard de "solo imágenes" (mimetype `image/*` o extensión `.heic`/`.heif`) sigue siendo
  sincrónico y sigue devolviendo 400 `{ ok: false, error: 'solo imágenes' }` si no matchea.
- **Ya no valida que el contenido sea una imagen real decodificable** (antes lo hacía sharp
  dentro del request, con 400 `'no se pudo procesar la imagen'` si fallaba) — decidir eso
  exigiría el mismo trabajo bloqueante que se está evitando. Un archivo corrupto o que no sea
  una imagen real se guarda igual como "original" y la cola lo marca `estado_proceso='error'`
  cuando falla la conversión (fail-open en la subida, fail-closed en el procesamiento: nunca
  se muestra `'listo'` con datos basura, nunca desaparece en silencio).
- Response 200: `{ "ok": true, "foto": { ...id, url, url_liviana:null, estado_proceso:
  'pendiente', es_heic, ... } }` — inmediato, sin esperar la conversión.

### POST /api/preparacion/:id/foto/:fotoId/reintentar (nuevo)
Reintento manual de una foto que agotó sus 3 intentos automáticos (backoff 500/1500/4000ms,
ver `lib/fotosPreparacionCola.js`) y quedó en `estado_proceso='error'`. Le da otra tanda
completa de 3 intentos — útil porque no se pudo reproducir de forma determinística la causa
exacta de un fallo de `heic-convert` con las muestras disponibles (ver el plan), así que un
reintento manual puede resolver algo transitorio.

- Response 200: `{ "ok": true, "foto": { ...estado_proceso: 'pendiente', intentos: 0, ... } }`.
- Response 400: `{ "ok": false, "error": "la foto no está en estado de error" }` — si la foto
  está `pendiente`/`procesando`/`listo`, no hay nada que reintentar.
- Response 404: preparación o foto inexistente.

## Preparación de pedidos — escaneo obligatorio y evidencia (2026-08-12)

Incidente disparador: un pedido de 5 unidades salió con 1 porque `confirmar-manual` (el
atajo que salta el escaneo) verificaba de un saque sin escanear nada, y era el 48% de los
ítems reales. Cambios de esta ronda:

### POST /api/preparacion/:id/item/:itemId/confirmar-manual (comportamiento cambiado)
Ya no es gratis. Requiere `motivo` de una lista corta — sin él, 400 y no se toca el ítem.
Cualquier usuario puede usarla (no se restringe a admin); motivo, usuario y hora quedan en
`preparacion_eventos` (evento `tipo:'escaneo'`, `detalle.origen:'manual'`,
`detalle.motivo`, `detalle.detalle_texto`).

- Request: `{ "motivo": "codigo_ilegible" | "sin_etiqueta" | "otro", "detalle_texto": "..." }`.
  `detalle_texto` es obligatorio (y no puede ser solo espacios) cuando `motivo` es `"otro"`;
  para los otros dos motivos es opcional y se ignora si viene.
- Response 200: igual que antes — `{ "ok": true, "item": {...} }`.
- Response 400: `{ "ok": false, "error": "motivo requerido (uno de: codigo_ilegible, sin_etiqueta, otro)" }`
  o `{ "ok": false, "error": "detalle_texto requerido cuando motivo es \"otro\"" }`.
- Response 404: preparación o ítem inexistente (sin cambios).
- Re-confirmar un ítem ya `verificado` sigue siendo no-op para el evento (no duplica), pero
  igual exige `motivo` válido en el request — no hay atajo para saltear la validación.

### GET /api/preparacion/:id (campo agregado: `requisitos_foto` con nota de cantidad)
Cuando un ítem tiene `cantidad_esperada > 1`, el slot de foto "de artículo" (o "de piezas"
en `kit_transmision`) lleva la cantidad anotada en `etiqueta`: *"... — que se vean las N
unidades (control humano, no verificable por el sistema)"*. **Esto NO es una validación
automática** — el backend no puede comprobar que la foto muestre realmente N unidades
(se podría fotografiar 5 piezas sueltas y empacar 1 igual). Es un texto para que la
interfaz se lo pida explícitamente al operario; el control real lo hace la persona que
mira la foto después, ante un reclamo. Las reglas de perfil/categoría/SKU que ya existían
(`requisitosParaItem`) no se reemplazan — este piso se agrega encima, no las sustituye.
La nota se agrega al slot cuyo `tipos` incluye `articulo`/`piezas`; si ninguno matchea por
nombre (bici `re_embalada`, o un `requisitos_json` custom con tipos propios por SKU/
categoría) se anota el **primer** slot como fallback — nunca desaparece en silencio.

### POST /api/preparacion/:id/completar (comportamiento cambiado: fotos de paquete)
Además de lo que ya exigía (todos los ítems `verificado`, con sus fotos de artículo según
perfil), ahora exige **dos fotos generales de la preparación** (no atadas a un ítem,
`item_id: null` en `preparacion_fotos`), subidas con `POST /:id/foto` sin `item_id` y
`tipo` en `'paquete_abierto'` / `'paquete_cerrado'`:

- `paquete_abierto`: el paquete abierto, con todo el contenido a la vista antes de cerrar.
- `paquete_cerrado`: el paquete ya cerrado, con la etiqueta puesta.

Ambas obligatorias para el cierre **final** (transición a `completada`). Si la preparación
tiene algún ítem `deposito_delegado` pendiente, el primer `/completar` la deja en
`pendiente_deposito` **sin** exigir estas dos fotos todavía (el paquete no está sellado —
falta lo que agregue el depósito); se exigen recién en el `/completar` que efectivamente
cierra.

- Response 400 (fotos de paquete faltantes): mismo shape que las fotos por ítem —
  `{ "ok": false, "error": "preparación incompleta", "faltantes": [{ "item_id": null, "sku": null, "nombre": "Paquete armado", "motivo": "fotos", "faltan": [...] }] }`.
- Response 400 (nuevo): `{ "ok": false, "error": "esta preparación está cerrada y no se puede completar así — pedile a un compañero que la reabra" }`
  si `estado='cerrada_sin_evidencia'` — no se completa directamente, hay que reabrir con
  `POST /:id/reabrir` antes (deja rastro de quién reactivó el caso). El mensaje al operario
  es deliberadamente genérico (no menciona el endpoint); el detalle va a `console.error`.
- Response 409 (nuevo, defensa en profundidad): `{ "ok": false, "error": "la preparación cambió de estado mientras se completaba, volvé a intentarlo" }`
  — si el `UPDATE` final (`WHERE id=? AND estado<>'cerrada_sin_evidencia'`) no afecta
  ninguna fila porque otro proceso (cron, script de mantenimiento) cerró la preparación sin
  evidencia justo en el medio. No hay TOCTOU posible dentro de un solo proceso (sin `await`
  entre la lectura del estado y este `UPDATE`), es defensa contra dos procesos corriendo en
  paralelo.

### POST /api/preparacion/:id/escanear, /item/:itemId/confirmar-manual, /foto (guard de estado agregado)
Los tres rechazan con 400 si la preparación está `completada` o `cerrada_sin_evidencia` —
antes se podía escanear/confirmar/subir fotos sobre una `cerrada_sin_evidencia` sin pasar
por `/reabrir`, así que el evento `reabierta` (el rastro de "entró un reclamo y alguien la
reactivó") podía quedar registrado después de haber tocado datos, o directamente nunca.
`despachada_sin_verificar` y `pendiente_deposito` siguen siendo trabajables (para que
`/completar` las pueda subir a `completada` más adelante, o para que el depósito termine su
parte).

- Response 400: `{ "ok": false, "error": "esta preparación está cerrada — pedile a un compañero que la reabra antes de seguir" }`
  (`cerrada_sin_evidencia`) o `{ "ok": false, "error": "ya completada" }` (`completada`).

### Estado nuevo: `despachada_sin_verificar` — cargar el tracking ya NO fuerza `completada`
**Bloqueante crítico de esta ronda:** antes, `POST /seguimientos/:wcOrderId` (y el cron
`reintentarColgadosTracking`) marcaban la preparación como `completada` sin mirar ítems,
fotos NI el estado previo — un camino más rápido que el propio `confirmar-manual` para
"verificar" un pedido sin escanear nada (etiqueta lista → nunca se abre la preparación →
cargar tracking → `completada` con 0 escaneos y 0 fotos).

**El flujo de WooCommerce no cambia**: cargar el tracking sigue pasando el pedido a
`completed` (dispara el mail al cliente) y después al status final (`enviadoandreani`) —
eso es correcto y necesario, el envío sale igual. **Lo que cambia es el estado INTERNO** de
la preparación (`marcarPreparacionEnviada`, misma función para el endpoint y el cron):

- Si la preparación ya estaba completamente verificada (mismo criterio que `/completar`:
  todos los ítems `verificado` con sus fotos, y las dos fotos de paquete) → `completada`,
  como antes.
- Si NO → **`despachada_sin_verificar`**: el pedido salió igual, pero el sistema no puede
  afirmar una verificación que no ocurrió (mismo espíritu que `cerrada_sin_evidencia`).
  Queda un evento `tipo:'despachado_sin_verificar'` en `preparacion_eventos`.
- **Nunca pisa una `cerrada_sin_evidencia`**: si el estado al momento de cerrar el paso 2
  es `cerrada_sin_evidencia`, ni `completada` ni `despachada_sin_verificar` la reemplazan
  (el `UPDATE` lleva `AND estado<>'cerrada_sin_evidencia'` en el `WHERE`, además del chequeo
  previo). `woo_paso2_pendiente` sí se limpia siempre — es un flag del lado Woo, no de
  verificación.
- Sigue siendo trabajable con el flujo normal (escanear/confirmar/fotos) y, si más tarde
  queda todo verificado, `/completar` la puede subir a `completada`.
- Sale de `GET /pendientes` (mismo criterio que `completada`/`cerrada_sin_evidencia`: ya
  salió, no es trabajo pendiente) y **no se mezcla** con `GET /historial` (solo trae
  `completada`/`pendiente_deposito`) — se consulta desde `GET /despachadas-sin-verificar`.

#### GET /api/preparacion/despachadas-sin-verificar (nuevo; `total`/`truncado` agregados)
Lista las preparaciones en `despachada_sin_verificar`, canal `web`, más recientes primero.
Mismo criterio y consulta que `GET /cerradas-sin-evidencia` — un estado que existe para
poder consultarlo ante un reclamo, así que tiene que tener dónde listarse igual que el
otro. **No filtra por ventana temporal, a propósito** (ver `despachados_sin_verificar` en
`GET /seguimientos` más abajo: el estado no es terminal y "nada se oculta" es el criterio
de la pantalla) — pero antes tenía un `LIMIT 200` en silencio, exactamente lo que ese
criterio prohíbe. Ahora expone `total`/`truncado`, mismo patrón que `a_medias_total` (hallazgo
del revisor).

- Request: sin body.
- Response 200: `{ "ok": true, "data": [ { ...preparación, total_items, total_fotos } ], "total": 3, "truncado": false }`.
  `data` viene con `LIMIT 200`; `truncado:true` si `total > data.length`.

### Estado nuevo: `cerrada_sin_evidencia`
Preparaciones viejas que nunca se completaron ni verificaron de verdad, cerradas por el
script de mantenimiento `scripts/cerrar-preparaciones-sin-evidencia.mjs` (dry-run por
default; `--aplicar` para escribir). **No es `completada`**: el sistema no puede afirmar
una verificación que no ocurrió. Salen de `GET /pendientes` (igual que `completada`/
`pendiente_deposito`) y **no se mezclan** con `GET /historial` (que solo trae `completada`/
`pendiente_deposito`) — tienen su propia sección.

El script valida `--corte` (`corteEsValido`: prefijo `YYYY-MM-DD` + `Date.parse` no-NaN)
antes de usarlo en el `WHERE creado_en < ?` — SQLite compara ese `WHERE` como **texto**, así
que un valor no-ISO (ej. `--corte=hoy`) compararía mal contra los `creado_en` reales y
cerraría filas de más (`'2026-08-01T...' < 'hoy'` da `true` para cualquier fecha ISO real).
Corte inválido → `exit 1` con mensaje claro, no escribe nada. `CORTE_DEFAULT` es una fecha
FIJA (medianoche UTC del 2026-08-12): corrido otro día hay que pasar `--corte=` explícito.

#### GET /api/preparacion/cerradas-sin-evidencia (nuevo)
Lista las preparaciones en `cerrada_sin_evidencia`, más recientes primero.

- Request: sin body.
- Response 200: `{ "ok": true, "data": [ { ...preparación, total_items, total_fotos } ] }`
  (mismo shape que las filas de `GET /historial`).

#### POST /api/preparacion/:id/reabrir (nuevo)
Reabre una `cerrada_sin_evidencia` (p.ej. si entra un reclamo) y la devuelve al flujo
normal. Cualquier usuario puede reabrir (no se restringe a admin); queda un evento
`tipo:'reabierta'` con usuario y hora en `preparacion_eventos`.

- Request: sin body.
- Response 200: `{ "ok": true, "estado": "en_preparacion" }`.
- Response 400: `{ "ok": false, "error": "solo se puede reabrir una preparación 'cerrada_sin_evidencia' (está '<estado>')" }`
  — no aplica a `completada`, `pendiente_deposito` ni `en_preparacion` (ya está abierta).
- Response 404: preparación inexistente.

### Velocidad del escaneo (medido)
`POST /:id/escanear` no cambió de forma (sigue siendo un `UPDATE` simple + insert de
evento, sin llamadas a red): benchmark local de 200 requests secuenciales sobre
`supertest` — **avg 7.65ms, p50 6.40ms, p95 13.94ms**. El costo de "escanear 5 veces" es
el de la cámara/lector detectando el código, no el del backend — el requisito de "la
cámara queda lista para el siguiente escaneo sin toques intermedios" es responsabilidad
del frontend (fuera de este archivo).

## Seguimientos: 3 secciones locales, ya no se infiere desde Woo (2026-08-13)

La medición histórica (conservada en Git) mostró que la pantalla presentaba
**70 pedidos** como "colgados" (a medias) que en realidad nunca pasaron por esta herramienta
— el usuario carga el tracking a mano en WooCommerce por costumbre, y la versión vieja de
`GET /seguimientos` infería "a medias" mirando la meta `_andreani_tracking` en pedidos
`completed` de Woo, que es exactamente donde esa costumbre deja rastro. **Contrato viejo
retirado** (array plano con `colgado:true`, dos llamadas a Woo por carga de pantalla).

**Ronda de revisión (mismo día):** el revisor encontró que "acotado, típicamente 0" para
`a_medias` era cierto hoy pero sin techo — si el paso 2 empieza a fallar sistemáticamente,
cada carga de tracking del día deja una fila y la pantalla pasa a hacer N GET seriales a Woo
sin límite. Se sacó esa dependencia de Woo por completo (ver `a_medias` más abajo), se agregó
`truncado` para el universo principal (también sin techo antes) y se corrigieron dos defectos
de `cargados_hoy` (corte a medianoche UTC en vez de Buenos Aires, y `COUNT(*)` que doblaba un
pedido con reintento manual). El contrato de abajo ya refleja esos cambios.

### GET /api/preparacion/seguimientos (contrato nuevo)
Parte del universo de pedidos Woo en `andreaniStatus` (`lpaandreani`, **una sola llamada** a
Woo) y lo reparte entero entre `esperando` y `sin_preparacion`; `a_medias` es dato
**exclusivamente local** (`preparaciones.woo_paso2_pendiente=1`), nunca se deriva de Woo.

- Request: sin body.
- Response 200:
  ```json
  { "ok": true, "data": {
    "esperando":       [{ "wc_order_id", "envio", "preparacion_id", "estado_preparacion" }],
    "sin_preparacion": [{ "wc_order_id", "envio", "preparacion_id", "estado_preparacion" }],
    "a_medias":        [{ "wc_order_id", "envio", "preparacion_id", "tracking" }],
    "a_medias_total": 1,
    "despachados_sin_verificar": 3,
    "cargados_hoy": 5,
    "truncado": false
  }}
  ```
- **`esperando`**: pedidos en `lpaandreani` cuya preparación local está `completada`
  (preparado y **verificado**) — falta cargar el tracking. Cierra el circuito
  preparar → verificar → despachar.
- **`sin_preparacion`**: **todo el resto** del universo `lpaandreani` — sin fila local, o en
  `en_preparacion` / `despachada_sin_verificar` / `cerrada_sin_evidencia` (`estado_preparacion`
  viene `null` en el primer caso, para que el frontend arme el badge). A propósito **no** se
  excluyen los `en_preparacion`: marcar "etiqueta lista" (`POST /etiquetas/:wcOrderId/lista`)
  ya crea una preparación en ese estado sin trabajo real — excluirlos escondería justo los
  pedidos por despacharse, y un pedido que no aparece manda al operario de vuelta a Woo.
- **`a_medias`**: `woo_paso2_pendiente=1` — paso 1 confirmado en Woo (tracking guardado,
  mail ya mandado) pero el paso 2 (status final `enviadoandreani`) todavía no. El `tracking`
  sale de la columna local `preparaciones.tracking` (guardada en el mismo INSERT que pone
  `woo_paso2_pendiente=1`, ver más abajo) — de solo lectura, no se le vuelve a pedir a Woo.
  **`envio` también sale entero de datos locales** (`preparaciones.numero_pedido`/`comprador`/
  `localidad`, guardados en ese mismo INSERT — ver ronda de revisión I2 más abajo):
  `{ pedido, nombre, apellido:'', localidad, provincia:'' }`, sin llamar a Woo por fila. Antes
  se le pedía a Woo el pedido completo por cada fila — costo "típicamente 0" hoy, pero sin
  techo: si el paso 2 empieza a fallar en cadena, cada carga de tracking del día deja una fila
  acá y la pantalla pasaba a hacer N GET seriales sin límite (hallazgo del revisor). El `envio`
  local es más pobre (sin dirección exacta) pero alcanza para identificar al comprador — no
  hace falta reimprimir la etiqueta desde acá. `pedido` es **`order.number`** (numeración
  custom de esta tienda en Woo), nunca `wc_order_id`: son valores distintos, y el operario
  busca por el primero. La lista viene con **`LIMIT 20`** (`ORDER BY id`); `a_medias_total` es
  el conteo real del universo `woo_paso2_pendiente=1`, para que el frontend pueda decir
  "mostrando 20 de N".
- **`despachados_sin_verificar`**: solo el número (`COUNT(*)` de preparaciones `canal='web'`
  en ese estado — esta pantalla es exclusivamente Andreani/web, y hoy nada del flujo `ml` deja
  preparaciones en este estado). **Sin ventana temporal, a propósito**: `despachada_sin_verificar`
  no es terminal (`POST /:id/completar` la puede subir a `completada` si se verifica después),
  así que el número baja solo con trabajo real; ocultar los viejos con una ventana escondería
  justo los reclamos más urgentes de resolver, contra el criterio de "nada se oculta" de esta
  pantalla. El detalle sigue en `GET /despachadas-sin-verificar` (ya existe, ver arriba).
- **`cargados_hoy`**: `COUNT(DISTINCT preparacion_id)` de eventos `tracking_cargado` de hoy
  — **no** `COUNT(*)`: un reintento manual sobre un pedido colgado registra un segundo evento
  para el mismo pedido, y `COUNT(*)` lo contaba dos veces (hallazgo del revisor). El corte de
  "hoy" es **hora de Buenos Aires** (`lib/tiempo.js#inicioHoyBuenosAiresISO`, UTC-3 fijo), no
  medianoche UTC/hora del server como antes — a las 00:00 UTC (21:00 Argentina) el contador se
  reiniciaba tres horas antes de tiempo y arrastraba trabajo del día anterior. La misma función
  reemplaza la copia equivalente que tenía `lib/coberturaCola.js#progresoHoy` (mismo defecto,
  ahora una sola fuente). Requiere el evento nuevo que registra `POST /seguimientos/:wcOrderId`
  en su camino de éxito (ver abajo), que antes no dejaba ningún rastro.
- **`truncado`**: `true` cuando el universo `lpaandreani` devuelve exactamente 100 filas (el
  `per_page` de la consulta) — señal explícita de que puede haber pedidos 101+ que no se están
  mostrando, en vez de que desaparezcan en silencio de una pantalla cuyo criterio de diseño es
  que nada se oculte (hallazgo del revisor). No pagina todavía; si en la práctica se llega a
  tocar el límite, paginar es el siguiente paso.
- Response 500: `{ "ok": false, "error": "..." }` si falla la consulta a Woo.

### POST /api/preparacion/seguimientos/:wcOrderId (ronda de revisión I1/I2, resto sin cambios)
El fail-closed por estado, el salteo del paso 1 en el reintento (para no reenviar el mail) y
`marcarPreparacionEnviada` (ver `despachada_sin_verificar` más arriba) **no cambian**.

- **I1 — CAMBIO DE CONTRATO, avisar al frontend**: el evento `tipo:'tracking_cargado'` en
  `preparacion_eventos` (`detalle: { tracking }`, fuente de `GET /seguimientos.data.cargados_hoy`)
  ahora se registra **inmediatamente después del INSERT local del paso 1** (antes de intentar
  el paso 2), no solo "en el camino de éxito" como decía esta misma sección hasta la ronda
  anterior. Motivo: el paso 1 (Woo en `completed`, tracking guardado, mail nativo ya
  mandado) es el momento real en que el tracking "quedó cargado" — si el paso 2 falla
  (`502`/`colgado:true`) el pedido ya salió igual, y antes ese caso no sumaba a
  `cargados_hoy` (justo el día de más trabajo, cuando Woo está lento y varios quedan
  colgados). `GET /seguimientos.data.cargados_hoy` sigue dedupeando con
  `COUNT(DISTINCT preparacion_id)`, así que un reintento posterior sobre el mismo pedido no
  duplica el conteo. **El frontend hoy incrementa `cargados_hoy` en memoria solo en la rama
  `ok:true` de la respuesta** — con este cambio el backend también lo cuenta cuando la
  respuesta es `502 colgado:true`, así que el frontend tiene que dejar de incrementarlo a
  mano ahí (o incrementarlo también en la rama `colgado`) para no quedar corrido en -1 el
  resto del día; lo más simple es refrescar `cargados_hoy` desde `GET /seguimientos` después
  de cada intento, éxito o colgado.
- **I2 — el INSERT del paso 1 ahora llena `numero_pedido`/`comprador`/`localidad`** desde el
  `GET /orders/{id}` que la ruta ya hacía antes de este INSERT (`actual.data`), tanto en el
  `INSERT` como en el `ON CONFLICT ... DO UPDATE`. Antes, para un pedido sin fila local previa
  (el caso central de la sección "sin_preparacion" de esta pantalla) la fila nacía con los dos
  en `NULL`, y `a_medias` terminaba mostrando `wc_order_id` como número **y** como nombre —
  ese id además no es el número de pedido real de Woo (`order.number`, numeración custom de
  esta tienda), así que el operario no podía ubicar en Woo el único pedido que está trabado.
  `localidad` sale de `shipping.city` con fallback a `billing.city` (mismo criterio que
  `normalizarEnvio`).

### POST /api/preparacion/seguimientos/:wcOrderId/corregir-tracking (ajuste menor)
Ahora también actualiza `preparaciones.tracking` (el mismo espejo local de arriba) al tracking
nuevo, tanto si hace el PUT a Woo como en el atajo "mismo valor, no-op". Antes solo tocaba
`meta_data` en Woo — la columna local quedaba con el valor viejo, y un Deshacer posterior
(reintento de `a_medias` con el tracking de la columna) reintentaba contra un número que ya no
era el vigente en Woo (hallazgo del revisor).

### `reintentarColgadosTracking` (cron): 404/410 ya no quedan colgados para siempre (I3)
Ahora que `a_medias` es 100% local (`woo_paso2_pendiente=1`), un pedido borrado o pasado a
papelera en Woo hacía que el PUT del paso 2 fallara **siempre** — antes esto se resolvía solo
porque la sección vieja se derivaba de Woo; con el dato local, la fila quedaba como ruido
permanente (el chip la contaba todos los días, y "Reintentar" nunca podía resolverla).

- Si `wooFetch` del PUT del paso 2 falla con **404 o 410**, se interpreta como "el pedido ya
  no existe en Woo": se limpia `woo_paso2_pendiente=0` y se registra un evento
  `tipo:'tracking_abandonado'` (`detalle: { error, motivo }`) para que un reclamo posterior
  pueda ver qué pasó. No cuenta como `resuelto` (no llegó a `enviadoandreani`).
- **Cualquier otro error sigue fail-closed** (5xx, timeout, red): no se toca la bandera, se
  reintenta en la corrida siguiente — no hay forma de distinguir ahí "temporal" de
  "permanente".

### GET /api/preparacion/pendientes (campo agregado: `notas`)
Cada fila de `data` con `canal:'web'` suma `notas`: el `customer_note` del pedido en
WooCommerce, cacheado en `pedidos_cache.customer_note` (poblada por `syncPedidosCache`), o
`''` si el pedido no tiene nota. Los pedidos `canal:'ml'` **no** tienen esta clave — la API
de orders de MercadoLibre no expone un campo equivalente (confirmado 2026-08-26), así que no
se inventa un valor vacío ahí para no sugerir que existe la posibilidad.

### POST /api/preparacion/iniciar (gate nuevo: envío vs. facturación)
Antes de crear la preparación de un pedido `canal:'web'`, si los datos de envío y
facturación del pedido difieren de verdad (`direccionesDifieren()` en `lib/preparacion.js`:
compara calle+número, localidad+provincia, nombre del destinatario y teléfono, normalizado
sin acentos/mayúsculas/espacios de más) y todavía no se registró una decisión para esa
preparación:

- Request: `{ canal:'web', id:<wc_order_id>, direccion_elegida?: 'shipping'|'billing' }`.
- Response 409 (sin `direccion_elegida`, o primera vez que se detecta la diferencia):
  `{ ok:false, error, direcciones_difieren:true, campos_distintos:[...], envio:{...},
  facturacion:{...} }` — `envio`/`facturacion` son el objeto completo de `normalizarEnvio()`
  para cada fuente. **No crea la preparación.**
- Con `direccion_elegida` presente (`'shipping'` o `'billing'`): crea la preparación
  normalmente y guarda la elección en `preparaciones.direccion_confirmada_fuente` (+
  `_por`, `_en`). Una preparación que ya tiene `direccion_confirmada_fuente` no vuelve a
  frenar en llamadas posteriores a `/iniciar` con el mismo pedido.
- Si envío y facturación coinciden (caso común), se comporta igual que antes de este
  cambio — sin 409, sin fricción.
- La elección persistida es la que usan `GET /etiquetas` y `GET /seguimientos` para esa
  preparación, en vez de la regla automática de `normalizarEnvio` (envío si tiene
  `address_1`, si no facturación).

### GET /api/preparacion/vinculos/:clave (Fase 4: detección de pedidos del mismo comprador)
Consulta sugerencias pendientes de vínculos para un pedido. Devuelve las filas de
`preparacion_vinculos` donde ese pedido participa y el estado sigue siendo `'sugerido'`
(todavía no se decidió por ese vínculo).

- Request: `:clave` = `'web:<wc_order_id>'` o `'ml:<ml_order_id>'` (URL-encoded).
- Response 200 (lista vacía si no hay sugerencias):
  ```json
  {
    "ok": true,
    "data": [
      {
        "id": 1,
        "campo_match": "email|dni|telefono|nombre_direccion",
        "otro_pedido": {
          "clave": "web:123",
          "canal": "web",
          "numero": "123",
          "comprador": "Juan Pérez"
        },
        "creado_en": "2026-08-26T10:30:00Z"
      }
    ]
  }
  ```
- Response 400: `:clave` ausente o malformada.
- Response 500: error interno.

### POST /api/preparacion/vinculos/:id/decidir (Fase 4: confirmación del operario)
Decide si dos pedidos del mismo comprador irán juntos, separados pero vinculados, o no
vinculados. Actualiza el estado del vínculo y guarda quién y cuándo lo decidió.

- Request:
  ```json
  {
    "estado": "confirmado_junto|confirmado_separado_pero_vinculado|rechazado",
    "un_solo_paquete": true|false
  }
  ```
  - `estado`: obligatorio, uno de los 3 valores.
  - `un_solo_paquete`: opcional, ignorado si `estado` no es `'confirmado_junto'`. Si es
    `true`, ambos pedidos irán en una sola caja; si es `false` o ausente, cajas separadas
    pero marcadas como vinculadas en la lista.

- Response 200:
  ```json
  { "ok": true, "estado": "confirmado_junto" }
  ```

- Response 400: `estado` inválido.
- Response 404: vínculo no encontrado.
- Response 500: error al actualizar.

**Notas de diseño:**
- La detección de vínculos ocurre cuando se crea una preparación (`POST /iniciar`): para
  cada pedido nuevo, buscamos otros en la DB que coincidan por DNI, email, teléfono o
  nombre+dirección de envío (el primero que coincida en ese orden). Si hay match,
  creamos una fila en `preparacion_vinculos` con `estado='sugerido'`.
- El frontend consulta `GET /vinculos/:clave` al armarse la pantalla de preparación y
  avisa al operario si hay sugerencias. El operario decide con `POST /decidir`.
- La decisión NO toca WooCommerce (es 100% interna) — no envía notas de cliente, no
  cambia estado del pedido, nada. Es solo para que el operario sepa que dos pedidos
  vienen de la misma persona y puede organizarlos juntos si quiere.

## Notificaciones ML: preguntas, mensajes y reclamos pendientes (`/api/notificaciones-ml`)

Permiso `notificaciones-ml` (binario, `niveles:false`, igual que `etiquetas`). Alcance
decidido con el usuario (2026-08-26): solo listar con "hace cuánto" y link a Mercado Libre
para responder ahí — esta herramienta no responde nada por API.

La app de ML tiene **todos los topics** seleccionados en el panel de developers; el filtro de
qué procesar vive en `POST /api/ml/notificacion` (`server.js`), no en el panel. Hoy procesa
`orders` (ya existía; desde A.3, dispara `syncOrdenMlPuntual` — GET puntual de esa orden a
`/orders/{id}`, no el barrido paginado `/orders/search`, que queda solo en el cron cada 10 min
como respaldo), `orders_v2` (desde A.1: camino puntual a `pedidos_cache`, igual que `orders`,
pero **no** dispara `syncOrdenMlPuntual` — eso sigue siendo solo para `orders`), `questions` y
`messages` y `claims`; el resto de los topics (`shipments`, `orders_feedback`, `items`,
`invoices`) se reciben y se descartan en silencio hasta que se sume su función.

### GET /api/notificaciones-ml/pendientes
Response 200: `{ ok:true, preguntas:[...], mensajes:[...], reclamos:[...], total:number }`.
- `preguntas`: filas de `ml_preguntas` con `estado='UNANSWERED'`, ordenadas por
  `fecha_creacion ASC` (más vieja primero — la más urgente arriba).
- `mensajes`: filas de `ml_mensajes` con `respondido_en IS NULL`, mismo orden.
- `reclamos`: filas de `ml_reclamos` con `cerrado_en IS NULL`, mismo orden.

### GET /api/notificaciones-ml/count
Conteo liviano para el aviso del Home (no trae las filas). Response 200:
`{ ok:true, preguntas:number, mensajes:number, reclamos:number, total:number }`.

### Ingesta (interna, disparada por el webhook — no expuesta por HTTP)
`ingerirPregunta(db, mlCfg, resource)`, `ingerirMensaje(db, mlCfg, resource)` e
`ingerirReclamo(db, mlCfg, resource)` en
`routes/notificacionesMl.js`. Ambas son **fail-open**: si la llamada a ML falla, no se
reintenta ni se bloquea nada más del webhook — la próxima notificación de ese mismo recurso
corrige el estado. `ingerirMensaje` acepta tanto una respuesta en array como un objeto único
de ML (el shape exacto de `resource` para `messages` no está confirmado en producción
todavía — revisar contra la primera notificación real que llegue).

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
- `409` si el usuario ya tiene una sesión en estado `abierta` (no puede abrir otra hasta retomar o descartar la actual).
- `409` si el alcance se cruza con una sesión de otro usuario en estado `abierta` o `confirmada_con_errores`:
  `{ ok:false, error, ocupada_por, categorias, marcas }`. El solapamiento se checkea con ambos estados porque una sesión en `confirmada_con_errores` sigue siendo reintentable y sus ajustes seguirían siendo válidos.

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

### POST /api/inventario/sesiones/:id/asociar (respuesta ampliada: sube el código a Woo — spec 2026-08-21)
Request `{ "ean": "...", "sku": "...", "pisar_codigo"?: true }`.
Respuesta: `{ ok, item, codigo }`. `codigo.estado`:

| `codigo.estado` | Cuándo | Llamada a Woo |
|---|---|---|
| `no_valido` | el código escaneado no es un GTIN válido (`looksLikeEan`) | ninguna |
| `subido` | GTIN válido y se escribió en Woo (producto sin código, o con `pisar_codigo:true`) | sí, PATCH `global_unique_id` |
| `sin_cambio` | el producto ya tenía ese mismo código en Woo | ninguna |
| `conflicto` | el producto tiene **otro** código en Woo; no se pisó; trae `gtin_actual` | ninguna |
| `fallo` | no se pudo subir; trae `error` y `motivo` | depende de `motivo` |

La asociación local del ítem (`item.sku`) se hace **siempre**, incluso en `fallo` — excepción
deliberada al fail-closed del resto del sistema: el trabajo físico del operario no se
descarta por un error de Woo. El mapeo global `ean_sku` se siembra cuando el SKU es
inequívoco; si hay homónimos (`motivo='sku_ambiguo'`), el ítem conserva su `sku` pero no se
escribe `ean_sku` para no apuntar arbitrariamente a un producto. En `conflicto`, la pantalla
pregunta y, si el operario confirma pisar, repite el POST con `pisar_codigo: true`. Esta subida se
extrajo a `lib/gtinWoo.js`, compartida con `POST /api/codigos/asignar` (mismo comportamiento,
no cambia), porque `inventario` y `codigos` son permisos distintos.
`motivo='woo'` indica que hubo un intento remoto fallido; `sku_ambiguo` y `no_endpoint`
son rechazos locales fail-closed y no hacen ninguna llamada a Woo.

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
**Ajuste por delta contra stock live (no absoluto):** cada ítem ajusta su stock en Woo
aplicando un delta: `delta = cantidadContada - stockInicial`, luego `stockFinal = stockLive + delta`.
Esto preserva las ventas que ocurrieron durante el conteo y evita sobre-publicar stock.
Claim atómico (`UPDATE ... WHERE estado IN ('abierta','confirmada_con_errores')`),
**fail-closed por ítem** al escribir a Woo (un PUT fallido no aborta el resto; la sesión
queda en `confirmada_con_errores` y el reintento procesa solo los no ajustados).
**Fail-closed adicional:** si `stockLive > stockInicial` durante el conteo (detección de
ingreso externo de mercadería o error de medición inicial), el ítem se rechaza sin PUT
a Woo y cae en fallidos para revisión manual.

**Respuesta 200:**
```json
{
  "ok": true,
  "ajustados": 5,
  "fallidos": 0,
  "errores": [],
  "ventasDuranteConteo": [
    {
      "sku": "FB-1",
      "stock_al_abrir_sesion": 10,
      "stock_al_confirmar": 8,
      "stock_final": 7
    }
  ]
}
```
- `ajustados`: cantidad de ítems ajustados exitosamente en Woo.
- `fallidos`: cantidad de ítems que fallaron (quedan en `inventario_conteos.ajustado_en = NULL`).
- `errores`: array de `{ sku, error }` para cada ítem fallido.
- `ventasDuranteConteo`: array (opcional, solo presente si hubo al menos una venta detectada).
  Cada entrada contiene:
  - `sku`: el SKU donde se detectó la venta.
  - `stock_al_abrir_sesion`: el `stock_inicial` congelado (al crear la sesión para ítems en alcance, o al momento del escaneo para ítems fuera de alcance que se agregaron después).
  - `stock_al_confirmar`: el `stockLive` leído de WC al momento de ajustar.
  - `stock_final`: el stock que se escribió en Woo tras aplicar el delta.

**Respuesta 409:** corta **antes** de tocar Woo. Dos escenarios:

1. **Ítems sin asociar a SKU** (sin SKU no hay a qué ajustarle stock):
   ```json
   {
     "ok": false,
     "error": "Hay ítems sin asociar a un SKU...",
     "sin_asociar": 2,
     "codigos_desconocidos": 1,
     "codigos": ["13000000000088"]
   }
   ```

2. **Pendientes con stock sin contar** (`estado === 'abierta'` solamente):
   ```json
   {
     "ok": false,
     "error": "Quedan productos con stock sin contar...",
     "pendientes_con_stock": 2,
     "pendientes": [
       {
         "sku": "FB-1",
         "nombre": "Casco Bell",
         "bloque": "con_stock",
         "marca": "Bell",
         "categoria_principal": "Cascos",
         "stock_inicial": 5,
         "stock_woo": 5
       },
       ...
     ]
   }
   ```
   `pendientes` viene ordenado: `bloque` con_stock primero (CASE WHEN='con_stock' THEN 0), después categoría → marca → nombre, todas COLLATE NOCASE.

### GET /api/inventario/no-contables/sugerencias (Fase 0, Tarea 1)
Devuelve productos candidatos a marcar como no-contables (sin marca o stock absurdo >500).
Query params: ninguno.
- Response 200: `{ "ok": true, "sugerencias": [ { "id_woo", "sku", "nombre", "stock", "marca" }, ... ] }`
- Sin permisos especiales: accesible a cualquier usuario con permiso de inventario (solo lectura).

### POST /api/inventario/no-contables (Fase 0, Tarea 1)
Marca una o más productos como no-contables (excluidos del conteo automático).
**Requiere admin.** Responde 403 si el usuario no es administrador.
- Request: `{ "ids_woo": [1, 2, 3] }` (array no vacío de id_woo de productos).
- Response 200: `{ "ok": true, "marcados": 3 }`.
- Response 400: `{ "ok": false, "error": "Indicá `ids_woo` (array no vacío)." }`.

### POST /api/inventario/no-contables/revertir (Fase 0, Tarea 1)
Desmarca productos como no-contables, devolviéndolos al flujo de conteo normal.
**Requiere admin.** Responde 403 si el usuario no es administrador.
- Request: `{ "ids_woo": [1, 2, 3] }` (array no vacío de id_woo de productos).
- Response 200: `{ "ok": true, "revertidos": 3 }`.
- Response 400: `{ "ok": false, "error": "Indicá `ids_woo` (array no vacío)." }`.
- También soportado como `DELETE /api/inventario/no-contables` con el mismo body.

### GET /api/inventario/negativos (Fase 0, Tarea 3)
Lee alertas abiertas de stock negativo detectado en el catálogo.
- Request: sin body ni query.
- Response 200: `{ "ok": true, "alertas": [ { "id", "sku", "stock_detectado", "detectado_en", "nombre", "marca", "stock_actual" }, ... ] }`
  - Solo lista filas con `resuelto_en IS NULL` (alertas abiertas).
  - `stock_detectado` es el valor negativo que se vio al detectar.
  - `stock_actual` es el stock presente ahora en `catalogo_cache`.
- Sin permisos especiales: accesible a cualquier usuario con permiso de inventario (solo lectura).

### GET /api/inventario/diferencias/pendientes (Fase 0, Tarea 2)
Devuelve **solo sobrantes pendientes de aprobación** (diferencias grandes que frenaron el ajuste).
Los faltantes con `requiere_revision=1` siguen existiendo como alertas históricas para investigar,
pero no aparecen en esta bandeja — son informativos, no accionables.
- Request: sin body ni query.
- Response 200: `{ "ok": true, "pendientes": [ { "id", "sku", "tipo", "cantidad_contada", "stock_inicial_usado", "diferencia", "nombre", "marca", "requiere_revision", "revisado_en", "creado_en", ... }, ... ] }`
  - Solo filas con `tipo='sobrante'`, `requiere_revision=1`, `revisado_en IS NULL`.
  - Ordenadas por `creado_en` (antiguas primero).
- Sin permisos especiales: accesible a cualquier usuario con permiso de inventario (solo lectura).

### POST /api/inventario/diferencias/:id/aprobar (Fase 0, Tarea 2)
Aprueba un sobrante grande y aplica el ajuste a WooCommerce (ejecuta `setStockWcDelta`).
**Requiere admin.** Responde 403 si el usuario no es administrador.
**Defensa en profundidad:** devuelve 400 si se intenta aprobar una fila `tipo != 'sobrante'`.
- Request: sin body.
- Response 200: `{ "ok": true, "resultado": { ... } }` — resultado del ajuste a Woo.
- Response 400:
  - `{ "ok": false, "error": "Esta diferencia ya fue revisada" }` — si `revisado_en IS NOT NULL`.
  - `{ "ok": false, "error": "Solo los sobrantes requieren aprobación; los faltantes ya se ajustaron automáticamente al confirmar la sesión" }` — si `tipo != 'sobrante'`.
- Response 404: `{ "ok": false, "error": "Diferencia no encontrada" }`.
- Response 502: `{ "ok": false, "error": "<mensaje>" }` — fallo en el ajuste a Woo; queda pendiente para reintentar.

### POST /api/inventario/diferencias/:id/rechazar (Fase 0, Tarea 2)
Rechaza un sobrante (decisión deliberada de no tocarlo en Woo). Marca la diferencia como revisada
y **borra la fila de `inventario_conteos`** para ese ítem, cerrando la decisión.
**Requiere admin.** Responde 403 si el usuario no es administrador.
**Defensa en profundidad:** devuelve 400 si se intenta rechazar una fila `tipo != 'sobrante'`.
- Request: sin body.
- Response 200: `{ "ok": true }`.
- Response 400:
  - `{ "ok": false, "error": "Esta diferencia ya fue revisada" }` — si `revisado_en IS NOT NULL`.
  - `{ "ok": false, "error": "Solo los sobrantes requieren aprobación; los faltantes ya se ajustaron automáticamente al confirmar la sesión" }` — si `tipo != 'sobrante'`.
- Response 404: `{ "ok": false, "error": "Diferencia no encontrada" }`.

### GET /api/inventario/ritmo (Fase 0, Tarea 4)
Estima el ritmo de conteo de un operario, en **ítems por hora**, a partir de sus últimas 5
sesiones confirmadas.
- Request: query param `usuario` (obligatorio, username del operario).
- Toma las últimas 5 sesiones de ese usuario con `estado IN ('confirmada',
  'confirmada_con_errores')`, ordenadas por `confirmado_en DESC`. De esas, quedan como
  "válidas" las que tienen `items_contados` no nulo y `0 < segundos_activos <= 10800` (3h) —
  una sesión de más de 3 horas se descarta del cálculo (probablemente no fue continua). Para
  cada válida calcula `(items_contados / segundos_activos) * 3600`.
- Con **menos de 3 sesiones válidas**, no hay muestra suficiente: devuelve un valor fijo
  conservador con `estimado: true`.
  ```json
  { "ok": true, "ritmo": 20, "estimado": true, "muestras": 1 }
  ```
- Con **3 o más sesiones válidas**, calcula el **percentil 25** (interpolación lineal, método
  PERCENTILE.INC de Excel) del ritmo observado — no el promedio, para no sobreestimar con
  una sesión atípicamente rápida.
  ```json
  { "ok": true, "ritmo": 28.4, "estimado": false, "muestras": 4 }
  ```
  - `ritmo`: ítems por hora (número, puede tener decimales).
  - `estimado`: `true` si `ritmo` es el valor fijo de respaldo (pocos datos), `false` si es
    el percentil 25 calculado sobre datos reales.
  - `muestras`: cantidad de sesiones que efectivamente entraron en el cálculo (después de
    excluir las de más de 3 horas).
- Response 400: `{ "ok": false, "error": "Falta `usuario`" }`.
- Sin permisos especiales: accesible a cualquier usuario con permiso de inventario (solo
  lectura). Nota: esto expone la métrica de productividad de cualquier operario a cualquier
  otro con el mismo permiso — decisión de producto, no un descuido, pero vale saberlo si se
  quiere acotar más adelante.

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
## Consulta de Precios: asociación y subida de GTIN (C2)

### GET /api/consulta-precios/buscar
- Query param: `q` (string, búsqueda por SKU o EAN conocido).
- Response 200: `{ "ok": true, "found": true, "tipo": "sku"|"ean", "producto": {...} }`
  - `producto` incluye: `id_woo`, `sku`, `nombre`, `marca`, `categorias`, `precio` (contado),
    `stock`, `tipo`, `id_padre`, `gtin`, `img`. Los campos `id_woo`, `id_padre` y `gtin` se
    agregaron en C2; no asumir otra forma de respuesta.

### GET /api/consulta-precios/buscar-sku
- Query param: `q` (string, autocomplete).
- Response 200: `{ "ok": true, "data": [ { "id_woo", "sku", "nombre", "stock", "tipo", "id_padre" }, ... ] }`
  - Incluye `id_woo` e `id_padre` desde C2.

### POST /api/consulta-precios/asociar
Enseña el mapa local `ean_sku` y, si `ean` pasa la validación GS1 (8/12/13/14 dígitos con
checksum), intenta escribir `global_unique_id` en Woo reutilizando `lib/gtinWoo.js`.

- Request: `{ "ean", "sku", "id_woo"?, "pisar_codigo"?, "pisar_mapa"? }`.
  - `id_woo` es opcional; si viene, debe ser un número entero exacto — se rechaza booleano, array,
    objeto, NaN, o string con decimales (400 si no). Se acepta `id_woo` string si contiene solo
    dígitos, ej. `"1"`.
  - `pisar_codigo: true` ignora un GTIN conflictante (en `catalogo_cache.gtin`) y lo reemplaza
    en Woo.
  - `pisar_mapa: true` ignora un conflicto de mapa (EAN ya mapeado a otro SKU en `ean_sku`) y
    lo reemplaza localmente.
- Response 200: `{ "ok": true, "producto": {...}, "codigo": { "gtin", "estado", ... } }`.
  - `producto` mismo shape que `/buscar` (incluye `id_woo`, `id_padre`, `gtin`).
  - `codigo.estado`:
    - `no_valido`: EAN no pasa checksum; se conserva el mapa local, no se llama a Woo.
    - `sin_cambio`: producto ya tenía ese GTIN; se conserva sin PATCH.
    - `conflicto`: producto tiene otro GTIN; requiere `pisar_codigo: true` para sobrescribir.
    - `conflicto_mapa`: EAN ya estaba mapeado en `ean_sku` a otro SKU; requiere `pisar_mapa: true`
      para reemplazarlo. `sku_actual` contiene el SKU anterior. No se toca Woo ni `catalogo_cache`.
    - `subido`: Woo confirmó el PATCH; `catalogo_cache.gtin` y `ean_sku` se actualizan.
    - `fallo`: Woo rechazó o no respondió; mapa local se conserva, cache no se afirma subido.
      `motivo` contiene `woo` o el rechazo local.
- Response 400:
  - SKU homónimo: `{ "ok": false, "codigo": "sku_ambiguo", "error": "..." }` — cliente debe
    enviar `id_woo` para desambiguar.
  - SKU ↔ id_woo incoherentes: `{ "ok": false, "codigo": "sku_id_woo_incoherente", "error": "..." }`
    — si llegan ambos, el `id_woo` debe resolver un producto cuyo `sku` coincida exactamente con
    el `sku` del request.
  - id_woo rechazado: `{ "ok": false, "error": "id_woo debe ser un número entero..." }` si no es
    número/string-dígitos exacto, o `{ "ok": false, "error": "id_woo XXX no existe o no tiene SKU asignado" }`
    si no existe.
  - SKU inexistente o sin SKU en la fila resuelta: `{ "ok": false, "error": "..." }`.

La asociación local es fail-open ante fallos remotos porque el trabajo de mostrador no debe
perderse. Un SKU sin precio en el catálogo no impide la asociación.

### POST /api/consulta-precios/ean (endpoint legado, en desuso)
Alias de `/asociar` sin subida a Woo. Mismo validación de `id_woo` y `sku` que `/asociar`.
- Request: `{ "ean", "sku", "id_woo"?, "pisar_mapa"? }`.
  - Mismas validaciones que `/asociar` para `id_woo` (número entero exacto, rechaza tipos).
- Response 200:
  - Si hay conflicto de mapa: `{ "ok": true, "producto": {...}, "codigo": { "estado": "conflicto_mapa", "sku_actual": "...", "ean": "..." } }`
  - Si el mapa se guardó sin conflicto: `{ "ok": true, "producto": {...} }` — **sin incluir la clave `codigo`**.
  - Los únicos estados posibles son `conflicto_mapa` (si el EAN ya estaba mapeado a otro SKU); nunca aparecen `conflicto` (GTIN), `fallo`, `subido`, ni `no_valido` (porque no intenta validación GS1 ni subida a Woo).

**Limitación conocida (C2):** `ean_sku` guarda solo el SKU, no el `id_woo`. Con un SKU
repetido en `catalogo_cache` (múltiples productos Woo con el mismo SKU), `/buscar` devolverá
una fila arbitraria. Esto se resolverá en una entrega separada (migración `.sql` + persistencia
de `id_woo` en `ean_sku`).

**Ampliación de permisos (C2):** a partir de esta entrega, el permiso `write` del nivel
`'consulta-precios'` (antes solo permitía leer precios y mapear EANs localmente) ahora incluye
la capacidad de escribir `global_unique_id` en WooCommerce mediante POST `/api/consulta-precios/asociar`.
Usuarios con este permiso pueden modificar códigos GTIN de productos en Woo, no solo guardarlos localmente.

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

## GET /api/codigos/firma — firma liviana de la cola de Carga de Códigos

Nuevo (2026-08-10, plan `codigos-frescura-y-catalogo-incremental`). Pensado para que el
front sondee cada ~20s sin bajar los 417 KB de `GET /api/codigos/faltantes` cuando no
cambió nada: solo si la firma cambia respecto de la última conocida vale la pena pedir
`/faltantes` de nuevo. Mismo patrón que `firmaCandidatos` (`routes/matcher.js`): firma
barata en SQL, separada del payload completo.

- Request: `GET /api/codigos/firma?conStock=` — mismo parámetro `conStock` que `/faltantes`
  (default `true`; `conStock=false` incluye también lo que no tiene stock).
- Response 200: `{ "ok": true, "firma": "<count>:<max_actualizado_en>" }`, ej.
  `{ "ok": true, "firma": "184:2026-08-10T12:00:00.000Z" }`. Si el count es 0 el campo queda
  `"0:"` (sin fecha).
- La firma se calcula con **exactamente el mismo WHERE SQL** que `/faltantes`
  (`tipo <> 'variable' AND sku no vacío AND gtin vacío`, + `stock > 0` si `conStock`), vía
  el helper compartido `whereFaltantes()` en `routes/codigos.js` — evita que ambos se
  desincronicen. Una asignación de código baja el `COUNT` y mueve el `MAX`, así que
  cualquiera de los dos movimientos cambia la firma.
- **Decisión explícita sobre lo que la firma NO replica**: `/faltantes` filtra además en JS
  por `cobertura_exclusiones` (productos "solo local") y `esNoVendible()` (categorías
  SERVICES/QR PAGOS). La firma no aplica esos dos filtros — son baratos y estables (edición
  manual rarísima), y replicarlos exigiría traer las filas completas en vez de un
  `COUNT`/`MAX` puro. Riesgo aceptado, asimétrico a propósito: un cambio en una fila que de
  todos modos estaría excluida mueve la firma sin que la cola visible cambie (refresco de
  más, inofensivo); el caso peligroso — cola visible cambia y la firma no se entera — no
  puede pasar, porque toda fila que entra/sale de la cola por una asignación real
  (INSERT/UPDATE de `gtin`/`stock`/`sku`) siempre pasa por el WHERE de SQL. Si en cambio se
  edita `cobertura_exclusiones` a mano o cambian categorías, la cola visible puede tardar
  hasta un F5 en reflejarlo — no es el escenario ("otro operador asignó un código") que
  motivó este endpoint.

## `refrescarCatalogo` (Woo) — modo incremental (2026-08-10, mismo plan, Paso 2)

La forma de request/response de los endpoints no cambia (`GET /api/woo/catalogo`:
`{ ok:true, data:[...] }`), salvo `POST /api/woo/catalogo/recargar` que ahora puede devolver
`{ ok:true, omitido:true, motivo:'en_curso' }` en vez de `{ ok:true, total }` — ver candado
más abajo — o, desde el frente de confiabilidad operativa (Hito 3), `{ ok:true, total:0,
sospechoso:true }` cuando el barrido completo forzado por este mismo endpoint devuelve 0
productos: `ok:true` porque la llamada en sí no falló, pero `total` NO refleja el catálogo
real (se omitió la poda por seguridad, ver más abajo) — cualquier cliente de este endpoint
debe tratar `sospechoso:true` como una falla operativa, no como "0 productos actualizados".
El resto es comportamiento interno de `refrescarCatalogo`, que igual vale dejar escrito
porque es contrato operativo, no solo de código.

- Cada corrida es **incremental** salvo que corresponda un barrido **completo**: primera vez
  (sin marca previa), pasó ≥1h desde el último completo (`sync_estado.catalogo_ultimo_completo`,
  intervalo **provisorio** — ver comentario junto a `INTERVALO_COMPLETO_MS` en `routes/woo.js`
  sobre la medición pendiente de si un cambio de stock mueve `date_modified`), o se pide
  explícito (`{ forzarCompleto: true }`).
- Incremental: `GET /products?modified_after=<marca-5min>&dates_are_gmt=true&per_page=100&status=any`
  (margen de solape de 5 min para no perder ediciones ocurridas durante la corrida anterior)
  y variaciones **solo** de los padres que devolvió esa consulta. En régimen estable (nada
  cambió), es 1 sola llamada a `/products` y 0 de variaciones.
- Completo: igual que antes (todas las páginas, todas las variaciones de todos los
  productos variables) — es la **única** corrida que poda `catalogo_cache` (productos
  borrados en Woo no aparecen nunca en un `modified_after`, así que el incremental no puede
  detectarlos ni podarlos sin riesgo de falso positivo). Ojo: `status=any` tampoco incluye
  `trash` — un producto papelereado (no borrado) en Woo puede quedar como fila fantasma
  hasta que se borre de verdad; no resuelto en este cambio, motivo adicional para no estirar
  el intervalo del completo.
- `POST /api/woo/catalogo/recargar` (botón manual) **siempre** fuerza completo.
- **Candado anti-solape** (`_refrescarCatalogoEnCurso`, en memoria del proceso, mismo patrón
  que `_wcToMlEnCurso`/`_reconciliarStockEnCurso` de `routes/sync.js`): si ya hay una corrida
  en curso (cron u otro llamado a `POST /catalogo/recargar`), la nueva se omite y devuelve
  `{ omitido:true, motivo:'en_curso' }` en vez de disparar otro fetch en paralelo contra Woo.
- Fail-closed: `sync_estado.catalogo_ultimo_refresco`/`catalogo_ultimo_completo` solo avanzan
  si la corrida terminó sin error. Una falla en variaciones ya relanzaba antes de persistir
  (sigue igual). Con **0 resultados** (completo o incremental) tampoco avanza ninguna marca:
  0 es indistinguible entre "nada cambió" y "Woo falló en silencio" (200 con lista vacía por
  mantenimiento/permisos degradados), así que la corrida siguiente vuelve a pedir la misma
  ventana — sigue siendo 1 sola llamada mientras nada cambie de verdad.
- Cron bajado de cada 15 min a cada 5 min (`server.js`) — el costo por corrida en régimen
  estable se derrumbó de ~584 llamadas a 1, así que la frecuencia más alta no compite con el
  presupuesto de llamadas.

## Cobertura accionable — matcher inverso WC → ML (`/api/cobertura`, 2026-08-10)

Reemplaza el flujo de "informe" de Cobertura por una herramienta de trabajo: cola priorizada
por marca, tarjeta de confirmación con candidatos + diff estructurado, multi-publicación y
solo-ML accionables. El motor de matching (candidatos + diff) vive en
`lib/matcherEngine.js` (`construirML`, `candidatosDeWC`, `candidatosParaWC`, `diffTokens`);
las rutas y la persistencia son este contrato.

**Estados de un producto en la cola** (no todos tienen columna propia — ver
`migrations/007_cobertura_cola.sql`):
- `pendiente` — default, en la cola de su marca.
- `vinculado` — decisión en `sku_matcher_decisiones` (`accion='confirmar'`), el push a ML lo
  hace `pushSkusPendientes`/`escribirSkuEnMl` (mismo camino que el Matcher ML→WC existente).
- `descartado` ("solo local") — fila en `cobertura_exclusiones` (tabla ya existente, sin
  campo nuevo — regla explícita del encargo).
- `hay_que_publicarlo` — fila en `cobertura_hay_que_publicar`.
- `salteado` — fila en `cobertura_salteados`. **No es terminal**: sigue en la cola pendiente
  de su marca, ordenado al final de la tanda (no al principio).
- `sin_stock` — no tiene tabla: se calcula (stock <= 0), lista aparte, no se mezcla con la cola.

### GET /api/cobertura/resumen
Pantalla de entrada, liviana a propósito (NO el universo entero — el endpoint viejo `GET /`
pesaba 1 MB, es justo lo que este contrato reemplaza para la pantalla de entrada).
- Response: `{ ok, total_pendientes, total_valor, marcas: [{marca, conteo, valor}] (top 10),
  total_marcas, seguir_donde_quede: {marca, pendientes} | null, progreso_hoy:
  {resueltos_hoy, valor_desinmovilizado_hoy}, otras_secciones: {hay_que_publicarlo,
  multi_publicacion, solo_ml, sin_stock}, ultima_actualizacion_ml, refresco_ml_en_curso }`.
- `ultima_actualizacion_ml` es `MAX(actualizado_en)` de `ml_publicaciones_cache` (columna
  real, no un contador en memoria): está disponible **sin forzar ningún refresco** — incluso
  recién arrancado el server — y sobrevive un restart, a diferencia del estado del punto
  siguiente. Es lo que la interfaz muestra como "última actualización: hace X" (plan de
  flujo §9, "siempre visible").

### POST /api/cobertura/actualizar-ml
Botón "Actualizar desde ML" (plan de flujo §1 y §9): fuerza el refresco de **todo** el
universo de publicaciones ML (`ml_publicaciones_cache` completo, no solo las que están sin
`seller_sku`) que alimenta el matcher inverso. Reusa el mismo motor de refresco que
`POST /api/matcher/refrescar-ml` (`refrescarPublicacionesMl`, `routes/matcher.js#mlFetchConReintento`
sobre `lib/mlClient.js#mlFetch`) — no es un camino nuevo hacia ML.
- Request: sin body.
- Response 202: `{ ok:true, running:true, scope:'all' }` — arrancó en background (el scan +
  multiget completo son ~10-15 min reales con ~6840 publicaciones: cada llamada va espaciada
  1,5s, el pacing mínimo medido para no gatillar el 429 de ML — más que el timeout de nginx;
  el frontend sondea el estado con presupuesto acorde, no solo un par de minutos).
- Response 409 (**candado anti-reentrada, COMPARTIDO con el Matcher**): `{ ok:false,
  running:true, error:'Ya hay un refresco en curso', scope }` — si ya había un refresco
  corriendo (disparado desde Cobertura O desde el Matcher, da igual: es el mismo recurso),
  no arranca un segundo. Tocar el botón varias veces no multiplica la carga contra ML.
- **Presupuesto**: las llamadas usan `manual:true` (mismo trato que el resto de refrescos
  manuales del repo) — eso saltea el *cooldown* de 429, **nunca** el presupuesto de
  `lib/mlLimites.js` (`reservarCupo` se llama siempre dentro de `mlFetch`, con o sin `manual`).
- **Reintento por llamada** (incidente 2026-08-27): cada llamada individual del scan/multiget
  tolera hasta 3 reintentos con backoff ante un 5xx transitorio (`mlFetchConReintento`) antes
  de rendirse — un 429 o un 4xx normal no se reintenta. Si el estado sondeado tarda, puede ser
  esto: no es necesariamente que el refresco esté colgado.
- **Fail-closed**: si el scan o el multiget de ML fallan (agotados los reintentos), `refrescarPublicacionesMl`
  aborta ANTES de tocar la caché (el reemplazo es una transacción atómica al final) — ninguna
  publicación válida se pierde ni queda a mitad de camino. El error queda expuesto en el
  estado sondeable, `ultima_actualizacion_ml` NO avanza.

### GET /api/cobertura/actualizar-ml/estado
Sondeo del refresco forzado — mismo estado compartido que
`GET /api/matcher/refrescar-ml/estado` (un solo refresco a la vez, se vea desde donde se vea).
- Response: `{ ok, running, scope, phase, done, total, error, resultado, actualizado_en }`.
  `resultado` es `{ total, items, variaciones }` del último refresco exitoso; `error` viene
  poblado si el último intento falló (fail-closed, ver arriba) y `resultado` queda `null`.

### GET /api/cobertura/marcas
Todas las marcas con conteo/valor (para "ver todas").

### GET /api/cobertura/marcas/:marca/cola?limit=&offset=
Cola paginada de una marca — la tarjeta siguiente no espera al universo entero. Cada ítem
trae `candidatos` (hasta 8, motor `candidatosParaWC`) y `sin_candidato`. Al pedirla se
actualiza `cobertura_sesion` ("seguir donde quedé" apunta a la última marca consultada).
- Response: `{ ok, marca, total, data: [{...catalogo_cache, salteado, candidatos, sin_candidato}] }`.

### GET /api/cobertura/productos/:id_woo/buscar-ml?q=
Búsqueda manual entre publicaciones ML sin `seller_sku`, con el mismo diff estructurado que
los candidatos sugeridos (mismo componente de tarjeta en el frontend). Disponible siempre.

### POST /api/cobertura/productos/:id_woo/confirmar
Body: `{ ml_clave }`. Escribe la decisión en `sku_matcher_decisiones` (accion='confirmar',
`origen='cobertura'`) **antes** de intentar el push — si ML no responde, la decisión queda
igual guardada (fail-open, el cron la toma después). La respuesta distingue a propósito:
- `{ ok:true, estado:'vinculado', clave, sku }` — ML confirmó al toque.
- `{ ok:true, estado:'pendiente_sync', clave, sku, motivo }` — guardado, ML no respondió
  todavía. **El frontend debe mostrar un mensaje distinto**, nunca el mismo que "vinculado".
- **400** `{ ok:false, error }` — la `ml_clave` no existe en `ml_publicaciones_cache` (pestaña
  vieja tras un refresco que cerró publicaciones).
- **409** `{ ok:false, error }` — **BLOQUEANTE corregido**: la clave ya tiene una decisión
  viva en `sku_matcher_decisiones` que no es esta (accion='omitir' del Matcher ML→WC, o
  'confirmar'/'asignar' para OTRO sku). Antes esto se pisaba en silencio: A confirmaba una
  publicación, B la confirmaba después contra otro producto (push de A todavía pendiente,
  `seller_sku` seguía NULL en caché) y A perdía su vínculo sin aviso. `origen='cobertura'`
  en la fila distingue estas decisiones de las que escribe el Matcher ML→WC sobre la misma
  tabla — así "resueltos hoy" (`GET /resumen`) y el historial no se inflan con trabajo de la
  otra herramienta.

### POST /api/cobertura/productos/:id_woo/descartar
"Solo local" → `cobertura_exclusiones` (motivo `solo_local`). Sin body.

### DELETE /api/cobertura/exclusiones/:id_woo/revertir
Revierte "solo local": el producto vuelve a `pendiente`.

### POST /api/cobertura/productos/:id_woo/publicar
Manda a "hay que publicarlo" (`cobertura_hay_que_publicar`).

### DELETE /api/cobertura/hay-que-publicar/:id_woo
Revierte: el producto vuelve a `pendiente`.

### POST /api/cobertura/productos/:id_woo/saltear
`cobertura_salteados`. No terminal — reaparece al final de la cola de su marca.

### GET /api/cobertura/historial?q=&limit=
Vinculados (`sku_matcher_decisiones` accion='confirmar') + descartados
(`cobertura_exclusiones`), buscable por nombre/SKU, orden por fecha desc. Cada entrada de
vínculo trae `pendiente_sync` (true si `ml_publicaciones_cache.seller_sku` todavía no
coincide con el SKU de la decisión — mismo criterio que POST /confirmar).

### POST /api/cobertura/vinculos/:clave/deshacer
Solo deshace vínculos con `origen='cobertura'` (no toca decisiones del Matcher ML→WC sobre
la misma tabla). Revierte un vínculo: vuelve el producto a `pendiente`. Si el push a ML **ya
se efectivizó** (`seller_sku` cacheado == sku de la decisión), dispara la desvinculación en
ML primero. **FAIL-CLOSED explícito**: si ML no confirma la desvinculación, NO se toca nada
local (ni la decisión ni la caché) y responde `502 { ok:false, error, fail_closed:true }` —
evita dejar el producto libre localmente mientras ML sigue mostrando el SKU viejo (el riesgo
de "vínculo equivocado" que todo el diseño de Cobertura existe para evitar). Si nunca se
efectivizó en ML, revierte local sin llamar a ML.

**ALTO corregido (revisor) — carrera con `pushSkusPendientes` (cron cada 10 min):**
- Si hay un push corriendo (`getEstadoPush().running`), responde `409 { ok:false, error,
  fail_closed:true, push_en_curso:true }` de entrada, sin intentar nada — reintentar en unos
  segundos alcanza.
- Ventana residual (push que arranca justo después de ese chequeo): tras borrar la decisión
  local, se **relee** `ml_publicaciones_cache`. Si el push ganó la carrera y el `seller_sku`
  ya está puesto, se dispara `desvincularSkuEnMl` fail-closed; si esa desvinculación falla,
  **se restaura la decisión local** (vuelve a coincidir con la realidad de ML) y responde
  `502 { fail_closed:true }` — nunca queda local diciendo "libre" mientras ML sigue con el SKU.

**🟡 corregido (revisor, ronda 3) — `mlFetch` LANZA ante fallo de transporte, no siempre
devuelve `{ ok:false }`** (`lib/mlClient.js`: `throw e` tras un error de red/timeout/DNS, a
diferencia de un 4xx/5xx de ML que sí vuelve como respuesta normal). Las tres llamadas a
`desvincularSkuEnMl`/`pausarPublicacionMl` de este contrato (rama `yaEfectivizado`, rama
post-delete de este endpoint, y `pausarConAdvertencia` de multi-publicación/solo-ML) están
envueltas en `try/catch` tratando la excepción igual que `{ ok:false }` — sin esto, un cable
de red cortado en el momento exacto de la desvinculación post-delete dejaba la decisión ya
borrada, ML con el SKU intacto, y un 500 genérico en vez del 502 fail-closed con
restauración: exactamente la divergencia que el fix anterior prometía cerrar, solo que
alcanzable con un error de transporte en vez de un 4xx de ML.

### GET /api/cobertura/hay-que-publicar
Lista ordenada por valor desc. `PATCH /api/cobertura/hay-que-publicar/:id_woo` con
`{ tachado: true|false }` es el check manual (no dispara nada de sistema).

### GET /api/cobertura/hay-que-publicar/export.csv
Excel/CSV de la lista completa (`lib/csv.js#generarCSVHayQuePublicar`).

### GET /api/cobertura/multi-publicacion
**Reemplaza** el slice liviano que antes servía `computarCruce().multiPub` en esta misma
ruta (ese dato crudo sigue disponible en `GET /cruce`). Por producto: `{ id_woo, nombre, sku,
stock_wc, sobreventa, publicaciones: [{ clave, item_id, variation_id, status, stock,
sin_stock_ml }] }`. El encabezado del frontend debe aclarar que es intencional (condiciones
de venta distintas) — no se "arregla" desvinculando todo.
- `sobreventa` (🟡 corregido, a nivel de PRODUCTO): `true` si la suma del stock ML de todas
  las publicaciones **activas** supera el stock WC — el mismo stock físico único se está
  prometiendo más de una vez. Antes este nombre lo llevaba, mal, una señal por-publicación
  ("esta publicación no tiene stock en ML") que es lo contrario de sobreventa.
- `sin_stock_ml` (por publicación, antes mal llamado `sobreventa`): `true` si esa publicación
  puntual no tiene stock cargado en ML. Señal aparte, no reemplaza a `sobreventa`.
- Publicaciones marcadas "correcta" (ver abajo) **no aparecen** en `publicaciones` — si un
  producto se queda sin ninguna publicación por marcar-correcta, el producto entero
  desaparece de la lista (🟡 corregido: antes el flag no suprimía nada).

- `POST /api/cobertura/multi-publicacion/:clave/marcar-correcta` — decisión puramente local
  (`cobertura_marcados_correcto`, sección `multi_publicacion`), no escribe en ML. **Saca la
  publicación de la lista** (no solo marca un flag).
- `POST /api/cobertura/multi-publicacion/:clave/pausar` — escritura a ML (`status:'paused'`,
  **nunca cerrar**). FAIL-CLOSED: si ML no confirma, la caché local no cambia, `502
  { fail_closed:true }`.
  - **ALTO corregido (revisor):** ML no permite pausar una variación individual — pausar
    cualquier clave de un `item_id` pausa TODAS sus variaciones hermanas. Si la clave es una
    variación con hermanas y el body no trae `{ confirmado: true }`, responde `409
    { ok:false, requiere_confirmacion:true, variaciones_afectadas:N, error }` **sin ejecutar
    nada**. Con `{ confirmado: true }` (o si es una publicación simple, sin hermanas)
    procede y responde `200 { ok:true, estado:'paused', variaciones_afectadas:N }`.
- `POST /api/cobertura/multi-publicacion/:clave/desvincular` — limpia `seller_sku` en ML
  (mismo criterio fail-closed que `POST /vinculos/:clave/deshacer`) y borra la decisión local.

### GET /api/cobertura/solo-ml?q=&limit=&offset=
Publicaciones sin `seller_sku` **y sin decisión viva** (ver BLOQUEANTE abajo), buscable por
título (son ~3638: consulta filtrada, no cola de a una). Las marcadas "correcta" también
quedan excluidas (mismo criterio de supresión que multi-publicación) — no viaja más el campo
`marcada_correcta`, la fila directamente no aparece.
- **BLOQUEANTE corregido (revisor):** antes solo miraba `seller_sku` vacío. Ahora excluye
  también cualquier clave con una fila en `sku_matcher_decisiones` (omitida por el Matcher
  ML→WC, o ya confirmada para un producto con el push todavía pendiente) — mismo criterio
  que el universo de candidatos del matcher inverso (`construirIndiceMlSinSku`). El conteo de
  `GET /resumen.otras_secciones.solo_ml` usa el mismo criterio exacto.
- `POST /api/cobertura/solo-ml/:clave/marcar-correcta` — igual que en multi-publicación (suprime).
- `POST /api/cobertura/solo-ml/:clave/pausar` — mismo criterio de advertencia por variación
  (`variaciones_afectadas`, 409 sin `confirmado:true`) y fail-closed que multi-publicación.
- `POST /api/cobertura/solo-ml/:clave/vincular` — body `{ id_woo }`. El mismo trabajo al
  revés que `POST /productos/:id_woo/confirmar`: mismas validaciones (clave existente, 409 si
  ya tiene otra decisión viva), mismo camino de escritura (`escribirSkuEnMl`), mismo criterio
  fail-open (`estado: 'vinculado'|'pendiente_sync'`).

### GET /api/cobertura/sin-stock
Lista aparte (stock <= 0, resto de las reglas de `esFaltante` sin el filtro de stock). No se
mezcla con la cola principal — por si reponen.

### Nota de escritura a ML (todo lo de arriba)
Todo lo que escribe en ML pasa por `mlFetch` (`lib/mlClient.js`), que ya aplica el
presupuesto de `lib/mlLimites.js` y el cooldown/backoff ante 429 — Cobertura no reinventa
nada de eso. `escribirSkuEnMl`/`desvincularSkuEnMl`/`pausarPublicacionMl` (`lib/matcherPush.js`)
son los tres únicos puntos de escritura hacia ML que usa este contrato.

### Permisos — **SUPERADO por el Matcher unificado, entrega 1 (2026-08-14, ver sección al
final del documento)**. `cobertura` como permiso aparte (`niveles:false`) ya no existe: se
absorbió en el permiso único `matcher` (`niveles:true`). Se deja el texto original como
registro de por qué `/cobertura` pedía `nivel:'read'` fijo — ya no aplica, ahora deriva del
método (`nivelDe(m)`) como el resto de las herramientas `niveles:true`.

<details><summary>Texto original (histórico)</summary>

`cobertura` era `niveles:false` en `lib/permisos.js` (checkbox de "acceso" en la UI de
Usuarios, sin selector read/write — igual que `inventario`/`etiquetas`). La regla pedía
`nivel:'read'` **fijo**, sin importar el método HTTP: con `nivelDe(m)` (derivado del método),
todo POST/PATCH/DELETE de esta lista pedía `write`, que `niveles:false` nunca podía otorgar
— un operario no-admin con el permiso tildado no podía usar ni un solo botón (403 en todo
menos las lecturas). Mismo bug que ya costó el Contador de Inventario v2.

</details>

### Conteos consistentes entre `/resumen` y las listas reales
`GET /resumen.otras_secciones.sin_stock` usa el mismo criterio EXACTO que `GET /sin-stock`
(`lib/coberturaCola.js#calcularSinStock`, función compartida) y `.solo_ml` usa el mismo
criterio EXACTO que `GET /solo-ml` (sin `seller_sku` y sin decisión viva). Antes divergían —
🔵 hallazgo del revisor: la tarjeta de entrada mostraba un número que la lista real nunca
podía alcanzar.

### `origen` en `sku_matcher_decisiones` (columna nueva, migración 008)
Distingue las decisiones que escribe Cobertura (`origen='cobertura'`) de las que escribe el
Matcher ML→WC (`routes/matcher.js`, mismo tabla, `origen` queda `NULL`). `GET
/resumen.progreso_hoy.resueltos_hoy`, `GET /historial` y `POST /vinculos/:clave/deshacer`
filtran por `origen='cobertura'` — sin esto, confirmar un vínculo desde la otra herramienta
inflaba "resueltos hoy" y aparecía en el historial de Cobertura (🟡 hallazgo del revisor).

## Matcher unificado — entrega 1 (2026-08-14)

Permiso único, sesión por usuario, concurrencia optimista, Vínculos absorbido y redirects.

Fusiona `cobertura` (WC→ML, `/api/cobertura`), `matcher` (ML→WC, `/api/matcher`) y `vinculos`
(`public/vinculos/index.html`) en una sola herramienta llamada **Matcher**. **Solo backend en
esta entrega** — el frontend único (una pantalla, dos direcciones, dirección ML→WC
deshabilitada como "próximamente") es un despacho aparte contra este contrato. El
motor de matching **no se tocó** (`lib/matcherEngine.js` sigue como estaba — eso es la
entrega 2).

**IMPORTANTE para el frontend que consuma este contrato: nada de lo de arriba en este
documento (rutas de `/api/cobertura/*` y `/api/matcher/*`) cambió de forma** — mismos paths,
mismos requests, mismas responses de éxito. Lo que cambió es (1) qué permiso hace falta para
llamarlos, (2) cuatro rutas nuevas absorbidas de Vínculos bajo `/api/cobertura/vinculos*`
(arriba, sección "Vínculos WC↔ML"), (3) dos campos nuevos en la respuesta de `POST
/productos/:id_woo/confirmar` y `POST /solo-ml/:clave/vincular` cuando hay conflicto de
concurrencia, y (4) `GET /resumen.seguir_donde_quede` ahora es por usuario.

### 1. Permiso único `matcher`
`lib/permisos.js`: `cobertura` (`niveles:false`) desapareció de `HERRAMIENTAS`. Todo lo que
antes pedía `cobertura` ahora pide `matcher` (`niveles:true`, igual que ya tenía la dirección
ML→WC) — incluye `/api/cobertura/*` completo (nivel deriva del método: GET→read,
POST/PATCH/DELETE→write) y el endpoint compartido `GET /api/sync/buscar-sku` (Buscar
producto), que ahora acepta `matcher` además de `config-ml`/`sync-ml`.

**El permiso se migra solo** (`migrations/014_permiso_cobertura_a_matcher.sql`): quien tuviera
`cobertura` recibe `matcher` **con el mismo nivel**, y las filas de `cobertura` se borran. Si
ya tenía `matcher`, ese gana — bajarlo sería quitarle acceso que hoy usa.

Es defensivo a propósito. Medido sobre la base de staging del 2026-08-14, **nadie quedaría
afuera** (el único con `cobertura` es Santi, que además tiene `matcher=write`, así que solo
se le limpia la fila huérfana). Pero **producción es una base distinta que se pasa a mano** y
no se puede verificar desde el entorno de desarrollo: sin la migración, un usuario que allá
tuviera solo `cobertura` perdería el acceso **en silencio** al desplegar. Verificado sobre una
copia de la base real, en los dos casos: el de Santi (conserva `write`, se limpia la huérfana)
y el de un usuario con solo `cobertura` (recibe `matcher` con su nivel y conserva sus otros
permisos).

Joaco, que hoy tiene `matcher` (write) pero no tenía `cobertura`, **ya queda con acceso a
todo** sin que nadie toque nada — es el efecto buscado. Santi pasa de `read` en cobertura a
poder trabajar la cola completa: **consultado y confirmado con el usuario el 2026-08-14.**

**Excepción admin-only, aplicada en el handler (`requireAdmin`, `lib/auth.js`), NO en
`lib/permisos.js`** (`resolvePermiso` no distingue por sub-ruta con esa granularidad):
- `POST /api/cobertura/multi-publicacion/:clave/pausar`
- `POST /api/cobertura/solo-ml/:clave/pausar`
- `POST /api/cobertura/multi-publicacion/:clave/desvincular`
- `POST /api/cobertura/vinculos/:clave/desvincular` (nuevo, absorbido de Vínculos)

Responden `403 { ok:false, error:'Requiere administrador' }` a un no-admin, aunque tenga
`matcher` con nivel `write`.

**`POST /api/cobertura/vinculos/:clave/deshacer` exige ser el autor, o admin.** Un no-admin
solo puede deshacer un vínculo cuyo `confirmado_por` sea el suyo; sobre uno ajeno recibe 403
diciendo quién lo confirmó. Los vínculos anteriores a la migración 013 no tienen autor
registrado y quedan solo para admin, que es el default seguro. *(La versión anterior de este
documento decía que `deshacer` no era la misma acción que "desvincular" porque no escribía en
la publicación en vivo. Era falso: cuando el vínculo ya se efectivizó, `deshacer` llama al
mismo `desvincularSkuEnMl` y escribe en ML igual. Hallazgo del revisor.)*

**`POST /api/cobertura/vinculos/reasignar` no es admin-only**, pero desde la entrega 1 pasa
por la **misma revalidación** que confirmar: si la clave ya la resolvió otra persona con otro
SKU, devuelve `409 { ya_resuelto, resuelto_por, propio, sku, wc_nombre }` en vez de pisarla en
silencio. Antes vivía bajo el permiso `sync-ml` (otra herramienta, otro perfil de usuario) y
esa diferencia era defendible; al mudarla a la superficie del Matcher quedan las dos
escrituras a un click de distancia y tienen que jugar con la misma regla.

**Límite real del gate de "desvincular", para que no diga lo que no es:** es admin-only *en
la superficie del Matcher*. Quien además tenga `sync-ml` con nivel `write` puede desvincular
desde `POST /api/sync/desvincular` (Sync ML Detalle), que no pasa por `requireAdmin`. Medido
sobre la base real el 2026-08-14: el único con ese permiso es **Santi**, que no es admin.
**No es una regresión de esta entrega** — ya era así —, pero afirmar sin condiciones que "un
no-admin no puede desvincular" sería falso.

El frontend debe mostrar pausar/desvincular **deshabilitados con el motivo** a un no-admin,
nunca ocultos (si Joaco no los ve, va a creer que es un bug — decisión de flujo ya cerrada).

### 2. Sesión por usuario (migración 012)
`cobertura_sesion` deja de ser un singleton (`id=1`, compartido por todos) y pasa a
`(user_id, direccion)` — `direccion` queda fija en `'wc_ml'` en esta entrega (pensando en la
entrega 2, ML→WC, que tendrá la suya). `lib/coberturaCola.js#seguirDondeQuede` y `#tocarSesion`
ahora reciben `userId` (de `req.user.id`); sin `userId` son no-op / devuelven `null` (no
debería pasar detrás de `authGuard`, pero no revientan si pasa en un test o script).
**Efecto en el contrato:** `GET /api/cobertura/resumen.seguir_donde_quede` y el side-effect
de `GET /api/cobertura/marcas/:marca/cola` (que actualiza la sesión) ahora son **por
usuario** — dos personas trabajando la cola al mismo tiempo ya no se pisan el progreso. La
forma de la respuesta no cambió (`{marca, pendientes} | null`).

Se pierde el dato del singleton viejo al migrar (sqlite no soporta cambiar la PRIMARY KEY,
se recrea la tabla) — es solo "en qué marca estaba trabajando", dato de conveniencia, no de
negocio.

### 3. Concurrencia optimista al confirmar
La cola está priorizada: dos personas pueden ver primero las mismas publicaciones. **Sin
locks por ítem** (decisión del plan — sobre-ingeniería para dos personas ocasionales, y deja
candados huérfanos si alguien cierra la pestaña). La revalidación ya estaba: `confirmarDecisionCobertura`
(`routes/cobertura.js`) lee la decisión existente y recién después escribe, todo síncrono
(`better-sqlite3`, sin `await` en el medio) — no hay ventana de carrera real dentro de ese
proceso Node.

**Lo nuevo es el CONTENIDO del 409 cuando otra persona ya resolvió la misma clave con OTRO
sku** (`POST /api/cobertura/productos/:id_woo/confirmar` y `POST
/api/cobertura/solo-ml/:clave/vincular`):

```json
{
  "ok": false,
  "error": "Ya lo resolvió Ana: vinculado a FB-1",
  "ya_resuelto": true,
  "resuelto_por": "Ana",
  "accion": "confirmar",
  "sku": "FB-1",
  "wc_nombre": "Pedales M520"
}
```
`resuelto_por` es el `username` de quien lo confirmó (columna nueva `confirmado_por` en
`sku_matcher_decisiones`, migración 013 — puede ser `null` en decisiones viejas, previas a
esta entrega, o escritas por el Matcher ML→WC). El frontend debe mostrar "Ya lo resolvió
{resuelto_por}: vinculado a {sku}" y **avanzar solo** al siguiente ítem de la cola — no es un
error que frene el flujo. El caso `accion==='omitir'` (la publicación fue descartada desde el
Matcher ML→WC) sigue devolviendo el mismo 409 mudo de antes (sin `ya_resuelto`): no es un
conflicto entre dos personas de Cobertura, es una decisión de la otra herramienta.

### 4. Vínculos absorbido
Ver la sección "Vínculos WC↔ML" más arriba en este documento — se movió completa a
`/api/cobertura/vinculos*`, con el detalle ruta por ruta (incluida la nueva
`POST /vinculos/:clave/desvincular`, admin-only). `POST /api/sync/desvincular` sigue vivo sin
cambios (otro consumidor: Sync ML Detalle).

### 5. Redirects con aviso
`/cobertura` y `/vinculos` (las pantallas estáticas, NO `/api/cobertura`) redirigen con
`302` a `/herramientas/matcher/?aviso=unificado`. El query param `aviso=unificado` es la
señal para que el frontend del Matcher muestre el cartel "se unificó" — la implementación del
cartel (texto, cierre, si se repite) es responsabilidad del frontend, acá solo se garantiza
que nunca hay un 404 crudo en un acceso directo viejo.

## Contador de inventario — cierre seguro (2026-08-21)

Origen: `docs/incidentes/2026-08-21-sobreventa-por-no-contado.md`. Se vendió en ML un producto
que un conteo nunca verificó y seguía publicado con stock. Causa: `/confirmar` recorría solo
`inventario_conteos`, y un producto del alcance nunca escaneado no tiene fila ahí.

### `POST /api/inventario/sesiones/:id/confirmar` — 409 nuevo

Si la sesión está **abierta** y quedan productos del bloque `con_stock` sin ninguna fila de
conteo, responde **409 sin tocar Woo ni el estado de la sesión**:

```json
{ "ok": false, "error": "Quedan productos con stock sin contar...",
  "pendientes_con_stock": 9,
  "pendientes": [{ "sku": "FB-7555", "nombre": "...", "stock_woo": 2 }] }
```

El bloque `sin_stock` **no** entra al gate: ya está en 0 en Woo, ajustarlo a 0 es un no-op.

El gate corre **solo con la sesión abierta**. Un reintento desde `confirmada_con_errores` no
se bloquea: esa sesión ya está cerrada y sus pendientes no se pueden decidir nunca más, así
que bloquearlo no protegería nada y dejaría trabados para siempre los ajustes que fallaron por
un error de Woo (la sesión 5 de producción está justo así).

### `POST /api/inventario/sesiones/:id/cerrar-en-cero`

Crea filas de conteo en 0 (`confirmado_por_omision=1`) para productos del bloque `con_stock`
del alcance que todavía no se contaron. Es lo que permite salir del 409 de arriba.

```json
// request
{ "skus": ["FB-2", "FB-3"] }
// response
{ "ok": true, "cerrados": 2, "skus": ["FB-2", "FB-3"] }
```

**Nunca acepta `todos: true`** — devuelve 400 si falta `skus` o viene vacío. Esto no es una
omisión: bajar a 0 productos que tenían stock termina escribiendo en Woo al confirmar, y un
botón masivo sería la salida fácil que devuelve el problema que el gate vino a arreglar. Su
hermana `cerrar-sin-stock` sí acepta `todos:true`, porque esos productos ya están en 0.

Los SKU pedidos se intersectan con el alcance de **esa** sesión y **ese** bloque: no se puede
colar un SKU de otra sesión, fuera del alcance, ni del bloque `sin_stock`. 400 si la sesión no
está abierta.

## Etiquetas — cola persistente (Fase 1 del plan de control de stock, 2026-08-25)

Hasta acá `public/etiquetas/index.html` guardaba la cola de impresión en `localStorage` del
navegador (se perdía al cerrar la pestaña). Estos endpoints la reemplazan por una cola en la
base (`etiquetas_cola`, creada por `routes/etiquetas.js`). Permiso: herramienta `etiquetas`
(`niveles:false`, igual criterio que `inventario` — acceso total una vez adentro).

### GET /api/etiquetas/cola
Lista la cola. Opcionalmente filtra por `?estado=pendiente|impresa`.

- Response 200: `{ "ok": true, "cola": [ { id, sku, cantidad, origen, sesion_id,
  solicitado_por, nota, estado, creado_en, impreso_en } ] }`.

### POST /api/etiquetas/cola
Agrega un ítem a la cola.

- Request: `{ sku, cantidad, origen?, sesion_id?, nota? }`. `sku` no vacío, `cantidad` entero
  > 0 (400 si no). `solicitado_por` se toma de `req.user.username`, no del body.
- Response 200: `{ "ok": true, "item": {...} }`.

### PATCH /api/etiquetas/cola/:id
Edita `cantidad` y/o `nota` de un ítem **pendiente**. 400 si el ítem ya está `impresa`
(inmutable una vez impresa — evita reimprimir con datos distintos a los que salieron por la
térmica). 404 si no existe.

- Request: `{ cantidad?, nota? }`.
- Response 200: `{ "ok": true, "item": {...} }`.

### POST /api/etiquetas/cola/marcar-impresas
Marca varios ítems como impresos de una vez (después de imprimir el lote).

- Request: `{ ids: [1, 2, 3] }`. 400 si `ids` viene vacío.
- Response 200: `{ "ok": true, "marcadas": <n> }`. Solo cuenta los que estaban `pendiente`
  (idempotente: reenviar los mismos ids no vuelve a marcarlos ni suma al conteo).

### DELETE /api/etiquetas/cola/:id
Descarta un ítem **pendiente** (p.ej. se decidió que no hace falta etiqueta). 400 si ya
está `impresa` (inmutable, igual criterio que PATCH — una vez impresa queda como registro,
no se borra). 404 si no existe.

- Response 200: `{ "ok": true }`.
- Response 400: `{ "ok": false, "error": "solo se puede descartar un ítem pendiente..." }`.

Sin llamadas a ML/Woo — no aplica fail-open/fail-closed. Sin cambios al renderer 50×25mm
existente: estos endpoints son solo la fuente de datos, la pestaña "Cola de conteo" del
frontend (próximo despacho) consume el mismo renderer sin tocarlo.

## Ubicaciones — alcance por ubicación física (Fase 2 del plan de control de stock, 2026-08-25)

Zona+estante como alcance alternativo de sesión (barrido completo de un lugar físico),
mutuamente excluyente con categoría/marca. Habilita el cierre en cero seguro (Rupturas 3 y 6
del plan): un SKU con unidades registradas en más de una ubicación, o sin ninguna ubicación
registrada, nunca se cierra en cero automáticamente.

### GET /api/inventario/ubicaciones
Lista las ubicaciones activas con cuántos SKUs tienen asociados.

- Response 200: `{ "ok": true, "ubicaciones": [ { id, zona, estante, estado, activa,
  creado_en, skus_registrados } ] }`. `estado`: `bootstrap` | `mapeada`.

### POST /api/inventario/ubicaciones (admin)
Crea una ubicación nueva.

- Request: `{ zona, estante }`, ambos no vacíos.
- Response 200: `{ "ok": true, "ubicacion": {...} }` (`estado` arranca en `bootstrap`).
- Response 409: ya existe esa zona+estante.

### POST /api/inventario/ubicaciones/:id/mapear (admin)
Marca la ubicación como recorrida y completa. Es el único estado que habilita el cierre en
cero automático masivo sobre esa ubicación — nunca se infiere solo, es una decisión
explícita de quien la mapeó.

- Response 200: `{ "ok": true, "ubicacion": {...} }` (`estado: "mapeada"`).
- Response 404: no existe o está inactiva.

### POST /api/inventario/sesiones (extendido)
Ahora acepta `ubicacion_id` como alternativa a `categorias`/`marcas` — no se pueden combinar
en la misma sesión (400 si vienen ambos). El alcance de una sesión por ubicación arranca
vacío (bootstrap: todavía no hay nada asociado a esa ubicación) y se va poblando solo a
medida que se escanea — ver "Captura automática" abajo.

- Request: `{ ubicacion_id }` en vez de `{ categorias, marcas }`.
- Response 400: `ubicacion_id` inexistente/inactiva, o viene junto con categorías/marcas.
- El anti-solape entre sesiones (409 "El alcance se cruza con la sesión de X") ahora también
  cubre ubicación: dos sesiones se cruzan si comparten al menos un SKU real, sin importar si
  una es por ubicación y la otra por categoría/marca.

### Captura automática durante el conteo
Si la sesión activa tiene `ubicacion_id`, todo SKU que se escanea (`POST
.../sesiones/:id/escanear`) o se asocia (`POST .../sesiones/:id/asociar`) se asocia SOLO a
esa ubicación en `producto_ubicacion` (INSERT OR IGNORE — re-escanear el mismo SKU no
duplica ni pisa la fecha de la primera asociación). Sin acción manual del operario.

### POST /api/inventario/sesiones/:id/cerrar-sin-stock (reglas nuevas cuando la sesión es por ubicación)
- 400 si la ubicación de la sesión todavía NO está `mapeada` — el cierre en cero automático
  no es seguro hasta recorrerla entera.
- Si está mapeada: de los SKUs a cerrar, se **excluyen** (no fallan, se filtran) los que
  tengan unidades registradas en OTRA ubicación además de esta (overflow) — nunca se
  auto-cierran. Un SKU sin ninguna ubicación registrada tampoco puede ser candidato en una
  sesión por ubicación (el alcance se construye solo desde `producto_ubicacion`).
- Response 200 agrega `excluidos_por_ubicacion: [sku, ...]` cuando hubo alguno filtrado
  (el campo no aparece si no hubo exclusiones).
- Comportamiento de una sesión por categoría/marca (sin `ubicacion_id`): sin cambios.

## Rotación y criticidad — historial de ventas + score compuesto (Fase 3 del plan de control de stock, 2026-08-25)

Infraestructura para el planificador de ciclos (Fase 4): historial de ventas WC+ML
(`ventas_historial`) y un score de criticidad calculado on-demand, no cacheado (ver
`lib/criticidad.js`). Sin pantalla propia todavía — gateado bajo el permiso `inventario`.

### Backfill / incremental
`lib/criticidad.js#backfillVentas(db, cfg)` trae ventas de WooCommerce (`/orders`,
status completed/processing) y MercadoLibre (`/orders/search`, status paid) de los últimos
12 meses, con cursor incremental por canal (retoma desde la última fecha vista menos 1 día
de margen). El SKU de MercadoLibre se resuelve con la MISMA lógica que `syncMlToWc`
(`routes/sync.js`): vínculo confirmado en `sku_matcher_decisiones` primero, `seller_sku` de
la publicación como fallback — no se reimplementa. Un canal caído no bloquea al otro
(fail-open entre canales; cada uno reporta su propio error si falla). Corre solo por el cron
diario (`0 5 * * *` en `server.js`) — no hace falta correrlo a mano.

### GET /api/criticidad/top?limit=50
Lista SKUs ordenados por score de criticidad descendente (score compuesto 0..1: ventas 12m
40%, historial de diferencias de inventario 30%, categoría marcada crítica 20%, valor de
stock actual 10%; cada dimensión normalizada contra el máximo del catálogo).

- Response 200: `{ "ok": true, "criticidad": [ { sku, score, ventas_12m,
  diferencias_historicas, categoria_critica, valor_stock } ] }`.

### GET /api/criticidad/categorias-criticas
Lista las categorías marcadas como críticas a mano.

- Response 200: `{ "ok": true, "categorias": [ { categoria, marcado_por, marcado_en } ] }`.

### POST /api/criticidad/categorias-criticas (admin)
Marca una categoría como crítica (afecta el score de todo SKU que la tenga).

- Request: `{ categoria }`. Idempotente (no falla si ya estaba marcada).
- Response 200: `{ "ok": true }`.

### DELETE /api/criticidad/categorias-criticas/:categoria (admin)
Desmarca. 404 si no estaba marcada.

### POST /api/criticidad/backfill (admin)
Dispara manualmente el backfill/incremental (sin esperar al cron diario) — útil después de
marcar categorías nuevas o para diagnosticar un canal caído.

- Response 200: `{ "ok": true, "resultado": { woo: {ordenes, insertados} | {error},
  ml: {ordenes, insertados} | {error} } }`.
- Response 502: excepción no controlada (no debería pasar — `backfillVentas` ya atrapa los
  errores de cada canal por separado; esto cubre un fallo fuera de esa función).

## Planificador de ciclos — plan del día y conteo dirigido (Fase 4 del plan de control de stock, 2026-08-25)

### Siembra automática: sku_ultimo_conteo
Al confirmar (o reintentar) una sesión, `sembrarUltimoConteo` graba en `sku_ultimo_conteo`
(sku, contado_en, sesion_id, por_omision, diferencia_ultima) cada SKU de
`inventario_conteos` de esa sesión — **nunca** desde `inventario_sesion_alcance`
(Ruptura 9: eso infla la cobertura con SKUs que quedaron pendientes, no contados de
verdad). Un cierre en cero por omisión también siembra (con `por_omision=1`, evidencia
más débil). Protegido contra pisar un conteo más reciente del mismo SKU hecho por otra
sesión mientras esta estaba `confirmando`.

### GET /api/inventario/plan-hoy
Propone UNA sesión para hoy.

- Si hay al menos una ubicación `mapeada` con productos asociados: propone la más urgente
  (mayor `dias_sin_contar` entre sus SKUs) como barrido completo, `cierre_en_cero_habilitado:
  true` (las reglas de seguridad de Fase 2 siguen aplicando al cerrar).
- Si no hay ninguna ubicación mapeada todavía (Ruptura 6, ciclo 0): propone bootstrap por
  categoría — la que tenga más SKUs nunca contados —, `cierre_en_cero_habilitado: false`.
- `capacidad_estimada_2h` sale del ritmo del usuario (percentil 25 de sus últimas sesiones,
  mismo cálculo que `GET /ritmo`; sin usuario en la sesión usa el fallback 20/h). No separa
  ritmo por condición escaneado/manual (Ruptura 8) todavía — esa granularidad requiere
  trackear qué ítems se escanearon vs se tipearon a mano, dato que hoy no se registra por
  separado; queda para un despacho futuro si hace falta.
- `queda_afuera` es una estimación (`productos - capacidad_estimada_2h`), no una lista.

Response 200:
```
{ ok, propuesta: { tipo: 'ubicacion'|'categoria_bootstrap', ...,
    cierre_en_cero_habilitado, capacidad_estimada_2h, queda_afuera } | null,
  ritmo: { ritmo, estimado, muestras },
  cobertura: { total_contable, con_conteo_registrado, porcentaje, vencidos_20_dias },
  ubicaciones: { mapeadas, totales } }
```

### GET /api/inventario/dirigido?limit=20
Lista informativa de los SKUs más urgentes (mayor días sin contar, nunca contados primero),
para "apagar incendios" puntuales. **No crea sesiones ni habilita cierre en cero** — contar
uno de estos SKUs se hace desde una sesión normal por categoría/marca/ubicación (Ruptura 5:
el "conteo dirigido" como TIPO de sesión con su propio alcance de lista-de-SKUs queda fuera
de este despacho — este endpoint es solo la lista de prioridades).

- Response 200: `{ ok, dirigido: [ { sku, nombre, stock, dias_sin_contar, nunca_contado } ] }`.

## Actualización de stock — push inmediato a MercadoLibre

Dos endpoints que aplican stock a WooCommerce disparan, para cada SKU que se aplicó CON ÉXITO
en WC, un push puntual de ese SKU a ML (`syncSkuPuntual`). Si aplicar a WC falló para un SKU,
NO se intenta el push — `catalogo_cache` sigue con el stock viejo en ese caso, así que empujar
igual pushearía a ML un valor sin relación con el cambio pedido. El campo `sync_ml` en la
respuesta confirma si el push fue exitoso, quedó pendiente/omitido, o falló (fail-open: si
falla, el error se reporta pero no bloquea; el cron periódico de `syncWcToMl` retoma como
respaldo).

**`sync_ml` NO está alineado por índice con `resultados`**: solo trae una entrada por cada SKU
que sí se aplicó en WC (los que fallaron en `resultados` no tienen contraparte en `sync_ml`), y
tampoco emite entrada si el ítem no tenía `sku`.

### POST /api/recepciones/:id/confirmar (campo agregado: `sync_ml`)
- Response 200 (agrega campo):
  ```
  {
    "ok": true,
    "aplicados": 5,
    "errores": 0,
    "sin_match": 2,
    "resultados": [...],
    "pendientes": [...],
    "confirmado_en": "2026-08-26T15:30:00.000Z",
    "solo_documento": false,
    "sync_ml": [
      { "sku": "FB-1234", "estado": "sincronizado", "detalle": "1/1 publicaciones actualizadas" },
      { "sku": "FB-5678", "estado": "sin_cambios", "detalle": "Sin cambios pendientes en ML" },
      { "sku": "FB-9999", "estado": "error", "detalle": "Fallo tras reintento: ..." }
    ]
  }
  ```

### POST /api/woo/stock/aplicar (campo agregado: `sync_ml`)
- Mismo shape que `POST /api/recepciones/:id/confirmar`, agregado a la respuesta existente
  (`ok`, `aplicados`, `errores`, `resultados`).

### Shape de cada elemento de `sync_ml`
- `sku`: identificador del producto.
- `estado`:
  - `'sincronizado'`: al menos una publicación de ese SKU se actualizó en ML con éxito, y
    ninguna falló (si alguna falló, el agregado es `'error'` aunque otra sí se haya
    sincronizado — no se reporta éxito parcial como si fuera total).
  - `'sin_cambios'`: sin diff pendiente en ML, o ninguna publicación del SKU estaba activa.
  - `'error'`: al menos una publicación falló tras el reintento (error real de ML, no 429).
  - `'omitido'`: no se intentó nada — ML no está configurado, el sync general (`syncWcToMl`)
    ya está corriendo y va a cubrir este SKU en la misma corrida, o ML devolvió 429
    (cooldown de cuota) en TODAS las publicaciones del SKU: no es un fallo de este SKU en
    particular, es la cuenta entera limitada, y el cron lo retoma solo.
- `detalle`: cadena descriptiva (cantidad de publicaciones actualizadas, motivo del skip,
  error específico). Solo aparece una entrada por SKU aunque el lote lo repita (deduplicado).

### Comportamiento de `syncSkuPuntual` (función interna, reusada por ambos endpoints)
- Busca **todas** las publicaciones/variaciones mapeadas a ese SKU con diff pendiente contra
  ML (un SKU puede tener más de una) y empuja cada una por separado.
- Si el sync general `syncWcToMl` está en curso (candado `_wcToMlEnCurso`), no hace nada:
  devuelve `'omitido'` porque esa corrida ya va a cubrir el mismo diff. Si el cron arranca
  DESPUÉS de que el push puntual ya empezó, se acepta la ventana de carrera (el PUT de stock
  a ML es idempotente).
- Por publicación: lee el status de `ml_publicaciones_cache` primero (mismo patrón que el
  cron `syncWcToMl`) y solo hace un GET a ML como fallback si no está cacheada — evita una
  llamada + 500ms de espera por publicación en el caso común. Si no está activa, o no se
  pudo confirmar el status, no se toca (no es error, se retoma en el próximo ciclo del
  cron). Si está activa, hace el PUT de stock.
- Ante un 429 (cooldown de cuota) en cualquiera de los dos pasos, **no reintenta** — corta
  de una con `estado: 'omitido'` (no `'error'`: el cooldown es de la cuenta entera, no de
  esta publicación), mismo criterio que el cron `syncWcToMl`. Otros errores HTTP sí
  reintentan, pero **un solo reintento** (backoff de 800ms, no el 500/1500/4000ms del resto
  del repo): esto corre síncrono dentro del request HTTP del operario, no en un cron de
  fondo, así que la latencia por SKU está acotada a propósito.
- Fail-open real: cualquier fallo termina en `estado: 'error'` para esa publicación sin tirar
  una excepción hacia el endpoint que la llama — el stock en WC ya quedó aplicado igual, y el
  cron `syncWcToMl` reintenta ese mismo diff en su próxima corrida. Los dos endpoints además
  envuelven la llamada en su propio try/catch por si `syncSkuPuntual` tirara algo inesperado.

### Fuera de este despacho
- Tabla `ciclos` (numeración de ciclos) — no se creó: nada en este despacho la necesita
  todavía, `plan-hoy` trabaja directo sobre `dias_sin_contar`.
- El "tablero" visual (% bajo régimen, deuda en días-SKU, proyección de recuperación,
  cobertura de ubicación/etiquetas) — sin pantalla propia en este despacho; los números que
  ya expone `plan-hoy` (`cobertura`, `ubicaciones`) son la base de datos que un tablero
  futuro consumiría.
- El tipo de sesión "conteo dirigido" (alcance = lista de SKUs sueltos) en `POST /sesiones`
  — `GET /dirigido` da la lista, pero abrir una sesión sobre esa lista puntual todavía se
  hace por categoría/marca/ubicación como cualquier otra.

## API Administrativa de Incidentes Operativos (Hito 5)

Sistema de detección y visualización de fallos de integración (ML/WooCommerce) sin depender
de que un administrador mire logs de PM2 en vivo. Los incidentes son creados por `routes/ml.js`
y `routes/woo.js` via `lib/incidentes.js` cuando una integración falla de forma clasificable.
Estos endpoints son **lectura exclusivamente** — solo para visualización por parte de admins.

### GET /api/incidentes
Lista incidentes operativos con filtros opcionales y paginación.

- Query parameters (todos opcionales):
  - `estado`: filtrar por `'activo'` o `'resuelto'`.
  - `integracion`: filtrar por nombre (ej. `'mercadolibre'`, `'woocommerce'`).
  - `severidad`: filtrar por `'info'`, `'advertencia'`, o `'critico'`.
  - `page`: número de página (1-based, default 1); valores ≤0 o no numéricos → default.
  - `pageSize`: elementos por página (1-100, default 20); valores ≤0 o no numéricos →
    default; >100 → clampea a 100.

- Response 200 (require admin):
  ```json
  {
    "ok": true,
    "data": [
      {
        "id": 1,
        "integracion": "mercadolibre",
        "proceso": "refrescar_publicaciones",
        "tipo_error": "rate_limit",
        "severidad": "advertencia",
        "estado": "activo",
        "mensaje_tecnico": "HTTP 429",
        "mensaje_humano": "Rate limit de ML alcanzado",
        "contexto_json": "{\"status\":429,...}",
        "contador_repeticiones": 3,
        "primera_deteccion_en": "2026-08-28T10:00:00.000Z",
        "ultima_deteccion_en": "2026-08-28T10:15:00.000Z",
        "ultima_recuperacion_en": null,
        "resuelto_en": null,
        "creado_en": "2026-08-28T10:00:00.000Z",
        "actualizado_en": "2026-08-28T10:15:00.000Z"
      }
    ],
    "page": 1,
    "pageSize": 20,
    "total": 42
  }
  ```

- Response 403: `{ "ok": false, "error": "Requiere administrador" }` — no autenticado o no admin.
- Response 500: `{ "ok": false, "error": "<mensaje>" }` — error interno.

Notas:
- `contexto_json` y `mensaje_tecnico` ya están sanitizados por `lib/incidentes.js` (secretos
  redactados, strings truncados).
- `clave_dedupe` es un detalle interno de dedupe y no se expone en la API.
- Ordenado por `ultima_deteccion_en DESC, id DESC` (incidentes más recientes primero).
- `pageSize` tiene un tope duro de 100 para evitar respuestas gigantes.
- Valores inválidos de `page`/`pageSize` (strings no numéricos, negativos, muy grandes) no
  rompen el endpoint — se comportan con gracefully (default/clamping).
- Query params repetidos (ej. `?estado=activo&estado=resuelto`) se normalizan tomando el
  último valor; no se devuelve error.

### GET /api/incidentes/:id
Detalle de un incidente específico, incluyendo su historial completo.

- Path parameter:
  - `id`: entero positivo, identificador del incidente.

- Response 200 (require admin):
  ```json
  {
    "ok": true,
    "data": {
      "id": 1,
      "integracion": "mercadolibre",
      "proceso": "refrescar_publicaciones",
      "tipo_error": "rate_limit",
      "severidad": "advertencia",
      "estado": "activo",
      "mensaje_tecnico": "HTTP 429",
      "mensaje_humano": "Rate limit de ML alcanzado",
      "contexto_json": "{\"status\":429,...}",
      "contador_repeticiones": 3,
      "primera_deteccion_en": "2026-08-28T10:00:00.000Z",
      "ultima_deteccion_en": "2026-08-28T10:15:00.000Z",
      "ultima_recuperacion_en": null,
      "resuelto_en": null,
      "creado_en": "2026-08-28T10:00:00.000Z",
      "actualizado_en": "2026-08-28T10:15:00.000Z",
      "historial": [
        {
          "id": 1,
          "incidente_id": 1,
          "evento": "abierto",
          "detalle_json": "{\"severidad\":\"advertencia\",...}",
          "creado_en": "2026-08-28T10:00:00.000Z"
        },
        {
          "id": 2,
          "incidente_id": 1,
          "evento": "repetido",
          "detalle_json": "{\"repeticiones\":2,...}",
          "creado_en": "2026-08-28T10:05:00.000Z"
        }
      ]
    }
  }
  ```

- Response 400: `{ "ok": false, "error": "ID inválido" }` — `id` no es un entero positivo.
- Response 403: `{ "ok": false, "error": "Requiere administrador" }` — no admin.
- Response 404: `{ "ok": false, "error": "no encontrado" }` — incidente con ese `id` no existe.
- Response 500: `{ "ok": false, "error": "<mensaje>" }` — error interno.

Notas:
- `historial` está ordenado cronológicamente (más antiguo primero).
- `evento` puede ser: `'abierto'` (creación), `'repetido'` (falló de nuevo sin cambio de
  severidad), `'escalado'` (severidad aumentó), `'resuelto'` (ciclo sano de la integración).
- `detalle_json` puede ser `null` (ej. en eventos de resolución).

### Diseño de paginación y validación
- `page` y `pageSize` llegan como **strings** desde `req.query` (Express siempre stringifica
  query params); se validan con `Number.isSafeInteger` (no `Number.isInteger`) antes de usarse
  como OFFSET/LIMIT en SQL, rechazando valores muy grandes (1e21) que causarían datatype
  mismatch en sqlite.
- Comportamiento fallido → graceful degradation (default/clamping), **no 400** — un cliente que
  mande `pageSize=abc` obtiene `pageSize=20`, no un error. La validación de segundo nivel en
  `lib/incidentes.js` garantiza cotas aún si alguien bypassea `routes/incidentes.js`.

### Decisión fail-open: el registro de incidentes nunca bloquea la integración
Si `abrirOActualizarIncidente` falla (disco lleno, DB bloqueada), devuelve `{ error: true }` sin
lanzar una excepción. La integración que disparó el incidente (ML/Woo) continúa: el incidente
no se registró, pero tampoco cortó la sincronización (comentario explícito en `lib/incidentes.js` línea 137-140: "FAIL-OPEN a propósito"). El admin verá un hueco en la línea de
tiempo (falta un evento), pero el sistema de integraciones no colapsa. Mismo criterio para
`confirmarCicloSano` — si el registro de la resolución falla, devuelve `{ error: true }` sin
interrumpir el ciclo exitoso que la llamó.

## Hito 7: Notificaciones Push (iOS, Android, Web)

Infraestructura backend para enviar notificaciones push a dispositivos móviles registrados.
Contrato con `openapi/mobile-v1.yaml` (contract-first, la app ya tiene el cliente TypeScript
generado). Los endpoints en esta sección son parte de la API móvil (rotas bajo `/api/`).

### POST /api/devices (web) / POST /api/v1/devices (móvil)
Registra un dispositivo para recibir notificaciones push.

- Request:
  ```json
  {
    "platform": "ios" | "android" | "web",
    "push_token": "string (token del proveedor APNs/FCM)",
    "device_name": "string (opcional, ej. 'iPhone de Juan' o 'Navegador')",
    "refresh_token": "string (obligatorio en /api/v1; refresh vigente de la sesión móvil)"
  }
  ```

- Response 200:
  ```json
  {
    "id": "1",
    "platform": "ios",
    "device_name": "iPhone de Juan",
    "creado_en": "2026-08-28T15:30:00Z"
  }
  ```

- Response 401: No autenticado (sin sesión válida).
- Response 422:
  - `{ "error": { "code": "platform_invalido", "message": "..." } }` — `platform` no es uno de: 'ios', 'android', 'web'.
  - `{ "error": { "code": "push_token_invalido", "message": "..." } }` — `push_token` vacío o no string.
  - `{ "error": { "code": "cursor_invalido", "message": "..." } }` — (en `GET /notifications`) cursor corrupto o mal formado.
- Response 500: Error interno.

Notas:
- Solo usuarios autenticados pueden registrar dispositivos (sesión HTTP válida).
- Cada usuario es dueño de sus propios dispositivos; no puede ver ni modificar los de otros.
- Si el mismo `push_token` se re-registra para el mismo usuario, se actualiza (limpia `revocado_en`).
- Un usuario puede tener múltiples dispositivos simultáneamente (ej. iPhone + iPad).
- **Reasignación de tokens (ALTO 1, 7ª pasada revisor):** a lo sumo puede haber una fila ACTIVA (`revocado_en IS NULL`) por token; registrar un `push_token` que otro usuario tiene activo lo REASIGNA: se revoca la fila del usuario anterior y se crea una fila NUEVA para el usuario actual. **Consecuencia para el usuario anterior:** deja de recibir notificaciones push en silencio (su dispositivo queda activo en la app, pero el token es inválido en el backend). Las filas revocadas persisten como historial puro — un token revocado que se re-registra crea una fila nueva, no reutiliza la vieja.

### DELETE /api/devices/{id}
Revoca/elimina un dispositivo, deteniendo futuras notificaciones hacia ese token.

- Path parameter: `id` (string, ID del dispositivo a revocar).
- Request: sin body.

- Response 200: `{ "ok": true }`

- Response 401: No autenticado.
- Response 403: `{ "error": { "code": "sin_permiso", "message": "..." } }` — el dispositivo no pertenece al usuario autenticado.
- Response 404: `{ "error": { "code": "no_encontrado", "message": "..." } }` — el dispositivo con ese ID no existe.
- Response 500: Error interno.

Notas:
- Revoca seteando la columna `revocado_en` (soft-delete, registro persiste para auditoría).
- El token queda inactivo y no recibe más notificaciones.
- En `/api/v1`, también revoca los refresh tokens asociados a ese dispositivo y su familia de rotación.

### GET /api/notifications
Lista notificaciones del usuario autenticado, paginadas por cursor.

- Query params:
  - `cursor` (opcional): cursor de paginación (opaco, devuelto en `next_cursor` de respuesta anterior).

- Response 200:
  ```json
  {
    "items": [
      {
        "id": "1",
        "tipo": "nuevo",
        "titulo": "⚠️ Incidente en ML",
        "cuerpo": "Un error fue detectado en la integración.",
        "deep_link": "incidentes",
        "leida": false,
        "creado_en": "2026-08-28T15:00:00Z"
      }
    ],
    "next_cursor": "base64-cursor-or-null"
  }
  ```

- Response 401: No autenticado.
- Response 500: Error interno.

Notas:
- Solo el usuario autenticado ve sus propias notificaciones.
- Paginación por cursor (no offset), más eficiente en bases de datos.
- Ordenadas por `creado_en DESC` (más recientes primero).
- Cada notificación tiene un `deep_link` opaco (ej. "incidentes") que la app usa para navegar al detalle.
- `leida` es un booleano (no entero).
- Si no hay más resultados, `next_cursor` es `null`.

### POST /api/notifications/{id}/read
Marca una notificación como leída.

- Path parameter: `id` (string, ID de la notificación).
- Request: sin body.

- Response 200: `{ "ok": true }`

- Response 401: No autenticado.
- Response 404: `{ "error": { "code": "no_encontrado", "message": "..." } }` — la notificación no existe o no pertenece al usuario.
- Response 500: Error interno.

Notas:
- Idempotente: marcar leída una notificación ya leída no es error, devuelve 200 igual.
- Solo el propietario de la notificación puede marcarla como leída.

### Arquitectura: Desacoplamiento entre envío y visualización

Las notificaciones son **dos tablas separadas**:

1. **`notificaciones_enviadas`** (log de intentos de delivery):
   - Registra cada intento de envío a cada dispositivo.
   - Estados: `'pendiente'`, `'enviado'`, `'fallido'`, `'agotado'` (supera reintentos).
   - Reintentos con backoff creciente (2 min, 10 min, 30 min; máx. 3 reintentos por dispositivo).
   - Si se agotan los reintentos, marcado como `'agotado'` para evitar re-procesamiento.
   - Contiene deduplicación: tipos 'nuevo' y 'resuelto' tienen constraint UNIQUE por incidente,
     pero 'reaviso' es repetible (intencional).

2. **`notificaciones_usuario`** (lo que ve el usuario en la app):
   - Registra notificaciones VISIBLES para el usuario.
   - Independiente del delivery: aunque un `notificaciones_enviadas` tenga estado='fallido',
     la notificación sigue en `notificaciones_usuario`.
   - Campo `leida` para tracking de lo que el usuario vio.

**Separación consciente:** un error de delivery a FCM (proveedor caído, token inválido) no borra
la notificación de la vista del usuario. El usuario sigue siendo consciente de que algo pasó,
aunque no le llegara el push en el dispositivo.

### Worker: `procesarNotificacionesPush`

Cron cada 2 minutos (configuración en `server.js` con `cron.schedule('*/2 * * * *')`).

**Lógica (dos pasos independientes):**

1. **Paso FEED** — por cada incidente:
   - Busca incidentes en estado 'activo' sin notificación 'nuevo' en el feed → envía 'nuevo'.
   - Busca incidentes en estado 'activo' con última notificación en el feed > intervalo de reaviso → envía 'reaviso'.
     - Intervalo de reaviso: configurable via `REAVISO_INCIDENTE_MIN` (default 30 min).
   - Busca incidentes en estado 'resuelto' sin notificación 'resuelto' en el feed → envía 'resuelto'.

2. **Paso REINTENTOS** — independiente del feed, busca filas de `notificaciones_enviadas` con:
   - `estado = 'fallido'` cuyo backoff ha vencido.
   - Reintentar el envío físico a cada dispositivo, sin importar si el feed ya tiene la notificación creada.

**Backoff creciente en reintentos de push:**
- Si intento 1 falla: reintentar después de 2 min.
- Si intento 2 falla: reintentar después de 10 min.
- Si intento 3 falla: reintentar después de 30 min.
- Si intento 4 falla: marcar dispositivo como 'agotado', no reintentar más.

**Estado terminal 'agotado':**
Cuando un dispositivo supera los 3 reintentos, se marca como `estado = 'agotado'` en `notificaciones_enviadas`. Una vez agotado, el dispositivo NO se reintenta más para ese incidente/tipo, incluso si el feed se actualiza con nuevos reavisos.

**Destinatarios:** usuarios con `preferencias_notificacion.incidentes_criticos = 1`
(default 1, opt-out, no opt-in).

**FAIL-OPEN:** cualquier error en el envío del worker (proveedor caído, DB busy) nunca lanza
una excepción. El worker continúa procesando otros incidentes. Errores se loguean en consola.

### Decisión de diseño: Opción (c) preferida

El worker es un **cron periódico que escanea** `incidentes_operativos` (no requiere tocar
`abrirOActualizarIncidente`/`confirmarCicloSano`). Esto permite:
- **Desacoplamiento total:** el ciclo de sync ML/Woo + incidentes nunca aguarda al worker de push.
- **Independencia de errores:** un fallo del proveedor push (FCM timeout) no bloquea nada.
- **Simplicidad:** sin callbacks, sin wiring, sin threads adicionales (el cron es async, mismo
  hilo que Express).
- **Compatibilidad:** cero cambios en `lib/incidentes.js`, la librería productiva.

Las otras opciones consideradas:
- (a) Wrapper en los callers (`routes/woo.js`, `routes/matcher.js`) → requería modificar rutas
  ya estables y rechazado en revisión por acoplamiento innecesario.
- (b) Callback opcional → parámetro nuevo en firmas de funciones, mayor complejidad, sin
  beneficio claro vs. (c).

## Compatibilidad del contrato móvil (Hito 7)

El contrato OpenAPI y el backend quedan alineados en los tres puntos que afectan a estos
endpoints:

### 1. Enum de tipos de notificación no coincide

**En el YAML:** `Notification.tipo` es un enum cerrado:
`['pregunta_nueva', 'mensaje_postventa', 'reclamo', 'pedido_nuevo', 'error_stock_ml']`

**En el código (workerNotificacionesPush.js):** Los tipos emitidos son:
`['nuevo', 'reaviso', 'resuelto']`

**Impacto:** Si la app generó un cliente desde el YAML y hace type-checking estricto sobre el
enum, el parseo se rompe cuando recibe un tipo no esperado.

**Resolución:** el enum OpenAPI refleja los tipos que emite el worker: `nuevo`, `reaviso` y
`resuelto`.

### 2. Rutas montadas sin prefijo `/v1`

**En el YAML:** `servers.url = ".../api/v1"` — rutas esperadas bajo ese prefijo.

**En el código (server.js):** Las rutas están montadas directamente:
- `POST /api/devices` (no `/api/v1/devices`)
- `GET /api/notifications` (no `/api/v1/notifications`)

**Impacto:** Clientes que respeten estrictamente el YAML fallarán al conectar.

**Resolución:** se agregaron aliases `/api/v1/devices` y `/api/v1/notifications`; las rutas
`/api/...` existentes se conservan por compatibilidad.

### 3. Autenticación: cookie vs. JWT, respuesta error no normalizada

**En el YAML:** Declara `bearerAuth` para la app móvil (`Authorization: Bearer <access_token>`).

**En el código:** las rutas móviles `/api/v1` usan JWT; el panel web y los aliases históricos
`/api` continúan usando sesión por cookie.

**Respuesta:** los 401 reflejan la respuesta real de `requireAuth` (`{ ok:false, error:string }`).

**Resolución:** Bloque 4 implementa access tokens JWT cortos y refresh tokens opacos rotativos,
revocables por familia y dispositivo. El panel web conserva `express-session`.

---

**Nota para el equipo de la app:** debe consumir estos endpoints bajo `/api/v1` enviando
`Authorization: Bearer <access_token>`; el refresh token se envía solo a `/api/v1/auth/refresh`.
