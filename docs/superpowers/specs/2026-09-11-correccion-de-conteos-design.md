# Spec: corregir conteos de sesiones ya cerradas

**Fecha:** 2026-09-11
**Estado:** diseño aprobado, sin implementar
**Alcance:** qué pasa cuando se detecta que un conteo ya confirmado estaba mal.

## El problema

Al 2026-09-11 hay **18 sesiones confirmadas**, **1.006 conteos ya ajustados** contra Woo y **188
diferencias** registradas. Una vez que una sesión se confirma, lo que se contó se escribió en el
stock publicado y no hay ninguna forma de tocarlo desde la herramienta.

Cuando después aparece que un conteo estaba mal —se tipeó 12 donde había 1, se contó una
variante por otra, o directamente no se contó algo que sí estaba— hoy la única salida es abrir
una sesión nueva sobre ese alcance, o editar el producto a mano en Woo. Lo primero es caro y no
dice por qué; lo segundo deja el sistema sin enterarse de nada.

Es el mismo agujero que ya apareció en preparación y en el conteo: **el hecho físico ocurre y
nadie lo asienta.**

## Decisiones del usuario (2026-09-11)

1. **Hay dos motivos distintos y los dos tienen que existir**: un recuento real (fui, lo conté,
   hay 3) y una corrección de carga (el número cargado estaba mal).
2. **Solo admin, y se aplica al toque.** Sin cola de aprobación: el que cuenta avisa, un admin
   la carga y se escribe en Woo enseguida.
3. **El asiento es una sesión de corrección propia**, con su fila en el historial, que apunta a
   la sesión corregida y puede abarcar varios productos.
4. **La sesión original no se reescribe.** Su detalle sigue mostrando lo que se contó ese día.
5. **Una corrección puede tocar un producto que no estaba en la sesión original**, porque el mal
   conteo puede haber sido una omisión.

## Por qué no se edita el conteo viejo

Era la opción más directa de explicar y se descartó a propósito. Editar la sesión 34 cambia
retroactivamente lo que dice haber pasado ese día: los $1.963.027 de faltantes que se aplicaron
dejarían de coincidir con el stock que efectivamente se escribió. Un inventario que se puede
reescribir no sirve para auditar nada — y auditar es exactamente para lo que existe.

El historial pasa a ser un libro de asientos: se suman, no se borran.

## Los dos motivos tienen matemática distinta

Esta es la parte que, mal hecha, escribe stock que no existe.

| Motivo | Qué sabés | Qué se escribe |
|---|---|---|
| **Recuento** | La cantidad física de ahora ("fui y hay 3") | **Absoluto**: se fija el stock contra lo que Woo tiene hoy, igual que un conteo normal |
| **Corrección de carga** | Que el número cargado estaba mal ("se tipeó 12, era 1") | **Relativo**: el ajuste original sobró en 11, se aplica −11 sobre el stock de hoy |

**Qué significa el número que se carga**, que es donde esto se puede malinterpretar:

- En un **recuento**, `cantidad` es lo que hay **físicamente ahora**. El sistema escribe ese
  valor contra el stock vivo de Woo.
- En una **corrección de carga**, `cantidad` es **lo que el conteo original tendría que haber
  dicho** (1, no 12). El sistema calcula `cantidad − cantidad_contada_original` (1 − 12 = −11) y
  aplica esa diferencia sobre el stock de hoy. Nunca pide el delta: pedir "−11" invita a
  equivocarse de signo.

La diferencia importa porque **entre la sesión original y la corrección hubo ventas reales**. Un
absoluto las pisa; un relativo las respeta. Si se usara siempre el absoluto, corregir un error de
carga de la semana pasada borraría todas las ventas de esa semana. Si se usara siempre el
relativo, un recuento nuevo arrastraría el error viejo.

La pantalla obliga a elegir cuál es, con esas palabras, y el asiento guarda la elección.

### Producto que no estaba en la sesión original

Es el caso de omisión: no se contó, la sesión lo cerró en 0 (o lo dejó como faltante) y en
realidad había 3. Entra como **recuento**: no hay número previo que corregir, hay una cantidad
física de ahora. El modelo lo soporta sin nada extra, porque la sesión de corrección tiene sus
propias filas de conteo.

