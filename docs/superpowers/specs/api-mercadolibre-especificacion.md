# Especificación de integración con Mercado Libre

**Esta es la fuente para todo lo que se desarrolle contra Mercado Libre.** Antes de escribir
código que toque ML, se lee este documento. Si algo no está acá, se releva primero y se
agrega; no se implementa contra memoria ni contra suposiciones.

Construida el 2026-09-07/08 combinando dos fuentes:

1. **Documentación oficial** (`developers.mercadolibre.com.ar`), extraída con un navegador
   real porque el sitio devuelve 403 a cualquier acceso automatizado. 228 páginas mapeadas.
2. **Observación en vivo** contra la cuenta real, solo con GET, sanitizada.

Las dos hacen falta: la documentación describe el universo de endpoints; la observación dice
qué responde *esta* cuenta con *este* token. Donde discrepan, manda lo observado y queda
anotado.

---

## 1. Reglas que no se negocian

- **El VPS es el único cliente de Mercado Libre.** La app nunca llama a ML ni ve tokens.
  Todo pasa por `/api/v1`.
- **Ninguna acción comercial se da por enviada sin confirmación del servidor.** Una respuesta
  a un cliente, un reembolso o una devolución no se muestran como hechos hasta que ML lo
  confirma. Esto vale también para la cola offline: estas acciones no se encolan.
- **Nada que mueva dinero o cierre una disputa se ofrece como acción rápida** desde una
  notificación. Va dentro del detalle, con confirmación explícita de la consecuencia.
- **ML Full queda fuera** del programa (decisión del plan maestro).
- Toda escritura lleva **clave de idempotencia** y se revalida contra el estado vigente en ML
  inmediatamente antes de ejecutarse.

## 2. Infraestructura que ya existe

`lib/mlClient.js` expone `mlFetch(db, cfg, método, ruta, body, opts)`: OAuth con refresh,
categorización de errores, deduplicación de errores repetidos y cooldown. Más
`lib/mlRateLimiter.js` y `lib/mlScanRamp.js`.

**Agregar un endpoint es barato.** Lo caro —autenticación, límites, resiliencia— está hecho.

`mlFetch` devuelve la respuesta completa de axios: los datos están en `.data`.

## 3. La cuenta

Sitio `MLA`. Tags: `normal`, `business`, `messages_as_seller`, `eshop`, `large_seller`,
`user_product_seller`, `brand`. `messages_as_seller` es el que habilita mensajería posventa
como vendedor.

No hay forma de leer los scopes del token: se infieren por lo que responde.

---

## 4. Trampas que solo aparecieron observando

Estas cinco no están en la documentación de forma evidente y cada una costaría medio día.

### 4.1 `?tag=post_sale` es obligatorio en mensajería

`GET /messages/packs/{pack}/sellers/{seller}` sin el parámetro devuelve **404**. Con
`?tag=post_sale` devuelve **200**. Verificado con dos packs distintos.

Un 404 acá parece "no existe la conversación" y en realidad es "te faltó un parámetro".

### 4.2 `available_actions` vive en `players[]`, y son objetos

No está en la raíz del reclamo. Está por rol (`complainant`, `respondent`, `mediator`), y
cada elemento es:

```json
{ "action": "send_message_to_mediator", "mandatory": false, "due_date": null }
```

No son strings. `mandatory` y `due_date` son la señal de urgencia y plazo: **para casos de ML
se usa el plazo de ML**, no un temporizador propio, porque un reloj inventado puede
contradecir al de ellos y el que manda es el de ellos.

### 4.3 El detalle y la búsqueda de reclamos se contradicen

Para el mismo reclamo abierto (`5124016992`, `type: mediations`, `stage: recontact`):

| Endpoint | Acciones del vendedor |
| --- | --- |
| `GET /post-purchase/v1/claims/search?status=opened` | `send_message_to_mediator` |
| `GET /post-purchase/v1/claims/{id}` | `[]` en los tres players |

