# Ahorro de llamadas a ML: cancelaciones + reactivación automática

Fecha: 2026-08-05
Rama: `worktree-ahorro-llamadas-ml`

## Problema

Tras el incidente de 429 del 2026-08-04, el consumo de la API de ML sigue alto. Medición real
sobre la base de staging (2026-08-05):

- **24 publicaciones** y **30 variaciones** reactivables
  (`getReactivablesRows`: pausadas por `out_of_stock`, sin `paused_by_seller`, con stock web > 0).
- **9** ventas canceladas en la ventana de 30 días.

Costo por corrida hoy:

| Cron | Frecuencia | Llamadas por corrida | Por día |
|---|---|---|---|
| `procesarCancelacionesMl` | cada 15 min | 1 (9 canceladas, pagina de a 50) | ~96 |
| `reactivarAutomatico` | cada 15 min | 24 GET `/items/{id}` + ~30-60 de comisión/envío | ~5.000-8.000 |

`procesarCancelacionesMl` **no es el problema** — es solo el que *imprime* el 429
(`routes/sync.js:739-741` loguea cualquier status ≠ 200), mientras otros crons lo absorben en el
backoff de `lib/mlClient.js` sin dejar rastro visible. El límite de ML es global de la cuenta.

El consumo real es `reactivarAutomatico`, y tiene tres derroches independientes:

1. **Pide los items de a uno.** `chequearNetoReactivar` (`routes/sync.js:~1155`) hace un
   `GET /items/{itemId}` por publicación. El panel ya resuelve lo mismo con multiget
   `/items?ids=` en chunks de 20 (`evaluarPreciosReactivables`): 24 llamadas contra 2.
2. **La caché de comisión y envío muere con la corrida.** `netoMl` acepta
   `caches = { fee: Map, envio: Map }` (`lib/mlPrecios.js:54`), pero son Maps en memoria que se
   arman y se tiran en cada corrida. `listing_prices` es función pura de
   (precio, category_id, listing_type_id) y `shipping_options/free` de (item_id, precio):
   se re-consultan 96 veces por día para obtener siempre lo mismo.
3. **Re-evalúa contra ML publicaciones cuyo veredicto no puede haber cambiado.** Las 24 frenadas
   lo están *por precio*. Ese veredicto solo cambia si se mueve el precio web
   (`catalogo_cache.regular_price`) o el de ML (`ml_publicaciones_cache.precio`) — **ambos ya
   están en la base local**. Se puede decidir a quién consultar sin gastar una sola llamada.

   **CORRECCIÓN (revisor, 2026-08-06): la premisa "ambos refrescados por crons que corren
   igual" es FALSA para el precio de ML.** `ml_publicaciones_cache.precio` NO tiene ningún
   cron que la refresque — la única escritura es `prepararUpsertCache` en
   `routes/matcher.js`, disparada solo por el refresco MANUAL del matcher
   (`POST /api/matcher/refrescar-ml`). Consecuencia real: el operador corrige el precio en ML
   justo cuando la herramienta le avisa que está frenado (incluso desde el botón de la propia
   app, `POST /api/precios/actualizar-precio`), pero esa columna no cambiaba y la comparación
   del paso 4 leía "no cambió" — la reactivación quedaba sin efecto hasta la red de seguridad
   de 24h, sin error ni rastro. Corregido con dos mitigaciones (ver paso 4): (a) el propio
   `POST /actualizar-precio` ahora actualiza esa columna y borra la frenada en el momento en
   que el sistema sabe que el precio cambió; (b) la red de seguridad bajó de 24h a 2h.

## Decisiones del usuario (2026-08-05)

- **Latencia:** el cron sigue cada 15 min, pero solo consulta a ML las publicaciones cuyo precio
  local cambió desde la última evaluación. Reacción casi inmediata, casi sin llamadas.
- **Caché de comisión:** vence a los **7 días**.
- **Revalidación:** antes del PUT que activa la publicación se revalida **siempre en vivo**,
  aunque haya caché. **Fail-closed**: si ML no responde, no se reactiva.
- **Cancelaciones:** bajar el cron de 15 min a **cada 2 horas**.

## Criterio de aceptación global

Con la base actual (24 publicaciones frenadas por precio, sin cambios de precio):
una corrida de `reactivarAutomatico` en régimen debe hacer **0 llamadas a ML**, y una corrida con
1 publicación cuyo precio cambió debe hacer **a lo sumo 3** (1 multiget + comisión + envío, ya
cacheadas tras el primer ciclo). Ninguna publicación reactivable debe dejar de reactivarse por
estas optimizaciones.

