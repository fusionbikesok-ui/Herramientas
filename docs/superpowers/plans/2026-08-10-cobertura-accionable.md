# Cobertura de Catálogo: de informe a herramienta de trabajo

Fecha: 2026-08-10
Rama: `worktree-cobertura-accionable` (base `d09fa9f`, master local — NO `origin/master`)

## El pedido

Textual del usuario: *"Quiero que mejoremos cobertura catálogo, quiero poder trabajar más rápido
y cada vez menos faltantes en ML, que esté lo más posible en ML, pero como está ahora ni ganas
me dan de abrirlo para usarlo."* Y después: *"los de multipublicación no puedo hacerles nada"*,
*"no me importa si llega a ser un cambio enorme, tiene que ser fácil de usar y útil
principalmente"*.

## Diagnóstico, medido

**Hoy la herramienta es un informe, no una herramienta.** Cruzás, mirás cinco pestañas de listas
filtrables, y no hay una sola acción disponible. Mirás una pared de 693 renglones y cerrás.

| Dato | Valor |
|---|---|
| Faltantes | **693**, todos con stock real |
| Valor inmovilizado sin publicar | **~$746 millones** |
| Faltantes sin foto (no publicables ya) | solo **13** |
| Payload de la pantalla | **1 MB** |
| Publicaciones ML en caché | 6822 |
| **Publicaciones ML SIN `seller_sku`** | **3638 (53%)** |
| Decisiones del matcher en `omitir` | 2362 |

**El hallazgo que reencuadra todo el trabajo (lo aportó el usuario y se confirmó en los datos):**
los 693 faltantes **no son 693 productos por publicar**. `esFaltante` (`lib/cobertura.js:38`)
marca un producto como faltante si **ninguna** publicación de ML lleva su SKU — y hay 3638
publicaciones sin SKU cargado. O sea que en su mayoría *la publicación ya existe, pero está sin
vincular*.

El Matcher actual va **ML → WC** (dada una publicación, buscarle el SKU). Lo que falta es el
sentido inverso: **WC → ML** (dado un producto con stock sin publicación vinculada, encontrarle
la publicación que ya existe). Ese es el corazón de este trabajo.

### El hallazgo que define el diseño: el parecido de títulos miente

Prueba sobre 400 productos con stock, buscando candidato entre las publicaciones sin SKU por
coincidencia de palabras: **186 encuentran candidato con ≥60%**. Pero la muestra:

| Producto WC | Candidato ML propuesto | |
|---|---|---|
| Maxxis Ikon 29x2.20 **Alambre** | Maxxis Ikon R-29x2.20 **Kevlar** | ❌ otro producto |
| Pedales Shimano **M520** | Pedales Shimano **M540** | ❌ otro modelo |
| Piñón Shimano Hg500 **11-25T** | Piñón Shimano Hg50 **11-36t** | ❌ otro cassette |
| Cadena **Shimano Hg53** | Cadena **Sumc Sx10** | ❌ otra marca |

Todos entre 60% y 80% de coincidencia, **todos equivocados**. Lo que distingue a estos productos
—`M520` vs `M540`, alambre vs kevlar, `11-25T` vs `11-36T`— son justo los tokens que un match
por bolsa de palabras pesa poco, mientras que "pedales", "shimano" y "spd" suman de más.

**Un vínculo equivocado es peor que ninguno:** ata el producto a la publicación incorrecta y el
stock empieza a sincronizar contra el listado que no es — sobreventa y venta de un producto por
otro. Consecuencias de diseño, no negociables:
1. El puntaje **debe pesar fuerte los tokens discriminantes**: códigos alfanuméricos de modelo
   (`m520`, `hg500`, `sx10`), medidas (`29x2.20`, `11-25t`, `60ml`) y marca. Un candidato que
   difiere en un código de modelo **no es un candidato**, por más palabras que comparta.
