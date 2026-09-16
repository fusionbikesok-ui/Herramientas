# E1 — Matriz de barridos por tópico (revisada 2026-09-15)

Contrato de reparación de la sombra de E1. La reparación **no depende del aviso**: cada tópico tiene su
barrido de la API remota con cursor persistido en `integrations.reconciliation_cursors`. La fuente de
conciliación es la API remota.

Dos criterios de aceptación, según lo que la API permite **enumerar**:

- **Paridad (`enumerable`)**: la API lista los recursos de una ventana; "0 faltantes" = lo enumerado
  contra lo que hay en `inbox_messages`.
- **Convergencia (`convergence`)**: sin historial consultable; para cada recurso conocido abierto o
  reciente, el estado proyectado coincide con el remoto actual dentro de un barrido. Se informan
  **cobertura** (barridos/conocidos) y **convergencia** (coincidentes/barridos y tiempo hasta coincidir).

## Matriz

| Tópico | Estrategia | Barrido | Cursor y solape | Borrados / cierres | Límites y riesgos | Evidencia |
|---|---|---|---|---|---|---|
| `ml.orders` | enumerable | `GET /orders/search?seller={id}&order.date_last_updated.from={cursor−solape}&sort=date_desc&limit=50&offset=n` | `order.date_last_updated` máximo visto; solape 600 s; cada 10 min | cancelación como estado en la misma búsqueda | tope de `offset` no verificado: ventanas de ≤ 6 h si una página supera 1.000 resultados | **Sonda autenticada 2026-09-13**: sin filtro 2.446, desde ayer 3, desde +30 días 0 → el filtro existe y se aplica. Legado usa `order.date_created.from/to` |
| `ml.shipments` | convergence | `GET /shipments/{id}` con header `x-format-new: true` para todo envío conocido no entregado/cancelado y los cerrados de los últimos 30 días | por envío: `last_updated`; sólo se reproyecta si cambió; cada 15 min | cancelado/devuelto como estado | sin búsqueda ni historial enumerable de cambios | **Sonda 2026-09-13**: `last_updated` presente (`2026-09-13T16:31:37.701-04:00`), 200 sin el header; la documentación indica `x-format-new` obligatorio desde 2025-10-12 → el cliente v2 lo envía siempre. `lib/mlClient.js` del legado **no reenvía headers por llamada** |
| `ml.questions` | enumerable (sin responder) + convergence (resto) | `GET /questions/search?seller_id={id}&api_version=4&status=UNANSWERED&limit=50`; preguntas conocidas respondidas/eliminadas: `GET /questions/{id}` | enumerable: conjunto completo de sin responder por corrida; convergencia por pregunta; cada 20 min | eliminada por ML → registrada como no encontrada | respondidas no se enumeran por fecha en el uso verificado | Código productivo `routes/*` (búsqueda `UNANSWERED`, cron cada 20 min) |
| `ml.messages` | enumerable (no leídos) + convergence por pack | `GET /messages/unread?role=seller&tag=post_sale` y `GET /messages/packs/{pack}/sellers/{seller}?mark_as_read=false` para packs de órdenes de los últimos 30 días | por pack: último mensaje visto; cada 20 min | no aplica | `mark_as_read=false` obligatorio; el id del aviso no es resoluble como vendedor | **PM-157** (verificado contra la API 2026-09-06, contador de no leídos intacto) |
| `ml.claims` | enumerable (abiertos) + convergence (cerrados conocidos) | `GET /post-purchase/v1/claims/search?status=opened&players.user_id={id}&players.role=respondent`; conocidos cerrados: `GET /post-purchase/v1/claims/{id}` | conjunto de abiertos por corrida; convergencia por reclamo; cada 20 min | cierre como estado | filtro por fecha no verificado | Código productivo (búsqueda `status=opened`) |
| `ml.items` | enumerable | `GET /users/{id}/items/search?search_type=scan&limit=100` + `GET /items?ids=` (20 por lote) | conjunto completo por corrida; 1 vuelta diaria fuera de horario | publicación ausente del scan o `status=closed` → baja | costo de cuota: una vuelta diaria | Código productivo (`search_type=scan`, multiget) |
| `woo.orders` | enumerable | `GET /wp-json/wc/v3/orders?modified_after={cursor−solape}&modified_before={window_to}&dates_are_gmt=true&per_page=100&page=n&orderby=modified&order=asc&status=any`, y una segunda pasada idéntica con `status=trash` | `date_modified_gmt` máximo; solape 600 s; cada 10 min | cancelación como estado en la pasada `any`; papelera como cierre en la pasada `trash`; borrado definitivo → diferencia de IDs semanal | `per_page` máximo 100; `any` no incluye `trash`, por eso son dos pasadas | **Código fuente WooCommerce** (`class-wc-rest-crud-controller.php`, trunk, consultado 2026-09-13): `modified_after`, `modified_before`, `dates_are_gmt`, `per_page` ≤ 100. **`class-wc-rest-orders-v2-controller.php`, trunk, consultado 2026-09-16**: `status` tiene `default => 'any'` y su enum incluye `'any'` y `'trash'`. **WordPress `wp-includes/post.php`, consultado 2026-09-16**: `trash` se registra con `internal => true` y por eso hereda `exclude_from_search => true`, así que `post_status='any'` lo excluye; el legado ya dependía de esa exclusión (`routes/sync.js:467`, `routes/woo.js:283`) |
| `woo.products` | enumerable | `GET /wp-json/wc/v3/products?modified_after=…&dates_are_gmt=true&per_page=100` y variaciones de los padres modificados | `date_modified_gmt` máximo; solape 600 s; cada 10 min; vuelta completa diaria | `product.deleted` **no aparece** en modificados → diferencia del conjunto completo de IDs en la vuelta diaria | variaciones requieren una llamada por padre | Fuente WooCommerce (arriba); legado usa `modified_after` con solape (`routes/woo.js`) y recibe `product.deleted` firmado (PM-154) |

## Reglas comunes

1. Deduplicación por `(channel_account_id, topic, resource_id, remote_version)`; una señal repetida o
   fuera de orden no crea mensajes nuevos.
2. El cursor avanza **sólo** al terminar la ventana completa sin errores; ante error queda y la próxima
   corrida repite la ventana con solape.
3. 408/429/5xx: backoff con jitter (tope 8 intentos) y respeto de `Retry-After`; 401/403: terminal →
   `dead_lettered` con incidente; respuesta perdida → `uncertain` y relectura, nunca repetición ciega.
4. Cuota: los barridos comparten el limitador del legado mientras convivan; ningún barrido corre si el
   cooldown de ML está activo.
5. Tópicos con limitación declarada informan cobertura; nunca prometen "0 faltantes".
6. Toda ventana temporal congela su límite superior; órdenes se subdividen en intervalos de hasta 6 h.
7. Envíos y packs se descubren mediante relaciones técnicas extraídas de órdenes; no se inventan IDs
   ni se depende de una tabla de dominio de E2.
8. `missed_feeds` se incorpora en T3 como suplemento con cursor propio; no sustituye estos barridos.

## Pendiente de verificar al implementar (no bloquea la especificación)

- Tope real de `offset` en `/orders/search` con la ventana de 6 h como mitigación ya definida.
- Paginación y ventana de `/post-purchase/v1/claims/search` si se amplía a cerrados por fecha.
