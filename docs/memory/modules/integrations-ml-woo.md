# Integraciones MercadoLibre y WooCommerce

## Operación vigente POS y ARCA — regreso a la web, 2026-10-06

POS y Facturador ARCA vuelven a operar exclusivamente en fusionbikes.com.ar, por decisión del usuario. Herramientas ofrece accesos directos; los informes, directorio y etiquetas Andreani/corrector PDF permanecen en el VPS. Los enlaces antiguos ?fm_module=pos/facturador redirigen a la web. El gateway con FUSION_SALES_LOCATION=web bloquea las API antiguas de POS, facturación y envíos manuales del VPS; los enlaces PDF ya compartidos conservan su vigencia original.

Antes de habilitar la web se deshabilitó fusion_arca_vps_enabled y production_enabled en la copia privada y FUSION_POS_VPS_ENABLED en gateway.env; se conciliaron 173 comprobantes, 14 series, 225 ventas ML y 6 registros WhatsApp sin diferencias fiscales. La factura nueva 173/pedido 70706 ya estaba archivada en Woo. Numeración confirmada con ARCA: punto 15 A1/B15/NC_A0/NC_B1; punto16 A7/B135/NC_A0/NC_B0. Ningún pendiente ni CAE solicitado durante las pruebas. El autor del recibo 173 es 0 en la tienda por el contrato del archivo original.

En la web fusion_arca_vps_cutover queda vacío, respaldado junto con settings/ML en opciones fusion_return_web_20261006_*. La emisión manual del punto15 está habilitada y el usuario autorizó recuperar el automatismo ML del punto16. La automatización web por cambio de estado conserva su pausa. Certificados originales y conexión Meta for WooCommerce permanecen en la web. No se cambió Master Control ni precios.

Servicios privados VPS fusion-arca-egress/source y timer outbox detenidos y deshabilitados. El backup fiscal diario conserva el archivo y los borradores/operaciones anteriores. Respaldo del regreso: /opt/fusion-management-migration/backups/return-web-20261006T184545Z. No volver a habilitar VPS ni restaurar una base antigua después de nuevas emisiones web sin otro corte y conciliación. Historial anterior de migración que contradiga esta sección queda superado.

Verificación del regreso: 33 pruebas focalizadas de gateway, desvíos, bloqueo de API, POS, catálogo, transporte fiscal y entrega aprobadas en copia aislada sin credenciales productivas. UI real: WordPress WSFE y Padrón conectados; POS encuentra FB-70394 con stock1/contado ARS4.450.000 y ofrece 3/6/9/12/18/24 cuotas antes del cobro. Se retiró el producto de prueba, borrador web guardado vacío; no se creó un pedido ni se solicitó CAE de prueba. SQL confirmó ML enabled/automatic true, punto16, producción web true; tareas ML recientes completas. Informes VPS cargan 10.140 líneas y Andreani consulta el historial sincronizado. No se probó un envío real de correo/WhatsApp ni un cobro. Las 33 pruebas no constituyen la suite completa del proyecto.

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

- Desde el ajuste E1 del 2026-09-30, las notificaciones `ml.messages` se releen por ID con `GET /messages/{id}?tag=post_sale`; `/messages/unread` queda como barrido redundante cada seis horas. Los GET individuales de `ml.shipments` se hacen en serie, con 300 ms entre ellos y `x-format-new: true`. El gateway mantiene rutas y parámetros cerrados. Ver `docs/superpowers/evidence/e1/2026-09-30-E1-429-api-fix-deploy.md`; la calibración de cupos y la campaña PM-186 siguen sujetas a la medición Tarea 0.
- La reasignación manual de un vínculo ML→Woo exige el SKU observado por el cliente y
  responde conflicto si otra operación lo cambió antes de escribir.
- Un timeout durante el primer PUT de tracking a Woo es un resultado incierto: se persiste y
  la UI no afirma que el tracking o el mail fueron confirmados hasta reconciliar con Woo.
- `pack_id` es la identidad canónica del paquete ML para preparación; las filas anteriores se
  completan desde pedidos sincronizados, incluso si la preparación ya fue cerrada.

## Cuándo actualizar

- **Bloqueo por contradicción de título (2026-10-01):** `lib/contradiccionTitulo.js` compara
  transmisión, velocidades, color y talle entre `ml_publicaciones_cache` y `catalogo_cache`;
  auto-vínculos, vínculos manuales, la decisión legacy y subidas positivas de stock quedan
  bloqueados cuando ambos lados declaran atributos incompatibles. El stock cero sigue permitido
  para proteger de sobreventa y el sync cachea el resultado por clave dentro de cada corrida.
