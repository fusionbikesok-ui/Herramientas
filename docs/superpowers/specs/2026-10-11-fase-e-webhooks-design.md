# Fase E — Webhooks primero, crons reducidos (diseño, v2)

Fecha: 2026-10-11 · Rama `spec/fase-e-webhooks` · Prioridad acordada con José: **A (velocidad) + C (control)**,
y **B (carga/estabilidad) de forma progresiva**. v2 integra la auditoría cruzada (Claude + Codex GPT-6-Sol Low).

## Objetivo

Cada aviso de ML o Woo se convierte en un **trabajo durable** que relee el recurso vigente y dispara la acción
interna que corresponde **para ese recurso**. Los barridos no desaparecen: verifican y miden. Ninguna frecuencia se
baja hasta que lo que la reemplaza esté en producción y medido.

## Estado actual (verificado en código)

| Entrada | Hoy | Problema |
|---|---|---|
| ML `orders`/`orders_v2` (`server.js:559-640`) | recibo durable (`registrarWebhookMl`) y job `webhook.audit`; **la sync corre después del 200, fuera del job** (`syncOrdenMlPuntual` / `syncPedidoMlPuntual`) | un reinicio pierde la venta hasta el barrido |
| ML `items` | job `item.project` → `refrescarPublicacionesMlAcotado` (ya corre el Vigía, el autovínculo y la auditoría de precios, `routes/matcher.js:589`) | coalescencia de 2 min que **descarta** (`lib/workerIntegrationJobs.js:259`); no empuja stock |
| ML `questions` / claims | `question.project` / `claim.project` | OK |
| ML `messages` | `webhook.audit` a propósito: el id no se resuelve con credenciales de vendedor (`workerIntegrationJobs.js:85`) | fuera de alcance |
| ML `shipments`, `payments`, `invoices`, otros | `webhook.audit` | shipments sin uso |
| Woo `order.*` (`server.js:318`) | recibo durable (E1 T3); después, **fuera de cola**, `syncPedidoWebPuntual` + `syncWcToMl` general | trabajo no durable; barrido general por un pedido |
| Woo `product.*` (`server.js:383`) | job `catalog.woo_product_sync` → `refrescarProductoPuntual`; la baja llama `protegerPorBajaWoo` (`routes/woo.js:532`) | no empuja stock a ML |
| Firma Woo | si `WOO_WEBHOOK_SECRET` está vacío **no valida** (`server.js:323`, `:389`) | fail-open |
| Venta ML → pedido Woo (`routes/sync.js:1035-1049`) | `syncSkuPuntual` fire-and-forget con `catalogo_cache.stock` **anterior** al descuento de Woo | **bug vigente: devuelve a ML la unidad vendida** |
| `missed_feeds` (`plataforma/src/reconciliacion/missed-feeds.ts:65`) | consulta sin `site_id` | para `items` ML lo exige |
| `/items?ids=` (muere 25/10/2026) | ya no se usa; todo es `/items/bulk` | sin acción |

## Modelo: recibo → trabajo → relectura → efecto verificado

1. **Recibo** (ya existe): se persiste antes del 200; si SQLite falla, 503 y el emisor reintenta. ML siempre recibe
   200 (`server.js:627`).
2. **Trabajo durable por recurso.** `integration_jobs` con clave `(tipo, recurso)` única entre pendientes, más:
   - `generacion` (se incrementa con cada aviso nuevo del recurso);
   - `lease_hasta` (quién lo tiene tomado y hasta cuándo);
   - `dirty` = 1 si llegó un aviso mientras estaba tomado → al terminar, se repite en vez de cerrarse;
   - `run_after` para la coalescencia: un aviso del mismo recurso dentro de 2 min **reprograma** el pendiente,
     nunca descarta.
3. **Relectura**: el worker hace GET del recurso vigente (`/orders/{id}`, `/items/bulk` de hasta 20 ids con
   `status_code` por elemento, `/user-products/{id}/stock`, `GET /orders/{id}` y `/products/{id}` de Woo). Nunca
   aplica el payload del aviso: así el orden de llegada no importa.
   En `/items/bulk`, cada elemento se trata por su `status_code`: 200 → se proyecta; 404 → baja confirmada solo si
   una relectura individual `GET /items/{id}` también da 404, y entonces se retira del caché y se encolan los
   `stock.bolsa` de sus SKUs; 403 → incidente (ítem ajeno o token) sin tocar el caché; 429, 5xx u otro → se reencola
   ese id con backoff. Un elemento no-200 nunca deja el job cerrado como hecho.
