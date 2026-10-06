# Plan específico: precio de ML que deja el neto que queremos

**Fecha:** 2026-09-11
**Estado:** tramo 1 implementado y probado contra las 10 frenadas reales; pendiente de despliegue
**Alcance:** calcular, para cada publicación de ML, el precio que hace que el **neto** (después de
comisión y envío) iguale el **precio de contado** de la tienda. No toca el cálculo del neto, que
está bien.

**Se entrega en dos tramos, por decisión del usuario (2026-09-11):**

1. **Primero en el reactivador de publicaciones** (`public/sync-ml/`), sobre las publicaciones
   frenadas. Es el mejor banco de pruebas: son pocas, están frenadas justamente por este motivo,
   y el resultado se ve enseguida — la publicación vuelve a estar activa.
2. **Después en la auditoría de precios**, sobre las 526 que están fuera de rango.

**Siempre es una acción que dispara el usuario**, de a una o en lote sobre lo que seleccione.
Nunca un proceso automático que cambie precios solo.

## De dónde parte

`lib/mlPrecios.js` ya calcula el neto real con los números que da ML, no con tasas escritas a
mano:

```
neto = precio_ML − comisión (sale_fee) − envío a cargo del vendedor
```

- comisión: `GET /sites/MLA/listing_prices?price=&category_id=&listing_type_id=` → `sale_fee_amount`
- envío: `GET /users/{id}/shipping_options/free?item_id=` → `coverage.all_country.list_cost`
- caché persistente de 7 días (`ml_precios_cache`, decisión del usuario 2026-08-05)

La tabla `ml_precio_auditoria` tiene **1.431 publicaciones**: 900 `ok`, **357 `bajo`**, 169
`alto`, 5 sin precio web.

## El problema del cálculo actual

`precioSugerido()` existe y se usa en `routes/precios.js:236`, pero extrapola:

```js
const pct = saleFee / precioMl;              // tasa EFECTIVA de hoy
return Math.ceil((precioWeb + (envio || 0)) / (1 - pct));
```

**La comisión de ML no es proporcional: es porcentaje + un costo fijo.** Verificado sobre datos
reales — `FB-21170`, precio $12.000, comisión $2.904,65:

```
12.000 × 13,79% = 1.654,80      →  2.904,65 − 1.654,80 = 1.249,85  ≈ $1.250 fijos
```

La fórmula toma el 24,2% *efectivo* (que ya incluye el fijo) y lo estira a un precio mayor, con
lo cual multiplica el costo fijo. Para un objetivo de $12.000 de neto:

| | precio sugerido | neto real que deja |
|---|---|---|
| fórmula actual | $15.833 | **$12.400** |
| cálculo correcto | $15.370 | $12.000 |

**3% de más**, y crece cuanto más lejos esté el precio nuevo del actual.

**Y no hay fórmula global que lo arregle:** la tasa depende de la categoría y del tipo de
publicación. Medido sobre las 1.431 filas, dentro del tramo de más de $100.000 las tasas
efectivas van de **11,48% a 28,64%**. Cualquier porcentaje escrito en el código sería mentira
para la mitad del catálogo.

## El método: punto fijo, preguntándole a ML

No se extrapola nada. Se busca el `P` que cumple:

```
P = contado + comisión(P) + envío(P)
```

Iterativo, arrancando en `P₀ = contado / (1 − tasa_actual)` y recalculando con los valores que
devuelve ML **para el precio candidato**. Converge en 2 o 3 vueltas porque la comisión crece más
despacio que el precio (la iteración es contractiva). Se corta cuando dos vueltas seguidas dan
el mismo precio redondeado, con un tope de 5 iteraciones por las dudas.

Cada vuelta son dos llamadas a ML, las dos ya cacheadas 7 días. Para 526 publicaciones, el peor
caso es ~3.000 llamadas la primera vez y casi ninguna después.

## Decisiones del usuario (2026-09-11)

1. **El objetivo es el precio de contado**, y se acepta que el neto quede **hasta 5% por
   debajo** — la misma tolerancia que ya usa `veredictoNeto` (`tolUnder = 0.05`).
