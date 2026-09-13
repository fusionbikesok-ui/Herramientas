# Plan: Guardia ML — ventas retenidas que se liberan solas y avisan

**Fecha:** 2026-09-13 · **Estado:** decisiones confirmadas por José 2026-09-13 · **Alcance:** Guardia ML.

## Problema medido

- Retener una venta abre un caso urgente atado al pedido (`retenerPedidoMl`, `lib/guardiaMl.js:134`).
- Liberarla a mano cierra el caso (`POST /pedidos-retenidos/:orderId/liberar`), pero **resolver el caso
  no libera la venta**: queda retenida hasta que alguien entra a Guardia a liberarla. Un caso se
  resuelve desde cinco lugares (escaneo, worker de operaciones, excepción que vence, fuera de universo,
  cancelación), ninguno toca la venta.
- Nadie se entera de que se retuvo una venta: no hay chip en el inicio ni push. La Camelbak del
  2026-09-11 quedó retenida sin que nadie la viera.

## Decisiones (José, 2026-09-13)

| Tema | Decisión |
|---|---|
| Al resolverse el bloqueo | **Se libera sola** si no queda ningún otro bloqueo en esa venta; el próximo ciclo (≤10 min) crea el pedido en Woo |
| Aviso al retener | **Chip en "Requiere tu atención"** del inicio y **push en la app** a quienes pueden liberar |
| Recordatorio | **Uno solo, a las 2 horas** si sigue retenida |

Decisión técnica derivada: una **excepción no libera**. Un caso en `excepcion` sigue con
`bloquea_sync=1` y vuelve a abrirse al final del día; sin producto vinculado no se puede crear el
pedido Woo. La venta se libera sólo cuando **todas** sus publicaciones quedan cubiertas.

## Diseño

### 1. Liberación automática — `lib/guardiaMl.js`

- `liberarPedidoRetenido(db, orderId, { actor, motivo })`: mueve la lógica del endpoint manual
  (marcar liberado, borrar la reserva `wc_order_id=0` sin `retenido_en`, borrar
  `ordenes_ml_procesadas` si no hay pedido Woo, registrar `pedido_liberado` en el caso). El endpoint
  pasa a llamarla: un único camino, mismos efectos.
- `clavesDePedidoRetenido(fila)`: claves `item_id|variation_id` desde `items_json` (mismo formato que
  `normalizarOrdenMl`).
- `liberarRetenidasResueltas(db)`: para cada venta `retenido`, si **cada** clave cumple
  `esClaveCubierta(db, clave)` (o el `seller_sku` de la venta resuelve a exactamente un SKU del catálogo,
  la misma regla con la que `syncMlToWc` decide retener) **y** `!claveBloqueadaGuardia(db, clave)`,
  la libera con actor `sistema` y motivo `bloqueo resuelto: <claves>`. Fail-open por venta.
- Se ejecuta en la tarea de Guardia que ya corre cada 5 minutos (`server.js`, a continuación de
  `procesarOperacionesGuardia`, así un vincular confirmado en esa misma corrida ya libera).

### 2. Aviso y recordatorio — sistema de incidentes

- Al retener: `abrirOActualizarIncidente` con `integracion='guardia_ml'`, `proceso='venta_retenida'`,
  `tipoError=<ml_order_id>` (una alerta por venta), severidad `advertencia` (no dispara email), mensaje
  con producto y motivo.
- Al liberar o cancelar (manual o automático): `confirmarCicloSano` de ese mismo incidente.
- `lib/workerNotificacionesPush.js`, sólo para `guardia_ml/venta_retenida`:
  - destinatarios: usuarios activos admin o con `matcher:write` (los que pueden liberar), sin filtro de
    severidad;
  - recordatorio: **uno solo**, a los 120 min del aviso inicial (el resto de incidentes sigue con
    `REAVISO_INCIDENTE_MIN`).
- Deep link `incidentes/{id}`: la app ya lo abre (`parseNotificationDeepLink`) → sin build ni OTA.
- El inicio ya lista incidentes activos: la venta retenida aparece ahí además del chip.

### 3. Chip del inicio

- `/api/sync/dashboard` agrega `atencion.ventas_retenidas_guardia` (conteo `estado='retenido'`).
- `public/home/index.html`: chip crítico "ventas retenidas" → `/herramientas/guardia-ml/`, permiso
  `guardia-ml`.

## Pruebas

- Libera sola cuando todas las claves quedan cubiertas; no libera con una clave sin cubrir, con caso en
  excepción o bloqueado; efectos idénticos al manual (reserva y procesada borradas, evento registrado);
  idempotente.
- Endpoint manual sigue igual (tests existentes).
- Incidente abierto al retener y resuelto al liberar/cancelar; una alerta por venta.
- Worker: destinatarios admin/matcher-write para `venta_retenida`; recordatorio único a 120 min; otros
  incidentes sin cambios.
- Dashboard expone el conteo; smoke del chip.

## Criterios de aceptación

1. Una venta retenida se libera sola ≤5 min después de que su último bloqueo queda cubierto.
2. Retener abre una alerta con push a admin/matcher-write y aparece en el inicio (chip + incidentes).
3. A las 2 h sigue retenida → exactamente un recordatorio; nunca un segundo.
4. Suite completa verde; revisión del diff antes de desplegar.
