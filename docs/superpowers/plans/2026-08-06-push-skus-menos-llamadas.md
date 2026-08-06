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

Tres derroches identificados originalmente:

1. **Escribe sin verificar.** El chequeo de idempotencia de `escribirSkuEnMl`
   (`lib/matcherPush.js:64-65`) compara contra `ml_publicaciones_cache.seller_sku`, columna que
   **solo se refresca a mano** (`prepararUpsertCache` en `routes/matcher.js`, disparado por
   `POST /api/matcher/refrescar-ml`).
2. **Un PUT por variación.** `escribirSkuEnMl` usa `/items/{id}/variations/{varId}`
   (`lib/matcherPush.js:67-69`), a propósito, para que ML no revalide la publicación entera. Con
   126 publicaciones y 561 variaciones, eso son 561 llamadas donde podrían ser 126.
3. **Sin cuota ni prioridad efectiva.** El cron corre cada 10 min
   (`server.js:262`) y cada corrida escribe hasta `TIEMPO_MAX_CORRIDA_MS` = 5 min seguidos con
   `CALL_DELAY_MS` = 350 ms → hasta ~850 PUT por corrida. El `ORDER BY` prioriza activas, pero
   nada limita cuánto presupuesto de ML se lleva el push frente al sync, que es lo que factura.

## Descartados (2026-08-06, tras revisión + verificación contra ML real)

El `revisor` devolvió NO APROBADO (2 bloqueantes) sobre la primera implementación de los 4 pasos.
Antes de corregirlos, se verificó el paso 1 contra la API real de ML y resultó inviable; el
usuario decidió no seguir con el paso 2. Se eliminan ambos del alcance:

### Paso 1 descartado — verificación previa por multiget (NO viable)

Evidencia contra ML real (`GET /items/{id}` e `/items/{id}/variations/{varId}` sobre
`MLA885463683|66762882764`, seller_sku `FB-25180` real):

- El multiget de un item (`variations` embebido) devuelve cada variación **sin ningún array
  `attributes`** — ni siquiera pidiendo `attributes=id,status,variations,attributes` explícito.
  Las claves reales de una variación ahí son `id, price, attribute_combinations,
  available_quantity, sold_quantity, sale_terms, picture_ids, seller_custom_field,
  catalog_product_id, inventory_id, item_relations, user_product_id` — el SELLER_SKU no está, y
  `seller_custom_field` viene `null` aunque el SKU exista.
- Solo el endpoint **puntual** `/items/{id}/variations/{varId}` devuelve `attributes` con el
  SELLER_SKU real.

Consecuencia: leer el SKU de una variación cuesta **1 llamada por variación**, exactamente las
mismas que el PUT que se quería evitar — no hay ahorro. Peor: tal como se había implementado,
`extraerSellerSkuDeAtributos` nunca encontraba el atributo (porque no está en la respuesta del
multiget), devolvía `''`, y `actualizarCacheDesdeItemMl` escribía ese `''` en
`ml_publicaciones_cache.seller_sku` de TODAS las variaciones del lote — blanquearía la caché
entera, inflaría la cola muy por encima de los 561 reales y dispararía reescrituras masivas de
SKUs que ML ya tenía. Confirma el hallazgo 5 del revisor.

### Paso 2 descartado — PUT agrupado por publicación (decisión del usuario)

El revisor advirtió (bloqueante 1) que `PUT /items/{id}` con un array `variations` **parcial**
puede borrar las variaciones de esa publicación que no vienen incluidas en el array — comprobarlo
exigía una escritura real sobre una publicación con variaciones (riesgo de perder talles, stock y
fotos de un producto publicado en serio, para verificar una optimización). El usuario eligió
explícitamente **no agrupar**: se mantiene 1 PUT por variación/publicación
(`/items/{id}/variations/{varId}` o `/items/{id}`), que es el camino ya probado en producción.

`lib/matcherPush.js` volvió a la versión de master en estos dos puntos: no existen
`verificarLoteEnMl`, `actualizarCacheDesdeItemMl`, `extraerSellerSkuDeAtributos`,
`escribirSkusAgrupadoEnMl`, `agruparPorItem`, `procesarGrupo`, `intentarConReintentos429` ni
`procesarEntradaIndividual`/`procesarEntradasIndividualmente`. `escribirSkuEnMl` es exactamente
la de master.

## Decisiones del usuario (2026-08-06, vigentes)

- **Pausadas:** cuota chica **por corrida completa** (no por tanda), 10 publicaciones distintas.
  Las activas se escriben siempre y primero, sin cuota; las pausadas avanzan de a poco, sin
  competir con el sync por el presupuesto de ML.
- **Agrupar:** descartado (ver arriba). Se mantiene 1 PUT por variación/publicación.

## Criterio de aceptación global (reescrito)

El objetivo ya **no** es reducir a "~133 llamadas": sin verificación previa ni agrupado, cada
publicación pendiente sigue costando 1 PUT. El objetivo es **drenar la cola de 561 sin chocar el
429 ni competirle presupuesto al sync**, dejando el costo en prácticamente 0 una vez vacía (el
filtro de `seleccionarPendientes`/`contarPendientes` ya excluye lo resuelto, así que una corrida
sobre una cola vacía no genera ninguna llamada a ML). La cuota de 10 pausadas por corrida
completa (no por tanda) logra esto: en ~13 corridas del cron (cada 10 min, ~2h15) se vacían las
556 pausadas sin que ninguna corrida individual dispare un lote de cientos de PUT seguidos.