Existe además `GET /post-purchase/v1/claims/{id}/detail`, un endpoint distinto que la
documentación lista aparte y que todavía no se probó: es el primer candidato a explicar la
diferencia.

**Regla mientras no se resuelva:** una lista vacía en el detalle es **desconocido**, no
"ninguna acción". No se habilita ni se esconde un botón con ese dato.

### 4.4 ML modera los mensajes

`GET /post-purchase/v1/claims/{id}/messages` devuelve `message_moderation` por mensaje. Un
mensaje enviado puede quedar moderado: enviarlo no garantiza que llegue.

### 4.5 `GET` sobre `attachments` devuelve 405

El endpoint de adjuntos de reclamo es solo de escritura. Para leer adjuntos existe
`/attachments/{id}/download`.

---

## 5. Superficie por área

Leyenda: **[✓]** implementado en el VPS · **[ ]** no implementado · **[obs]** observado en vivo.

### 5.1 Autenticación

- [✓] `POST /oauth/token` — token y refresh
- [✓] `GET /users/me` **[obs]** — identidad y tags de la cuenta

### 5.2 Preguntas y respuestas

- [✓] `GET /questions/search?seller_id=&status=UNANSWERED&api_version=4` — la cola de trabajo
- [✓] `GET /questions/{id}?api_version=4` **[obs]**
- [ ] **`POST /answers`** — responder. **No existe en el repositorio.** Hoy no se puede
      responder una pregunta desde ningún lado, ni el panel ni la app.
- [ ] `DELETE /questions/{id}` — eliminar pregunta
- [ ] `GET /my/received_questions/search` — recibidas
- [ ] `GET /block-api/search/users/{seller}?type=blocked_by_questions` — bloqueados
- [ ] `DELETE /users/{seller}/questions_blacklist/{user}` — desbloquear
- [ ] `GET /users/{id}/questions/response_time` — tiempo de respuesta (métrica de reputación)

**Forma observada de la pregunta:** `id`, `seller_id`, `text`, `tags`, `status`, `item_id`,
`date_created`, `hold`, `deleted_from_listing`, `answer`, `from`, `ai_categories`.

`hold` y `ai_categories` no estaban en ningún diseño previo. No trae `available_actions`: la
regla es el estado (`UNANSWERED` se puede responder).

### 5.3 Mensajería posventa

Todo exige `?tag=post_sale` (ver 4.1).

- [✓] `GET /messages/packs/{pack}/sellers/{seller}?tag=post_sale` **[obs]** — hilo del pack
- [✓] `GET /messages/{id}?tag=post_sale`
- [✓] `GET /messages/unread?tag=post_sale` y `/messages/unread/{resource}?tag=post_sale`
- [ ] **`POST /messages/packs/{pack}/sellers/{seller}?tag=post_sale`** — enviar al comprador
- [ ] `POST /messages/attachments?tag=post_sale&site_id=` — subir adjunto (multipart)
- [ ] `GET /messages/attachments/{id}?tag=post_sale&site_id=` — bajar adjunto
- [ ] `GET /messages/action_guide/packs/{pack}?tag=post_sale` — **motivos habilitados**
- [ ] `GET /messages/action_guide/packs/{pack}/caps_available?tag=post_sale` — cupo restante
- [ ] `POST /messages/action_guide/packs/{pack}/option?tag=post_sale` — elegir motivo

**`action_guide` importa:** ML restringe cuándo y por qué se puede escribir, y hay un cupo.
Enviar sin consultarlo puede rebotar. La respuesta del hilo trae `conversation_status`,
`seller_max_message_length` y `buyer_max_message_length` **[obs]**: el largo máximo se lee de
ahí, no se fija en el código.

### 5.4 Reclamos

