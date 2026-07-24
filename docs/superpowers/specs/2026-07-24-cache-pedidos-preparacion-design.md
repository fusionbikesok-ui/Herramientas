# Caché local de pedidos para Preparación de Pedidos — diseño

**Fecha:** 2026-07-24
**Estado:** aprobado, pendiente de plan de implementación
**Alcance:** primer ítem de una lista de 8 mejoras a Preparación de Pedidos, decompuesta
en ciclos independientes de spec→plan→implementación (ver `docs/superpowers/specs/` para
los siguientes, que se abordan uno por uno en orden: concurrencia, auditoría por paso,
corrección de tracking, escritura transaccional a Woo, heurística de perfiles).

## Contexto y problema

Hoy, en `routes/preparacion.js`:
- `GET /pendientes` (líneas 163-186) hace **llamadas en vivo** a WooCommerce (pedidos en
  estado `lpaandreani`) y a MercadoLibre — y para cada orden ML candidata hace un `GET
  /shipments/{id}` adicional (`pendientesMl`, línea 693) — sin batching. Esto es lo que
  hace lenta la pantalla al abrirla.
- `GET /historial` (líneas 363-373) solo lista filas de la tabla local `preparaciones` en
  estado `completada`/`pendiente_deposito` — es decir, **solo lo que se procesó
  manualmente en esta app**. Un pedido despachado por Andreani directamente (ej. cargado
  el tracking sin pasar por el flujo de escaneo/fotos) o un pedido ML ya enviado nunca
  tocado en la app no aparece.
- No existe hoy ninguna tabla de caché ni sync pasivo para pedidos (sí existen para
  catálogo — `catalogo_cache` — y vínculos ML↔Woo — `ordenes_ml_wc_pedidos`).

## Decisiones (confirmadas con el usuario)

1. **Sync periódico, no en vivo por request.** Pedidos **pendientes** (los que el
   depósito opera activamente) sincronizan cada 5 minutos; pedidos **ya enviados**
   (Andreani/ML) sincronizan cada 30 minutos — no cambian de estado con la misma
   urgencia y así se reduce la carga de requests a Woo/ML.
2. **Ventana de tiempo:** últimos 30-60 días para pedidos enviados — no se sincroniza
   historial completo desde siempre.
3. **Fail-open con aviso:** si un sync falla (Woo/ML no responden), la pantalla sigue
   mostrando el último dato bueno con un aviso "actualizado hace X min, no se pudo
   refrescar" — no bloquea el trabajo del depósito por una falla momentánea de red.
   Coherente con el comportamiento ya existente de `pendientesMl` (tolerante a fallas de
   ML, ver línea 173-180 actual).
4. **Pedidos ya enviados sin preparar en la app:** aparecen en Historial como
   informativos, con una acción para completarlos retroactivamente (cargar fotos, etc.)
   si hiciera falta — reusa el flujo existente `POST /iniciar` → `crearPreparacion()`
   (ya idempotente por clave), sin cambios a ese endpoint.
5. **Ambos tabs migran a la caché**, no solo Historial — así se resuelve también la queja
   de velocidad en Pendientes.

## Diseño técnico

### Tabla nueva `pedidos_cache`

Sigue el patrón de `catalogo_cache`/`ordenes_ml_wc_pedidos` (`db/schema.sql`): schema base
simple, columnas nuevas futuras vía `ALTER TABLE ... ADD COLUMN` idempotente en
`db/index.js` si hiciera falta más adelante.

```sql
CREATE TABLE IF NOT EXISTS pedidos_cache (
  clave           TEXT PRIMARY KEY,   -- 'web:<wc_order_id>' | 'ml:<ml_order_id>'
  canal           TEXT NOT NULL,      -- 'web' | 'ml'
  wc_order_id     INTEGER,
  ml_order_id     TEXT,
  numero_pedido   TEXT,
  comprador       TEXT,
  fecha           TEXT,
  estado_envio    TEXT NOT NULL,      -- 'pendiente' | 'enviado'
  estado_wc       TEXT,
  logistic_type   TEXT,
  substatus       TEXT,
  items_json      TEXT NOT NULL,      -- snapshot de items, mismo shape que ya arman
                                       -- armarPendienteWeb/itemsDesdeOrdenMl hoy
  actualizado_en  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pedidos_cache_estado ON pedidos_cache(estado_envio);
```

### Dos funciones de sync, siguiendo el patrón de `routes/sync.js`

