# Cola de Códigos que se entera de los cambios ajenos, y catálogo incremental

Fecha: 2026-08-10
Rama: `worktree-codigos-frescura` (base `1eb9546`, master local — NO `origin/master`)

## Lo que reportó el usuario

Sobre **Carga de Códigos Universales** (`/codigos`):

1. "me parece que no está haciendo la carga en WC"
2. "es lenta la actualización de catálogo"
3. "dos usando la misma herramienta al mismo tiempo no se actualiza para los dos así recargues
   la página"

## Qué es real y qué no (verificado, no supuesto)

**Síntoma 1 — descartado como falla.** Los códigos SÍ llegan a WooCommerce. Verifiqué contra la
API de Woo tres asignaciones reales (`796941381109`/FB-9047, `796941381192`/FB-9064,
`022255445504`/FB-4387): las tres con su `global_unique_id` correcto. De 92 asignaciones
registradas, solo una perdió el código en el catálogo local. El endpoint es fail-closed: no
escribe en la base si Woo no confirmó. Es un efecto secundario percibido del síntoma 3 — si la
cola no se refresca, el producto sigue listado y parece que no se guardó. El usuario confirmó
después que sí está funcionando.

**Síntoma 3 — reproducido, causa raíz identificada.** `public/codigos/index.html` carga la cola
UNA sola vez al entrar (`cargarFaltantes()` desde el `requirePermiso`) y, al asignar, hace
`faltantes = faltantes.filter(...)` sobre el array en memoria **sin volver a pedir la lista**.
No hay `setInterval`, ni listener de `visibilitychange`, ni de `focus`. Por eso una segunda
persona no se entera nunca de una asignación ajena.

Dos precisiones sobre el reporte, medidas en navegador real con dos pestañas:
- **F5 SÍ actualiza** (`200` fresco, la tarjeta desaparece, el contador baja de 1195 a 1194). Lo
  que no se actualiza nunca es quedarse en la pestaña sin recargar.
- **La caché HTTP quedó descartada:** el navegador hace la petición real cada vez, pese a que el
  endpoint no manda `Cache-Control`.

**Síntoma 2 — real, con dos causas distintas que conviene no mezclar.**
- *Latencia:* el cron de `refrescarCatalogo` corre cada 15 min, así que un cambio hecho en Woo
  tarda hasta 15 min en verse.
- *Costo:* cada refresco son **~584 llamadas a Woo** (21 páginas de `/products` + **563
  llamadas, una por cada producto variable**, para traer sus variaciones — todas, siempre, haya
  cambiado algo o no). Unas 56.000 llamadas diarias. Es el mismo patrón de bucle-por-ítem que
  causó la ráfaga de ML de `1eb9546`. La concurrencia ya está acotada a 4
  (`WOO_CONCURRENCIA_MAX`), así que el problema es el volumen, no la seriedad.

## Decisiones del usuario

- Frescura de la cola: **firma liviana + refresco automático** (no bajar el payload entero).
- Catálogo incremental: **sí, en este mismo trabajo**.

---

## Paso 1 — Firma liviana de la cola

**Archivos:** `routes/codigos.js`, `public/codigos/index.html`, `docs/api-contrato.md`.

Bajar los 417 KB para descubrir que no cambió nada es el desperdicio a evitar.

- Endpoint nuevo `GET /api/codigos/firma?conStock=` → `{ ok:true, firma }`. La firma se calcula
  con **la misma cláusula WHERE que `/faltantes`** (mismo parámetro `conStock`), como
  `COUNT(*)` + `MAX(actualizado_en)`. Una asignación baja el count y mueve el máximo, así que
  cualquiera de los dos movimientos la cambia.
- El front consulta la firma cada ~20 s **solo con la pestaña visible** (nada de polling en
  background gastando batería y datos en el depósito) y además al volver a la pestaña
  (`visibilitychange`). Si la firma cambió respecto de la última conocida, recién ahí llama a
  `cargarFaltantes()`.
- Mismo patrón de firma que ya usa el matcher (`firmaCandidatos` en `routes/matcher.js`), para
  no inventar un mecanismo nuevo.

**Cuidado que no se puede pasar por alto:** el operador puede estar tipeando un código en una
tarjeta cuando entra un refresco. El array `pendientes` (lo tecleado por `id_woo`) ya existe y
**debe sobrevivir al re-render**; y no se puede sacar de la pantalla la tarjeta que está
editando en ese momento. Si eso obliga a postergar el refresco mientras hay algo tipeado, se
posterga: perder lo tecleado en el depósito es peor que ver la cola un minuto desactualizada.

**Criterios de aceptación:**
1. Con dos sesiones sobre la misma cola, al asignar en A la cola de B se actualiza sola en menos
   de ~25 s, sin recargar la página.
2. Mientras la firma no cambia, no se pide `/faltantes` ni una sola vez: el tráfico de estar
   quieto es solo la firma.
3. Un código a medio tipear en una tarjeta sobrevive a un refresco automático.

## Paso 2 — Refresco de catálogo incremental

**Archivos:** `routes/woo.js` (`refrescarCatalogo`), `server.js` (frecuencia del cron),
`docs/api-contrato.md`.

- Guardar en `sync_estado` la marca del último refresco completo con éxito.
- Corrida **incremental**: `/products?modified_after=<marca>&dates_are_gmt=true&per_page=100&status=any`,
  y traer variaciones **solo de los padres que volvieron en esa consulta**.
- **`dates_are_gmt=true` no es opcional.** Está documentado en memoria
  ([[woo-after-hora-local]]): Woo interpreta `after`/`before` en hora local y el 2026-07-29 eso
  nos generó los pedidos duplicados 66554/66555. Sin ese parámetro este paso vuelve a pisar la
  misma mina.
- Verificado hoy, y es lo que hace viable el incremental: **Woo actualiza la fecha del padre
  cuando cambia una variación.** Muestra de 6 padres / 17 variaciones: 0 variaciones con fecha
  más nueva que su padre. La muestra es chica y no cubre específicamente los cambios de
  solo-stock que escribe nuestro propio sync, así que **no se apoya todo el diseño en eso**:
- **Red de seguridad obligatoria:** un barrido **completo** periódico (el comportamiento actual)
  que además es lo único capaz de detectar productos borrados en Woo, que el incremental no ve.
  El botón manual `POST /api/woo/catalogo/recargar` fuerza siempre el barrido completo.
- Margen de solape al calcular `modified_after` (restarle unos minutos a la marca), para no
  perder ediciones ocurridas durante la corrida anterior.
- La marca se actualiza **solo si la corrida terminó sin errores** — fail-closed, mismo criterio
  que el resto del repo. Si falla, la próxima vuelve a mirar desde la marca vieja.
- Con el costo por corrida derrumbado, **subir la frecuencia del cron** para que la latencia baje
  de los 15 min actuales. Elegir el número en función del costo medido, no al voleo.

**Criterios de aceptación:**
1. En régimen estable (nada cambió en Woo), una corrida incremental hace **una sola** llamada a
   `/products` y **cero** llamadas de variaciones.
2. Un cambio en una variación se refleja en `catalogo_cache` en la siguiente corrida incremental.
3. Un producto borrado en Woo desaparece de `catalogo_cache` tras el siguiente barrido completo.
4. Si una llamada a Woo falla, la marca no avanza y no se persiste un catálogo parcial.
5. Existe un test que falla si alguien saca `dates_are_gmt=true`.

## Regla de despliegue

`npm test` verde + revisor OK + `probador-e2e` (toca `public/`) + auditor 🟢. Merge y
`pm2 restart` los autoriza el usuario.