- [✓] `GET /post-purchase/v1/claims/{id}` **[obs]**
- [ ] `GET /post-purchase/v1/claims/{id}/detail` — ver 4.3
- [✓] `GET /post-purchase/v1/claims/search?players.user_id=&players.role=respondent&status=opened` **[obs]**
- [✓] `GET /post-purchase/v1/claims/{id}/messages` **[obs]**
- [ ] **`POST /post-purchase/v1/claims/{id}/actions/send-message`** — responder
- [ ] `POST /post-purchase/v1/claims/{id}/attachments` — adjuntar (405 en GET, ver 4.5)
- [ ] `GET /post-purchase/v1/claims/{id}/attachments/{id}/download`
- [ ] `GET /post-purchase/v1/claims/reasons/{reason_id}` — texto del motivo
- [ ] `GET /post-purchase/v1/claims/{id}/actions-history`
- [ ] `GET /post-purchase/v1/claims/{id}/status-history`
- [ ] `GET /post-purchase/v1/claims/{id}/affects-reputation` — si pega en la reputación
- [ ] `GET /post-purchase/v1/claims/{id}/changes`

**Forma observada:** `id`, `resource_id`, `status`, `type`, `stage`, `parent_id`, `resource`,
`reason_id`, `fulfilled`, `claimed_quantity`, `claim_version`, `players[]`, `resolution`,
`site_id`, `related_entities`. **`claim_version` existe: ML también maneja concurrencia
optimista.**

### 5.5 Resolución de reclamos — acciones económicas

**Ninguna de estas se ofrece como acción rápida.** Van dentro del detalle, con confirmación
explícita de la consecuencia, y todas son irreversibles o mueven dinero.

- [✓] `GET /post-purchase/v1/claims/{id}/expected-resolutions` **[obs]** — qué pide la otra parte
- [ ] `GET /post-purchase/v1/claims/{id}/partial-refund/available-offers` — ofertas posibles
- [ ] `POST /post-purchase/v1/claims/{id}/expected-resolutions/partial-refund`
- [ ] `POST /post-purchase/v1/claims/{id}/expected-resolutions/refund`
- [ ] `POST /post-purchase/v1/claims/{id}/expected-resolutions/allow-return`
- [ ] `POST /post-purchase/v1/claims/{id}/actions/open-dispute` — abrir mediación

**Forma de `expected-resolutions` [obs]:** `player_role`, `user_id`, `expected_resolution`,
`details`, `status`.

### 5.6 Evidencia de reclamos

- [ ] `GET/POST /post-purchase/v1/claims/{id}/evidences`
- [ ] `POST /post-purchase/v1/claims/{id}/attachments-evidences`
- [ ] `GET /post-purchase/v1/claims/{id}/attachments-evidences/{id}/download`
- [ ] `DELETE /post-purchase/v1/claims/{id}/attachments-evidences/{id}`
- [ ] `POST /post-purchase/v1/claims/{id}/actions/evidences`

### 5.7 Devoluciones

Ojo con la versión: `returns` cuelga de **v2** en un caso y de v1 en el resto.

- [ ] `GET /post-purchase/v2/claims/{id}/returns`
- [ ] `POST /post-purchase/v1/returns/{id}/reviews` — revisar lo devuelto
- [ ] `GET /post-purchase/v1/returns/{id}/return-review`
- [ ] `GET /post-purchase/v1/returns/reasons?flow=&claim_id=`
- [ ] `POST /post-purchase/v1/claims/{id}/returns/attachments`
- [ ] `GET /post-purchase/v1/claims/{id}/charges/return-cost` — quién paga el retorno

Las acciones `return_review_ok` y `return_review_fail` aparecen en `available_actions` del
vendedor cuando hay una devolución en curso. **No se pudieron observar**: no hay ningún caso
de ese tipo abierto en la cuenta.

### 5.8 Órdenes y packs

