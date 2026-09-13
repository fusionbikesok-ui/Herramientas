# Arquitectura de sistemas UM1 — Identidad de productos

**Estado:** diseño ya implementado en lo sustancial; el estado medido por subentrega vive en
`2026-09-04-identidad-productos.md` (verificado el 2026-09-11). Este documento explica el porqué
de la arquitectura, no el avance.
**Fecha:** 2026-09-05.
**Alcance:** identidad Fusion, WooCommerce, MercadoLibre, catálogo, stock, ventas retenidas, web y App.
**Base observada:** `/opt/fusionbikes/herramientas`, rama `conteo-confiable`, commit `9ca06bf`.

Este documento separa arquitectura objetivo, comportamiento existente y brechas. No convierte una
función existente en evidencia de aceptación.

## 1. Vista de contexto

```text
Administración / Ventas / Operación
        │ web, App, alertas, decisiones
        ▼
Identidad de productos (Fusion)
        │                 │                    │
        ▼                 ▼                    ▼
 WooCommerce        MercadoLibre          Pedidos/stock
 catálogo + stock   publicaciones + ventas  preparación
        │                 │                    │
        └──── webhooks + lecturas autenticadas ┘

Persistencia local: casos, decisiones, operaciones, eventos, evidencia, auditoría y outbox.
Workers: ingesta durable, reconciliación puntual, scans completos, operaciones y alertas.
```

Reglas de autoridad:

- Producto Fusion es autoridad de identidad interna.
- Woo es autoridad del stock comercial.
- ML es autoridad de lo publicado y vendido en ML.
- Un webhook es una señal durable, no una observación suficiente.
- Una relación sólo converge después de releer el origen y verificar el resultado.

## 2. Contenedores y responsabilidades

| Contenedor | Responsabilidad | No debe hacer |
| --- | --- | --- |
| API de identidad | Autenticación, permisos, lectura y decisiones | Escribir directamente en ML o Woo desde una ruta HTTP |
| Ingesta de eventos | HMAC, deduplicación, persistencia y ACK rápido | Confiar en el payload como estado final |
| Reconciliador puntual | Releer un producto/ítem afectado y actualizar proyecciones | Auditar globalmente con datos parciales |
| Auditor completo | Scan Woo/ML, clasificación y salud | Crear efectos remotos |
| Operador de identidad | Ejecutar operaciones idempotentes, verificar y compensar | Reintentar errores no transitorios indefinidamente |
| Producto Fusion | Identidades, EAN/UPC/GTIN, reservas, archivo y transferencias | Ser un espejo mutable de Woo |
| Cola de ventas retenidas | Retener y reprocesar pedidos afectados por identidad | Liberar parcialmente un pedido mixto |
| Proyección web/App | Presentar evidencia, estados y acciones permitidas | Inferir éxito por un POST aceptado |
| Auditoría/observabilidad | Eventos inmutables, métricas, trazas y alertas | Reemplazar el estado operacional |

Implementación existente relacionada:

- API/rutas: `routes/identidadProductos.js`, `routes/woo.js`, `server.js`.
- Núcleo: `lib/identidadProductos.js`, `lib/identidadMl.js`, `lib/workerIntegrationJobs.js`.
- UI: `public/identidad-productos/index.html`.
- Persistencia: migraciones `082_identidad_productos.sql` a `085_identidad_sin_cero.sql`.
- Legacy todavía presente: `routes/matcher.js`, `routes/guardiaMl.js`, `routes/sync.js`.

## 3. Modelo de identidad y datos

```text
FusionProduct 1 ─── 0..1 WooIdentity
      │
      ├── 0..N MlIdentity (item_id|variation_id)
      ├── 0..N Identifier (EAN/UPC/GTIN tipado)
      ├── 0..N EvidenceSnapshot
      └── 0..N Decision / Exception / Operation
```

Invariantes:

- Una unidad vendible es un producto simple o variación Woo `publish|private`; un padre `variable` no es vendible.
- `fusion_sku` es `FB-{id_woo}` y no editable.
- Los valores activos son únicos globalmente. ~~Puede existir como máximo un EAN activo y un UPC activo por unidad~~ **superado el 2026-09-06 (PM-151)**: 22 productos tienen dos activos del mismo subtipo con códigos válidos. Una unidad admite N activos ordenados por prioridad.
- Se preservan tipo, valor crudo, fuente, vigencia y estado del identificador.
- UPC-A y EAN-13 con cero inicial comparten clave GTIN normalizada, sin perder sus representaciones originales. Implementado (PM-150): canónico GS1 de 14 dígitos en `valor_normalizado`, representación recibida en `valor_crudo` y `subtipo`.
- Woo proyecta el identificador principal a `global_unique_id`; Fusion conserva el resto. El principal es el primero de la lista de prioridad del producto, reordenable (PM-151), con desempate determinista por `(orden, id)`.
- Un código histórico no confirma una identidad activa y no se reutiliza.

## 4. Máquinas de estado

### Caso humano

