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
Además de lo que ya devolvía, `pedidos` ahora incluye:

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

- Request: sin body.
- Response 200:
  - `{ "ok": true, "omitido": false }` — corrió la sincronización.
  - `{ "ok": true, "omitido": true }` — se salteó por candado activo o config de ML no
    lista; NO sincronizó.
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
  (ver `POST /vinculos/revisado`).
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
