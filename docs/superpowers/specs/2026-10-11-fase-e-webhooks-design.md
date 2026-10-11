# Fase E — Webhooks primero, crons reducidos (diseño)

Fecha: 2026-10-11 · Rama `spec/fase-e-webhooks` · Prioridad acordada con José: **A (velocidad) + C (control)**,
y **B (carga/estabilidad) de forma progresiva**.

## Objetivo

Cada aviso de ML o Woo se interpreta y dispara la acción interna que corresponde, **para esa clave**. Los barridos
no desaparecen: pasan a **verificar y medir** ("diferencias que el webhook no cubrió"). Recién después de medir se
baja su frecuencia, de a una.

## Estado actual (verificado en código)

- ML `POST /api/ml/notificacion` (`server.js:559`) persiste en `integration_events`/`integration_jobs`
  (`lib/workerIntegrationJobs.js:58`, dedupe por `dedupe_key`); consume `procesarIntegrationJobs` cada minuto.
  - `orders_v2` → `syncOrdenMlPuntual` · `questions` → `question.project` · claims → `claim.project`.
  - `items` → `item.project` (L251-273): relee con `refrescarPublicacionesMlAcotado` y registra
    `ml_cambios_observados`, **pero no sincroniza stock ni corre el Vigía**. Coalescencia de 2 min que **descarta**.
  - `shipments`, `payments`, `invoices` y otros: solo auditoría o se descartan.
- Woo `/api/woo/webhook/order` (`server.js:318`) → `syncPedidoWebPuntual` + `syncWcToMl` **general** (30 llamadas).
  Woo `/api/woo/webhook/product` (L383) → `refrescarProductoPuntual`, **sin push a ML**.
  **Si `WOO_WEBHOOK_SECRET` está vacío no se valida la firma** (L323, L389).
- `/items?ids=` (muere 25/10/2026): **ya no se usa**; todo va por `/items/bulk`. Sin acción.
- 6 procesos tocan stock ML (`syncWcToMl`, `syncMlToWc`, `reconciliarStockMl`, `procesarReintentos`, Guardia,
  saga de Identidad); ~35 `cron.schedule` en `server.js` 833-1160.

## Matriz topic → acción (destino)

### MercadoLibre

| Topic | Acción interna | Notas |
|---|---|---|
| `orders_v2` | `syncOrdenMlPuntual(orderId)`; luego `syncSkuPuntual` por cada SKU vendido | P0. Reglas de precio y pedido inmutable intactas |
| `shipments` (con `x-format-new`) | releer el envío y actualizar su estado en Preparación | P0. Hoy solo se audita |
| `items` | releer item (`/items/bulk`, 1 id) → caché → **Vigía de esa publicación** → **`syncSkuPuntual` de sus SKUs** | P0. Ver coalescencia |
| `stock-locations` / `user-products` | releer el user_product y sus items → mismo camino que `items` | P1 |
| `questions` / `messages(created)` / `post_purchase` | proyecciones existentes, sin cambio | P1 |
| `payments` | solo auditoría (el pedido ya llega por `orders_v2`) | P2 |
| `items_prices`, `catalog`, `invoices`, `public` | no suscribir; descartar con métrica | fuera de alcance |

### WooCommerce

| Evento | Acción interna | Notas |
|---|---|---|
| `order.created/updated` | `syncPedidoWebPuntual` + **`syncSkuPuntual` por SKU de las líneas** (reemplaza `syncWcToMl` general) | El descuento de stock por venta **no** dispara `product.updated` (código fuente de WC): llega solo por `order.*` |
| `product.created/updated` | `refrescarProductoPuntual` + **`syncSkuPuntual(sku)`** (y de cada variación) | Cubre la edición manual de stock o precio |
| `product.deleted` | marcar en caché y abrir incidente si estaba vinculado | |

## Reglas transversales

1. **Firma Woo obligatoria (fail-closed):** sin `WOO_WEBHOOK_SECRET` el endpoint responde 503 y loguea; con firma
   inválida, 401. Comparación en tiempo constante sobre el body crudo.
