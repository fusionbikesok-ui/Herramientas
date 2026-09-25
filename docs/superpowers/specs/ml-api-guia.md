# Guía canónica de integración con Mercado Libre

**Fecha:** 2026-09-25

**Alcance:** cómo el código de FusionBikes (legado y plataforma) debe llamar a la API de Mercado Libre y qué hacer con cada webhook. Toda entrega, tramo o cambio que llame a ML o procese sus webhooks debe cumplir esta guía y citarla en su diseño (ver `plan-maestro.md`).

**Fuentes:** páginas oficiales de Mercado Libre (`developers.mercadolibre.com.ar`), convertidas a texto y guardadas en `/root/backups-worker/ml-investigacion-20260925/mldocs/` (fuera del repo; citadas por archivo:línea de esa carpeta). Complementado con un informe de Codex (`codex-ml-informe.md`, misma carpeta) y con el relevamiento de código propio (sección 6).

---

## 1. Reglas oficiales fechadas

| Regla | Detalle | Fuente |
|---|---|---|
| Webhook: responder rápido | HTTP 200 en **500 ms** tras recibir la notificación. Si no, ML reintenta durante **1 hora** con hasta **8 intentos**; pasado ese plazo la notificación se descarta y, si el tópico se desactiva por fallback, ese período no queda en `missed_feeds`. | `productos-recibe-notificaciones.txt:386-392,452` |
| Patrón recomendado por ML | Confirmar 200 **de inmediato** (encolar) y recién después hacer el GET al recurso — evita reintentos y "notificaciones duplicadas" percibidas. | `productos-recibe-notificaciones.txt:390` |
| `missed_feeds` | Sólo guarda hasta **2 días** atrás; después no está disponible. Para ítems, filtrar con `site_id=MLA` (u otro sitio); una llamada por sitio. | `productos-recibe-notificaciones.txt:448,624,630-631` |
| `/shipments` — header obligatorio | `x-format-new: true` en todo GET a `/shipments/{id}` y subrecursos. Ya es obligatorio (no sólo recomendado). | `envios.txt:9,13,18` |
| `/shipments` — campos descontinuados | Desde el **12/10/2025**, `order_id` y `external_reference` ya no se devuelven en `/shipments`; el parseo no debe depender de ellos (usar la relación orden↔envío que da el propio recurso `orders` o la notificación). | `envios.txt:13` |
| `/items?ids=` y `/users?ids=` — deprecación | En proceso de deprecación. Migrar a **`/items/bulk?ids=`** y **`/users/bulk?ids=`** antes del **25/10/2026**. Durante la convivencia ambos endpoints funcionan. Multiget sigue siendo **máx. 20 ids** por llamada; la respuesta es "verbose" (`{code, body}` por cada id) — no cambia de forma al migrar a `/bulk`. `attributes=` filtra campos del `body` de cada resultado (`attributes=body.x`). | `items-y-busquedas.txt:7,726-733` |
| Mensajería post-venta | GET y POST/PUT comparten cada uno un rate limit propio de **500 rpm** (uno para lectura, otro para escritura). GET a `/messages/packs/{pack}/sellers/{seller}` **marca como leído** salvo que se pase `mark_as_read=false`; el resto de los recursos de mensajería no marca como leído. Límite de **350 caracteres** por mensaje. | `mensajeria-post-venta.txt:33,66,327` |
| Stock `user-products` | Las escrituras usan `x-version`; un conflicto de versión responde **409** y exige releer el recurso antes de reintentar (no hay regla de reintento ciego). | relevamiento de código, sección 6; confirmar contra `user-products.txt` si se toca este endpoint |
| Reclamos (`claims`) | El resource vigente lleva el prefijo **`/post-purchase/v1/claims/{id}`** (y `/detail`). `POST /post-purchase/v1/claims/search` exige **al menos un filtro** de búsqueda (no se puede listar todo); acepta `offset`+`limit`, y la **suma de `offset+limit` debe ser menor a 10000** (ej. `offset=9950&limit=50` es inválido). | `que-es-un-reclamo.txt:20-22,177-179,200-201,307-308` |
| OAuth | El `refresh_token` es de **un solo uso**: cada refresh devuelve uno nuevo que hay que persistir. El `access_token` dura **6 horas**. | `autenticacion-y-autorizacion.txt:169,174,178` |
| Rate limit general | ML documenta un límite referencial de **1500 rpm por seller** (agregado de todos los recursos, no por endpoint). Ante 429, usar backoff exponencial con jitter y respetar el header `Retry-After` cuando esté presente. | relevamiento de código (`lib/mlLimites.js`, `lib/mlClient.js`); no se encontró una página oficial que fije el valor exacto de 1500 rpm en esta pasada — tratarlo como el valor ya usado en el código, no como cifra recién confirmada en la doc oficial. |