4. **Efecto** y **verificación**: el job se cierra solo cuando el efecto quedó verificado (el pedido existe, el stock
   remoto coincide con el deseado). `omitido`, 429, cooldown o un resultado incierto → se reencola con backoff;
   jamás se cierra como hecho. Un reintento de `order.ml` **nunca** repite el POST a Woo mientras la reserva de esa
   orden siga incierta (`wc_order_id=0`): espera a que la resuelva el chequeo periódico de E-0.

## Matriz topic → acción

### MercadoLibre

| Topic | Job | Acción |
|---|---|---|
| `orders` y `orders_v2` (hoy `orders` → `syncOrdenMlPuntual`, pedido Woo; `orders_v2` → `syncPedidoMlPuntual`, Preparación; `server.js:633-648`) | `order.ml` (un job por orden, sin importar cuál de los dos topics llegó) | relee la orden → si está `cancelled`: **cancelación puntual e idempotente** del pedido Woo, con la misma lógica de `procesarCancelacionesMl` extraída a una función por orden; si `wc_order_id=0` (reserva en curso), reencola sin tocar nada; si ya estaba cancelado, no se toca el pedido. En los dos casos, después **refresca los SKUs de la orden y encola sus `stock.bolsa`** (Woo devuelve el stock al cancelar). Si no → **los dos efectos**: Preparación, y crear o cancelar el pedido Woo (reglas intactas: `precioContado()` sobre `regular_price`, todo en el POST, sin modificar después salvo cancelación y nota privada) → **encola `stock.bolsa`** para cada bolsa afectada. No empuja stock directo |
| `items` | `item.project` | relee el ítem → caché + Vigía (ya incluidos) → encola `stock.bolsa` de sus claves **solo si cambió `available_quantity`, `status` o el vínculo** |
| `user_products`, `stock-location` | `item.project` por cada item del user_product | igual que `items` |
| `shipments` (`x-format-new: true`) | `shipment.project` | relee el envío → estado en Preparación (entrega E-4) |
| `questions`, claims | existentes | sin cambio |
| `messages`, `payments`, `invoices` y otros | `webhook.audit` | auditoría; `messages` no es resoluble con credenciales de vendedor |
| `items_prices`, `catalog`, `public` | — | no suscribir |

### WooCommerce

| Evento | Job | Acción |
|---|---|---|
| `order.created/updated/deleted/restored` (cubre cancelación, reembolso y papelera) | `order.woo` | relee la orden. **Decide siempre la relectura vigente; el topic solo dispara** (un `deleted` atrasado sobre una orden ya restaurada no anula nada). Si la relectura da 404 o la orden está en la papelera (`status=trash`): el conjunto actual es vacío (se refrescan los SKUs del conjunto persistido y se encolan sus bolsas, igual que en la otra rama; el cierre del job y la actualización de `woo_orden_skus` son atómicos), y se retira la orden de `pedidos_cache` y de la cola de Preparación; si ya tenía una fila en `preparaciones`, esta **no se borra**: pasa al estado `anulado_en_woo` (con un evento en su historial), que se agrega a `ESTADOS_BLOQUEADOS_PARA_TRABAJAR` (`routes/preparacion.js:87`), y además se revisa **cada mutación y transición automática** de `routes/preparacion.js` que filtra por estado con condiciones propias (por ejemplo `:1634` y `:1663`) para que excluya `anulado_en_woo`; un test intenta cada acción sobre una preparación anulada y espera 409 o no-op; se muestra con aviso a quien la estaba preparando. Si la relectura posterior encuentra la orden vigente (restaurada), vuelve al estado que tenía antes de anularse, registrado en el evento (hoy `syncPedidoWebPuntual` no maneja el 404, `routes/preparacion.js:3865`: se agrega). Si no, `syncPedidoWebPuntual` → calcula la **unión** entre el conjunto de SKUs persistido de esa orden (tabla `woo_orden_skus(order_id, skus_json, actualizado_en)`, que se escribe para **toda** orden y no solo para las elegibles de Preparación, y se reemplaza recién cuando el job se cierra verificado, en la **misma transacción** que el cierre y condicionado a que la `generacion` tomada siga siendo la vigente; si el job quedó `dirty`, se conserva el conjunto anterior hasta procesar la lectura nueva) y el actual → refresca esos SKUs de Woo → encola `stock.bolsa`. Reemplaza el `syncWcToMl` general |
| `product.created/updated` | `catalog.woo_product_sync` | `refrescarProductoPuntual` (y variaciones) → encola `stock.bolsa` de sus claves vinculadas |
| `product.deleted` | `catalog.woo_product_sync` | **relee el producto (o su padre)**: si sigue vigente, el aviso atrasado no borra nada y se trata como `updated`, **pero** y lo mismo en **todo** refresco de un padre, cualquiera sea el topic (`product.updated` incluido, porque `routes/woo.js:588-592` borra las hijas del caché antes de reinsertarlas): se comparan las variaciones del padre en caché antes de releer con las de después: cada variación que desapareció (también por el refresco de `routes/woo.js:585`) recibe `protegerPorBajaWoo` y se encolan sus bolsas usando el SKU anterior, para llevar ML a 0; solo con 404 o `status=trash` se aplica `protegerPorBajaWoo` (conservando el SKU antes de borrar) → encola `stock.bolsa` para llevar a 0 y verificarlo |