```text
detectado → disponible → tomado(opcional) → operación_pendiente
     │             │                         ├→ verificado
     │             └→ intervención ◄─────────┘
     └→ archivado (publicación cerrada/eliminada)
```

Guardas:

- `pendiente` no vuelve a `urgente` sólo por esperar al worker.
- Cambio real de identidad durante una operación sin efectos remotos: operación obsoleta y nueva decisión.
- Cambio real con efectos parciales: intervención.
- `bloqueada_impacto` es acción humana y aparece en Pendientes y Operaciones.
- Reclamar es opcional; `expected_version` es obligatorio para mutar.

### Operación remota

```text
queued → reading_sources → writing_sku → verifying
                       ├→ completed
                       └→ intervention
```

- Se relee Woo al ejecutar para obtener stock fresco.
- Se sobrescribe directamente `SELLER_SKU` sin poner stock en cero.
- Fallo de escritura o verificación: intervención, sin fallback automático destructivo.
- Tres fallos o quince minutos sin progreso: intervención.
- `operation_id` hace la operación idempotente y cada paso queda auditado.

### Incidente de identidad Woo

```text
normal → webhook recibido → relectura confirma cambio → protegido
   ▲                                                   │
   └────── relectura válida + stock verificado ◄────────┘
```

Protegido significa: todas las claves ML vinculadas en stock cero, pedidos afectados retenidos y alerta crítica.

### Identificadores

```text
observado → validado → activo (ordenado por prioridad; el primero es el principal)
                  ├→ conflicto (mismo valor reclamado por otro producto)
                  ├→ incorrecto (tarea de catálogo)
                  └→ histórico/reservado
```

Un conflicto EAN/UPC/GTIN no se auto-resuelve: se alerta, permite decisión humana y marca el descartado como incorrecto.

## 5. Blueprint operativo: pérdida de identidad Woo

| Capa | Flujo |
| --- | --- |
| Evidencia física | Alerta persistente, caso visible, pedido retenido, historial de cambios |
| Acción de usuario | Revisa comparación, confirma impacto o corrige/vincula identidad |
| Frontstage | API muestra causa, claves ML afectadas, stock, ventas retenidas y próxima acción |
| Backstage | Webhook se deduplica; job relee Woo; clasifica; crea protección y operación; worker verifica ML |
| Soporte | Woo REST/webhook HMAC, ML Notifications/items API, SQLite, outbox, leases, métricas y push |

Puntos de fallo que deben ser visibles:

- webhook rechazado o deshabilitado por Woo;
- duplicado/fuera de orden;
- relectura Woo 404 o timeout;
- escritura ML aceptada pero respuesta perdida;
- operación bloqueada por hermanas;
- stock cambió mientras esperaba decisión;
- venta recibida antes de abrir el incidente.

## 6. Interfaces y contratos

Toda mutación de identidad lleva `operation_id`, `expected_version`, `evidence_fingerprint`, actor y motivo.

Los endpoints deben separar:

- `POST /webhooks/*`: validar, persistir y responder rápido;
- `GET /casos`, `/operaciones`, `/productos`: lecturas con frescura explícita;
- `POST /decisiones`: persistir decisión, nunca escribir remoto;
- `POST /operaciones/{id}/confirm-impacto`: sólo Administración;
- `POST /operaciones/{id}/retry`: sólo intervención autorizada;
- `POST /excepciones`: sólo Administración para `solo_ml`/exclusión;
- `/api/v1/identidad-productos`: mismo contrato de negocio para App.

Una respuesta `409` por versión/huella no debe ocultarse ni convertirse en reintento ciego.

## 7. Prácticas recomendadas adoptadas

