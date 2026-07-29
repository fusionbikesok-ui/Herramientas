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
              "fuera_de_alcance": false, "confirmado_por_omision": false }],
  "pendientes": [{ "sku":"FB-1", "nombre":"...", "bloque":"con_stock", "marca":"Bell",
                   "categoria_principal":"Cascos", "stock_inicial":5, "stock_woo":5 }],
  "resumen": { "pendientes_con_stock": 2, "pendientes_sin_stock": 1,
               "fuera_de_alcance": 0, "codigos_desconocidos": 0 } }
```
`pendientes` viene ordenado: con-stock primero, después categoría → marca → nombre.
`bloque` está **congelado** al abrir la sesión: si el stock cambia por otra vía durante el
conteo, el ítem no salta de bloque (`stock_woo` sí muestra el valor actual).

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