`order.restored` existe en el núcleo de Woo (`class-wc-webhook.php:1031`, sale de la papelera); la referencia REST v3
publicada no lo lista porque está desactualizada. Si el webhook no estuviera dado de alta en la tienda, el barrido de
stock cubre la restauración.

Nota de WooCommerce (código fuente de `class-wc-webhook.php`): el descuento de stock por una venta **no** dispara
`product.updated`. Llega solo por `order.*`.

## Escritura de stock: un solo camino, por bolsa

- **Bolsa** = `user_product_id` (la cantidad que comparten las publicaciones hermanas); si no tiene, la clave.
- Un único job `stock.bolsa` por bolsa, serializado por el lease. Es **el único disparador de push a ML** desde
  eventos; reemplaza el fire-and-forget de `routes/sync.js:1035`.
- Pasos:
  1. relee de Woo el stock de los SKUs de la bolsa (**nunca** usa `catalogo_cache` sin refrescar). Si la relectura falla, no empuja y reencola;
  2. calcula la disponibilidad deseada con el mismo CTE del sync (reservas, `solo_local`, protecciones de Identidad
     y canario);
  3. **si hay una orden ML de la bolsa con `order.ml` pendiente, se reprograma**: no se empuja hasta que la venta
     impacte en Woo;
  4. compara contra el remoto releído; si son iguales, no escribe (esto corta los ecos ML↔Woo);
  5. una sola escritura por bolsa. El valor agregado se calcula así:
     - todas las hermanas apuntan al **mismo SKU Woo** → se usa el `stock_disponible_ml` del CTE con la reserva
       **mayor** y el modo más restrictivo (`solo_local` en cualquiera → 0);
     - hermanas con **SKUs Woo distintos** en la misma bolsa → contradicción: **no escribe**, abre o actualiza el caso
       de Identidad que bloquea (como hoy hace el bloqueo por contradicción de `_empujarClaveMl`) y queda en la lista
       de incidentes;
     - cualquier hermana con un caso de Identidad que bloquea o fuera del canario → no escribe, **con una sola
       excepción: el push protector a 0**. Una baja Woo confirmada (relectura con 404 o `status=trash` del producto o la
       variación) se trata como stock 0, y ese push a 0 se permite aunque el caso de `protegerPorBajaWoo` esté abierto,
       porque solo puede bajar disponibilidad. Como borrar de `catalogo_cache` (`routes/woo.js:539`) saca la clave del
       CTE (por su `JOIN` con el catálogo, `routes/sync.js:273`), **antes** de borrar se registra la baja en
       `woo_bajas_confirmadas(sku, claves_json, confirmada_en)`. Esa tabla es una entrada explícita del cálculo de la
       bolsa: esas claves tienen deseado = 0. El 0 se verifica releyendo ML, y la fila se cierra solo cuando todas sus
       claves dan 0 en ML. Una lectura que falla por otra causa (timeout, 5xx, 429) no confirma
       nada y sigue bloqueando;
  6. relee y verifica. Si no coincide, reencola.
