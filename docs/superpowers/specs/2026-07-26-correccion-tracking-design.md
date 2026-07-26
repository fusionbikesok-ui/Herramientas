# Corrección de tracking erróneo — Preparación de Pedidos

**Fecha:** 2026-07-26
**Estado:** aprobado, pendiente de plan de implementación
**Alcance:** tercer ciclo de 6 en la lista de mejoras a Preparación de Pedidos (después de
caché de pedidos y concurrencia, ambos ya en `master`). Ataca la fricción #4 detectada en
el análisis original del proceso: sin flujo soportado para corregir un tracking mal
cargado.

**Nota:** este ciclo se planeó y ejecutó con el usuario no disponible en el momento
(agente orquestador tomando las decisiones de diseño en su representación, siguiendo el
mismo criterio conservador de los ciclos 1 y 2). Cualquier decisión marcada abajo puede
revisarse después.

## Contexto y problema

Hoy, en `routes/preparacion.js` (`POST /seguimientos/:wcOrderId`):

- Cuando un pedido web ya está `completed` (o `enviadoandreani`) con un tracking guardado
  en el meta `_andreani_tracking`, y el operario intenta cargar un tracking **distinto**
  (porque el original estaba mal tipeado), el endpoint responde `409` sin ninguna
  alternativa. El comentario en el código lo documenta explícitamente: *"Corregir un
  tracking erróneo sería un flujo aparte, hoy hacemos fail-closed."*
- El único camino existente hoy es reintentar con el **mismo** tracking exacto (para
  recuperar un PUT que falló a mitad de camino) — no es una corrección real.
- La única forma de arreglar un tracking mal cargado hoy es editando el pedido a mano
  directamente en el admin de WooCommerce, por fuera de esta herramienta y sin dejar
  registro en `preparacion_eventos` (el sistema de auditoría por paso del ciclo anterior).

## Decisiones (tomadas por el orquestador en ausencia del usuario)

1. **Endpoint separado, no reutilizar `POST /seguimientos/:wcOrderId`.** La corrección es
   una operación distinta con precondiciones distintas (pedido YA completado/enviado, no
   "en origen"). Mantener el endpoint existente sin tocar su fail-closed actual evita
   reabrir un camino de reenvío de mail accidental.
2. **La corrección NUNCA cambia el `status` del pedido en WooCommerce — solo el
   `meta_data` del tracking.** Como el email nativo de WooCommerce se dispara por la
   *transición* a `completed` (no por cambios de meta), un PUT que solo actualiza
   `meta_data` no reenvía el mail al cliente. Esto es justamente lo que permite corregir
   sin re-notificar.
3. **Precondición fail-closed:** solo se puede corregir un pedido cuyo `status` actual en
   Woo sea `completed` o el estado final configurado (`enviadoandreani`) Y que ya tenga
   un valor de tracking guardado (si no lo tiene, no es "corrección", es el flujo normal
   de `POST /seguimientos/:wcOrderId`). Si el tracking nuevo es idéntico al guardado, se
   responde `ok` sin hacer ningún PUT (no-op, evita golpear la API de Woo sin necesidad).
4. **Se registra como evento de Actividad**, reusando la infraestructura del ciclo 3
   (`registrarEvento`/`preparacion_eventos`) en vez de crear un sistema de auditoría
   paralelo. Tipo nuevo: `tracking_corregido`, con `detalle: { tracking_anterior,
   tracking_nuevo }`. Se busca la preparación por `clave='web:'+wcOrderId` — si por algún
   motivo no existe una fila en `preparaciones` (no debería pasar, ya que llegar a
   `completed` implica que `POST /seguimientos/:wcOrderId` ya la creó), el registro del
   evento se saltea silenciosamente (fail-open, igual criterio que el resto de
   `registrarEvento`) sin bloquear la corrección del tracking en sí.
5. **UI: buscar por número de pedido, sección nueva en el tab "Cargar seguimientos".**
   Los pedidos ya completados no aparecen en la lista principal de ese tab (son
   pendientes o colgados), así que hace falta una forma de encontrarlos. Se agrega una
   fila de búsqueda simple arriba de la lista existente: input de número de pedido +
   botón "Buscar" → si el pedido está en estado corregible, muestra el tracking actual y
   un input para el nuevo valor + botón "Corregir". Sin buscador de biblioteca ni
   autocompletado — el operario ya tiene el número de pedido a mano (viene de una
   consulta previa a WooCommerce o de un reclamo del cliente).

## Diseño técnico

### Backend

**Nuevo endpoint `GET /seguimientos/:wcOrderId/tracking-actual`** — lookup de solo
lectura, para que el frontend muestre el tracking guardado antes de corregir:

```json
{ "ok": true, "status": "enviadoandreani", "tracking_actual": "AND123456", "corregible": true }
```

`corregible` es `true` solo si `status` es `completed` o el `enviadoAndreaniStatus`
configurado Y `tracking_actual` no está vacío. Si el pedido no existe en Woo, `404`.

**Nuevo endpoint `POST /seguimientos/:wcOrderId/corregir-tracking`**:

```json
// request
{ "tracking": "AND654321" }
// response
{ "ok": true, "tracking_anterior": "AND123456", "tracking_nuevo": "AND654321" }
```

Precondiciones (fail-closed, en este orden):
1. `tracking` no vacío → si no, `400`.
2. El pedido existe en Woo → si no, `404`.
3. `status` es `completed` o `enviadoAndreaniStatus` → si no, `409` con el status actual
   (mismo formato de error que el endpoint existente).
4. Existe un meta `_andreani_tracking` con valor no vacío → si no, `409` ("no hay tracking
   cargado para corregir — usá el flujo normal de seguimientos").

Si `tracking === tracking_actual` (mismo valor): responde `ok` sin PUT (no-op explícito,
no es un error).

Si es distinto: un único PUT a Woo con **solo** `meta_data` (sin `status`), después
`registrarEvento` (fail-open, ver Decisión 4).

### Frontend (`public/preparacion/index.html`, tab "Cargar seguimientos")

- Buscador simple arriba de la grilla existente (no reemplaza nada de lo actual): input
  numérico + botón "Buscar". Al buscar, llama a `GET .../tracking-actual`.
  - Si `corregible: false` o 404: mensaje inline ("no encontrado" / "este pedido no tiene
    un tracking cargado todavía — usá la lista de abajo").
  - Si `corregible: true`: muestra el tracking actual (texto, no editable) + un input para
    el nuevo valor + botón "Corregir". Al confirmar, llama al POST de corrección y
    muestra un mensaje de éxito con ambos valores (antes → después).
- No se toca el resto del tab (la lista de pendientes/colgados sigue igual).

## Fuera de alcance de este ciclo

- Corrección de tracking para pedidos de MercadoLibre: ML gestiona su propio envío
  (Flex/colecta), no hay tracking manual cargado por esta herramienta para ese canal.
- Historial de correcciones fuera de `preparacion_eventos` (ya cubierto por el feed de
  Actividad del ciclo 3, no hace falta duplicar).
- Deshacer una corrección (volver al tracking anterior) — si se necesita, es solo volver
  a usar el mismo flujo con el valor anterior como "nuevo" valor.

## Siguiente paso

Invocar el plan de implementación: endpoint de lookup + endpoint de corrección (TDD), y
el buscador en el frontend del tab "Cargar seguimientos".
