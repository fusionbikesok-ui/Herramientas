# Rediseño del contador de inventario — diseño

**Fecha:** 2026-09-11
**Estado:** implementado y verificado en navegador; pendiente de despliegue
**Maqueta:** `docs/superpowers/design/2026-09-11-conteo-propuesta.html` (+ PNG de teléfono y escritorio)

## Por qué

La herramienta se usa y funciona, pero el tiempo por ronda no baja y hay un bug que corrompe
conteos. Medido sobre la pantalla real el 2026-09-11:

- **"Elegir alcance": 247 controles y 8.198 px de alto** en un teléfono de 390 px. Dos muros de
  chips, ~100 categorías y ~150 marcas.
- **Pantalla de conteo: 78 controles visibles, 69 por debajo de 44 px.** Los 63 botones "Contar"
  miden 38×68; el checkbox de seleccionar todo, **13×13**; "← Inicio", 13 px de alto.
- **El campo de escaneo no es fijo** (`position: static`) en un documento de 6.386 px.
- **Cero imágenes**, aunque el 99% del catálogo tiene foto (4.560 de 4.588).
- El botón deshabilitado explica su motivo en un `title`, invisible en un teléfono.

Y el flujo real que describió el usuario: *"busco en la lista que me dice que no he contado,
después paso a los que he contado, scrollear al fondo buscando lo que acabo de añadir y sumarle
de a 1 unidad hasta llegar"*. Está en el código tal cual: la fila pendiente no tiene campo de
cantidad, sólo un botón que agrega 1 y **manda el producto a la otra lista**.

## El bug que se arregla primero

`inventario_conteos` es **única por `(sesion_id, ean)`**, y `POST /sesiones/:id/escanear` guarda
el código leído como `ean` aunque sea un SKU (`routes/inventario.js:1045`). El botón "Contar" de
la lista llama a ese mismo endpoint con el SKU. Consecuencia: **el mismo producto entra en dos
filas** si llega por dos caminos (dos EAN distintos, o escaneo + conteo manual), y **cada fila
genera su propia diferencia**.

Cuatro casos reales en producción:

| SKU | Qué pasó |
|---|---|
| `FB-67121` Casco Giro Caden II | contó 1 + 2 = **3, lo mismo que esperaba el sistema**; generó dos faltantes (−2 y −1) y **el stock quedó en 0** |
| `FB-62879` Calza Santini | dos faltantes idénticos de −1 |
| `FB-62881` Calza Santini | **tres sobrantes** de +1, $343.205 cada uno |
| `FB-62779` Guantes Santini | dos filas, una diferencia |

**Corrección:** la fila se resuelve **por producto**. Al escanear o contar, si ya existe una fila
con ese `sku` en la sesión, se le suma; sólo se inserta una fila nueva cuando no existe. El
`UNIQUE(sesion_id, ean)` se conserva como red para los códigos desconocidos (`sku IS NULL`), que
sí se identifican por el código leído.

**No se reescribe la historia.** Las sesiones 31 y 33 están cerradas y su stock ya se aplicó;
juntar sus filas ahora no devolvería el stock. Queda registrado acá y en la pantalla de
auditoría. `FB-67121` está publicado en 0 teniendo 3 unidades: eso hay que corregirlo en Woo a
mano, es una decisión de negocio, no una migración.

## Decisiones del usuario (2026-09-11)

1. **Al tocar un producto se abre el teclado numérico ahí mismo** y **la fila no se mueve de
   lugar**: queda donde estaba, marcada, con su cantidad.
2. **"Elegir alcance" se reemplaza por la ronda sugerida + un buscador.** Los muros de chips
   desaparecen.
3. **Las variantes se agrupan por producto**, con una foto y una cantidad por variante.
4. **Conteo a ciegas:** no se muestra la cantidad esperada hasta que el operario carga la suya.
   Fundamento: la práctica recomendada de cycle counting detecta 20-30% más diferencias sin el
   anclaje del número del sistema.
5. **Una sola lista**, sin separar "con stock" de "sin stock en sistema": esa división delata el
   número esperado. El backend sigue sabiendo cuáles esperaba con stock para exigir que se
   decidan antes de cerrar, pero no lo muestra.
6. **El buscador para asociar códigos entra en el alcance** y se diseña una sola vez para las
   cuatro herramientas que hoy tienen su propia versión.

## Fundamento de accesibilidad

- **WCAG 2.2 SC 2.5.8** fija 24×24 px como mínimo AA (44×44 es AAA / 2.5.5). El estándar propio
  del proyecto, por el uso con guantes, es **44 mínimo y 56 para la acción principal**.