- **Endpoint de escritura:** el mismo que hoy funciona en producción, `available_quantity` del ítem o de su variación
  (`routes/sync.js:216`). Verificado: la cuenta **no** tiene stock multiorigen. **Guarda en una puerta nueva:** hoy no hay un punto único
  (`buildMlStockUpdate` solo arma el pedido y hay PUT directos en `routes/sync.js:1516`, `:2490` y `:3746`, más
  `_empujarClaveMl`). Se crea `escribirStockMl(db, mlCfg, itemId, variationId, cantidad, opts)` (async), que hace la
  comprobación y el PUT, y **todos** esos llamadores migran a ella. Un test recorre `routes/` y `lib/` y falla ante
  **cualquier** PUT a ML cuyo path sea `/items/...` con `available_quantity` en el body (armado con
  `buildMlStockUpdate` o a mano) fuera de `escribirStockMl`; además hay tests de comportamiento de cron, puntual,
  reactivador y bolsa con la guarda en rojo. Antes de cada push exige una comprobación vigente (de menos de 1 h)
  del tag `warehouse_management` de `/users/{id}`; ML lo marca aun con un solo depósito. Si la comprobación está
  vencida y no se puede renovar, **no escribe** (fail-closed) y reintenta. Si aparece multiorigen, ninguna escritura
  de stock procede, abre un
  incidente y avisa a José: soportar multiorigen (escritura por ubicación en `/user-products/{id}/stock/type/...`)
  queda fuera de esta fase y requiere su propio diseño.
- Bajo el mismo candado, `stock.bolsa` toma los `stock_lock` de **todos** los SKUs de la bolsa en orden alfabético
  (así se evitan deadlocks) y no escribe si **cualquiera** de ellos tiene una fila de `stock_refresco_pendiente` que no
  sea la suya.
- `syncSkuPuntual` sigue para los usos manuales, pero si `_wcToMlEnCurso` **reencola** en vez de devolver `omitido`.
- Cada push guarda intención (`deseado`, `remoto_previo`, `origen_job`) en `sync_log`, para auditar y detectar ecos.

## Seguridad de los webhooks Woo

- Firma obligatoria: sin `WOO_WEBHOOK_SECRET` → 503 y alerta; firma ausente o inválida → 401. **Única excepción, el
  ping de alta**: Woo lo manda sin firma al activar el webhook, con el body `webhook_id=<n>` en form-urlencoded. Ambos
  endpoints agregan un parser crudo para `application/x-www-form-urlencoded`. Esa comprobación va **primero**,
  antes de validar los encabezados de entrega (el ping no trae topic ni delivery id): un body con **exactamente** esa
  forma **y** un `<n>` que figure entre los webhooks registrados para ese endpoint (lista `WOO_WEBHOOK_IDS` o lectura
  de `GET /webhooks`) recibe 200, se registra y no dispara nada; con un id desconocido, 401. Cualquier otro body sin firma es 401. HMAC-SHA256 en
  base64 sobre el body crudo, comparada en tiempo constante (ya implementado salvo el fail-open).
- Se valida que `X-WC-Webhook-Topic` sea el esperado por endpoint y que `X-WC-Webhook-ID` esté en la lista de
  webhooks registrados.
- El comentario de `server.js:316` ("WC reintenta si no recibe 200 en < 5s") se corrige: el timeout de entrega es
  de 60 s.

## Recuperación y medición

Se miden **tres cosas por separado**. "Aviso perdido" se reserva para la primera.

| Métrica | Fuente | Alerta |
|---|---|---|
| Entregas fallidas | ML `missed_feeds` (con `app_id` = el client id de la app ML ya configurado (`ML_CLIENT_ID`) en cada consulta y `site_id=MLA` para `items`, paginado **siempre desde offset 0** con deduplicación por `_id` (ML no ofrece un cursor estable), cada hora dentro de la ventana de 2 días) → reinyecta como recibo; Woo: monitor `GET /webhooks` cada hora (`paused`, `disabled`, ausente) | inmediata si hay webhooks Woo no activos; diaria con el conteo ML |
| Trabajos no terminados | jobs con `generacion` sin cerrar más de 15 min, o en dead-letter | inmediata |
| Diferencias del barrido | `barrido_corridas(proceso, inicio, fin, revisados, diferencias, diferencias_sin_evento, error)`; "sin evento" = la clave no tuvo job cerrado en la ventana previa | diaria; si supera el umbral 2 días seguidos, el barrido vuelve solo a su frecuencia anterior |

Woo desactiva un webhook tras fallos consecutivos por encima de `woocommerce_max_webhook_delivery_failures`
(5 por defecto). La reactivación es manual y la hace José desde el panel.

## Barridos y crons

- Durante E-1 a E-3 **no se baja ninguna frecuencia**; los barridos corren igual y alimentan `barrido_corridas`.
- E-5 y siguientes:
  - se unifican en un único barrido de stock los de Guardia, la auditoría de Identidad y `reconciliarStockMl`;
  - los crons de cada minuto pasan a un solo bucle de jobs;
  - se baja una frecuencia por semana (stock de 10 min a 1 h; refresco ML de 5-15 min a 2 h, más el nocturno
    completo), solo con `diferencias_sin_evento` en 0 o explicada;
  - nunca se apaga un barrido.