## 2. Cómo hacer cada llamada

| Recurso | Vía preferida | Frecuencia |
|---|---|---|
| `orders` | Por evento (webhook `orders_v2`) + reconciliación periódica como red de seguridad (ML puede perder notificaciones). | Evento; reconciliación cada tantos minutos según el diseño de la corriente. |
| `shipments` | Por evento (webhook `shipments`) con `x-format-new: true` siempre. Reconciliación periódica para envíos abiertos, ya que el volumen de GET individuales escala con la cantidad de envíos en curso (ver §5). | Evento; reconciliación de respaldo, no como camino principal. |
| `items` | Multiget (`/items/bulk?ids=`, máx. 20, `attributes=` acotado) para lecturas en lote; evento (`items`) para cambios puntuales. Evitar `/items?ids=` en código nuevo desde ya. | Evento + barrido de catálogo espaciado. |
| `questions` | Por evento (`questions`) para responder rápido; `/questions/search?status=UNANSWERED` como reconciliación de red de seguridad. | Evento; reconciliación periódica. |
| `messages` | Por evento (`messages`, acción `created`) + `/messages/packs/{pack}/sellers/{seller}` (cuidando `mark_as_read`). La reconciliación por `/messages/unread` es cara (1 + N packs) y debe ser de respaldo, no la vía principal. | Evento; reconciliación de respaldo espaciada. |
| `claims`/`post_purchase` | Por evento (`post_purchase`) + GET puntual a `/post-purchase/v1/claims/{id}`. `claims/search` sólo para reconciliación acotada (respeta el límite `offset+limit<10000` y requiere filtro). | Evento; reconciliación acotada. |
| Escritura de stock (`user-products`) | Escritura con `x-version` vigente; en 409, releer antes de reintentar — nunca reintentar ciego. | Por evento de negocio (venta, ajuste), no por barrido. |

## 3. Qué hacer con cada webhook (prioridad y trato)

| Tópico | Prioridad | Trato |
|---|---|---|
| `orders_v2` | **P0** | Responder 200 ya, encolar, releer `/orders/{id}` async. |
| `shipments` | **P0** | Responder 200 ya, encolar, releer con `x-format-new: true`. |
| `items`, `stock-locations`, `user_products` | **P0–P1** | Responder 200 ya; releer y aplicar contra el libro de stock con `x-version`. |
| `post_purchase` | **P1** | Responder 200 ya, releer `/post-purchase/v1/claims/{id}`, detectar reapertura (closed→opened). |
| `questions` | **P1** | Responder 200 ya, releer `/questions/{id}`. |
| `messages` (acción `created`) | **P1** | Responder 200 ya, procesar sólo `created`; **ignorar** `read`. |
| `payments` | **P2** | Responder 200 ya; procesar sin prioridad de latencia. |
| `items_prices`, `catalog*`, `vis_leads`, `invoices`, `public_*` | **fuera de alcance** | No suscribir estos tópicos. |

Reglas transversales:
- **Idempotencia por `topic+resource`**: dos notificaciones del mismo recurso no deben duplicar trabajo.
- **Agrupar ráfagas de 2–5 s** del mismo recurso antes de releer (varias notificaciones seguidas del mismo cambio son comunes).
- **Procesamiento monotónico**: no dejar que una relectura vieja pise el estado de una más nueva ya aplicada.

## 4. Diagnóstico 2026-09-25 (estado encontrado, no una regla de ML)

