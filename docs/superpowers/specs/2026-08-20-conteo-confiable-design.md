# Conteo confiable — Contador de inventario (Entrega A)

## Contexto

La herramienta de **Conteo de stock** (`public/inventario/index.html`, backend
`routes/inventario.js`) permite abrir una sesión sobre un alcance (categorías/marcas),
escanear productos con la cámara del celular (o pistola / tipeo) y, al confirmar, ajustar
el stock real en WooCommerce por cada ítem contado.

Al operar la herramienta aparecieron **dos problemas** distintos que se descubrieron juntos:

1. **Conteo no confiable (esta entrega, A).** Escaneando con la cámara, "cuento 8 y me marca
   3". El usuario confirmó que el bug es **constante**, pasa con **cualquier conteo**
   (unidades iguales o productos distintos), y que **al recargar la página sigue mal** — o sea,
   el conteo nunca llegó a la base. Ojo con la redacción: la base **no perdió** nada, el `+1`
   **nunca se envió**. Quien lea "se perdieron conteos" se va a poner a buscar un bug de
   transacciones que no existe.

2. **Cierre inseguro de la sesión (Entrega B, fuera de alcance de este spec).** Al confirmar,
   `/confirmar` solo ajusta lo que se escaneó; los productos del alcance que quedaron **sin
   contar no se tocan**, así que puede quedar con stock en Woo algo que físicamente ya no está,
   sin que el operario se dé cuenta. Se diseña aparte.

Este spec cubre **solo la Entrega A: conteo confiable.** La Entrega B se apoya en que el
conteo de A sea confiable, por eso va primero (decisión acordada con el usuario).

### Diagnóstico del bug de conteo

Contar inventario son dos cosas: **(1) qué producto es** y **(2) cuántas unidades hay**. La
cámara es excelente para (1) e inherentemente floja para (2).

**El mecanismo, verificado en el código (2026-08-20):** no se están "perdiendo lecturas". El
gate está haciendo exactamente lo que fue diseñado para hacer. `createContinuousGate`
(`public/lib/scannerGate.js`) solo vuelve a contar un código después de que estuvo **ausente**
del cuadro ≥ `dropoutMs`, que en el contador vale **500ms** (`public/inventario/index.html:1351`).
El muestreo es cada **350ms** (`scanner.js:224`), así que entre unidad y unidad hacen falta
**dos frames vacíos seguidos** — del orden de 850ms en los que el código no se lea.

Pasando 8 unidades **iguales** a mano, el código de la unidad siguiente entra en cuadro antes
de que se cumpla ese silencio. `code` nunca llega a ser vacío, el gate entra por
`if (code === currentCode) return null`, y las 8 unidades cuentan **una sola vez**. Se cuenta
solo cuando por casualidad hubo un hueco largo: de ahí "cuento 8 y me marca 3".

**Esto es determinista, no estadístico.** La versión anterior de este spec decía "se pierden
lecturas de forma pareja", lo que sugiere una pérdida probabilística por muestreo grueso. No lo
es, y esa lectura manda el debugging para el lado equivocado.

**Sobre el muestreo (corrección de una afirmación equivocada que estuvo en este spec):** se
dijo acá que bajar el intervalo de 350ms *empeoraría* el bug, razonando que más frames leídos
son menos frames vacíos. **Es falso.** Muestrear más fino no acorta el hueco entre unidades:
aumenta la probabilidad de **observarlo**. Un frame vacío es la *observación* del hueco, no su
ausencia. Medido (`test/scannerGate-conteo.test.js`): con `dropoutMs: 0`, pasar de 350ms a
100ms sube el conteo de 5/8 a 8/8.

**Pero el muestreo no es la causa.** Con el `dropoutMs: 500` de producción el conteo es **1 de
8 con cualquier muestreo** — 350ms, 200ms, 100ms y 50ms dan todos 1. El hueco real entre
unidades pasadas a mano (~200ms) es menor que el umbral de 500ms, así que el gate **no se
re-arma nunca**. El umbral es el bloqueo dominante.

**Límite de fondo, ahora medido:** dos unidades idénticas emiten **la misma señal**. Nada en el
código de barras las distingue; la única evidencia de "esta es otra unidad" es un hueco
temporal. Y el gate no puede distinguir ese hueco de un **parpadeo** (la lectura falla un
instante con la misma unidad todavía delante: mala luz, un reflejo, la mano encima).