## Entregas (cada una usable sola)

1. **E-0 Fix de sobreventa (urgente, chico).** Barrera de venta ML, detallada en la sección "E-0: barrera de venta".
   Corrige el bug vigente de `routes/sync.js:1035-1049` sin esperar al resto.
2. **E-1 Ventas que no se pierden.** Jobs durables `order.ml` y `order.woo`, el job `stock.bolsa` como único
   disparador y la firma Woo fail-closed.
3. **E-2 Stock al instante desde ML.** `items`, `user_products` y `stock-location` → `stock.bolsa`, con
   generación, `dirty` y coalescencia que reprograma.
4. **E-3 Control medido.** Las tres métricas, `missed_feeds` con `site_id` y el monitor Woo.
5. **E-4 Envíos.** `shipments` → Preparación.
6. **E-5 en adelante: reducción de crons**, una frecuencia por semana.

## E-0: barrera de venta

Problema vigente: tras crear el pedido Woo de una venta ML, `syncSkuPuntual` empuja con el `catalogo_cache.stock`
**anterior** al descuento (`routes/sync.js:1035-1049`).

### Datos

`stock_refresco_pendiente(sku, ml_order_id, vendido_en, lineas_json, woo_confirmado, estado)`, con PK
`(sku, ml_order_id)`: cada venta es su propia obligación.
- `lineas_json`: **todas** las líneas de esa venta con ese SKU. Cada línea lleva índice local, `product_id`,
  `variation_id`, cantidad, `manage_stock` (leído de Woo al calcular: `true`, `false` o `parent` en una variación cuyo stock
  administra el padre) y `stock_gestor_id` (el producto que realmente lleva el stock: la propia línea, o el padre si
  `manage_stock=parent`) y, después del POST, `line_items[].id` y `name`.
- `estado`: `bloqueante` → `liberable` → (fila borrada).

### Orden en `_procesarOrden`

1. Reserva atómica de `ml_order_id` (`wc_order_id=0`, como hoy, `routes/sync.js:760`).
2. Cálculo completo de las líneas y de `skusProcesados` (hoy hasta `:941`). Si no hay líneas, se libera la reserva
   por el camino actual y no se inserta nada.
3. Se toman los candados de todos los SKUs de las bolsas afectadas (ver Serialización) y, **con los candados
   tomados, se recalcula el stock deseado de las líneas** antes de insertar; una escritura que haya empezado antes del
   candado termina antes de que se inserte, y de todos modos la corrección dueña (que corre siempre al liberar)
   relee ML y pisa cualquier valor escrito en ese intervalo. Bajo esos candados, una transacción inserta las filas con `woo_confirmado=0` y
   `estado=bloqueante`.
4. POST a Woo.
5. **Resultado:**
   - éxito: una transacción completa `line_items[].id` y `name` y marca `woo_confirmado=1`;
   - rechazo seguro: borra las filas en la misma transacción que libera la reserva. Solo cuenta como rechazo seguro
     un 400, 401, 403, 404 o 422 con cuerpo de error de validación de Woo. Se corrige `requiereVerificacionWc`
     (`routes/sync.js:625`): hoy toma todo 4xx salvo 429 como rechazo seguro, incluido el 408;
   - incierto (red, timeout, 5xx, 408, 409, 423, 425, 429): reserva retenida y filas conservadas.

### Resultado incierto: nunca un segundo POST

- Mientras exista la reserva `wc_order_id=0`, **ni** `_procesarOrden` **ni** el job `order.ml` (desde E-1) hacen otro
  POST. El job espera la resolución durable de la reserva y se reprograma.
- Una reserva `wc_order_id=0` con filas de barrera ya no es "abandonada": no la borra la limpieza de 60 min
  (`routes/sync.js:649`), porque la barrera prueba que el POST pudo haber salido.
- **Chequeo periódico** (cada 10 min, dentro del cron de pedidos ML): toma las reservas `wc_order_id=0` con barrera
  de más de 15 min y busca en Woo el pedido por la meta del Nº de orden ML:
  - si lo encuentra, en una transacción completa la reserva y la barrera desde la relectura del pedido;
  - si confirma que no existe, borra la reserva y la barrera en una transacción, y la venta vuelve al flujo normal;
  - si Woo no responde, no toca nada y reintenta.