- **SC 1.4.11** exige **3:1** para bordes y estados de los controles, no sólo para el texto: el
  borde del campo de cantidad y el estado "contado" tienen que verse.
- Se respeta `prefers-reduced-motion`; el foco es visible; ningún motivo vive sólo en un `title`.

## La pantalla de contar

Tres franjas; sólo la del medio scrollea.

**Superior fija (compacta).** El campo de escaneo **es también el buscador**: si el texto parece
un código, cuenta; si no, filtra la lista. 56 px de alto. Debajo, la **confirmación de la última
lectura**: nombre del producto, cuánto lleva acumulado y **Deshacer**. Es la señal que hoy no
existe y que habría delatado el duplicado.

**Medio.** La lista. Cada producto es una ficha con **foto de 72 px**, nombre en 16 px, y un
**único campo numérico de 74×56 px** que acepta tipear o ajustar. Sin ✕ ni 🏷️ al lado: esas
acciones van a un menú por fila. Las variantes se agrupan bajo una foto, con el talle/color como
dato principal — hasta **21 productos comparten la misma imagen**, así que ahí la foto no
distingue nada.

**Inferior fija (zona del pulgar).** Progreso real de la ronda ("38 de 151" + barra + tiempo
estimado restante) y el acceso a cerrar. El progreso honesto es lo que sostiene una ronda de 160
productos.

**Al cargar la cantidad** —y sólo entonces— la fila revela el resultado: *"coincide"* en verde o
*"el sistema tenía 10 · faltan 2"* en ámbar.

## El buscador para asociar un código

Hoy existen **cuatro implementaciones distintas** (Códigos, Consulta de precios, Conteo,
Recepción). Se unifica en un componente.

Sólo el **17% del catálogo tiene código cargado** (800 de 4.588, más 321 EAN asociados a mano):
asociar no es un caso raro, es el trabajo que hace posible escanear. Y en escritorio se asocia el
doble que en teléfono (176 contra 86 en 14 días).

- **El código leído, grande y arriba**, con su tipo.
- **Resultados con foto** — `/api/codigos/buscar` ya devuelve `img`, `gtin`, `stock`, `marca` y
  atributos con un `SELECT *`, y la pantalla los descarta hoy.
- **Píldora de estado del código:** verde *sin código* / ámbar *ya tiene 4550…*. Asociar hace un
  **PATCH del `global_unique_id` a WooCommerce**, y `/buscar` incluye a propósito productos que
  ya tienen código para permitir sobrescribir. Hoy eso ocurre sin ninguna señal, y es la forma
  exacta de los casos `gtin_contradictorio` que siguen urgentes en UM1.
- **Con variantes se invierte la jerarquía:** el nombre se apaga y el talle/color manda.
- **En escritorio el teclado es el eje:** el lector escribe en el campo, ↑↓ eligen, Enter asocia,
  Esc saltea.

## Escritorio: no es la misma pantalla estirada

El uso real lo demuestra. De las **12 sesiones de conteo** de los últimos 14 días, **las 12 se
abrieron desde un iPhone**. Pero el escritorio es el 37% del tráfico y hace dos trabajos propios:

| Acción | iPhone | Escritorio |
|---|---|---|
| Escanear | 1.098 | 494 |
| Asociar un EAN a un SKU | 86 | **176** |
| Confirmar la sesión | pocos | **42** |

Entonces: móvil manda en **contar**; escritorio es ciudadano de primera en **asociar códigos** y
**cerrar la ronda**, con flujo de teclado y sin mouse.


## El historial: hoy sólo se mira

Pedido del usuario: *"no puedo hacer casi nada desde allí, solo verlo"*. Es exacto — la fila
abre un detalle de sólo lectura (`modoHistorial = true`) con dos contadores. Y hay material para
trabajar: las 10 últimas sesiones acumulan **139 diferencias por $29 millones**, la sesión 31
sola tiene 36 diferencias por $8,4 M.

Acciones que se agregan a la fila del historial:

- **Ver las diferencias de esa sesión**, con su valor en pesos, ordenadas por lo que más duele.
  Hoy las diferencias sólo se ven agregadas en la tarjeta de auditoría del inicio, sin poder
  atribuirlas a una ronda.
- **Recontar el mismo alcance**: crea una sesión nueva con la categoría/marca de aquella. Es lo
  que se quiere hacer cuando una ronda dio diferencias raras.
- **Enviar los SKU a etiquetas** (ver abajo).
- **Exportar a CSV** la sesión con cantidades, esperado, diferencia y valor.
- **Reintentar los ajustes que fallaron**, cuando `sin_ajustar > 0`. El endpoint de confirmar ya
  reintenta; falta el botón.