2. **Sugerir siempre; aplicar de a uno o seleccionando en lote.** Nada se escribe solo.
3. **Alcance: las 357 bajas y las 169 altas** (526 publicaciones). Las `ok` no se tocan.
4. **Redondeo hacia arriba a los $100.** Nunca por debajo del objetivo.
5. **El envío se pregunta al precio nuevo, no al de hoy.**

## Por qué eso último importa

El usuario lo marcó: *"los precios de envío nunca son iguales"*. Verificado — el envío lo manda
el producto, no el precio: el mismo $7.470 aparece en publicaciones de $47.000 y de $1.900.000.
Pero hay **172 publicaciones con envío $0**, y si a una de esas se le sube el precio y cruza el
umbral de envío gratis, aparece un costo de unos **$7.000** que no estaba en la cuenta. Con el
envío de hoy, esas quedarían cortas por más que todo lo demás esté bien.

## Tramo 1: el reactivador

La pantalla ya tiene la sección y el texto correcto: *«no las reactivó a propósito: al precio
actual en ML, venderían por debajo del precio de contado»*. Hoy el único botón es **Reintentar
reactivación**, que vuelve a evaluar lo mismo y vuelve a frenarlas — porque el precio sigue mal.

`ml_reactivacion_frenada` guarda lo que hace falta para calcular: `neto`, `precio_contado`,
`deficit_pct` y `precio_ml_evaluado`. Al 2026-09-11 hay **10 frenadas**, con déficits de **6,5% a
13,3%** — todas por encima de la tolerancia del 5%. Un caso típico: `FB-54622`, precio en ML
$993.219 contra un contado de $993.352; el precio es casi el mismo que el de la tienda, así que
después de comisión y envío el neto queda 13% abajo.

Se agrega un segundo botón: **Corregir precio y reactivar (N)**, sobre las seleccionadas.

1. Calcula el precio objetivo de cada una (punto fijo contra ML).
2. Muestra la lista con el desglose y el cambio de precio, y pide confirmación.
3. Aplica los precios en ML.
4. Reactiva, con el flujo que ya existe (`POST /api/sync/reactivar`).
5. Informa qué quedó activa y qué falló, por publicación.

Si una falla —ML rechaza el precio, o el cálculo no converge— esa queda frenada con su motivo y
las demás siguen. Nunca se reactiva una publicación cuyo precio no se pudo corregir: sería
volver a publicar a pérdida, que es exactamente lo que el freno evita.

## Qué se construye

### Backend

- **`precioObjetivoMl(db, mlCfg, { itemId, categoryId, listingTypeId, freeShipping, contado })`**
  en `lib/mlPrecios.js`, al lado del neto. Devuelve `{ precio, comision, envio, neto, vueltas,
  convergio, cruza_umbral_envio }`. Reemplaza a `precioSugerido()`, que queda marcada como
  obsoleta con el motivo escrito.
- **`cruza_umbral_envio`**: verdadero cuando el envío al precio nuevo difiere del actual. No
  frena nada — se muestra, porque cambia la ecuación del producto y el usuario tiene que verlo.
- **`POST /api/precios/objetivo`**: calcula para una lista de claves. Idempotente, respeta el
  rate limiter de ML que ya existe (`lib/mlRateLimiter.js`). Lo usan los dos tramos.
- **`POST /api/precios/aplicar`**: escribe el precio en ML para una publicación o para una lista.
  Fail-closed por ítem: si ML rechaza uno, los demás siguen y ese queda marcado con su error.
  Registra quién, cuándo, precio anterior y nuevo.
- **`POST /api/sync/reactivar-con-precio`**: el combo del tramo 1 — corrige y reactiva en una
  sola acción, reusando los dos endpoints de arriba y el reactivador que ya existe. No reactiva
  nada cuyo precio no se haya podido corregir.

### Pantalla — tramo 1 (reactivador)