- **Confirmar que no existe** exige agotar el rango. `_confirmarInexistenciaEnWc` (`routes/sync.js:566`) hoy mira
  solo la primera página de 100. Pasa a paginar `status=any` y `status=trash`, por fecha descendente, hasta que una
  página trae pedidos con `date_created` anterior a la reserva menos 24 h o hasta que se acaban las páginas. Si llega
  a 20 páginas sin agotar el rango, **no** confirma: conserva todo y reintenta.

### Liberación (por fila, es decir por SKU y venta)

Una fila con `woo_confirmado=0` **nunca** pasa a `liberable`. Con `woo_confirmado=1`, pasa a `liberable` cuando
**cada** línea de su `lineas_json` tiene evidencia propia **y**, **después** de reunida la evidencia de todas sus
 líneas, se inicia una lectura en Woo de cada `stock_gestor_id` involucrado. Una lectura iniciada antes de reunir la
 evidencia no cuenta, aunque haya sido después del POST: podría traer el stock previo al descuento.
La evidencia de una línea es una de estas dos:
- la línea tiene `manage_stock=true` o `parent`, y la nota de descuento la nombra. Con `parent`, Woo descuenta el
  stock del padre, pero la entrada de la nota lleva el nombre de la variación (`$item->get_product()`); la lectura
  posterior es la del padre (`stock_gestor_id`). La nota sale de
  `GET /orders/{id}/notes?type=internal`. Ese endpoint no pagina (`class-wc-rest-order-notes-v2-controller.php`
  llama a `get_comments` sin límite); por defensa, si viene `X-WP-TotalPages` > 1 se recorren todas las páginas. Woo
  escribe cada entrada como `get_name() (desde→hasta)` después de "Stock levels reduced:" o de su traducción activa
  ("Niveles de stock reducidos:"); los patrones son configurables (`wc-stock-functions.php:257` y `:302`). El nombre
  que se busca es el `line_items[].name` guardado al confirmar, que es el `get_name()` del momento de la venta: un
  renombrado posterior no lo afecta. Si hay N líneas con el mismo nombre, se necesitan N entradas;
- la línea tiene `manage_stock=false` (y no `parent`) **en una relectura hecha después de confirmar el pedido**, que
  coincide con el valor leído antes del POST; entonces Woo no la descuenta. Si el valor cambió o la relectura no es
  concluyente, la línea necesita la nota como cualquier otra. Esta excepción vale **solo para esa
  línea**: no libera a las otras líneas del mismo SKU.

Se usa la nota y no el meta `_order_stock_reduced`, porque con HPOS la API REST oculta ese meta. Tampoco se usa
evidencia numérica (stock antes contra después): otra venta simultánea puede cumplir la desigualdad sin que se haya
descontado *este* pedido.

Siguen bloqueando, con un incidente visible para José:
- nombres que no identifican una sola línea (dos líneas de la orden con el mismo nombre, o dos productos del
  catálogo con stock gestionado que se llaman igual);
- "Unable to reduce stock" en la nota para esa línea;
- 30 min sin la entrada correspondiente.

El incidente "Woo no descontó" muestra el pedido, las líneas y la acción que hay que hacer **sobre esa orden**: en
el panel del pedido Woo, "Acciones del pedido → Reducir niveles de stock". Esa acción llama a `wc_reduce_stock_levels`
y agrega la nota, así que la barrera se libera sola. **Solo sirve si la línea no tiene `_reduced_stock`**: Woo saltea
las líneas ya descontadas y entonces no escribe nota. Por eso el incidente distingue dos casos según el meta
`_reduced_stock` de cada línea (`line_items[].meta_data`, visible por REST):
  - sin `_reduced_stock`: se ofrece la acción de Woo;
  - con `_reduced_stock` distinto de la cantidad vendida de la línea (guardada en `lineas_json`): queda bloqueada y
    el incidente muestra la discrepancia; "Confirmar descuento" no se ofrece;
  - con `_reduced_stock` igual a la cantidad vendida pero sin nota reconocible: se ofrece **"Confirmar descuento"** en la herramienta, un botón
    solo para admin que pide motivo, registra actor, hora y el valor de `_reduced_stock` como **evidencia de esa línea
    únicamente**. La fila pasa a `liberable` solo cuando todas sus líneas tienen evidencia (nota, `manage_stock=false`
    verificado o confirmación), y la lectura de sus `stock_gestor_id` se inicia después de la última. No se libera sola. Ajustar el inventario del producto a mano no sirve, porque no
genera la nota. Si después de la acción la nota no aparece, el incidente sigue abierto.

