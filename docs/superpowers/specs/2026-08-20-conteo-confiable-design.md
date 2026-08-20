# Conteo confiable — Contador de inventario (Entrega A)

## Contexto

La herramienta de **Conteo de stock** (`public/inventario/index.html`, backend
`routes/inventario.js`) permite abrir una sesión sobre un alcance (categorías/marcas),
escanear productos con la cámara del celular (o pistola / tipeo) y, al confirmar, ajustar
el stock real en WooCommerce por cada ítem contado.

Al operar la herramienta aparecieron **dos problemas** distintos que se descubrieron juntos:

1. **Conteo no confiable (esta entrega, A).** Escaneando con la cámara, "cuento 8 y me marca
   3". El usuario confirmó que el bug es **constante**, pasa con **cualquier conteo**
   (unidades iguales o productos distintos), y que **al recargar la página sigue mal** — o
   sea, la base de datos realmente perdió conteos (no es un problema de refresco de pantalla).

2. **Cierre inseguro de la sesión (Entrega B, fuera de alcance de este spec).** Al confirmar,
   `/confirmar` solo ajusta lo que se escaneó; los productos del alcance que quedaron **sin
   contar no se tocan**, así que puede quedar con stock en Woo algo que físicamente ya no está,
   sin que el operario se dé cuenta. Se diseña aparte.

Este spec cubre **solo la Entrega A: conteo confiable.** La Entrega B se apoya en que el
conteo de A sea confiable, por eso va primero (decisión acordada con el usuario).

### Diagnóstico del bug de conteo

Contar inventario son dos cosas: **(1) qué producto es** y **(2) cuántas unidades hay**. La
cámara es excelente para (1) e inherentemente floja para (2): el lector muestrea un frame
cada **350ms** (`public/lib/scanner.js`, `openWithBarcodeDetector`/`startZxingLoop`) y el
gate de escaneo continuo (`public/lib/scannerGate.js`) solo vuelve a contar un código cuando
estuvo **ausente del cuadro ≥ 500ms** (`dropoutMs: 500` en `abrirCamara()` de
`public/inventario/index.html`). A ese ritmo, pasando unidades a mano contra un muestreo
grueso, se pierden lecturas de forma pareja — de ahí "3 de 8", constante, con cualquier código.

La conclusión de diseño es **separar identificar de contar**: la cámara identifica el
producto; la cantidad la fija un control visible y editable, nunca un número oculto. Así,
aunque la cámara pierda una re-lectura, el total es lo que el operario ve y corrige en el
acto. Igual se reproduce y arregla el drop, porque el tallado unidad-por-unidad debe ser fiel.

## Objetivo

Que el número de unidades por producto en una sesión de conteo sea **confiable**: escanear N
unidades (iguales o distintas) al ritmo real del operario registra **exactamente N**, y para
lotes grandes se pueda **escanear una vez y fijar la cantidad** sin pasar unidad por unidad.

Criterio de éxito verificable: pasar N unidades al ritmo real registra N; recargando la
página sigue en N; un lote se puede cargar tipeando la cantidad en vez de escanear cada una.

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

## Fix del drop del escaneo (con `systematic-debugging`)

**No se diseña el fix a ciegas.** El bug es reproducible de forma constante (confirmado por el
usuario), así que el trabajo arranca por reproducir y diagnosticar antes de tocar nada:

1. **Reproducir** el drop en un test que **primero falla**: alimentar al gate/muestreo una
   secuencia de frames que simule N unidades al ritmo real y verificar que hoy registra < N.
   La lógica del gate (`public/lib/scannerGate.js`) es pura y ya es testeable por unidad
   (`frame(code, now)` acepta un `now` inyectable).
2. **Instrumentar** para ubicar en qué eslabón se pierden las lecturas: muestreo de 350ms
   (`detectTimer` en `scanner.js`) vs. lógica del gate (`scannerGate.js`) vs. el `POST` de
   `escanear()`. Sospechoso principal: el intervalo de 350ms es demasiado grueso para el ritmo
   con que se pasan las unidades.
3. **Arreglar la causa real** que revele el diagnóstico (candidatos probables: bajar el
   intervalo de muestreo; ajustar la lógica del gate para no perder transiciones entre códigos
   a alta cadencia). El fix concreto sale del diagnóstico, no de este spec.

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
`public/lib/scanner.js`, `public/lib/scannerGate.js`. **No toca** el esquema sqlite ni el sync
ML↔Woo. Si la reproducción del drop revelara que hace falta un endpoint nuevo, se agrega ahí y
recién ahí sube el alcance del spec.

## Testing / criterio de aceptación

- **vitest** de la lógica de gate/muestreo, incluyendo el test que reproduce el drop (falla
  antes del fix, pasa después). Cobertura del control de cantidad si tiene lógica JS propia
  (clamp a 0, no-borrado en 0).
- `probador-e2e` en navegador real sobre la pantalla de conteo: tallado por escaneo, edición de
  cantidad a mano, `+`/`−`, responsive (desktop y mobile), sin nada oculto.
- `npm test` completa verde al final (la corre el orquestador, una sola vez).
- Conformidad con el sistema visual (`public/lib/theme.css`, tokens) y presupuesto de peso
  frontend — verificado por `auditor-despliegue`.

## Preguntas resueltas con el usuario

- El bug es **constante**, con cualquier conteo (iguales o distintos), y **persiste al recargar**
  → la base perdió conteos de verdad; se descarta la carrera de refresco de pantalla.
- Se quieren **los dos modos** de conteo (unidad por unidad y escanear+cantidad), resueltos en
  una **pantalla unificada** sin interruptor.
- Orden acordado: **Entrega A (esta) primero**, Entrega B después.