- ACK temprano y relectura posterior para webhooks, conforme a la documentación oficial de notificaciones ML.
- HMAC y monitoreo de entregas Woo; Woo puede deshabilitar un webhook tras fallos consecutivos. [Webhooks WooCommerce](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks)
- Idempotencia, backoff con jitter, límite de reintentos y fail-fast para errores no transitorios. [AWS: retries seguros](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) y [AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_mitigate_interaction_failure_limit_retries.html)
- `SELLER_SKU` separado de `seller_custom_field`, según la documentación oficial de variaciones ML. [Variaciones MercadoLibre](https://developers.mercadolibre.com.ar/es_ar/atributos-y-variaciones/variaciones)
- Reconciliador completo obligatorio: los webhooks no son garantía de entrega ni orden.
- Métricas de edad, lag, divergencia, ventas retenidas, reintentos, intervención y salud por fuente.

## 8. Brechas actuales y orden recomendado

1. ~~**Alta:** el modelo local todavía concentra códigos en `gtin`; crear identificadores tipados y migración sin perder valores.~~ **En curso desde el 2026-09-06.** La tabla `identificadores_producto` ya existía (migración 082); lo que faltaba era que el valor guardado fuera comparable. Hecho: forma canónica GS1 y subtipo (PM-150, migración 088), orden de prioridad por producto (PM-151, migración 089) y siembra de los GTIN que sólo conocía ML —hasta ahora la tabla se llenaba **sólo desde Woo**: 740 filas `gtin` para 5141 productos, mientras los 5241 GTIN válidos de ML no participaban de la identidad. Pendiente: cablear la siembra a un punto de ejecución y exponer en la bandeja los **41 códigos en conflicto** (27 con stock activo, que es por donde se arranca).
2. ~~**Alta:** implementar la protección Woo→ML definida en PM-104.~~ **Implementada el 2026-09-06 (PM-154).** El webhook de producto ahora confirma la baja, abre caso `woo_ml` por clave afectada, retiene los pedidos que todavía no bajaron a Woo y encola una operación `proteccion_woo` que pone stock cero en ML y lo verifica. Reusa el ejecutor de la saga y por lo tanto sus frenos. **Pendiente de activación**: poner `canario_ml_key` y `lote_max=1` antes de desplegar.
3. ~~**Alta:** separar definitivamente contador humano de operaciones esperando worker en API y UI.~~ **Cerrada el 2026-09-06.** `conciliacionIdentidad.urgentes` incluía `pendiente`, así que el contador declaraba más trabajo humano del que la cola mostraba: un caso ya decidido, esperando al worker, seguía contando como si alguien tuviera que mirarlo. Ahora usa los mismos tres estados que lista la cola (`urgente`, `tomado`, `intervencion`) y `esperando_operacion` se informa aparte. El gate de conciliación suma las dos categorías: sacar una sin sumarla dejaría un agujero por el que el tablero anunciaría «conciliado» con casos sin resolver.
4. ~~**Media:** monitorear estado y logs de webhooks Woo, incluido el estado `disabled`.~~ **Cerrada el 2026-09-06.** `lib/wooWebhooks.js` relee el estado cada hora y guarda desde cuándo cambió, para distinguir «se cayó recién» de «lleva días caído». Al implementarlo se encontró que **`order.updated` ya estaba `disabled` en producción**, sin que nadie lo supiera. `paused` cuenta igual que `disabled`: en los dos casos los eventos no llegan. Reactivar es una decisión de operación y no se hace sola: si el webhook se cayó por entregas fallidas, reactivarlo sin arreglar la causa lo vuelve a caer.
5. ~~**Media:** completar reactivación/cierre ML y archivado de identidades.~~ **Cerrada el 2026-09-06.** `archivarIdentidadesMlHuerfanas` cierra las identidades cuya publicación ya no existe —contaban como cobertura y no se podían verificar nunca, porque no hay qué leer—. Sólo corre tras un scan completo: el criterio es «no está en el cache», así que con un refresco acotado archivaría identidades vivas. No borra, deja `archivado_en`, y la reactivación existente la recupera.
6. ~~**Media:** formalizar outbox, dead-letter y métricas de eventos perdidos.~~ **Cerrada el 2026-09-06.** `saludPipelineEventos` expone los tres números que dicen si algo se pierde: eventos que se ingirieron y nunca derivaron en trabajo —el que no tenía nadie mirando, porque no falla ni reintenta ni aparece en dead letters—, dead letters por tipo, y jobs que agotaron sus intentos sin quedar marcados como muertos. Medido: 0 eventos sin job, 42 dead letters (39 `message.project` por PM-137 y 3 `question.project`).
7. ~~**Baja:** retirar comentarios y nombres legacy que describen saga con stock cero o cron de cinco minutos cuando ya no sean el objetivo.~~ **Cerrada el 2026-09-06.** La pantalla de Operaciones anunciaba «stock cero → limpiar SKU → escribir SKU → restaurar stock», que dejó de ser el camino común: una corrección hacia un SKU válido se escribe de una sola vez, y el cero sólo cubre la ventana en que la publicación queda sin SKU. Ahora describe los dos caminos y muestra el tipo de cada operación. Las menciones a «cada 5 minutos» que quedan describen crons que siguen existiendo, así que no son legacy.

## 9. Skills aplicadas y próximas

Aplicadas en este diseño:

- `ux-strategy:service-blueprint`: blueprint de incidente Woo y ventas retenidas.
- `interaction-design:state-machine`: estados y guardas de caso, operación e identificadores.
- `ux-strategy:information-architecture`: separación Pendientes, Operaciones, Productos, Historial y Salud.
- `design-ops:handoff-spec`: contratos, estados, errores, permisos y brechas implementables.

Para la siguiente fase, sólo cuando corresponda:

- `interaction-design:error-handling-ux` para la experiencia de intervención y conflictos;
- `design-ops:design-review-process` para gates de revisión y aceptación;
- `design-systems:accessibility-audit` y `playwright` para el gate visual/interactivo;
- `security-best-practices` si se solicita una auditoría explícita de HMAC, permisos y secretos;
- `deep-research-work:deep-research` si se solicita un informe formal más amplio con matriz de fuentes.

## 10. Handoff

El próximo implementador debe leer este documento junto con la especificación UM1 y el registro PM. Debe verificar
qué brechas siguen abiertas contra el código y no implementar la sección 8 completa en un solo cambio. Cada entrega
debe actualizar estado, evidencia, handoff y decisiones en el mismo commit.