El paso a `liberable` lo intenta el job puntual con reintento y, si no, un chequeo dentro del cron de catálogo.

### Escrituras mientras hay barrera

- **Alcance = la bolsa, no solo el SKU.** Las claves afectadas por una fila son: todas las claves ML de ese SKU según
  el CTE del sync (`computedStockCte`, el conjunto exacto que nuestro sync escribe) **más** todas las que comparten
  `user_product_id` con alguna de ellas en `ml_publicaciones_cache`, cualquiera sea su SKU. Una clave fuera del caché
  tampoco la escribe nuestro sync. Si la enumeración falla, la barrera se conserva.
- Toda escritura de stock (cron `syncWcToMl`, puntual, reactivador y, desde E-1, `stock.bolsa`) pasa por
  `escribirStockMl`, que resuelve la bolsa de la clave a escribir y se omite si **cualquier** SKU de esa bolsa tiene
  una fila `bloqueante`, o una `liberable` ajena a la llamada. Toma el candado de cada SKU de la bolsa en orden
  alfabético.
- **Corrección dueña.** Es la única escritura permitida con la fila en `liberable`: la llamada que lleva su
  `barrera_id` (en E-0, `syncSkuPuntual(..., {barrera_id})`; desde E-1, el `stock.bolsa` encolado con ese id).
  Funciona así:
  - **es dueña de la bolsa, no del SKU:** si cualquier SKU de la bolsa todavía tiene una fila `bloqueante`, no corre;
    las filas `liberable` de otros SKUs de la misma bolsa no la bloquean, porque las cierra ella;
  - bajo los candados de la bolsa, **primero relee de Woo todos los `stock_gestor_id` de la bolsa y los vuelca en
    `catalogo_cache`**, y recién entonces recalcula el deseado con `computedStockCte()`. Si una lectura Woo falla,
    reintenta sin escribir;
  - **no** usa el `sin_cambios` del caché: relee de ML (`/items/bulk`) todas las claves afectadas (la bolsa completa), actualiza el caché y
    empuja cada clave cuyo remoto difiera del deseado;
  - cierra juntas todas las filas `liberables` de todos los SKUs de la bolsa, en la misma transacción en que una relectura remota confirma
    que **todas** las claves afectadas (cada publicación y variación de la bolsa) publican la cantidad deseada;
  - si falta una clave o falla una lectura, reintenta.
- **Serialización.**
  - `escribirStockMl` y la inserción de la barrera toman el mismo candado por SKU: `stock_lock(sku, token, vence)` en
    SQLite, válido entre procesos.
  - El dueño renueva `vence` cada 10 s mientras el PUT está en vuelo, y solo él lo libera
    (`DELETE ... WHERE token=?`), cuando ya conoce el resultado. El timeout de `mlFetch` es menor que el lease.
  - Otro proceso solo puede tomar un candado vencido y sin renovar, es decir, con el dueño caído.
  - Como un PUT en vuelo (o uno con dueño caído) pudo escribir un valor previo a la venta, la corrección dueña se hace
    **siempre**.

### Prerrequisitos (solo lectura)

**Al arrancar y una vez por día:** se verifica `woocommerce_manage_stock=yes`
(`GET /settings/products/woocommerce_manage_stock`). Si está en `no`:
- no se libera ninguna barrera;
- se pausan las escrituras de stock (las de `escribirStockMl`);
- se abre un incidente para José.

**Antes de implementar E-0** se verifica en QA o en un pedido real existente, en solo lectura:
- que `line_items[].name` coincide con la entrada de la nota, en un producto simple y en una variación;
- que "Reducir niveles de stock" existe en la versión de Woo de la tienda y genera la nota.

Si algo de eso no se cumple, E-0 no avanza hasta definir con José otra evidencia atribuible al pedido.

## Errores y bordes

- ML 429 o 429 sombra sintético: reencolar con backoff; el barrido cubre.
- Item sin vínculo: solo caché y Vigía, sin push.
- Orden ML con un SKU incoherente (`sku_incoherente`): no se descuenta stock; el pedido sigue el flujo actual.
- Orden Woo editada (cambian las líneas): la unión de SKUs viejos y nuevos asegura que se libere el stock quitado.
- Reinicio con jobs tomados: el lease vence y otro worker los toma; la relectura los hace idempotentes.
- Modo sombra de las Fases C y D: `stock.bolsa` respeta los mismos interruptores que el sync actual.

## Verificación

