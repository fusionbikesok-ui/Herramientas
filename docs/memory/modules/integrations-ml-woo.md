# Integraciones MercadoLibre y WooCommerce

## Fuente normativa

Las reglas de negocio que no se rompen están en la sección homónima de `CLAUDE.md`. Leela
completa cuando una tarea toque ventas, pedidos, publicaciones, catálogo, precios o sync
ML/Woo; no hace falta para tareas ajenas a esas integraciones.

## Mapa de contexto

- Precio de contado y pedidos creados desde ventas ML: `CLAUDE.md` y `lib/mlPrecios.js`.
- Contratos HTTP relacionados: `docs/api-contrato.md`.
- Diseño o intención histórica: buscar primero en `docs/superpowers/plans/` por el nombre
  concreto de la función, sin cargar todos los planes.

## Contratos vigentes de Entrega 1

- La reasignación manual de un vínculo ML→Woo exige el SKU observado por el cliente y
  responde conflicto si otra operación lo cambió antes de escribir.
- Un timeout durante el primer PUT de tracking a Woo es un resultado incierto: se persiste y
  la UI no afirma que el tracking o el mail fueron confirmados hasta reconciliar con Woo.
- `pack_id` es la identidad canónica del paquete ML para preparación; las filas anteriores se
  completan desde pedidos sincronizados, incluso si la preparación ya fue cerrada.

## Cuándo actualizar

ML distingue `elegible`, `no_elegible` e `inconcluso`: faltan `shipping.id` o
`logistic_type` son inconclusos/fail-open; solo logística externa explícita permite
invalidar/podar. El cron poda ausencias únicamente con listado confiable.

Solo con decisiones verificadas que cambien contratos, invariantes, fuentes de datos o rutas
canónicas de esta integración. No dupliques reglas normativas: enlazalas a su única fuente.

- **Auditoría de precios ML (2026-09-16):** `ml_publicaciones_cache` conserva también
  `category_id`, `listing_type_id` y `free_shipping`, obtenidos en el mismo multiget que refresca
  publicaciones. `lib/auditoriaPrecios.js` proyecta `ml_precio_auditoria` desde ese cache, el
  vínculo confirmado y `catalogo_cache.regular_price`; nunca relee `/items`. Comisión y envío se
  consultan sólo si `ml_precios_cache` no tiene una entrada vigente (7 días). Se dispara tras
  scans ML completos/acotados, refrescos y webhooks Woo, y por cron de respaldo cada 15 minutos;
  la huella evita recalcular filas sin cambios y un scan ML completo exitoso poda filas fuera de
  alcance. El botón manual usa la misma proyección local.

- Las confirmaciones puntuales no elegibles de Woo o ML conservan la fila de `pedidos_cache`
  como `no_elegible` para no romper preparaciones/auditoría, pero la excluyen de la cola y
  del inicio; ML requiere `paid`, `ready_to_ship` y logística local.

## Stock y preparación: decisiones programadas para E8–E22

- WooCommerce es la autoridad de stock disponible para venta. Fusion mantiene físico por ubicación,
  comprometido, no disponible y entrante, y no descuenta físicamente dos veces una venta.
- El físico sale al entregar al transportista. Cancelaciones, cambios y devoluciones deben
  reconciliarse con Woo antes de volver a publicar disponibilidad.
- La política exacta de publicación ML se define en E11. Mientras publicaciones independientes anuncien el stock completo no se promete cero sobreventa; una sobreventa real bloquea nuevas ventas en ambos canales y escala.
- Si Woo no responde, aumentos no se publican y los cambios pendientes quedan durables e idempotentes.
- UM1 inspecciona directamente cada publicación+variación activa: solo un vínculo exacto a SKU existente en Woo cubre la venta. La primera fase es lectura; no cambia ML/Woo. Los pedidos sin cobertura se retienen solo en Fusion y no cambian el estado ni las notas de Woo.
- Woo publica `product.created`, `product.updated` y `product.deleted` a
  `/api/woo/webhook/product`. La entrada valida HMAC, persiste/deduplica antes del ACK y el
  worker durable relee desde Woo el padre completo y sus variaciones. Una baja solo retira el
  cache local; el cron de catálogo cada cinco minutos y el scan ML confiable siguen siendo la
  reconciliación de respaldo. El webhook puntual nunca dispara una auditoría global de identidad
  con evidencia ML no confiable.