---

## Paso 3 (conservado) — Cuota de pausadas por corrida COMPLETA

**Archivo:** `lib/matcherPush.js`

`seleccionarPendientes` ya soportaba `cuotaPausadas` (número de publicaciones distintas, no
variaciones) manteniendo:

- **Todas** las activas listas para intentar entran siempre, sin cuota.
- Las pausadas se toman después, hasta la cuota, con el orden actual (más recientes primero).

**Bloqueante 2 del revisor, corregido:** la cuota se aplicaba por TANDA (cada vuelta del `while`
volvía a llamar `seleccionarPendientes` con la misma cuota fija), no por CORRIDA — como las ya
procesadas salen del filtro (`COALESCE(p.seller_sku,'') <> d.sku`), la vuelta siguiente volvía a
traer otras `cuotaPausadas` publicaciones y así hasta agotar la cola entera o llegar a
`TIEMPO_MAX_CORRIDA_MS`. La cuota no acotaba nada real.

Corrección: `pushSkusPendientes` lleva un contador `cuotaRestante` (inicializado en
`cuotaPausadas`) que se descuenta, después de cada vuelta del `while`, por la cantidad de
publicaciones pausadas DISTINTAS (`item_id`) que trajo esa vuelta — no por cuántas se
escribieron con éxito, sino por cuántas se intentaron (ya consumieron su cupo de la corrida,
tengan éxito, error fail-closed con backoff, o error fail-open que corta la corrida entera). Al
llegar a 0, `seleccionarPendientes(..., cuotaPausadas: 0)` devuelve solo activas (código ya
existente: `if (cuotaPausadas <= 0) return activas;`), y el `while` corta en cuanto ese lote de
solo-activas viene vacío.

`CUOTA_PAUSADAS_DEFAULT = 10` (decisión del usuario, antes se había sugerido 20).

`TIEMPO_MAX_CORRIDA_MS` (5 min) queda como red de seguridad, sin cambios — con la cuota, una
corrida real termina mucho antes.

**Aceptación:** test de que con 5 activas y 100 pausadas pendientes, una corrida COMPLETA
(`pushSkusPendientes`, no `seleccionarPendientes` aislado) procesa exactamente las 5 activas y 10
pausadas — no más, aunque el `while` encadene varias tandas internas; test de que la cola igual
se vacía a lo largo de varias corridas (sin starvation de pausadas).

## Paso 4 (conservado) — Coherencia con el resto del sistema

**Archivos:** `lib/matcherPush.js`, `routes/matcher.js`

- El **botón manual** (`POST /api/matcher/push-skus-pendientes`, `routes/matcher.js`) comparte el
  mismo motor y pasa `cuotaPausadas: null` para ignorar la cuota — el usuario está esperando el
  resultado completo y ya disparó la acción a propósito. La respuesta lo informa
  (`cuota_pausadas_ignorada: true`).
- `contarPendientes` sigue reflejando la cola real (sin acotar por cuota): si no, el operador ve
  "0 pendientes" con 546 sin escribir.
- El log de la corrida sigue mostrando `restantes` real.

**Aceptación:** test del camino manual con la cuota ignorada; `GET /push-skus-pendientes/estado`
y `GET /push-skus-pendientes/count` siguen devolviendo el total real de pendientes.

## Hallazgos menores del revisor aplicados

- **MENOR 9:** `_estado.escritos++` contaba también las claves saltadas por idempotencia
  (`escribirSkuEnMl` devuelve `{ ok:true, status:200, saltado:true }` cuando ML ya tenía ese SKU).
  Se separó en `_estado.saltados`, expuesto también en `getEstadoPush()` y en el log de la
  corrida, para que `escritos=120` refleje solo llamadas PUT reales.
- **MENOR 11:** el plan original pedía tocar `server.js` en el paso 3. No hace falta: el default
  de la firma de `pushSkusPendientes` (`cuotaPausadas = CUOTA_PAUSADAS_DEFAULT`) ya cubre al cron,
  que llama `pushSkusPendientes(app._db, syncCfg)` sin ese argumento.

## Fuera de alcance

- No se toca el flujo del matcher en `public/` (sin cambios de UI).
- No se toca el sync ML↔Woo ni la regla de precio de contado.
- No se cambia el backoff exponencial por publicación de `registrarFallo`, que ya funciona.
- Verificación previa por multiget y PUT agrupado: descartados, ver sección arriba.

## Riesgos

- **Cuota que esconde trabajo:** con cuota, la cola tarda más en vaciarse y puede parecer trabada.
  Mitigación: el log de la corrida y `contarPendientes` siguen mostrando el total real, sin
  acotar por cuota.
- **Cuota mal descontada:** si el contador `cuotaRestante` no bajara correctamente entre vueltas
  del `while`, el bloqueante 2 reaparecería en otra forma. Mitigación: test de corrida completa
  (no solo de `seleccionarPendientes` aislado) que ejercita varias vueltas internas del `while`
  con un límite de tanda alto.
