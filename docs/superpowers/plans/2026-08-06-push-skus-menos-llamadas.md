# Push de SKUs al matcher: la menor cantidad de llamadas posible

Fecha: 2026-08-06
Rama: `worktree-push-skus-menos-llamadas`

## Problema

`pushSkusPendientes` (`lib/matcherPush.js`) es el mayor consumidor de la API de ML que queda tras
el ahorro del 2026-08-05. El log de pm2 lo muestra cortándose solo:
`push SKUs matcher: escritos=47 errores=0 restantes=600 (cortado por rate limit 429)`.

Medición real sobre la base de staging (2026-08-06):

- **561 decisiones pendientes** de escribir en ML.
- De esas, **5 son publicaciones activas** y **556 pausadas**.
- Corresponden a **126 publicaciones distintas** (~4,5 variaciones por publicación).
- `ml_publicaciones_cache.actualizado_en` es **`2026-07-30T21:57:20Z`** — 7 días de antigüedad.

Tres derroches:

1. **Escribe sin verificar.** El chequeo de idempotencia de `escribirSkuEnMl`
   (`lib/matcherPush.js:64-65`) compara contra `ml_publicaciones_cache.seller_sku`, columna que
   **solo se refresca a mano** (`prepararUpsertCache` en `routes/matcher.js`, disparado por
   `POST /api/matcher/refrescar-ml`). Con la caché de hace 7 días no sabemos cuáles de los 561
   le faltan realmente a ML: se pueden estar reescribiendo SKUs ya puestos, gastando un PUT por
   cada uno. Es el mismo acoplamiento implícito que ya mordió con
   `ml_publicaciones_cache.precio` (ver plan 2026-08-05, paso 4).
2. **Un PUT por variación.** `escribirSkuEnMl` usa `/items/{id}/variations/{varId}`
   (`lib/matcherPush.js:67-69`), a propósito, para que ML no revalide la publicación entera. Con
   126 publicaciones y 561 variaciones, eso son 561 llamadas donde podrían ser 126.
3. **Sin cuota ni prioridad efectiva.** El cron corre cada 10 min
   (`server.js:262`) y cada corrida escribe hasta `TIEMPO_MAX_CORRIDA_MS` = 5 min seguidos con
   `CALL_DELAY_MS` = 350 ms → hasta ~850 PUT por corrida. El `ORDER BY` prioriza activas, pero
   nada limita cuánto presupuesto de ML se lleva el push frente al sync, que es lo que factura.

## Decisiones del usuario (2026-08-06)

- **Pausadas:** cuota chica por corrida. Las activas se escriben siempre y primero; las pausadas
  avanzan de a poco, sin competir con el sync por el presupuesto de ML.
- **Agrupar:** sí, un PUT por publicación con todas sus variaciones, **con fallback por variación**
  cuando ML rechace el agrupado (típicamente porque revalida la publicación entera, ej. límite de
  fotos).

## Criterio de aceptación global

Vaciar la cola actual debe costar **~133 llamadas** (7 de verificación + ~126 de escritura
agrupada) en vez de 561 reintentadas indefinidamente. Ningún SKU que ML no tenga puede quedar sin
escribirse: el ahorro no puede convertirse en "escribir de menos".

---

## Paso 1 — Verificar contra ML antes de escribir

**Archivo:** `lib/matcherPush.js`

Antes de escribir un lote, traer el estado real de esas publicaciones con **multiget**
`/items?ids=...&attributes=id,status,variations,attributes` en chunks de 20 — el mismo patrón que
ya usan `evaluarPreciosReactivables` y `reactivarItems` en `routes/sync.js`.

Con esa respuesta:
- Refrescar `ml_publicaciones_cache.seller_sku` y `status` de las claves del lote.
- **Descartar del lote** las claves cuyo SELLER_SKU en ML ya coincide con el de la decisión: no
  gastan PUT. Cuentan como resueltas, no como error.
- Las que ML ya no tiene (item o variación inexistente) se tratan con el camino de fallo que ya
  existe, no se reintentan en loop.

Costo: 1 llamada cada 20 publicaciones, contra hasta 4,5 PUT por publicación que evita.

**Aceptación:** test de que una clave cuyo SKU ya está en ML no genera PUT y queda fuera de
pendientes; test de que la verificación se hace en chunks de 20; test de que un fallo del multiget
no aborta la corrida entera (mismo criterio que `routes/sync.js:1221-1237`).

## Paso 2 — Un PUT por publicación, con fallback por variación