---

## Paso 1 — Bajar el cron de cancelaciones a cada 2 horas

**Archivo:** `server.js:199-202`

Cambiar `cron.schedule('6-59/15 * * * *', ...)` por una expresión cada 2 horas, **manteniendo el
escalonado** por minuto que ya usan todos los crons de ML (comentario en `server.js:175-178`: no
realinear al mismo minuto). Sugerido: `'6 1-23/2 * * *'`.

**Aceptación:** un test que lea la expresión de cron (o la revisión del diff) confirma frecuencia
de 2 h y minuto distinto al del resto de los crons de ML. `npm test` verde.

## Paso 2 — Caché persistente de comisión y costo de envío

**Archivos:** `migrations/004_ml_precios_cache.sql` (nuevo), `lib/mlPrecios.js`, `db/index.js`

Tabla nueva (nombre sugerido `ml_precios_cache`), con:

- `clave` TEXT PRIMARY KEY — `fee:{price}:{category_id}:{listing_type_id}` o `envio:{item_id}:{price}`
- `valor` REAL — el `sale_fee_amount` o el costo de envío
- `actualizado_en` TEXT

`saleFeeMl` y `costoEnvioMl` (`lib/mlPrecios.js:17` y `:34`) consultan primero esta tabla; si la
fila existe y tiene menos de **7 días**, la devuelven sin pegarle a ML. Si no, consultan y
guardan. Los Maps en memoria que ya reciben (`caches.fee` / `caches.envio`) se mantienen como
primer nivel dentro de una corrida.

Importante — **el costo de envío depende del precio**: la clave debe incluir el precio, no solo
el `item_id`. Hoy el Map en memoria se indexa solo por `item_id` (`lib/mlPrecios.js:36`), lo cual
es correcto dentro de una corrida (el precio no cambia) pero sería un bug si se persiste así.

Debe existir una forma de **invalidar** la caché (borrar filas) para cuando ML cambie comisiones
antes del vencimiento.

**Aceptación:** tests que cubran hit de caché fresca (0 llamadas a ML), miss por vencimiento
(consulta y reescribe), clave de envío distinta ante precios distintos del mismo item, y que un
fallo de ML no escriba una fila envenenada.

## Paso 3 — Multiget de items en el camino del cron

**Archivos:** `routes/sync.js` (`chequearNetoReactivar`, `reactivarItems`)

Traer los datos de item (`id,status,sub_status,price,category_id,listing_type_id,shipping,variations`)
con **un multiget `/items?ids=` en chunks de 20**, como ya hace `evaluarPreciosReactivables`, en
vez de un GET por publicación. Reutilizar el patrón existente, no inventar uno nuevo.

**Cuidado con la semántica actual, que no se puede perder:**
- La revalidación en vivo de `status` / `sub_status` (omitir si ya no está pausada o si el
  vendedor la pausó a mano) sale del **mismo** GET, sin llamada extra.
- Si el multiget no devuelve un item (`e.code !== 200`), esa publicación debe tratarse como
  "no se pudo consultar" → **fail-closed**, no se reactiva.

**Aceptación:** test que verifica que N publicaciones se resuelven con `ceil(N/20)` llamadas de
items, y que un item ausente del multiget no se reactiva.

## Paso 4 — Evaluación local: consultar solo lo que cambió

**Archivos:** `migrations/005_reactivacion_frenada_insumos.sql` (nuevo), `routes/sync.js`

Agregar a `ml_reactivacion_frenada` los insumos con los que se tomó la decisión:
`precio_ml_evaluado` REAL y `precio_web_evaluado` REAL (además de `detectado_en`, que ya está).

En `reactivarAutomatico`, antes de llamar a ML: para cada fila reactivable, comparar el precio
web actual (`catalogo_cache.regular_price` vía `precioWebClave`) y el precio de ML conocido
(`ml_publicaciones_cache.precio`) contra los valores con los que se la frenó.

- **Sin cambios** → se saltea, sin ninguna llamada. La frenada sigue vigente.
- **Cambió alguno**, o **no hay frenada registrada** (candidata nueva) → entra al lote que va a ML.

**Red de seguridad (obligatoria):** aunque nada haya cambiado, una frenada debe re-evaluarse
igual si pasaron más de **2 h** desde `detectado_en` (bajado de 24h a 2h por el hallazgo de la
premisa falsa de arriba: mientras el precio de ML no tuviera ningún otro camino de
actualización, 24h de bloqueo silencioso era demasiado riesgo). Cubre el caso de que el
veredicto haya cambiado por algo que no está en nuestras dos columnas (comisión de ML, costo
de envío), y actúa como segunda red por si el fix de `POST /actualizar-precio` no cubre la vía
por la que cambió el precio (ej. lo cambiaron directo desde la app de ML, sin pasar por acá).