- `syncPedidosPendientes(db, cfg)` — reusa la lógica ya existente de `armarPendienteWeb`
  (pedidos WC en `lpaandreani`) y `pendientesMl` (ML `paid`+`ready_to_ship`+local), pero en
  vez de devolver la respuesta HTTP, hace upsert en `pedidos_cache` con
  `estado_envio='pendiente'`. Registra resultado en `sync_log` (`direccion:
  'pedidos_pendientes'`) para el patrón "actualizado hace X" (`MAX(creado_en) WHERE
  estado='ok'`, ya usado en `routes/sync.js:938-940`).
- `syncPedidosEnviados(db, cfg)` — trae pedidos WC en estado `completed`/`enviadoandreani`
  y órdenes ML con envío `shipped`, ambos acotados a `fecha >= hoy - 60 días`, upsert con
  `estado_envio='enviado'`. Registra en `sync_log` (`direccion: 'pedidos_enviados'`).
- Ambas usan un candado en memoria (booleans module-level, patrón ya usado en
  `routes/sync.js:316-323`) para evitar solapamiento entre el cron y un disparo manual.
- Se registran en `server.js` junto a los cron existentes:
  `cron.schedule('*/5 * * * *', ...)` para pendientes,
  `cron.schedule('*/30 * * * *', ...)` para enviados — mismo patrón exacto que
  `server.js:156-179`, con `.catch(err => console.error(...))`.

### Endpoints que cambian de fuente

- `GET /pendientes`: deja de llamar Woo/ML en el momento del request — hace
  `SELECT * FROM pedidos_cache WHERE estado_envio='pendiente'`, enriquece con
  `estado_preparacion`/`preparacion_id` desde `preparaciones` (igual que hoy), y agrega
  `actualizado_hace`/`sync_error` derivado de `sync_log` para el aviso fail-open.
- `GET /historial`: además de las filas de `preparaciones` (comportamiento actual sin
  cambios), agrega — vía `LEFT JOIN`/segunda query — las filas de `pedidos_cache WHERE
  estado_envio='enviado'` que **no** tengan preparación asociada (`clave` no existe en
  `preparaciones`), marcadas con `preparacion_id: null` para que el frontend ofrezca
  "Completar ahora" en vez de "Ver detalle".
- Nuevo endpoint opcional de estado: `GET /pedidos-cache/estado` — devuelve última corrida
  exitosa de cada sync (para el aviso de "actualizado hace X" en ambos tabs), reusando el
  mismo patrón de `routes/sync.js:938-940`.

### Frontend (`public/preparacion/index.html`)

- Los tabs Pendientes e Historial ya no necesitan mostrar "Consultando WooCommerce y
  MercadoLibre…" (era honesto porque hoy es en vivo) — pasa a ser carga instantánea desde
  sqlite. Se agrega un indicador chico de "actualizado hace X min" con aviso visible si el
  último sync falló (mismo patrón que se usó para el panel de atención del home: mensaje
  de error explícito, no un catch silencioso).
- Las filas de Historial que vienen de `pedidos_cache` sin preparación asociada muestran
  un botón "Completar ahora" que dispara el `POST /iniciar` ya existente con
  `{canal, id}` derivados de la fila — sin cambios al endpoint `/iniciar` en sí.

## Fuera de alcance de este ciclo

- Concurrencia entre operarios, auditoría por paso, corrección de tracking erróneo,
  escritura transaccional a Woo, heurística de `kit_transmision`: son los siguientes 5
  ciclos de la lista, cada uno con su propio spec cuando llegue su turno.
- No se modifica `POST /iniciar` — sigue haciendo fetch en vivo del pedido puntual cuando
  el usuario decide iniciar/completar una preparación (acción explícita, poco frecuente,
  no es el cuello de botella que se está resolviendo).
- No se agrega batching al `GET /shipments/{id}` de ML dentro de `pendientesMl` — al pasar
  a sync periódico (cada 5 min) en vez de por-request, el costo de N requests ya no lo
  paga el usuario esperando en la pantalla, así que no hace falta optimizar ese loop en
  este ciclo.

## Siguiente paso

Invocar `superpowers:writing-plans` para el plan de implementación: crear la tabla
`pedidos_cache`, las dos funciones de sync + su registro en `server.js`, adaptar
`/pendientes` y `/historial`, agregar el endpoint de estado, y ajustar el frontend de
Preparación de Pedidos para leer de la caché y mostrar el aviso de frescura.
