# Plan específico: devolución de preparaciones canceladas

**Fecha:** 2026-09-10
**Estado:** implementado; falta que el admin cargue los estantes para poder usarlo
**Alcance:** qué pasa con el producto que ya se levantó cuando el pedido se cancela.

## El problema

Cuando un pedido se cancela después de que alguien fue a buscar el producto, ese producto queda
en la mesa de embalaje: no está en su estante y el sistema lo sigue contando como disponible.
Nadie registra que volvió. Al 2026-09-10 hay un caso vivo: la preparación del pedido ML
`#2000018370921442` (9/9) tiene el Stem `FB-48280` **escaneado y fotografiado**, el pedido está
cancelado, y la preparación quedó abierta a propósito porque cerrarla como "enviada" sería
falso.

Es el mismo agujero que el conteo: el movimiento físico ocurre y nadie lo asienta.

## Decisiones del usuario (2026-09-10)

- **Se pide confirmación solo cuando hay producto levantado**: al menos una unidad escaneada o
  el pedido ya embalado. Una preparación cancelada sin nada escaneado se cierra sin pedir nada
  — no hay qué devolver (caso `#2000018214080180`, sin SKU y sin escanear).
- **No entran las cancelaciones post-despacho.** El pedido que ya salió y vuelve es una
  recepción de devolución, no una vuelta al estante: flujo distinto, fuera de este plan.
- **Una sola confirmación por pedido**, no unidad por unidad.
- **Se registra la ubicación concreta del estante**, no "exhibición/depósito".
- **Si nadie confirma, queda como tarea pendiente visible.** La preparación NO se cierra sola.
- **Los estantes los carga el admin primero** (pantalla existente en conteo → "Elegir alcance").
  El preparador elige de esa lista; no crea ubicaciones.

## Consecuencia de esa última decisión

Hoy hay **una sola ubicación cargada** ("Mostrador / Molicsyn") y **0 productos mapeados**.
Hasta que se carguen los estantes reales, ninguna devolución se puede confirmar y las tareas se
van a acumular. La pantalla tiene que decirlo con todas las letras —"faltan cargar los
estantes"— en vez de mostrar un desplegable vacío, y avisarle al admin.

## Una ubicación por producto, aunque la confirmación sea una

El 91% de las preparaciones tiene **un solo producto** (221 de 247; 26 tienen dos o más, una
tiene 11). Con un producto, "una confirmación" y "una ubicación" son lo mismo. Con varios, una
sola ubicación para todo el pedido sería un dato falso — y este flujo existe justamente para no
inventar datos. Entonces: **un botón de confirmación**, y adentro **una ubicación por producto**
con la del primero precargada, para que el caso normal siga siendo un toque.

## Modelo

- `preparacion_devoluciones`: una fila por preparación cancelada con producto levantado.
  Estados: `pendiente` → `confirmada`. Guarda quién y cuándo.
- `preparacion_devolucion_items`: qué producto volvió y a qué `ubicacion_id`.
- Estado nuevo de preparación: `cancelada_pendiente_devolucion` → `cancelada_devuelta`. Es el
  cierre honesto que faltaba: hoy la única forma de cerrar una preparación es declararla
  enviada, y por eso las dos canceladas siguen abiertas.
- La devolución **también mapea** `producto_ubicacion`, igual que el conteo: si el producto
  volvió al estante B2, ahora sabemos que vive en B2.

## Detección

Donde ya se consulta el estado del canal (el mismo criterio del script
`cerrar-preparaciones-despachadas.mjs`): si el pedido está cancelado y la preparación tiene
ítems con `cantidad_escaneada > 0` o `estado_embalaje` puesto, se crea la devolución pendiente.
Idempotente: una preparación tiene como máximo una devolución.

## Pantalla

- Bloque **"Devoluciones pendientes"** en la cola, al lado de "Preparaciones abiertas sin
  terminar": qué pedido, qué producto, desde cuándo, quién lo había preparado.
- Al abrirla: la lista de productos, un selector de estante por producto y un botón
  **"Confirmar que volvió a su lugar"**.
- Si no hay ubicaciones cargadas, el botón no se muestra y en su lugar va el aviso.

## Fuera de alcance

- Cancelaciones después del despacho (recepción de devolución).
- Que el preparador cree ubicaciones (decisión explícita: las carga el admin).
- Si la cancelación devuelve stock en Woo/ML — hay que verificarlo aparte; este flujo es sobre
  dónde está físicamente el producto, no sobre el stock publicado.

## Implementado el 2026-09-10

- `migrations/102_preparacion_devoluciones.sql` (registrada en `db/index.js`).
- `estadoDelCanal`, `itemsLevantados` y `asegurarDevolucionPendiente` en `routes/preparacion.js`,
  extraídas del IIFE que ya calculaba el aviso de canal en el detalle.
- `GET /devoluciones`, `GET /devoluciones/:id`, `POST /devoluciones/:id/confirmar`.
- Bloque "Volver a su lugar" arriba de la cola y pantalla de confirmación con selector por
  producto. Se refresca también en el polling de fondo: una cancelación llega en cualquier momento.
- Estados nuevos: `cancelada_pendiente_devolucion` y `cancelada_devuelta`.

**La FK a `ubicaciones` se sacó a propósito.** La tabla la crea el router de inventario al
construirse, no una migración, así que el INSERT fallaba con "no such table" donde no está
montado — y un `try/catch` mudo hacía que la tarea simplemente no apareciera. El catch ahora
loguea: fail-open sí, silencioso no.

## Criterio de aceptación

1. Una preparación cancelada con ítem escaneado aparece como devolución pendiente y **no** se
   cierra sola.
2. Una preparación cancelada sin nada escaneado no genera tarea.
3. Confirmar con estante deja la preparación en `cancelada_devuelta`, registra quién y cuándo,
   y mapea el producto a esa ubicación.
4. Sin ubicaciones cargadas, la pantalla explica qué falta en vez de ofrecer un selector vacío.
5. La preparación `#2000018370921442` queda resuelta por este camino.