- [✓] `GET /orders/{id}` **[obs]**, `GET /orders/search?seller=&order.status=`
- [✓] `GET /orders/{id}/notes`, `POST` nota privada
- [ ] `GET /orders/{id}/shipments`, `/product`, `/discounts`
- [ ] `GET /packs/{id}` — el pack agrupa órdenes
- [ ] `GET/POST/PUT/DELETE /packs/{id}/notes[/{noteId}]`
- [ ] `GET /orders/{id}/feedback`, `POST /feedback/{id}/reply`
- [ ] `POST /users/{id}/order_blacklist` — bloquear comprador

**Forma observada de la orden:** incluye `mediations`, `status_detail`, `cancel_detail`,
`feedback`, `related_orders`, `pack_id` y `tags` (`not_delivered`, `not_paid`, `pack_order`…).

### 5.9 Envíos

- [✓] `GET /shipments/{id}` **[obs]**
- [ ] `/shipments/{id}/orders`, `/items`, `/costs`, `/payments`, `/sla`, `/delays`,
      `/lead_time`, `/carrier`, `/split`
- [ ] `GET /shipment_labels?shipment_ids=` — **etiquetas** (PDF/ZPL)
- [ ] `POST /shipments/{id}/process/ready_to_ship`
- [ ] `GET/POST /shipments/{id}/seller_notifications`
- [ ] `GET /users/{id}/shipping_preferences`
- [ ] Flex: `/flex/sites/{site}/users/{user}/subscriptions/v1`, zonas de cobertura,
      feriados, rangos de entrega, `/flex/sites/{site}/shipments/{id}/assignment/v2`

### 5.10 Publicaciones, stock y precios

- [✓] `GET /items/{id}` **[obs]**, `/items/{id}/variations/{varId}`
- [✓] `PUT /items/{id}` — pausar/activar (usado en cobertura y guardia)
- [ ] `GET /users/{id}/items/search?seller_sku=` — buscar por SKU propio
- [ ] `GET/PUT /items/{id}/description?api_version=2`
- [ ] `GET/POST /user-products/{id}/stock` y `/stock/type/seller_warehouse` — stock multi origen
- [ ] `GET /items/{id}/prices`, `/prices/standard`, `/sale_price?context=`
- [ ] `GET /sites/{site}/listing_prices?...` — **[✓ parcial]** costo por vender
- [ ] `GET /items/{id}/available_upgrades`, `/available_downgrades`, `/available_listing_types`
- [ ] `GET /moderations/last_moderation/{ref}`, `/moderations/infractions/{user}`
- [ ] `GET /item/{id}/performance`, `/reviews/item/{id}`, visitas

### 5.11 Facturación

- [ ] `GET /orders/billing-info/{site}/{id}`
- [ ] `POST /packs/{pack}/fiscal_documents` — subir factura propia
- [ ] `GET /invoices/io/documents/stream/order/{id}/pdf` y `/xml` — descargar de MELI

### 5.12 Notificaciones (webhooks)

Los topics entregan un `resource` que hay que ir a leer; **la notificación no es fuente de
verdad**. Recursos que llegan: `/orders/{id}`, `/messages/{resource}`, `/questions/{id}`,
`/items/{id}`, `/shipments/{id}`, `/user-products/{id}/stock`, `/items/{id}/price_to_win`,
`/flex/.../assignment/v1`, entre otros.

[✓] Ya se reciben. La app tiene todos los topics activos en el panel de ML por decisión del
2026-08-26: filtrar en el VPS es más simple que ir y volver al panel.

---

## 6. Qué falta observar

- **`/claims/{id}/detail`** — el candidato a resolver la contradicción de 4.3.
- **Acciones de devolución** — hasta que exista un caso abierto de ese tipo.
- **`action_guide` de mensajería** — motivos y cupo, con un pack vigente.
- **Scopes reales del token.**

`scripts/relevar-ml.mjs` (rama `feature/e6-notificaciones-ml`) hace este trabajo: solo GET y
sanitiza la salida.

## 7. Estado al momento del relevamiento

12 reclamos locales, todos cerrados. En ML, **1 reclamo abierto**: una mediación en etapa
`recontact` cuya única acción disponible para el vendedor es escribirle al mediador.