2. **Nada se vincula sin confirmación humana.** Decisión del usuario: uno por uno.
3. La tarjeta **tiene que resaltar la diferencia** entre los dos títulos, para que `M520` vs
   `M540` se cace de un vistazo en vez de leer dos renglones enteros.

## Decisiones del usuario, ya tomadas

- **No publicar en ML desde la herramienta todavía.** Prefiere hacerlo a mano por ahora, pero el
  diseño tiene que dejarlo preparado para el futuro. **No se construye ahora.**
- **Confirmación uno por uno, pero rápida**: tarjeta con las dos fotos y los dos títulos con las
  diferencias resaltadas; confirmar o descartar con un toque.
- **Priorización: las cuatro a la vez** — valor inmovilizado, tandas por marca, más vendidos,
  stock alto.
- **Multi-publicación necesita cuatro acciones**: marcarla como correcta para que deje de
  aparecer, pausar o cerrar una publicación, ver el stock de cada una para detectar sobreventa,
  y desvincular una publicación del SKU.

## Definiciones del usuario (entrevista completa, nada asumido)

**Forma de la herramienta**
- Se **rehace entera**: se van las cinco pestañas. Cobertura pasa a ser herramienta de trabajo.
- **Todo calculado al entrar**, sin apretar nada, con un botón para forzar refresco contra ML.
- Modo de trabajo: **de a una, a pantalla completa**. Confirmás o descartás y aparece la
  siguiente.
- **Celular y computadora por igual**: ninguna puede ser la versión pobre de la otra.
- **Se elimina la carga de Excel** (no la usa). **Se conservan** los filtros por marca y
  categoría y la vista de **Problemas**.

**La tarjeta de confirmación** — muestra las cuatro cosas:
1. Las **dos fotos** lado a lado. 2. Los **dos títulos con las diferencias resaltadas**.
3. Los **dos precios**. 4. **Stock y categoría** de cada lado.

Acciones desde la tarjeta, las cuatro: **abrir la publicación en ML**, **marcar "solo local"**,
**mandar a "hay que publicarlo"**, y **saltear para verlo después**.

- Con varios candidatos: **se muestran los mejores Y además el usuario puede buscar a mano**
  entre las publicaciones. La búsqueda manual no es un extra: es parte del flujo.
- **Deshacer con historial**: lista de lo vinculado con opción de revertir. No alcanza con un
  "deshacer" efímero.

**Cola y progreso**
- Se arranca **eligiendo una marca** y se trabaja esa tanda. Se ven las marcas con su conteo.
- Progreso, las cuatro señales: **faltantes totales**, **resueltos en esta sesión**, **valor que
  dejó de estar parado**, y **cuánto falta de la marca actual**.
- Ritmo de uso: **todavía no lo sabe**. Consecuencia de diseño: tiene que servir igual para diez
  minutos sueltos que para dos horas — o sea, **retomar donde quedó no es opcional**.

**La lista de "hay que publicarlo"** — las tres cosas: mirarla y tacharla ahí, **exportarla a
Excel**, y que **prepare los datos para copiar y pegar** en el formulario de ML.

**Multi-publicación**
- Umbral **más de 2, como hoy**. Vive **en la misma herramienta, en otra sección**.
- Acciones: marcar como correcta, **pausar** (nunca cerrar), ver stock por publicación para
  detectar sobreventa, y desvincular del SKU.

**Solo ML** (publicaciones sin producto web): **sí interesan y con acciones** — vincularla a un
producto de la web (el mismo trabajo al revés), pausarla, y marcarla como correcta así está.

**Bordes**
- **Sin stock**: lista **aparte**, por si reponen. No se mezclan con la cola principal.
- **Variaciones**: **una tarjeta por variación**. Decisión explícita del usuario aun sabiendo que
  son más tarjetas — prioriza claridad por decisión sobre cantidad de toques.
- **Si ML no responde** al confirmar: **la decisión se guarda y se empuja después**, sin frenar
  al usuario. Es lo que ya hace `pushSkusPendientes`.

## Alcance

### 1. Matcher inverso (WC → ML) — el corazón