## Etiquetas: el botón que cierra el círculo del 17%

Pedido del usuario: poder mandar a imprimir las etiquetas con los SKU **desde el conteo y desde
el historial**. Es la contracara del dato que explica todo: sólo el 17% del catálogo tiene código
cargado, así que hoy no se puede escanear. Cada etiqueta pegada hace escaneable un producto para
siempre.

Estado verificado: `public/etiquetas/` **funciona** — editor, "Cola de conteo", "Desde
inventario", generar e imprimir con `@media print`, y marcar como impresas. La cola tiene **56
filas, todas pendientes, todas de origen `preparacion` y ninguna impresa**: nadie las bajó al
editor. Del conteo nunca entró ninguna, aunque el botón 🏷️ por fila existe — mide 38 px y está
pegado a la ✕ de eliminar.

- **En el conteo:** la acción por producto sale del menú de la fila (ya no compite con la
  cantidad), y se suma **"Mandar a etiquetas"** sobre la selección: los que acabo de contar, los
  que no tienen código, o los seleccionados a mano.
- **En el historial:** "Enviar los SKU de esta sesión a etiquetas", que es el caso natural —
  terminé de contar Shimano, quiero las etiquetas de todo lo que conté.
- **Backend:** `POST /api/etiquetas/cola` acepta un SKU por llamada; mandar 137 serían 137
  pedidos. Se agrega **`POST /api/etiquetas/cola/lote`** con una lista, idempotente por
  `(sku, sesion_id)` para que tocar dos veces no duplique la etiqueta.
- La cantidad por defecto es **1 etiqueta por producto**, no una por unidad contada: se pega en
  el estante, no en cada unidad. Editable antes de mandar.

## Contratos de API

- `POST /sesiones/:id/escanear` — resuelve por SKU dentro de la sesión (ver arriba). Devuelve
  `{ item, total_del_producto, creado }` para que la pantalla muestre la confirmación con el
  acumulado.
- `GET /sesiones/:id` — **deja de enviar `stock_inicial`/`stock_actual` de los ítems no contados**
  mientras la sesión esté abierta. El número esperado se envía sólo para los ítems ya contados,
  junto con la diferencia. El gate de cierre sigue funcionando en el backend.
- `GET /sesiones/:id/progreso` — contados, total y ritmo, para la barra inferior.
- `GET /api/codigos/buscar` — sin cambios; ya devuelve todo lo necesario.
- `GET /sesiones/:id/diferencias` — diferencias de esa sesión con nombre, foto y valor.
- `POST /etiquetas/cola/lote` — alta masiva idempotente desde conteo o historial.

## Sonido de la lectura (2026-09-11, tercera tanda)

Antes había **un solo beep**, y sonaba al ENTRAR el código, antes de que el servidor
respondiera: decía "te escuché", nada sobre el resultado. Las guías de depósito recomiendan dos
sonidos por lectura —uno de lectura y otro de dato aceptado— más uno distinto para el error.

| Momento | Tono | Qué significa |
|---|---|---|
| Código leído | 880 Hz | te escuché |
| Primera unidad | 660 → 990 (asciende) | producto nuevo en la ronda |
| Suma | 990 · 990 (doble igual) | **ese producto ya estaba contado** |
| Sin asociar / desconocido | 240 Hz (grave, largo) | hay que resolverlo |
| Fuera de alcance | 520 → 380 (desciende) | se registró como hallazgo |

**La distinción entre primera unidad y suma es propia de este sistema** y sale del incidente del
casco Giro: si escaneás lo que creés que es la primera unidad y suena el tono de suma, ese
producto ya estaba contado. Es la señal que faltaba el 2026-09-08. La decisión de qué tono
corresponde vive en `ConteoLista.tipoDeSonido` con sus tests.

Hay un botón para silenciar en el panel "Más", y la preferencia sobrevive a recargar.

**No se usa vibración, y es deliberado.** Safari en iOS nunca soportó oficialmente la Vibration
API, y desde iOS 18.4 exige una interacción táctil que caduca en 1 segundo: un escaneo con lector
no toca la pantalla, así que nunca entra en esa ventana. Como las 12 sesiones de conteo de los
últimos 14 días se abrieron desde un iPhone, agregar `navigator.vibrate` sería código que no hace
nada y parece una función. (Preparación sí lo llama hoy; ahí es un no-op silencioso.)

Verificado interceptando el audio del navegador: `[880, 660, 990]` en la primera unidad,
`[880, 990, 990]` en la segunda, `[880, 240]` en un código desconocido, y `[]` con el sonido
silenciado.

## Fuera de alcance

- Cámara como método principal de escaneo (queda como está).
- Corregir en Woo el stock de `FB-67121` y las categorías de los repuestos Shimano en CASCOS.