- **No sincronizar (2026-10-02):** `POST /api/matcher/vinculos/no-sincronizar` es la mutación UM1
  permitida para registrar una decisión humana `omitir`. La ruta delega en
  `marcarClaveNoSincroniza`, que escribe la decisión y la auditoría de identidad/`sync_log`; así
  no queda una escritura directa sin historial y los automatismos no pueden revivirla. La vista
  puede enviar `expected_sku` para obtener 409 `vista_vieja` si el vínculo cambió mientras estaba
  abierta.

ML distingue `elegible`, `no_elegible` e `inconcluso`: faltan `shipping.id` o
`logistic_type` son inconclusos/fail-open; solo logística externa explícita permite
invalidar/podar. El cron poda ausencias únicamente con listado confiable.

En shipments, el tipo de logística se lee mediante `tipoLogisticaMl` (formato viejo y nuevo),
ubicado en `lib/mlUtil.js` y reexportado por `lib/preparacion.js` por compatibilidad. Para
logística local, el SLA operativo puede venir de `GET /shipments/{id}/sla` (con
`x-format-new: true`); si esa consulta falla se conserva el fallback de campos históricos.

En el formato nuevo de shipments, la dirección está en `destination.shipping_address` y el
receptor en `destination.receiver_name`; el formato viejo conserva `receiver_address` en la raíz.
`resolverSlaShipment` solo consulta SLA para `cross_docking`, `drop_off` y `xd_drop_off`, cachea
únicamente el objeto `sla` por 15 minutos (fallos por 30 segundos), y mezcla ese dato con el
shipment fresco. El cron respeta 300 ms entre GETs individuales de ML; `/iniciar` manual no
consulta SLA porque no usa ese resultado.

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
- El listado `GET /api/precios` devuelve el universo completo del estado solicitado: los filtros
  de marca/categoría son locales y no pueden operar sobre un corte previo de 1.000 filas (ese corte
  mostraba sólo 6 de las 21 publicaciones Pirelli auditadas).

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
- **Búsqueda manual rica de identidad (2026-09-26):** `GET /internal/v1/identidad/variantes` acepta
  `caso_id` opcional; cuando pertenece a la misma empresa agrega `explicacion` contra la publicación ML
  resuelta del caso, usando la misma proyección de atributos del detalle. Sin `caso_id` conserva el contrato
  anterior; UUID inválido responde 400 y un caso ajeno 404.
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
- **Revisión matcher-vínculos (2026-10-02):** `contradiccionTitulo` sólo evalúa transmisión/velocidades
  con rangos y contexto de bicicleta/transmisión, y talle/color/rodado con contexto de producto;
  los talles numéricos no se convierten en rodado. `no-sincronizar` exige `expected_sku` (SKU actual
  o `null` explícito), cancela operaciones durables pendientes y persiste `override_omitir` en las
  sagas de Guardia/Identidad. La saga revalida contradicción antes de restaurar stock o activar una
  identidad; en conflicto deja el caso abierto y registra historial.

## Una sola protección: Identidad (Fase C, 2026-10-07)

Spec `docs/superpowers/specs/2026-10-07-fase-c-una-proteccion.md`. Variable `IDENTIDAD_PROTECCION` = `apagado` | `sombra` (default; valor inválido = sombra) | `activo`. En `sombra`/`apagado` todo se comporta como antes; el código nuevo vive en `lib/proteccionIdentidad.js`.