**Cierre del agujero en el origen:** además de la ventana de 2h, `POST /api/precios/actualizar-precio`
(`routes/precios.js`) actualiza `ml_publicaciones_cache.precio` y borra la fila de
`ml_reactivacion_frenada` de esa clave inmediatamente después de un PUT a ML exitoso — es el
punto exacto donde el sistema sabe que el precio cambió. Fail-open respecto del PUT (no debe
fallar la respuesta al usuario por esto), con log si falla.

**Comparación fail-closed simétrica:** un precio de ML NULL (columna nunca refrescada) debe
tratarse igual que un precio web NULL — "no sé" no es "no cambió". `null !== null` da `false`
en JS, así que la comparación necesita una guarda explícita (`precioMlActual == null ||
frenada.precio_ml_evaluado == null → reevaluar`), no una comparación directa.

**Ojo con el modo de falla mudo ya documentado** (`server.js:213-215`): si este cron corre antes
que el de catálogo tras un reinicio, `catalogo_cache.regular_price` puede estar vacío. Un precio
web nulo **no** debe interpretarse como "cambió" ni como "no cambió": esa fila cae en el camino
ya existente de `MOTIVO_SIN_PRECIO_WEB`, que no persiste frenada y se reintenta sola.

**Aceptación:** tests de los cuatro caminos — sin cambios (0 llamadas), cambió el precio web
(entra), cambió el precio ML (entra), frenada de más de 24 h (entra igual). Más el caso de
`regular_price` nulo, que no debe romper ni contaminar la comparación.

## Paso 5 — Revalidación en vivo antes de activar (separada del screening)

**Archivo:** `routes/sync.js` (`chequearNetoReactivar`, `evaluarNetoVariaciones`, `reactivarItems`)

El PUT que activa la publicación debe seguir precedido de una verificación de margen con datos
**frescos de ML**, no de caché — pero **solo para las publicaciones que de verdad se van a
reactivar**, no para todo el lote que se está cribando.

**CORRECCIÓN (revisor, 2026-08-06):** la primera implementación de este paso pasaba
`saltarCachePersistente: true` para TODAS las publicaciones del lote (el screening entero), no
solo las que se activan — la caché persistente del paso 2 solo se ESCRIBÍA y nunca se LEÍA en
este camino, desviación de lo que dice este mismo documento arriba. Corregido separando dos
funciones:

- `evaluarNetoVariaciones` (screening, se llama para TODO el lote vía `chequearNetoReactivar`):
  usa la caché persistente normalmente (sin forzar el salteo).
- `reactivarItems`: justo antes del PUT de activación de una publicación que pasó el screening,
  vuelve a llamar a `evaluarNetoVariaciones` con `saltarCachePersistente: true` — revalidación
  en vivo real, con el dato más nuevo posible.

Costo: +2 llamadas por publicación que de verdad se reactiva (poquísimas), y de yapa cierra una
ventana que no existía antes: sin este paso, no había ninguna verificación entre que se arma el
screening y el PUT — si el lote es grande pueden pasar segundos o minutos entre uno y otro.
**Fail-closed**: si la revalidación falla o el veredicto da 'bajo', no se activa.

**Aceptación:** test de que en el camino de reactivación real se consulta ML aunque la caché esté
fresca, y de que un fallo de esa consulta impide el PUT de activación.

## Fuera de alcance

- No se toca el panel `GET /reactivables` (ya usa multiget; solo se beneficia de la caché del
  paso 2).
- No se toca la regla de precio de contado de las ventas ML.
- No se toca `public/` — sin cambios de UI.

## Riesgos

- **Reactivar de menos:** si la comparación local del paso 4 tiene un bug, una publicación que ya
  podría venderse queda frenada en silencio. Mitigación: la red de seguridad de 24 h y los tests
  de los cuatro caminos.
- **Caché envenenada:** una respuesta de error de ML guardada como valor válido daría un margen
  falso. Mitigación: solo se escribe la fila ante status 200 con valor numérico.
- **Migraciones:** son dos nuevas (004 y 005) y hay una previa (`003_ml_sku_push_fallos.sql`)
  todavía sin aplicar en el entorno. Verificar el orden al desplegar.