2. **Responder rápido:** ML < 500 ms (solo persistir); Woo 200 inmediato. Todo el trabajo va al job.
3. **Idempotencia y monotonía:** dedupe `topic+resource(+sent)`; el job siempre **relee el estado actual** y nunca
   aplica el payload. Así el orden de llegada no importa.
4. **Coalescencia sin pérdida:** en vez de descartar si el caché se refrescó hace < 2 min, el job se **reprograma**
   para `ultimo_refresco + 2 min` (una sola fila pendiente por clave, `run_after`). Las ráfagas de 2-5 s se agrupan.
5. **Por clave, no general:** ningún webhook dispara un barrido completo. `syncSkuPuntual` hoy se omite si
   `_wcToMlEnCurso`: pasa a **reencolar** en vez de omitir.
6. **Recuperación:** un job horario consulta `missed_feeds` de ML (guarda 2 días) y reinyecta lo faltante. Un monitor
   diario de webhooks Woo (`GET /webhooks`) alerta si alguno quedó `disabled` (Woo los desactiva tras más de 5
   fallas consecutivas); la reactivación es manual.
7. **Respeta las protecciones vigentes:** Identidad (casos que bloquean), canario y modo sombra de las Fases C y D.

## Barridos de control

- Tabla nueva `barrido_corridas(id, proceso, inicio, fin, revisados, diferencias, diferencias_sin_evento, error)`.
  "Sin evento" es una diferencia en una clave que no tuvo webhook procesado en la ventana previa.
- Alerta si `diferencias_sin_evento` supera el umbral ("se perdieron N avisos de ML/Woo hoy"). Si se repite, el
  barrido vuelve solo a su frecuencia anterior.
- Unificación: Guardia, la auditoría de Identidad y `reconciliarStockMl` pasan a ser un solo barrido de stock. Los
  crons de cada minuto pasan a un único bucle de jobs.
- Bajada progresiva, de a una frecuencia: evento en paralelo → una semana midiendo → bajar (stock de 10 min a 1 h;
  refresco ML de 5-15 min a 2 h, más el nocturno completo). **Nunca se apaga un barrido.**

## Entregas (cortadas por valor)

1. **E-1 Stock al instante:** `items` y Woo `order`/`product` → `syncSkuPuntual` por clave; coalescencia que
   reprograma; firma Woo fail-closed. Valor: los cambios de stock llegan en segundos en vez de 10 minutos.
2. **E-2 Control medido:** `barrido_corridas`, contador sin evento, alerta, `missed_feeds` y monitor de webhooks Woo.
3. **E-3 Envíos:** `shipments` → Preparación.
4. **E-4..n Reducción:** unificación y bajada de frecuencias, una por semana, con su métrica en 0 o explicada.

## Errores y bordes

- ML 429 o 429 sombra sintético: el job reintenta con backoff y el barrido cubre.
- Item sin vínculo: solo caché y Vigía, sin push.
- SKU compartido por varias publicaciones: `syncSkuPuntual` empuja a todas las vinculadas.
- Webhook que es eco de nuestro propio push: la relectura da igual, así que es un no-op.

## Verificación

- Tests por topic (payload → job → acción).
- Tests de la coalescencia que reprograma, de la firma fail-closed, de la reinyección de `missed_feeds` y del
  contador sin evento.
- En producción: una semana con `diferencias_sin_evento` medida antes de bajar cada cron.

## Auditoría unida (Claude + Codex GPT-6-Sol Low, 2026-10-11) — corrige lo anterior

Donde esta sección contradice la matriz o las reglas de arriba, **manda esta sección**.

### ALTO

1. **Trabajo durable antes del ACK.** Hoy `orders_v2` de ML queda como `webhook.audit` y la sincronización corre
   fuera del job, después del 200 (`server.js:631`, `lib/workerIntegrationJobs.js:98`). Woo `order.*` hace lo mismo
   (`server.js:337`). Un reinicio pierde la venta hasta el barrido. → Todo aviso crea un **job durable** por
   recurso (orden, item o producto). El worker relee el recurso y el job se cierra solo después de verificar el
   pedido, el stock y la preparación.