## Criterio de aceptación

1. Escanear un EAN, escanear otro EAN del mismo producto y tocar "contar" en la lista **suman a
   la misma línea** y producen **una sola diferencia**.
2. Contar un producto **no lo mueve de lugar** en la lista.
3. Mientras la sesión está abierta, la respuesta de la API **no contiene la cantidad esperada**
   de un producto sin contar.
4. Ningún control interactivo por debajo de 44×44 px; la acción principal, 56.
5. Elegir alcance se resuelve sin scrollear muros de chips.
6. Los resultados del buscador de asociación muestran foto, y marcan en ámbar el producto que ya
   tiene código.
7. Desde el historial se puede ver las diferencias de una sesión, recontar su alcance y mandar
   sus SKU a etiquetas.
8. Mandar dos veces los SKU de la misma sesión a etiquetas **no duplica** las filas de la cola.
9. `npm test` en verde.


## Lo implementado (2026-09-11)

**Backend** (`routes/inventario.js`, `routes/etiquetas.js`):

- **La fusión al asociar.** El diagnóstico inicial de esta spec era impreciso y quedó corregido
  arriba: `/escanear` ya deduplicaba por SKU desde el 2026-08-25. El agujero estaba en
  `/asociar`, que ponía el SKU sobre la fila del EAN sin mirar si la sesión ya tenía otra con
  ese mismo SKU. Ahora funde y devuelve `fusionado: true`.
- **Conteo a ciegas.** Con la sesión abierta, `GET /sesiones/:id` no manda `stock_inicial`,
  `stock_actual`, `stock_woo` ni `bloque` de un producto sin contar, y **reordena**: el orden
  `con_stock` primero delataba el bloque aunque el bloque no viajara. Con la sesión cerrada se
  manda todo: ahí se está auditando, no contando.
- **Foto y datos de orden** en items y pendientes, para que la lista única mantenga la posición.
- `GET /sesiones/:id/diferencias` y `POST /etiquetas/cola/lote` (idempotente por sku+sesión).
- `itemOut` resuelve `nombre` e `img`: la confirmación de lectura mostraba el SKU dos veces.

**Frontend** (`public/inventario/index.html`, `public/lib/conteoLista.js`):

- Lista única con ficha de producto: foto, nombre, y un solo campo numérico de 66×56 que se
  tipea. `⋯` abre el menú con etiquetas y borrar, que antes competían con el número.
- Franja superior fija con el campo que **escanea y busca**, más la confirmación de la última
  lectura con Deshacer. Franja inferior fija con el progreso real y el tiempo estimado.
- El filtro por defecto pasó a **Todos**: con "sin contar" por defecto, contar un producto lo
  sacaba de la vista — otra forma del mismo problema.
- Los muros de chips del alcance quedaron plegados detrás de un `<details>`.
- Buscador de asociación con foto, variante y píldora del estado del código, más confirmación
  explícita antes de pisar un código existente en Woo.
- Historial con acciones: ver diferencias de la ronda, mandar sus SKU a etiquetas, recontar.

**Medido en el navegador, en 390 px:**

| | antes | después |
|---|---|---|
| Controles por debajo de 44 px en el conteo | **69** | **0** |
| Alto de "Elegir alcance" | **8.198 px** | **1.043 px** |
| Fichas visibles sin scrollear | 3 | 7 |
| Fotos de producto | 0 | 151 |
| Contar mueve la fila de lugar | sí | **no** |

## Escritorio (2026-09-11, segunda tanda)

No es la pantalla del teléfono estirada: en 1440 px cada ficha medía **1.076 px de ancho**, con
la foto a la izquierda y el número a 800 px de distancia.

- **Dos paneles** a partir de 1024 px: lista compacta a la izquierda (ficha de 60 px de alto,
  9 visibles) y el producto en curso a la derecha, con foto grande y un campo de 76 px.
- **El teclado es el eje**, que es lo que pide el uso real (176 códigos asociados en escritorio
  contra 86 en teléfono, y 42 sesiones cerradas): el lector escribe en el campo de arriba,
  **↑↓** mueven la selección, **Enter** guarda y salta al siguiente, **Esc** vuelve al campo.
- **El buscador de asociación** también: ↑↓ eligen, Enter asocia, Esc saltea, con el primer
  resultado ya marcado para que Enter directo haga lo esperable.

Un detalle que costó encontrar: el bloque CSS de escritorio quedó **antes** del de la ficha, así
que las reglas base lo pisaban por orden (misma especificidad, gana la última). La ficha seguía
midiendo 84 px en vez de 60 hasta que se movió el bloque.