## Modelo

Sin tablas nuevas. Dos columnas en `inventario_sesiones`:

- `tipo TEXT NOT NULL DEFAULT 'conteo'` — `'conteo'` | `'correccion'`
- `corrige_sesion_id INTEGER` — a qué sesión corrige (NULL en las de tipo `conteo`)

Y una en `inventario_conteos`:

- `motivo_correccion TEXT` — `'recuento'` | `'carga'`, NULL fuera de una corrección

Las correcciones reusan `inventario_conteos` y `inventario_diferencias` con su propio
`sesion_id`. Esa es la razón de no crear tablas: el historial, el detalle de diferencias, el
envío a etiquetas y la auditoría ya construidos siguen funcionando sin tocarlos.

## Qué se construye

### Backend

- **`POST /api/inventario/sesiones/:id/corregir`** (admin). Recibe la lista de productos a
  corregir: `[{ sku, cantidad, motivo }]`. Crea la sesión de corrección, escribe en Woo producto
  por producto y devuelve el resultado de cada uno.
- **Fail-closed por producto**: si Woo rechaza uno, los demás siguen y ese queda en la sesión de
  corrección con su error, igual que `/confirmar`. Nunca se marca ajustado lo que no se escribió.
- **`GET /api/inventario/sesiones`** suma `tipo` y `corrige_sesion_id` a cada fila.
- **`GET /api/inventario/sesiones/:id`** de una corrección devuelve, por producto, qué decía el
  conteo original (si estaba) y qué dice la corrección.

### Pantalla

- En el historial, botón **"Corregir conteo"** dentro de una sesión confirmada.
- Elegís productos —de la sesión, o buscando uno que no estuvo—, ponés la cantidad y elegís el
  motivo con sus dos etiquetas explícitas.
- Antes de confirmar, el detalle de lo que va a pasar: por producto, qué tiene Woo hoy, qué se va
  a escribir y por qué. Sin eso el número es un acto de fe.
- La fila nueva en la lista: `Corrección · 3 productos · sobre la sesión 34 · Jose`.

### Tests

- Recuento: el stock queda en la cantidad indicada aunque Woo se haya movido desde la sesión.
- Corrección de carga: se aplica la diferencia, y una venta ocurrida en el medio **no** se pisa.
- Producto que no estaba en la sesión original entra como recuento.
- Un fallo de Woo en el medio del lote no interrumpe a los demás ni marca ajustado el que falló.
- La sesión original queda intacta: sus conteos, sus diferencias y su estado no cambian.
- Solo admin.

## Consecuencia conocida, aceptada

Los reportes de la sesión original **no se netean**. Si la 34 registró $1.963.027 de faltante y
la mitad era un error de carga, el detalle de la 34 va a seguir diciendo $1.963.027 y la
corrección va a decir "+$950.000 sobre la 34". El neto es correcto; el número de la sesión vieja,
leído solo, no. Es el precio de no reescribir la historia, y está aceptado expresamente
(decisión 4). Cualquier reporte agregado que se construya después tiene que sumar las
correcciones, no leer una sesión aislada.

## Fuera de alcance

- Corregir un producto que no estuvo en **ninguna** sesión: eso ya se puede, es un conteo nuevo.
- Deshacer una corrección: se corrige con otra corrección. El libro no tiene goma.
- Cola de aprobación: decisión explícita de que solo admin y al toque.

## Criterio de aceptación

1. Corregir un producto de una sesión confirmada deja el stock de Woo en el valor esperado según
   el motivo elegido, y la sesión original sin un solo cambio.
2. Una corrección de carga sobre un producto que se vendió en el medio respeta esa venta.
3. La corrección aparece como fila propia en el historial, dice a qué sesión corrige, y su
   detalle muestra original vs. corregido por producto.
4. Un producto que no estuvo en la sesión original se puede corregir.
5. Un fallo de Woo deja ese producto sin marcar y los demás aplicados.
6. Un no-admin recibe 403.
7. `npm test` en verde.