Se midieron los **dos** errores a la vez — subconteo de 8 unidades iguales, y sobreconteo de
UNA unidad quieta con parpadeo — sobre ocho combinaciones de muestreo y umbral. Resultado: la
única que acierta en las dos columnas es `muestreo 50ms / dropout 150ms`, y acierta **por
construcción del escenario**: el parpadeo simulado llega a 150ms y el hueco entre unidades es
200ms. Son **50ms de separación**. En el depósito real esas dos duraciones se solapan, así que
ese punto no sobrevive fuera de la simulación. Además, muestrear a 50ms es correr la detección
20 veces por segundo en un celular, con el costo de batería que eso implica.

**Conclusión: no existe un umbral seguro, y buscarlo es perder el tiempo.** No es que el
compromiso sea difícil de calibrar: las dos señales que hay que separar tienen la misma
duración. Por eso el conteo por cámara de unidades iguales **no se promete**, y el peso del
diseño va donde sí hay una respuesta correcta: el campo de cantidad.

Por eso la conclusión de diseño —**separar identificar de contar**— no es un rodeo del bug: es
la única respuesta correcta. La cámara identifica el producto; la cantidad la fija un control
visible y editable, nunca un número oculto.

## Objetivo

Que el número de unidades por producto en una sesión de conteo sea **confiable**: escanear N
unidades (iguales o distintas) al ritmo real del operario registra **exactamente N**, y para
lotes grandes se pueda **escanear una vez y fijar la cantidad** sin pasar unidad por unidad.

Criterios de éxito verificables, **separados a propósito** (ver el límite de fondo del
diagnóstico: unidades idénticas por cámara no tienen solución exacta, y una vara que no se
puede alcanzar no se escribe):

1. **Productos distintos:** pasar N productos distintos al ritmo real registra exactamente N.
   Esta sí es la vara del gate y no se negocia.
2. **Unidades idénticas:** la vara es el **campo de cantidad**, no la cámara — se puede escanear
   una vez y tipear la cantidad, y el total mostrado es siempre el del campo. Sobre el conteo
   por cámara de unidades iguales se mide y se deja **escrito el número que se alcanza**, sin
   prometer exactitud.
3. **Persistencia:** lo registrado sobrevive a recargar la página.

## Fuera de alcance

- **Entrega B** (advertencia + bloqueo + acciones sobre los no contados al confirmar). Se
  diseña en su propio spec y se construye después de esta entrega.
- Cambios al **sync ML↔Woo** y a la lógica atómica de `/confirmar` (claim, reintento,
  fail-closed por ítem): no se tocan.
- Cambios al **esquema sqlite**: esta entrega no agrega ni modifica columnas/tablas (ver
  "Backend / contrato"). Si la reproducción del bug revelara que hace falta, se sube el
  alcance y se documenta ahí — no se asume ahora.
- Otras herramientas que no sean el Contador de inventario.

## Modelo de conteo unificado (pantalla única)

**Decisión de producto (acordada):** una sola pantalla que sirve para los dos casos, sin
interruptor de modo. La misma pantalla talla por unidad **y** deja fijar cantidad; el operario
hace una u otra cosa según el producto, no según un modo que tenga que acordarse de setear.

Cada producto que entra al conteo (por cámara, pistola o tipeo) aparece en la lista con:

- un control **`− [ cantidad ] +`** donde la cantidad es **editable** (tap → teclado numérico);
- **escanear/leer el mismo código otra vez suma +1** (tallado unidad por unidad — comportamiento
  actual de `POST /sesiones/:id/escanear`, que hace `cantidad = cantidad + 1`);
- para un lote, se toca el número y se escribe la cantidad directo (reusa
  `PATCH /sesiones/:id/items/:itemId`, que ya existe).

Reglas del control de cantidad:

- El total mostrado es **siempre** el valor del campo — nunca un número oculto que el operario
  no vea.
