# Tracker: Sync ML↔Woo en tiempo real (A.1–A.4)

Detalle fase por fase de la reprioridad de notificaciones/sync iniciada 2026-08-26. Índice
general en `plan-maestro-v2.md`. Contexto técnico verificado en código (no asumido) al momento
de priorizar:

- `syncMlToWc` (`routes/sync.js:245`, venta ML → ajusta stock en Woo) — ya es idempotente
  (tabla `ordenes_ml_procesadas`) y ya se dispara por webhook (`topic:'orders'` en
  `server.js`), pero hace un barrido completo (`/orders/search` paginado) en vez de traer solo
  la orden puntual del `resource` de la notificación. Ver A.3.
- `syncWcToMl` (`routes/sync.js:924`, nuestro stock → ML) — ya se dispara por webhook de Woo
  (inmediato), pero recalculaba TODOS los diffs pendientes de la tabla `computed`, sin
  feedback visual. Ver A.2 (cerrado).
- `syncPedidosCache` (`routes/preparacion.js:2049`, llena `pedidos_cache`) — era solo cron
  cada 10 min, sin disparo inmediato por webhook. Ver A.1 (cerrado).
- Notificaciones ML: la app recibe TODOS los topics marcados en el panel de developers — el
  filtro de qué se procesa vive en el código (`POST /api/ml/notificacion`, `server.js`), no en
  el panel. Implementado: `orders`, `questions`, `messages`. Pendiente: `claims` (A.4). El
  resto (`orders_v2`, `shipments`, `orders_feedback`, `items`, `invoices`) se reciben y
  descartan en silencio hasta que se sume su función.

## Estado

| Ítem | Estado | Rama/commit | Nota |
|---|---|---|---|
| **A.1** — Venta confirmada → cola de Preparación al instante | ✅ **Desplegado** | `prep-cola-instantanea` → mergeado a `conteo-confiable` (`599ae86`) | `syncPedidoWebPuntual`/equivalente ML, upsert inmediato en `pedidos_cache` disparado desde los webhooks de Woo y ML. Cron de 10 min queda de respaldo. Auditor 🟢. **Pendiente operativo**: hasta el `pm2 restart` que ya se hizo (2026-08-26), no tenía efecto — confirmado activo. |
| **A.2** — Stock manual → push inmediato a ML + feedback visual | ✅ **Desplegado** (backend + frontend) | `stock-push-feedback` → mergeado (`7910412`) + `stock-push-frontend` → mergeado (`d2563f2`) | `syncSkuPuntual(db, cfg, sku)` en `routes/sync.js`, disparada desde `POST /api/recepciones/:id/confirmar` y `POST /api/woo/stock/aplicar`, con array `sync_ml` en la respuesta (ver `docs/api-contrato.md`). Frontend: chips de color en `public/stock/index.html` y `public/recepcion/index.html`. **5 rondas de revisor** en el backend (LIMIT 1 que mentía "sincronizado", 429 mal manejado, recepción podía quedar en `'procesando'` sin salida — todo corregido) y 3 rondas en el frontend (chips ocultos en error parcial, layout roto, accesibilidad). `probador-e2e` 🟢🟢. Auditor 🟢 en ambos gates. PM2 reiniciado, activo. Seguimientos BAJO no bloqueantes (ver Backlog abajo). |
| **A.3** — Cambio de stock por venta → sync puntual por orden | ✅ **Desplegado** | `sync-orden-puntual` → mergeado a `conteo-confiable` (`90a9edc`, merge `c4d5042`, 2026-08-27) | **Corrección 2026-08-28: este ítem estaba marcado "sin empezar" por error — ya está implementado y verificado activo en producción.** `syncOrdenMlPuntual` (`routes/sync.js:336`) se dispara desde el webhook de ML (`server.js:178`, topic `orders`) y procesa solo la orden puntual del `resource` en vez del barrido paginado completo; la búsqueda paginada queda de respaldo del cron, igual criterio que A.1. Verificado en logs de producción (`[notif-ml] topic=orders_v2 ... → syncPedidoMlPuntual`) y por lectura de código post-Hito 6 de confiabilidad, sin regresiones de merges posteriores. |
| **A.4** — Reclamos sumados a "Novedades ML" | 🟡 **Implementado, pendiente de revisión/merge** | `hito-a4-claims` → `075b882` | Implementado en worktree separado del Hito 7. Incluye `migrations/027_ml_reclamos.sql` (renumerada para convivir con Hito 7), tabla defensiva en `routes/notificacionesMl.js`, `ingerirReclamo` fail-open (incluidas excepciones de ML), topic `claims` en `server.js`, reclamos en `/count` y `/pendientes`, banner Home y contrato actualizado. Tests dirigidos: `test/notificacionesMl.test.js` 13/13 verdes; `git diff --check` OK. **No mergear todavía:** requiere revisor, tester/auditoría y resolver cualquier conflicto de `server.js` con Hito 7. |

## Backlog no bloqueante de A.2 (seguimiento, no bloquea el cierre)

- `routes/recepciones.js` pushea el `sku` de `recepcion_items.sku` (puede quedar stale si el
  SKU cambió en Woo después del match), a diferencia de `routes/woo.js` que ya lo corrigió
  para leerlo de `catalogo_cache`. Alinear ambos: agregar `sku` al `SELECT` que ya hace
  `aplicarStockItemInterno` por `id_woo`.
- Test de fail-open de recepciones no ancla que `estado='confirmada'` quede escrito ANTES del
  push a ML (el invariante que motivó moverlo) — agregar el assert contra la DB.
- `docs/api-contrato.md` no documenta que `resultados[].sku` en `/api/woo/stock/aplicar` sale
  de `catalogo_cache` (puede ser `''`) en vez del valor crudo del cliente.
- Duplicación del componente visual (`.sync-ml-*`, `buildSyncMlHtml`/`renderSyncMl`) entre
  `public/stock/index.html` y `public/recepcion/index.html` — candidato a mover a
  `public/lib/` cuando haya un tercer consumidor (ver Bloque 5 de `plan-api-mobile-v1.md`: la
  app móvil va a necesitar el mismo estado de sync, es la oportunidad de extraerlo).
- 2 bugs de UX no relacionados, encontrados por `probador-e2e` probando A.2: input de
  proveedor en `public/recepcion/index.html:196` no reactiva los botones si se completa
  después de agregar ítems; tabla del modal de stock recortada en 390px.