- El 429 que ven las corrientes de la plataforma (sombra) es **sintético**, no de ML: `crearPresupuestoShadow` en `lib/gatewayCanal.js` mantiene **un único bucket** de `GATEWAY_ML_SHADOW_RPM=30`/min **compartido por las 6 corrientes** (orders, shipments, items, questions, messages, claims). Antes de llamar a ML, si el bucket está agotado, el gateway devuelve `{status:429, headers:{'retry-after':'60'}}` sin salir a la red.
- Con ese cupo único, `ml.shipments` (≈1 GET por envío abierto) y `ml.messages` (1 + 1 por pack) lo agotan solos: 0 barridos OK en 24 h en producción, y 78–84 señales de `ml.items` terminaron en dead letter por `retryable: HTTP_429`.
- El sobre `{status, headers, body}` que recibe el código de la plataforma **no distingue** si el 429 vino del presupuesto sintético o de ML real: ambos se mapean igual a `ErrorBarridoReintentable`. Esto complica diagnosticar en logs cuál de los dos ocurrió.
- Hay **duplicación de lecturas** entre legado y plataforma: ambos consultan de forma independiente `/orders/search`, `/shipments/{id}`, `/questions/search`, `/questions/{id}`, `/messages/unread`, `/messages/packs/...` y `/post-purchase/v1/claims/{id}`, sin compartir cupo ni resultado.
- El legado no recibía 429 reales de ML ese día; tiene su propio presupuesto (`lib/mlRateLimiter.js`) independiente del gateway sombra.

## 5. Cuántas llamadas hace un barrido completo (estimación, no medición en producción)

- `ml.shipments`: aproximadamente 1 GET por envío abierto/reciente, en lotes de 20 (`Promise.all`). N envíos abiertos → N llamadas HTTP, repartidas en páginas de 20.
- `ml.messages`: 1 GET a `/messages/unread` + 1 GET por pack pendiente, en lotes de 10. M packs pendientes → 1+M llamadas HTTP.
- Ninguna de las dos usa multiget (no existe multiget de shipments ni de packs de mensajes en la API); `ml.items` sí usa `/items/bulk` en lotes de 20.

## 6. Estado actual del código (relevamiento propio, 2026-09-25)

Ver el detalle completo en la comunicación de esa fecha entre sesiones (no repetido acá para no duplicar mantenimiento); resumen:
- Legado: `lib/mlClient.js` (cliente con OAuth, cooldown/backoff propio ante 429 real), `lib/mlRateLimiter.js` (presupuesto propio), `routes/notificacionesMl.js` (webhooks: `ingerirPregunta`, `ingerirMensaje`, `ingerirReclamo`).
- Plataforma: `plataforma/src/reconciliacion/adaptadores/ml.ts` (adaptadores por corriente), `lib/gatewayCanal.js` (gateway sombra con `crearPresupuestoShadow`), `plataforma/src/worker/main.ts` (missed_feeds, `rondaMissedFeeds`).
- El legado hoy **no** usa `/items/bulk?ids=` (no tiene barrido de items) ni pasa `x-format-new: true` en su lectura de `/shipments/{id}` (`routes/sync.js:604`) — ver rama `fix/legado-ml-mitigacion-temporal` para la mitigación mínima de esto.

## 7. Backlog para el plan (corrección definitiva, no en esta guía)

Pendiente de convertir en entregas/tramos del plan maestro, con su propia decisión de José:
1. **Cupo por corriente**, no un bucket único: que `ml.shipments` y `ml.messages` no se puedan vaciar mutuamente el presupuesto de `ml.items` u otras.
2. **`shipments` y `messages` por evento como vía principal**, con reconciliación horaria (no continua) como respaldo — reduce drásticamente el volumen de GET individuales de las secciones 2 y 5.
3. **Etiqueta `CUPO_SOMBRA_AGOTADO`** distinta de un 429 real de ML, para que los logs y las alertas no confundan ambos casos (ver §4).
4. **Lectura única compartida** entre legado y plataforma para los recursos duplicados de §4, en vez de que cada sistema gaste su propio cupo — territorio natural de E9 (dominio de pedidos y efectos remotos) o de una entrega de infraestructura común, a decidir.