- **R1** `omitir` (links de pago) queda fuera de todo; la migración 120 cierra los casos `sin_cobertura` de Guardia de esas claves (evento `cerrado_omitida_link_pago`).
- **R2** el SKU manda: publicación vinculada con caso abierto → stock 0 (sin pausar ni tocar precio) solo si el caso está en `intervencion` o hay contradicción (`gtin_contradictorio`/`contradiccion_titulo`) con `seller_sku` ausente o distinto del vinculado. Con SKU igual la severidad baja a `normal` y el sync sigue. `computedStockCte()` en `routes/sync.js` elige la CTE por modo.
- **R3** autovínculo por SKU exacto y único (`autoVincularPorSellerSku`); el GTIN no veta.
- **R4** publicación activa sin decisión con caso abierto `sku_ausente`/`sku_vacio`/`sku_inexistente`/`sku_no_unico`/`contradiccion_titulo` → stock 0 en activo (no hay clase `sin_vinculo` nueva). `stock_no_verificado` no frena.
- **R5** retención de ventas ML: cobertura = decisión asignar/confirmar y sin freno R2; `omitir` nunca retiene (`claveCubiertaParaVenta`, `claveFrenadaParaVenta`, `esOmitir` en `lib/guardiaMl.js`).
- `claveBloqueadaGuardia` y la guarda de escritura de `lib/matcherPush.js` NO se tocan: delegarlas en Identidad bloquearía la saga de Identidad.
- **Guardia en activo:** no corren el escaneo ni el worker de operaciones (sí la liberación de ventas retenidas), las escrituras de `/api/guardia-ml` responden 409 y la página muestra el aviso. Tablas en solo lectura 30 días.
- **Reporte de sombra:** `GET /api/sync/fase-c/sombra` (admin, solo lectura): stock hoy vs activo por clave, regla, autovínculos simulados y R4 por clasificación.
- **Frenos R4 (revisión PR #12):** los frenos van primero en la cola del sync (el tope de llamadas no los deja sin ejecutar); R4 no aplica con catálogo vacío ni con audit no confiable (>6 h); si hay más de `R4_MAX_POR_CORRIDA` (20) claves no se aplica ninguna y se abre incidente crítico `mercadolibre/fase_c_r4`. Se reenvía el 0 si el cache de ML es más nuevo que nuestro último 0.
- **Antes de pasar a `activo`, José revisa `a_cero_por_r4.total` del reporte de sombra** (si supera el tope, R4 no se aplicaría).
- **Despliegue:** backup, migración 120 con `sombra`, leer el reporte, OK de José, `activo` + `pm2 restart`. Vuelta atrás: `sombra` + restart.

## Pausas con sentido (Fase A, 2026-10-05)

- **Vigía de formato** (`lib/vigiaPausado.js`): sólo pausa cambios reales. **Vacío → producto no pausa**: casi siempre es ML asignando catálogo; queda como aviso abierto (`aviso_catalogo`, `solo_aviso=1`) para que una persona lo mire y **no bloquea al reactivador**. Tampoco pausan `desaparece`, `oscila`, `alta_reciente` ni `migracion` (migración de ML). El texto informativo de un aviso sin pausa va en `ml_publicacion_cambios.nota`; `pausada=1` sólo si el vigía pausó de verdad.
- **Vigía de formato, incidente y ruido (2026-10-07, decisión de José)**: `oscila` = valor ya visto en los últimos **30 días** (antes 7; MLA820556361 volvió a MLA46017608 a los 12). El incidente `vigia_formato` (crítico) sólo se abre o actualiza si el vigía **pausó** (`pausadas>0`), **falló** al pausar (`errores>0`) o **frenó por el tope** (corrida o 24 h). Sin stock, ya pausadas, migraciones y avisos se asientan en `ml_publicacion_cambios` para revisar y no tocan incidentes (antes un cambio en una publicación ya pausada con 0 unidades mantuvo «Crítico ×236» abierto desde el 12/09: incidente 29). El mensaje va agrupado por publicación+campo+par de valores («MLA… (6 variaciones): campo pasó de X a Y») y el encabezado cuenta las publicaciones reales, incluidas las sin stock.
- **Tope**: `UMBRAL_PAUSA_MASIVA` (5) por corrida y también en una ventana de 24 h; si se supera, el vigía no pausa más y deja avisos.
- **`ml_pausas_log`** (migración 119) registra quién y desde dónde pausó cada publicación (`actor`, `origen`, fecha): permite decir «pausada por Fernando desde Cobertura hace 3 días».
- **Pausadas con stock** (`lib/pausadasConStock.js`, `GET /api/sync/pausadas-con-stock`): lista las publicaciones pausadas en ML con stock en Woo, agrupadas por causa (`vigia`, `solo_local`, `sin_vinculo`, `pausa_app`, `paused_by_seller`, `pausa_vieja`, `out_of_stock`, `otra`). Cada una trae `reactivable` y `motivo_no_reactivable` (`solo_local`, `sin_vinculo`, `aviso_abierto`, `sin_stock_disponible`), stock Woo/ML (`stock_ml` es `null` si ML no informó, nunca 0 inventado), precio de contado por variación y `en_juego` (plata); el orden lo define el servidor.
- **Reactivación siempre manual** (`POST /api/sync/pausadas-con-stock/reactivar`, máx. 50 por pedido, un pedido a la vez → 409 si ya hay uno en curso): sólo reactiva lo que la lista marca `reactivable`; se apoya en `reactivarItems(..., {manual:true, incluirPausasManuales:true})`, que sigue siendo fail-closed ante el precio. Una pausa del vendedor o de la app jamás se despausa sola.
- **`solo_local` visible**: los SKUs con `modo='solo_local'` (stock forzado a 0 por Config ML) se muestran en la vista Pausadas como grupo bloqueado con link a Config ML, y su conteo viaja en `GET /api/sync/dashboard` (`solo_local: {skus, publicaciones}`).
- Permiso: la vista y sus endpoints cuelgan de `sync-ml` (no hay herramienta nueva).

- 2026-10-06: «Calcular precio y reactivar» (Sync ML > Pausadas con stock) reusa `POST /api/precios/objetivo` (≤100 claves, calcula el precio ML que iguala el neto al precio de contado), `POST /api/precios/actualizar-precio-item` (precio único para todas las variaciones; ya borra `ml_reactivacion_frenada` y refresca el caché) y la reactivación existente `POST /api/sync/pausadas-con-stock/reactivar` (sigue pasando por el control de neto, no se toca). Las claves a calcular salen de `bloqueos[].clave` del resultado de la reactivación frenada por neto.
## Puente de lectura WordPress (2026-10-04)

- Master Control queda expresamente fuera de la migración: conservar su código,
  configuración, administración y lógica de precios en la tienda. POS y Taller
  deben consumir ese motor; no publicar reglas nuevas ni reemplazarlo.
- Plugin `fusion-herramientas-bridge` activo en WordPress (actualizado a 0.2.0, ver abajo). Fuente:
  `integrations/wordpress/fusion-herramientas-bridge/`. Dos GET autenticados bajo
  `/wc/v3/fusion-herramientas`: `status` y `commercial-products?ids=...` (máximo 25).
- Reutiliza autenticación Woo, HTTPS y `manage_woocommerce`; no crea credenciales,
  tablas, cron ni escrituras comerciales. Usa DataService/PricingEngine originales.
- No usar los precios REST estándar como base del POS: Master Control transforma
  esa representación con `forceApiPrices`. La lectura comercial tiene contrato propio.
- El snapshot cubre contado y financiación de una unidad; excluye carrito, cupón,
  envío, impuestos, USD y reserva de stock. Revalidar la operación en checkout;
  no multiplicar unidades ya redondeadas para cotizar varias cantidades.
- POS, Chat, Taller y Facturador aún no fueron migrados. El puente solo es preparación;
  no se ha medido reducción de carga. El checkout permanece en WooCommerce.

## Copia de consulta de módulos en VPS (2026-10-04)

- Puente de lectura actualizado a 0.2.0; agrega inventario/exportación por recursos permitidos y páginas de 50 filas con permiso adicional de administrador. No exporta claves fiscales, contraseñas ni sales. Código y 61 comprobaciones en `integrations/wordpress/`.
- POS, ARCA y Taller conservan sus paquetes originales en un WordPress/Woo privado del VPS. Consulta autenticada en `/herramientas/gestion-vps/`; historial importado y conciliado, con escrituras/emisión/envíos bloqueados. Detalle y límites en `integrations/management-migration/README.md` y memoria `operations-vps.md`.
- El catálogo, clientes, pedidos, precios/dólares, checkout e identidades no están conectados todavía. Cinco borradores POS se conservan sin asignar; no equiparar usuarios locales con IDs WordPress. Credenciales fiscales y OAuth/WhatsApp pendientes de transferencia segura.
- Master Control y checkout siguen íntegros en la tienda. Originales activos como autoridad; no duplicar escritores, stock ni emisor ARCA al completar el corte. Esta copia no acredita migración operativa ni ahorro medido de carga.


- Gestión VPS consulta `catalogo_cache` por `/api/woo/catalogo` y el contado por el lector local existente `/api/consulta-precios/buscar`, con identidad de producto validada, caché RAM 5 s y sesión/admin en cada solicitud. No usa listas ML ni consulta Woo por búsqueda. `precio` REST es proyectado: para FB-70394 era 6.675.000 (18 cuotas), mientras contado era 4.450.000, comprobado contra web y puente Master Control el 2026-10-04. Se reutiliza el criterio de Consulta de Precios (oferta vigente incluida), sin copiar coeficientes. Si no hay precio local válido se muestra faltante; no fallback a precio REST ni vencido. Sigue pendiente la paridad comercial completa del POS antes de cobrar. Imágenes HTTPS del catálogo, con fallback a padre; solicitudes estáticas, sin API Woo. Archivo ML visible en modo consulta, acotado a entorno/CUIT y único seller importado; OAuth y sincronización activa aún pendientes.

- Índice reconstruible `directory-cache/directory.sqlite` en el runtime privado de migración: clientes Woo con rol customer y pedidos Woo, JSON con lista explícita de campos, sin contraseñas/roles/credenciales ni metadatos arbitrarios. Invitados vinculados por pedido, nunca por nombre. Una copia Woo de ML queda marcada con `_ml_order_id`; no sumar como segunda venta. Consentimiento comercial desconocido. Las consultas no llaman a Woo. POS/Taller comparten GET clientes; ARCA accede al directorio. Esto no sustituye los escritores originales, los leads del chat ni la captura de carritos. Panel de ventas requiere detalle de devoluciones por ítem y taxonomías para equivalencia completa.

- Directorio: carga histórica y actualización incremental verificadas el 2026-10-05. La carga inicial concilió 1.593 cuentas customer y 13.888 pedidos desde 2023-03-09; el primer delta incorporó dos pedidos (13.890), con dos GET. 434 pedidos tienen marca de copia ML. UI probada: clientes POS, búsquedas por SKU y pedido exacto (#6115), detalle histórico y compras por ID de cliente. No hay mapeo de escritura ni selector fiscal ARCA; directorio compartido de consulta. No interpretar las fichas por pedido sin cuenta sincronizada como clientes únicos. El importador legado que acumula contactos repetidos no se modificó ni alimenta este índice.

- 2026-10-05: Panel de ventas 1.1.0 trasladado a `/herramientas/gestion-vps/ventas/`, bajo sesión/admin vigente y acceso desde Gestión/Directorio. Consultas, filtros, gráficos y CSV calculados sólo en caché VPS `metrics.sqlite`; usa pedidos del directorio (dp=8 explícito y checkpoint versionado), catálogo analítico diario y devoluciones por ítem del puente 0.3.0. Dos timers de 15 min; desfase combinado hasta aproximadamente 30 min, fecha real y alertas visibles. Paridad exacta de 452 líneas de septiembre 2026 (295 pedidos, 497 unidades, ARS 346.975.881) y 23 líneas de marzo 2023 (22 pedidos, 33 unidades, ARS 1.441.599,80), incluidos productos eliminados/reembolsos sin asignar. CSV descargado idéntico byte a byte al origen. 22 pruebas Node, 10 Python, 87 aserciones PHP. Snapshot/generación evita páginas o CSV mezclados; no se exponen contactos en analítica. Respaldo inicial metrics-20261005T154728Z, final metrics-20261005T160049Z; importador precision-20261005T155348Z. Sólo se reinició gateway; Master Control, precios/checkout/emisores originales intactos. POS/ARCA/Taller siguen consulta y Chat productivo pendiente. Usuario agregó migrar generador Andreani funcional: auditoría del plugin 1.1.2 iniciada, aún no publicado en esta etapa.

- 2026-10-05: Generador Andreani 1.1.2 migrado funcional a `/herramientas/gestion-vps/andreani/` y enlazado en Gestión. Lee pedidos/dimensiones locales (directorio shipping_fields_version=1, puente 0.3.1 sólo agrega virtual), guarda revisión versionada y exportación en SQLite privada del gateway; worker PHP interno reutiliza reglas y XLSX originales. Filtro inicial Todos, DNI/teléfono/domicilio y bultos revisables, domicilios/sucursales/Llega hoy, perfiles bicicleta categoría 62 editables. Sesión/admin actual + Origin + CSRF ligado a connect.sid; otras mutaciones continúan 423. 31 pruebas Node con roundtrip real aislado y 22 aserciones PHP; partes no editadas de plantilla idénticas, prueba real de consulta sin guardar/exportar pedidos reales. Descarga privada por autor 24 h, marcas permanentes. Estado nuevo en /var/lib/fusion-management-validation/andreani.sqlite (0700/umask0077), incluir en backups; código reconstruible en integrations/management-migration/andreani. No devuelve nuevas marcas a Woo: usar Herramientas para nuevas preparaciones, no operar el mismo pedido desde ambos generadores. No contratación/pagos ni envío de datos a Andreani; subir Excel en su portal. Backups inicial andreani-publish-20261005T165614Z y corrección andreani-publish-20261005T170119Z; sólo gateway reiniciado, Master Control intacto. Panel de ventas funcional; POS/ARCA/Taller aún consulta y Chat pendiente.

- 2026-10-05: Andreani Observaciones ahora agrega automáticamente el título histórico del primer producto a enviar (primera línea con cantidad positiva y no virtual), conservando aclaraciones de entrega y sin duplicarlo al reabrir o guardar. Regla aplicada en lectura de borradores nuevos/existentes, normalización y nuevas exportaciones. No reescribe archivos ya generados ni modifica la tienda. 27 aserciones PHP y validación del XML de Observaciones en las hojas domicilio/Llega hoy; plantilla de sucursal conserva su esquema original sin columna de observaciones.

- 2026-10-05: Corregida selección de bultos Andreani: borradores importados/locales con un único perfil predefinido conservaban other aunque el producto padre pertenecía a bicicletas. Perfil automático ahora se recalcula al abrir, guardar y exportar; no invalida por sí solo una revisión de destinatario existente. UI agrega Automático según los productos y conserva elecciones explícitas con profile_mode=fixed; medidas personalizadas, cajas guardadas y elecciones heredadas de varios bultos se respetan. Nuevos bultos automáticos llevan profile_mode=auto. Reglas configuradas: bicicletas 30×20×40 cm/9000 g; resto 12×25×30 cm/1000 g. 39 aserciones PHP, incluido Excel de borrador legado mal clasificado y casos manual/caja/múltiples. Tanda de 16 del 2026-10-05 15:03 ART: 11 bicicletas tenían perfil chico; se creó copia privada corregida modificando únicamente B–E (peso/medidas), sin cambiar destinatarios, referencias, observaciones, estados ni marcas originales. No se contrató/envió nada a Andreani. Archivo privado descargable 24 h para su autor, reporte en runtime andreani-package-correction.json.

- 2026-10-05: Por cambio solicitado, Andreani Observaciones ahora usa Pedido #<número visible Woo> en lugar del título. Aplicado permanentemente en la aplicación VPS al abrir borradores nuevos/existentes, guardar y generar nuevos Excel. Retira el antiguo título automático sólo como segmento completo, preserva aclaraciones de entrega y no duplica el número; menciones de productos dentro de frases manuales se conservan. 42 aserciones PHP y verificación XML de Observaciones; clasificación automática de bultos y medidas manuales conservadas. Archivos ya generados permanecen históricos; plantilla de sucursal sigue sin columna de observaciones. Fuentes en integrations/management-migration/andreani/worker.php.

## ARCA manual en VPS — 2026-10-05

El VPS es el emisor manual del punto 15 y la tienda quedó bloqueada fiscalmente. Catálogo/precio contado/miniaturas locales; cada carga/emisión de pedido revalida Woo y materializa copia nativa privada sin hooks comerciales. CAE nuevo se archiva en origen y marca sólo metadatos fiscales/series, con outbox durable, ACK y backoff. No cambia precios, stock, checkout ni Master Control. Se preservaron 172 comprobantes y 225 registros ML; ML es todavía archivo de consulta, su conexión fiscal y emisión no están migradas. OAuth independiente del facturador: no compartir refresh token de la app principal. Referencia: integrations/management-migration/arca/README-ARCA.md.

- 2026-10-06: POS VPS activado con puente seguro 0.2.0 en tienda. Catálogo/directorio locales y borrador SQLite por operador; checkout, precio final y pedido en origen, Master Control intacto. HMAC de cuerpo/tiempo, CSRF y operación idempotente; no liberar pedidos existentes. Recorrido FB-70394 ARS 4.450.000 comprobado hasta checkout, luego preparación liberada/tablero limpio; ningún pedido/pago/factura de prueba. 20 pruebas Node y controles PHP aprobados. ARCA continúa en producción punto15; restauradas sus rutas antes de activar POS. Presupuestos nuevos, conversión y cobros manuales siguen pendientes de traslado. Fuente y límites: integrations/management-migration/README-POS.md. Backup de activación pos-active-20261006T104541Z.

- 2026-10-06: POS VPS 0.3.0 restaura comparación previa de cuotas, checkout completo con plan seleccionado y cobro manual/entrega delegados al POS original antes del facturador ARCA integrado. Master Control intacto; búsquedas locales, cotización HMAC por canasta con caché 60s y revalidación al preparar. Recuperación de pedidos vinculada a actor. Renovación CSRF autenticada y reintento solo si pos_csrf. Ver integrations/management-migration/README-POS.md para contratos, validación y límites.