- Motor: extender `lib/matcherEngine.js`, que ya tiene `norm`, `toks`, extracción de color/talle
  y `candidatosDeItem` (ML→WC). Falta el inverso y, sobre todo, **el peso de tokens
  discriminantes**, que hoy no existe en ninguna dirección.
- Universo del lado ML: las **3638 publicaciones sin `seller_sku`**. Las 2362 decisiones en
  `omitir` merecen decisión explícita: ¿entran al universo o no? (ver Preguntas abiertas).
- La confirmación reutiliza lo que ya existe y está probado: escribe en
  `sku_matcher_decisiones` y el SKU viaja a ML por `pushSkusPendientes`
  (`lib/matcherPush.js`), con su mutex y su presupuesto. **No se inventa un camino de escritura
  nuevo.**
- Descartar también es una decisión que se persiste: un producto descartado no puede volver a
  aparecer mañana, o la herramienta vuelve a ser una pared.

### 2. Cola de trabajo priorizada

- Orden combinando las cuatro señales elegidas. **Las tandas por marca son el multiplicador
  real**: 99 Metha seguidos comparten categoría y atributos y se resuelven mucho más rápido que
  99 productos salteados. La priorización tiene que agrupar, no solo ordenar.
- Progreso visible y persistente: cuántos resolviste, cuántos quedan, dónde ibas. Que se pueda
  cerrar y retomar sin perder el hilo.
- "Más vendidos" necesita una fuente de datos que hoy hay que confirmar que exista (ver
  Preguntas abiertas).

### 3. Multi-publicación accionable

Las cuatro acciones pedidas. Ojo con la regla de negocio ya establecida: **un SKU con varias
publicaciones es intencional** (condiciones de venta distintas), así que "marcar como correcta"
es el camino esperado, no la excepción. Ver [[matcher-multi-publicacion]].

### 4. Peso y velocidad

`GET /api/cobertura/` devuelve **1 MB** de una. Hay que paginar o adelgazar: la pantalla tiene
que abrir rápido en el celular del depósito.

## Preguntas resueltas con el usuario

1. **Las 2362 decisiones en `omitir`: NO entran.** Se respeta la decisión previa. Cola más corta
   y sin re-preguntar lo ya descartado. (Costo asumido: si alguna se omitió por error, queda
   enterrada — aceptado explícitamente.)
2. **"Más vendidos" queda AFUERA.** No hay fuente confiable local: `ordenes_ml_procesadas` son
   196 filas y solo de ML, `pedidos_cache` son 235 y se poda a 60 días. El historial real vive en
   Woo y traerlo es un trabajo aparte. Se prioriza con **valor inmovilizado + tandas por marca +
   stock alto**, que ya tenemos. Sumar ventas queda como mejora posterior; **no inventar la
   señal ni derivarla de un proxy**.
3. **Sin candidato confiable → cola aparte de "hay que publicarlo"**, ordenada por valor. Son dos
   trabajos distintos (vincular vs publicar) y no se mezclan. Esa lista es, además, la que queda
   servida para automatizar la publicación en el futuro.
4. **Solo PAUSAR, nunca cerrar.** Pausar se deshace con un clic; cerrar es irreversible en ML y
   se pierde historial y reputación de la publicación. La acción de cerrar no se construye.

## Forma de entrega

**Todo junto, una sola entrega** (decisión del usuario, con la alternativa por partes ofrecida y
descartada). Consecuencia asumida: es una entrega grande y el usuario la ve recién al final. Por
eso el orden interno de construcción igual arranca por el matcher inverso —que es el que baja
los 693— y el resto se apila encima, para que si hay que recortar algo por tiempo se recorte
desde el borde y no desde el centro.

## Regla de despliegue

`npm test` verde + revisor OK + `probador-e2e` (toca `public/`) + auditor 🟢. Toca UX y UI
nuevas, así que van `disenador-ux` y `disenador-ui` antes de escribir código. Merge y
`pm2 restart` los autoriza el usuario.