- Botón **Corregir precio y reactivar (N)** junto al de reintentar, sobre la selección.
- Antes de aplicar, la lista de lo que va a pasar: precio de hoy → precio nuevo, y el neto
  resultante contra el contado.
- Al terminar, el resultado por publicación.

### Pantalla — tramo 2

En la auditoría que ya existe:

- Columna **precio objetivo** con el neto que va a dejar, al lado del neto de hoy.
- El desglose visible: *"$15.400 = $12.000 de contado + $2.150 de comisión + $1.250 fijo"*. Sin
  eso el número es un acto de fe.
- Aviso en las que cruzan el umbral de envío.
- Selección múltiple y **Aplicar**, con confirmación que muestra cuántas y el cambio total.

### Tests

- El caso `FB-21170` con comisión de porcentaje + fijo: el punto fijo da $15.370 y la fórmula
  vieja $15.833. Es la prueba de por qué se cambió.
- Convergencia: un ítem cuya comisión salta de tramo a mitad del cálculo.
- Un ítem que cruza el umbral de envío gratis: el precio tiene que incluir los $7.000.
- Redondeo hacia arriba a $100 que nunca deja el neto por debajo del objetivo.
- Aplicar en lote con un fallo en el medio: los otros se aplican, el que falla queda marcado.

## Fuera de alcance

- Tocar el cálculo del neto, que está bien y es lo que hace confiable a todo lo demás.
- Cambiar el descuento de contado (`precioContado`).
- Decidir si conviene bajar las 169 altas: la herramienta calcula y muestra; aplicar es del
  usuario, de a uno o en lote.
- Publicaciones sin precio web (5): no hay objetivo contra el cual calcular.

## Criterio de aceptación

0. En el reactivador, seleccionar las frenadas y apretar **Corregir precio y reactivar** deja las
   publicaciones activas con un precio cuyo neto ya no está por debajo del contado — y las que
   no se pudieron corregir siguen frenadas, con su motivo.
1. Para `FB-21170` con objetivo $12.000, el precio calculado deja un neto de $12.000 (±$100 por
   el redondeo), no $12.400.
2. Ninguna publicación queda con el neto por debajo del 95% del contado.
3. Una publicación con envío $0 que cruza el umbral trae el costo de envío incluido y el aviso.
4. El desglose que se muestra suma exactamente el precio propuesto.
5. Aplicar en lote con un error en el medio no interrumpe al resto ni pierde el registro.
6. `npm test` en verde.


## Lo implementado (2026-09-11) — tramo 1

- **`precioObjetivoMl`** en `lib/mlPrecios.js`. Dos fases y las dos hacen falta:
  1. **Punto fijo** `P ← contado + comisión(P) + envío(P)` hasta que el número se estabilice.
  2. **Cubrir el objetivo**: si por el redondeo a $100 el neto quedó corto, sube de a un paso.
- **`POST /api/precios/objetivo`**: calcula para hasta 100 claves. Sólo lee — no escribe nada.
- **Botón "Corregir precio y reactivar (N)"** en el reactivador, con el plan previo (precio de
  hoy → precio nuevo → neto → desglose) y confirmación. Aplica con `/actualizar-precio`, que ya
  existía y además borra la frenada, y recién después reactiva **sólo lo que se pudo corregir**.

### Dos defectos que aparecieron corriendo esto contra datos reales

**El endpoint de envío no mandaba el precio.** `costoEnvioMl` cacheaba por precio pero consultaba
`/shipping_options/free?item_id=...` sin `item_price`: ML respondía el costo del precio vigente,
así que todas las entradas de un item guardaban el mismo número bajo claves distintas. Para la
auditoría daba igual; para calcular un precio que todavía no existe, no. Ahora se mandan
`item_price` y `listing_type_id`. **Las 120 entradas `envio:` de la caché hay que invalidarlas al
desplegar**: se calcularon sin precio.