2. **Sobreventa por orden de llegada (hallazgo de los dos).** Si el aviso `items` o `orders_v2` dispara un push
   antes de que Woo refleje la venta, ML recibe un stock que ya no existe. El CTE de stock no descuenta las ventas
   de ML todavía no impactadas en Woo, y `sync.js:1005/1032` ya dispara `syncSkuPuntual` tras crear la orden Woo.
   → Habrá **un único disparador de push**, que corre después de confirmar el pedido Woo y refrescar su stock.
   Mientras una orden ML de esa publicación siga pendiente, no se empuja stock de esa clave.
3. **Unidad de escritura = bolsa de stock, no SKU.** Varias publicaciones hermanas comparten `user_product_id` y una
   sola cantidad. → Las escrituras se serializan por `user_product_id` (o por clave si no tiene): una sola operación
   por bolsa, con la protección más restrictiva de las hermanas y relectura si hay conflicto. Los topics oficiales
   son `user_products` y `stock-location` (singular), con el recurso `/user-products/{id}/stock`.
4. **`missed_feeds` solo recupera entregas fallidas**, no el trabajo perdido después de un 200. Para `items` exige
   `site_id`, que el enumerador actual omite (`plataforma/src/reconciliacion/missed-feeds.ts:65`). → Corregir
   `site_id`, paginar y guardar un cursor dentro de la ventana de 2 días. Se miden **tres cosas por separado**:
   entregas fallidas, recibos sin job completado y diferencias del barrido. No se llama "aviso perdido" a toda
   diferencia.
5. **Coalescencia y concurrencia.** → Cada recurso tiene una generación durable con lease y una marca `dirty`: si
   llega un aviso mientras el job está tomado, se repite al terminar. Se revalida el estado antes del PUT, y todo
   resultado `omitido`, 429 o incierto se reencola (incluido `_wcToMlEnCurso`).

### MEDIO

6. **Correcciones a la matriz.** `refrescarPublicacionesMlAcotado` **ya corre el Vigía**, el autovínculo y la
   auditoría de precios (`routes/matcher.js:581`): no se agrega un segundo Vigía. `messages` hoy va a auditoría y no
   a una proyección: queda fuera de E-1 hasta definir la relectura por pack. `product.deleted` ya llama
   `protegerPorBajaWoo` (`routes/woo.js:532`), y se conserva así.
7. **Órdenes Woo completas.** Hay que cubrir también cancelación, reembolso, papelera y cambio de líneas. Se compara
   el conjunto de SKUs anterior con el actual y se sincroniza la unión de los afectados.
8. **Ecos ML↔Woo.** Cada push guarda su intención y su versión. Antes de escribir se compara la disponibilidad
   deseada con la remota, y un eco nunca vuelve a disparar un camino con efectos.

### BAJO

9. **Woo.** Además de la firma fail-closed, se valida que el topic y el webhook ID sean los esperados. El monitor
   alerta por `paused`, `disabled`, ausencia y entregas fallidas. El umbral de desactivación es configurable (por
   defecto, más de 5 fallas). El comentario "WC reintenta si no recibe 200 en < 5s" (`server.js:316`) está mal: el
   timeout es de 60 s.
10. **Lecturas.** `/items/bulk` en lotes de hasta 20 IDs, con chequeo de `status_code` por elemento. Ya está
    migrado: el 25/10 no tiene impacto.

### Secuencia acordada

webhook → recibo y job durables → GET puntual del recurso vigente → proyección → efectos por bolsa
(`user_product_id`) o SKU → escritura verificada. **No se baja ninguna frecuencia de barrido** hasta que E-1 y E-2
estén en producción y medidos.

### Entregas, reordenadas

- **E-1:** jobs durables para órdenes (ML y Woo), un único disparador de push serializado por bolsa y firma Woo
  fail-closed.
- **E-2:** `items` y `user_products` → push por bolsa, con generación/dirty.
- **E-3:** medición triple, `missed_feeds` con `site_id` y monitor Woo.
- **E-4:** envíos.
- **E-5 en adelante:** reducción de crons.