- **Tests por entrega:**
  - E-0: una venta ML no reenvía a ML el stock anterior al descuento; si el refresco de Woo falla, ninguna escritura (ni el cron) empuja ese SKU hasta un refresco posterior a la venta;
  - E-1: un webhook de orden ML cancelada cancela el pedido Woo una sola vez (y reencola con `wc_order_id=0`) y empuja el stock devuelto; una orden Woo en la papelera empuja el stock liberado; durante el POST de la venta el cron no puede empujar ese SKU; un POST fallido con certeza borra las filas y uno incierto las conserva; borrar una variación de un padre vigente la protege y lleva ML a 0, también si llega solo como `product.updated`; un PUT en vuelo durante la venta es seguido por el `stock.bolsa` obligatorio; una nota que no nombra un SKU de la orden lo deja bloqueado; dos ventas seguidas del mismo SKU: no se libera hasta confirmar las dos; renombrar el producto después de la venta no impide liberar; con el caché de ML desactualizado igual al deseado y el remoto distinto, la corrección empuja; dos líneas del mismo SKU en un pedido exigen dos entradas en la nota; una línea `manage_stock=false` no libera a otra gestionada del mismo SKU; un `manage_stock=false` que cambia después del POST exige la nota; una hermana con otro SKU y el mismo `user_product_id` no se escribe durante la barrera; la corrección relee Woo y no vuelve a publicar el stock previo a la venta; una línea con `_reduced_stock` y sin nota se libera solo con "Confirmar descuento" auditado; confirmar una línea no libera la fila si otra línea sigue sin evidencia; un `_reduced_stock` parcial no permite confirmar; en `/items/bulk`, un elemento 5xx reencola ese id y un 404 confirmado por relectura retira el caché y encola la bolsa; dos SKUs de una bolsa con filas `liberable` distintas se cierran en una sola corrección; una escritura iniciada entre la reserva y la barrera queda pisada por la corrección; una variación con `manage_stock=parent` exige la nota y se libera con la lectura del padre; con el descuento demorado, una lectura previa a la nota no libera; con la reserva incierta no hay segundo POST; nombre que no coincide con la nota deja bloqueado con incidente; una caída después del POST se resuelve con el chequeo periódico (pedido encontrado → completa; inexistente confirmado → borra); con `woocommerce_manage_stock=no` no se escribe stock y se abre incidente; un 408 en el POST conserva reserva y barrera; la confirmación de inexistencia con más de 100 pedidos recientes pagina hasta agotar el rango y, al llegar al tope, no confirma; nombres repetidos dejan bloqueado con incidente; un candado vencido por dueño caído dispara la corrección; en E-0 la fila no se borra hasta que el push correctivo termina, y ese push (con su `barrera_id`) no queda bloqueado por su propia fila mientras cualquier otro sí; una bolsa con una hermana en barrera no se escribe; una baja Woo confirmada empuja 0 aun con el caso abierto y aunque el producto ya no esté en `catalogo_cache`, y una lectura con 5xx no lo hace; `sin_cambios` sin relectura remota coincidente no borra la barrera; la liberación funciona con la nota en español y en inglés, con HPOS y sin HPOS, y sin nota a los 30 min queda bloqueado con incidente; un `product.deleted` atrasado sobre un producto restaurado no lo borra; un reinicio entre el ACK y el job no pierde la venta, llegue por `orders` o por `orders_v2`; una orden Woo editada tras un reinicio libera el stock de las líneas quitadas; papelera → restauración vuelve a descontar; un 404 retira la orden de Preparación y una preparación ya iniciada queda `anulado_en_woo` con su historial y sus acciones en 409; restauración → `deleted` atrasado no anula; restauración tras anular devuelve el estado previo; un ping con id no registrado da 401; el test de la puerta única de escritura; el ping sin firma da 200 sin efecto y cualquier otro body sin firma da 401; multiorigen detectado o comprobación vencida → ninguna escritura de stock (cron, puntual, reactivador ni bolsa) y abre incidente; un aviso que llega durante el procesamiento no pisa `woo_orden_skus`; firma fail-closed; topic y webhook ID inválidos;
  - E-2: `dirty` repite, la coalescencia reprograma, dos hermanas hacen una sola escritura (mismo SKU con reservas o modos distintos → el más restrictivo; SKUs distintos → no escribe y abre caso), una orden pendiente
    frena el push y un eco no escribe;
  - E-3: la URL de `missed_feeds` lleva `app_id` y `site_id`, y reinyecta; alerta del monitor Woo; `barrido_corridas` cuenta lo sin evento.
- **En producción:** una semana de métricas antes de cualquier cambio de frecuencia.