**El solver cortaba antes de tiempo, y mentía sobre el motivo.** Con 5 vueltas máximas, 6 de las
10 frenadas terminaban a menos de $20 del objetivo y se reportaban como *"la comisión crece más
rápido que el precio"*, que era falso. Y al arreglar eso apareció el problema inverso: cortar
apenas el neto superaba el objetivo dejaba precios hasta **$40.000 por encima** de lo necesario,
porque la semilla arranca 20% arriba. Un precio de más no es gratis: es una venta que no ocurre.
Las dos fases resuelven las dos cosas, y cada una tiene su test.

### Resultado sobre las 10 frenadas reales

Las 10 calculan, con el neto entre **$27 y $85** por encima del contado (el redondeo a $100):

| | contado | precio hoy | precio nuevo | neto nuevo |
|---|---|---|---|---|
| MLA1764610433 | $993.352 | $993.219 | **$1.145.500** | $993.400 |
| MLA1764598259 | $384.000 | $388.029 | **$442.900** | $384.091 |
| MLA1812420947 | $228.803 | $305.071 | **$337.500** | $228.830 |
| MLA1957482767 | $297.400 | $330.000 | **$361.500** | $297.464 |

Dos de ellas quedan marcadas con **"cambia el envío"**: el costo de envío al precio nuevo difiere
del actual.


## Tramo 2 (2026-09-11): la auditoría de precios

- **Selección múltiple** en la tabla: casilla por fila y un "marcar todas" que refleja lo que
  está visible después de los filtros en memoria. La selección sobrevive al re-render.
- **"Calcular precio objetivo (N)"** llama a `POST /objetivo` en tandas de 100 (el tope del
  endpoint). Sólo calcula: no escribe nada en ML.
- La columna **Sugerido** pasó a ser **Precio objetivo**, con el desglose, el delta contra el
  precio de hoy y el aviso *"cambia el envío"*.
- **"Aplicar precio en ML (N)"** con confirmación que dice cuántas suben y cuántas bajan.
  Fail-closed por ítem: si ML rechaza una, las demás siguen y esa queda listada con su error.
- El botón por fila pasó de **Corregir precio** (un `prompt` sembrado con el número viejo) a
  **Aplicar objetivo**, que aplica el precio ya calculado y muestra el neto contra el contado.

### Dos defectos que encontró este tramo

1. **`/objetivo` tomaba el contado de `c.precio` (precio VIGENTE) en vez de `c.regular_price`
   (LISTA)** — y además resolvía el SKU por `p.seller_sku` en vez de la decisión del matcher,
   que difiere en 2 publicaciones. Es exactamente el bug que ya se había corregido en
   `auditarPrecios` y que el endpoint nuevo reintrodujo. Hoy no hizo daño porque hay 0 productos
   en oferta, pero el primer día de descuentos el objetivo habría apuntado un 33% abajo del
   precio que la tienda cobra. Corregido y cubierto con un test propio.
2. **El desglose no sumaba el precio propuesto.** El redondeo hacia arriba a $100 quedaba fuera:
   $1.000 contado + $100 comisión + $50 envío mostraba un precio de $1.200. Ahora el redondeo es
   un término visible más, y el test verifica que los cuatro sumen exactamente el precio.

- **`precio_sugerido` ya no se devuelve** en `GET /api/precios`: esa fórmula cerrada ignoraba la
  parte fija de la comisión y la recotización del envío. La función queda en `lib/mlPrecios.js`
  sólo como caso de contraste en los tests.

### Verificado end-to-end contra ML (2026-09-11)

`MLA2045968956`: contado $73.544 (el mismo `precio_web` que la auditoría, o sea que el arreglo
del `regular_price` alineó las dos puertas), comisión $12.933,86, envío $7.290 → precio $93.800 y
neto $73.576,14. Convergió en 4 vueltas y avisa que cruza el umbral de envío.


## Desplegado el 2026-09-12 00:08

Tramos 1 y 2 en producción. Suite completa: 2.527 tests en verde; los 13 fallos de la corrida
(`woo.test.js` y `cobertura-route.test.js`) eran concurrencia — los dos archivos pasan enteros
corridos solos (73/73 y 76/76). Ningún precio se escribió todavía en ML: aplicar es del usuario.