**Archivo:** `lib/matcherPush.js`

Para una publicación con N variaciones pendientes, mandar **un** PUT a `/items/{itemId}` con el
array `variations` llevando el `SELLER_SKU` de cada una, en vez de N PUT a
`/items/{id}/variations/{varId}`.

**Fallback obligatorio:** si ese PUT no devuelve 200, reintentar esa publicación **por variación**
con el método actual, que es el camino ya probado. El motivo está documentado en
`lib/matcherPush.js:51-53`: a nivel item ML revalida la publicación completa y puede rechazarla
por algo ajeno al SKU (ej. límite de fotos). El fallback evita que una publicación quede sin
escribir por culpa de la optimización.

Un 429 en el PUT agrupado **no** debe disparar el fallback (sería martillar a ML): cae en el
camino de rate limit que ya existe, que corta la corrida sin marcar fallo.

Las publicaciones **sin** variaciones siguen con el PUT simple a `/items/{itemId}` de siempre.

**Aceptación:** test de que 1 publicación con 3 variaciones se resuelve con 1 PUT; test de que si
ese PUT falla con 400, se reintenta con 3 PUT por variación y el resultado final es correcto; test
de que un 429 en el agrupado corta la corrida sin fallback y sin registrar fallo.

## Paso 3 — Cuota de pausadas por corrida

**Archivos:** `lib/matcherPush.js`, `server.js`

`seleccionarPendientes` (`lib/matcherPush.js:98-106`) hoy ordena activas primero pero no acota
cuántas pausadas entran. Agregar una **cuota de pausadas por corrida** (sugerido: 20 publicaciones,
no variaciones) manteniendo:

- **Todas** las activas listas para intentar entran siempre, sin cuota.
- Las pausadas se toman después, hasta la cuota, con el orden actual (más recientes primero).

Revisar además `TIEMPO_MAX_CORRIDA_MS` (5 min): con el agrupado y la cuota, una corrida debería
terminar en mucho menos. El tope queda como red de seguridad, no como objetivo.

**Aceptación:** test de que con 5 activas y 100 pausadas pendientes, una corrida procesa las 5
activas y exactamente 20 pausadas; test de que la cola igual se vacía a lo largo de varias
corridas (sin starvation de pausadas).

## Paso 4 — Coherencia con el resto del sistema

**Archivos:** `lib/matcherPush.js`, `routes/matcher.js`

- El **botón manual** (`POST /api/matcher/push-skus-pendientes`, `routes/matcher.js:478`) comparte
  el mismo motor. Decidir explícitamente si el manual respeta la cuota de pausadas o la ignora
  (el usuario está esperando el resultado). Sugerido: el manual **ignora la cuota** pero mantiene
  la verificación previa y el agrupado, y lo documenta en la respuesta.
- El contador de `contarPendientes` debe seguir reflejando la cola real, no la cuota.
- Dejar en el comentario de cabecera que la verificación previa existe porque
  `ml_publicaciones_cache.seller_sku` no tiene refresco automático — mismo acoplamiento implícito
  que ya se documentó para `precio` en `necesitaRecheck` (`routes/sync.js`).

**Aceptación:** test del camino manual con la cuota ignorada; `GET /push-skus-pendientes/estado`
sigue devolviendo el total real de pendientes.

## Fuera de alcance

- No se toca el flujo del matcher en `public/` (sin cambios de UI).
- No se toca el sync ML↔Woo ni la regla de precio de contado.
- No se cambia el backoff exponencial por publicación de `registrarFallo`, que ya funciona.

## Riesgos

- **Escribir de menos:** si la verificación del paso 1 tiene un bug, un SKU que ML no tiene queda
  sin escribirse y el matcher lo da por resuelto. Mitigación: solo se descarta del lote cuando ML
  devuelve explícitamente un SELLER_SKU **igual** al de la decisión; cualquier otra cosa (atributo
  ausente, respuesta parcial, item no devuelto) mantiene la clave en la cola.
- **Fallback que no se dispara:** si el PUT agrupado falla de una forma que no se detecta como
  fallo, N variaciones quedan sin escribir en silencio. Mitigación: solo el status 200 cuenta como
  éxito (`mlFetch` usa `validateStatus: () => true` y nunca lanza por status HTTP).
- **Cuota que esconde trabajo:** con cuota, la cola tarda más en vaciarse y puede parecer trabada.
  Mitigación: el log de la corrida ya informa `restantes`, y debe seguir mostrando el total real.