- Editar la cantidad a mano marca el ítem como conteo real (deja de estar "confirmado por
  omisión"), igual que hoy hace el `PATCH` (`confirmado_por_omision = 0`).
- `−` no baja de 0. Llegar a 0 **no** borra la fila (borrar es una acción explícita aparte, la
  que ya existe: `DELETE /sesiones/:id/items/:itemId`).
- Feedback claro por cada +1 al escanear (beep + el número que salta), reforzando el que ya hay.

El escaneo por cámara sigue alimentando el mismo `escanear(codigo)` de siempre: identificar un
producto necesita **una** lectura exitosa entre muchos frames, así que es robusto al drop aun
sin arreglarlo. El drop solo degrada el **re-conteo** del mismo código (tallado por unidad),
que es lo que arregla la sección siguiente.

## Fix del re-conteo por cámara (con `systematic-debugging`)

**No se diseña el fix a ciegas.** El bug es reproducible de forma constante (confirmado por el
usuario), así que el trabajo arranca por reproducir y diagnosticar antes de tocar nada:

1. **Reproducir** el bug en un test que **primero falla**: alimentar al gate/muestreo una
   secuencia de frames que simule N unidades al ritmo real y verificar que hoy registra < N.
   La lógica del gate (`public/lib/scannerGate.js`) es pura y ya es testeable por unidad
   (`frame(code, now)` acepta un `now` inyectable).
2. **Instrumentar** para confirmar el eslabón (el diagnóstico ya señala el gate): muestreo de 350ms
   (`detectTimer` en `scanner.js`) vs. lógica del gate (`scannerGate.js`) vs. el `POST` de
   `escanear()`. Sospechoso principal: el intervalo de 350ms es demasiado grueso para el ritmo
   con que se pasan las unidades.
3. **Lo medido cierra este paso** (`test/scannerGate-conteo.test.js`): la causa es el umbral
   `dropoutMs`, no el muestreo, y **no hay un umbral seguro** — el parpadeo y el cambio de
   unidad duran lo mismo (ver el límite de fondo). Por lo tanto **no se toca el gate para
   perseguir el conteo exacto de unidades iguales**: sería calibrar contra ruido.

   Lo que sí queda pendiente de decidir, con evidencia y no por intuición: si conviene bajar el
   muestreo de 350ms para mejorar la **identificación** (que sí mejora, y es lo que la cámara
   hace bien), pesándolo contra el costo de batería de correr la detección más seguido en un
   celular. Es una decisión aparte, no el fix del bug.

Criterio de aceptación del fix (verificable, TDD sobre el bug): el test que reproducía el drop
pasa; pasar N unidades (iguales o distintas) al ritmo real registra exactamente N; recargando
la página sigue en N.

## Backend / contrato de API

Cambio **mínimo** en backend: las piezas necesarias ya existen.

- `POST /sesiones/:id/escanear` — ya suma +1 por lectura del mismo código. Sin cambios.
- `PATCH /sesiones/:id/items/:itemId` — ya fija la cantidad a mano y limpia
  `confirmado_por_omision`. Sin cambios.
- `DELETE /sesiones/:id/items/:itemId` — borrar fila. Sin cambios.

La Entrega A es sobre todo **frontend**: `public/inventario/index.html`,
`public/lib/scanner.js`, `public/lib/scannerGate.js`.

**Cuidado, son piezas compartidas:** `scanner.js` y `scannerGate.js` los usa también
**Preparación de pedidos** (`public/preparacion/index.html:1477`, mismo `dropoutMs: 500`).
Cualquier cambio al gate o al intervalo de muestreo toca las dos herramientas, y en Preparación
el trabajo es distinto (se escanean ítems distintos, no unidades iguales), así que un cambio que
mejora el conteo puede empeorar la preparación. Verificar las dos. **No toca** el esquema sqlite ni el sync
ML↔Woo. Si la reproducción del drop revelara que hace falta un endpoint nuevo, se agrega ahí y
recién ahí sube el alcance del spec.

## Testing / criterio de aceptación

- **vitest** de la lógica de gate/muestreo, incluyendo el test que reproduce el bug (falla
  antes del fix, pasa después). **El test tiene que alimentar la secuencia real de frames,
  incluidos los vacíos** (`frame(null, t)`): un test que solo llame `frame('X', t)` repetido no
  reproduce nada — reproduce el comportamiento correcto del gate y pasa en verde con el bug
  intacto. Cobertura del control de cantidad si tiene lógica JS propia
  (clamp a 0, no-borrado en 0).
- `probador-e2e` en navegador real sobre la pantalla de conteo: tallado por escaneo, edición de
  cantidad a mano, `+`/`−`, responsive (desktop y mobile), sin nada oculto.
- `npm test` completa verde al final (la corre el orquestador, una sola vez).
- Conformidad con el sistema visual (`public/lib/theme.css`, tokens) y presupuesto de peso
  frontend — verificado por `auditor-despliegue`.

## Preguntas resueltas con el usuario

- El bug es **constante**, con cualquier conteo (iguales o distintos), y **persiste al recargar**
  → el `+1` nunca llegó a la base; se descarta la carrera de refresco de pantalla.

## Revisión del 2026-08-20 (qué cambió y por qué)

El spec original tenía la decisión de producto bien y el diagnóstico técnico apuntando al
sospechoso equivocado. Verificado contra el código, no por lectura del documento:

- El bug **no es** pérdida estadística de lecturas por muestreo grueso: es el gate re-armándose
  solo tras ≥500ms de ausencia del código, condición que un flujo continuo de unidades nunca
  cumple. Determinista, no probabilístico.
- El arreglo candidato principal del original —**bajar el intervalo de muestreo**— empeoraba el
  bug. Queda descartado explícitamente para que nadie lo reintente.
- El criterio de éxito "N unidades iguales registran exactamente N" **no es alcanzable** con
  código de barras: dos unidades idénticas son la misma señal. Se partió en dos varas, y la de
  unidades iguales pasó a ser el campo de cantidad. Una vara que no se puede cumplir no se
  escribe: la regla del proyecto es que un piso medido no se negocia, y por eso mismo hay que
  fijar solo pisos reales.
- `scanner.js`/`scannerGate.js` son **compartidos con Preparación de pedidos**; el original no
  lo decía.
- Se quieren **los dos modos** de conteo (unidad por unidad y escanear+cantidad), resueltos en
  una **pantalla unificada** sin interruptor.
- Orden acordado: **Entrega A (esta) primero**, Entrega B después.

## Revisión del 2026-08-21 — el `+1` perdido tuvo tres capas, no una

Este bug se dio por arreglado tres veces y volvió dos. Vale la pena dejar escrito el
recorrido, porque cada capa tapaba a la siguiente y ninguna se veía leyendo el código.

**Capa 1 — dos escrituras con semánticas distintas.** `POST /escanear` suma `+1` en el
servidor (relativo); `PATCH /items/:id` manda un valor **absoluto**. Si viajan juntas gana la
que *llega*, no la que se envió, y el `+1` desaparece sin error. Arreglo: serializar las
escrituras en una cola.

**Capa 2 — la cola no alcanza si la base es vieja.** Serializar el HTTP no arregla un valor
calculado al hacer *clic*: para cuando al `−` le toca el turno, el escaneo ya subió el
número. Arreglo: el `−` pasa una **función**, no un número, y resuelve su valor cuando le
toca el turno. Esto lo encontró una prueba en navegador contra la base, no la lectura del
código: mi arreglo de la capa 1 lo di por bueno y estaba incompleto.

**Capa 3 — la protección sobrante corrompía el estado.** Quedó vivo un `cantidadSeq` que
descartaba "respuestas viejas". Con la cola no existe una respuesta vieja (nunca hay dos
escrituras en vuelo), pero además `miSeq` se capturaba **al hacer clic**, no al ejecutarse:
tres toques rápidos incrementaban el contador todos juntos antes de que arrancara la primera
escritura, así que la respuesta **buena** se descartaba y con ella se salteaba el
`delete cantidadOptimista`. Ese valor local obsoleto quedaba de base para el `−` siguiente.
Medido en navegador: tres pares escaneo+`−` sobre cantidad 4 terminaban en **2**.

**Lo transferible:** una guarda que ya no protege nada no es código muerto inofensivo —
sigue teniendo efectos. Al agregar un mecanismo de orden más fuerte (la cola), hay que
**sacar** el más débil, no dejarlo por las dudas.

**Corolario sobre los tests:** al testear la cola por mutación aparecieron dos defectos en
los tests mismos. El escenario alternado arrancaba en `4` y daba bien aunque el orden se
rompiera (la suma conmuta lejos del piso; `siguienteAlRestar` satura en 0, así que hay que
arrancar cerca del piso para que el orden importe). Y el código tenía **dos** mecanismos
redundantes para sobrevivir a un fallo — `then(hacer, hacer)` y el `catch` — lo que volvía
intesteables a los dos: mutar uno lo tapaba el otro. Quedó uno solo.