- Guardia expone `GET /api/guardia-ml/casos/:id/opciones`: publicación ML con imagen/detalle y candidatos Woo con SKU único, imagen y stock. La selección queda separada de la escritura; en modo lectura se puede comparar sin vincular.
- Un `seller_sku` externo divergente bloquea la sincronización hasta revisión. Los vínculos compartidos pueden publicar el stock completo en cada clave por decisión operativa, pero una sobreventa agregada abre incidente crítico y retiene excedentes; no se promete reserva atómica entre claves ML.
- UM1 es la única puerta de escritura para vínculos, `seller_sku` y pausas. Matcher, Cobertura y Sync legacy conservan consultas, pero sus mutaciones devuelven `410 Gone`; el cron legacy de push está retirado.
- Guardia compara publicación+variación con SKU Woo único y seller_sku remoto exacto. La cola ofrece resolver, investigar, corregir catálogo, auditar cobertura e historial; la selección humana nunca convierte una sugerencia aproximada en auto-confirmación.
- **Ventas retenidas (2026-09-13, plan `2026-09-13-guardia-ventas-retenidas.md`, decisiones de José):**
  - `liberarPedidoRetenido` (`lib/guardiaMl.js`) es la única implementación de liberar: la usan el
    endpoint manual y `liberarRetenidasResueltas`, que corre tras `procesarOperacionesGuardia` en la
    cron `*/5` y libera una venta sólo si **todas** sus claves (`clavesDePedidoRetenido`, desde
    `items_json`) están cubiertas (`esClaveCubierta` o `skuUnicoEnCatalogo` del seller_sku, la misma
    regla exportada que usa `syncMlToWc`) y ninguna `claveBloqueadaGuardia`. Una excepción **no**
    libera (sigue `bloquea_sync=1`). Liberar borra la reserva `wc_order_id=0` sin `retenido_en` y la
    procesada: la próxima importación crea el pedido Woo.
  - Retener abre el incidente `guardia_ml/venta_retenida/<ml_order_id>` (advertencia, sin email);
    liberar o cancelar lo resuelve. El worker de push (`lib/guardiaAvisos.js`) lo manda a admin o
    `matcher:write`, con un único recordatorio a los 120 min y título "Venta liberada" al resolverse;
    deep link `incidentes/{id}` (la App ya lo abre). El inicio muestra el chip
    `atencion.ventas_retenidas_guardia` → `/herramientas/guardia-ml/`.
- **Verificado por sonda autenticada de sólo lectura (2026-09-13):** `GET /orders/search` acepta
  `order.date_last_updated.from` y lo aplica (sin filtro 2.446, desde ayer 3, desde +30 días 0).
  `GET /shipments/{id}` responde 200 **sin** `x-format-new` y trae `last_updated`, aunque la
  documentación lo declara obligatorio desde 2025-10-12. `lib/mlClient.js` (`_request`) **no reenvía
  headers por llamada**: cualquier cliente que necesite `x-format-new` debe agregarlo explícitamente.
  WooCommerce REST v3 (trunk) expone `modified_after`/`modified_before`/`dates_are_gmt` y
  `per_page` ≤ 100. La documentación de developers.mercadolibre bloquea lecturas automatizadas (403):
  verificar con sondas de sólo lectura o código productivo. Matriz de E1: `docs/superpowers/specs/e1/matriz-barridos.md`.
- **Vigía de formato — revisar avisos (2026-09-14):** `POST /api/sync/cambios-formato/:id/revisar`
  cierra los avisos abiertos del mismo `item_id` **con el mismo `campo` y `valor_nuevo`** (el vigía
  abre uno por variación); un cambio de otro campo de la misma publicación sigue abierto. Con
  `reactivar:true`, si ML rechaza y la publicación está `paused/out_of_stock`, el aviso se cierra con
  `pendiente_stock:true` y la reactiva el reactivador cuando haya stock; otro rechazo responde **409**
  con el mensaje de ML. Nunca responder 502/503/504 en rutas que la UI lee como JSON: Cloudflare los
  reemplaza por una página HTML.
- **Bolsas de stock compartidas (verificado 2026-09-13):** el bucle de reactivaciones de FB-32234,
  FB-4746 y FB-10376 (jul–5 sep) era un `user_product` compartido entre productos Woo distintos
  (causa documentada en `UM1.1-cierre-sku-ml.md`). `conflictosDeBolsaCompartida` da 0 hoy; la
  reactivación de FB-32234 del 12-09 fue legítima (venta y reposición).
