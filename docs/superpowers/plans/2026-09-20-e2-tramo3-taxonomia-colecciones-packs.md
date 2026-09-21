# Plan de implementación — E2 tramo 3 (taxonomía propia, colecciones y packs)

**Fecha:** 2026-09-20 · **Entrega:** E2 · **Dependencias:** tramos 1 y 2, desplegados en producción.

## Qué habilita, y qué no

El alcance lo fija el contrato de la ficha E2, no una suposición: **incluye** «taxonomía» y
«composiciones de packs/kits»; **no incluye** «cambios en Woo/ML». Todo este tramo es **en sombra**:
lee de los canales y escribe sólo en PostgreSQL. Ningún paso escribe en Woo ni en ML.

De los cuatro objetivos que eligió José el 2026-09-20, dos son de este tramo y dos no:

| Objetivo | Dónde |
|---|---|
| Navegación y reportes propios por rubro | **E2 T3** — es el resultado de este plan |
| Packs y kits vendibles | **E2 T3** como composición en sombra; la venta no |
| Publicar en ML por categoría | **E13** «Publicación verificada por categorías» (depende de E4 y E12) |
| Limpiar la mezcla de categorías en Woo | fuera de E2: es escritura en el canal |

Los dos de afuera no se pierden: **dependen de que este tramo produzca la taxonomía que consumen.**

## Línea base medida (2026-09-20, producción)

- **81 categorías** distintas en el catálogo de Woo, que son **tres cosas mezcladas en un mismo campo**:
  **65 de taxonomía real** (`CUBIERTAS`, `CASCOS`, `TRANSMISIÓN`, `ZAPATILLAS`), **15 de marca** (todas
  `BICICLETAS <marca>`, más `FANTTIK` sin prefijo, y `BICICLETAS POR MARCA`, que es un nodo contenedor con
  969 productos) y **1 de colección** (`Hotsale`, 183 productos).
- **155 marcas** distintas en el legado; **204** que ML declara como atributo; **207** valores distintos de
  `categoria_canal` ya capturados por el tramo 2.
- **La jerarquía no existe en ningún dato nuestro.** `catalogo_cache.categorias_json` guarda sólo nombres
  planos (`["ZAPATILLAS"]`) y el crudo de Woo que capturó el tramo 2 también (`[{"name":"..."}]`): sin `id`,
  sin `parent`, sin `slug`. `INDUMENTARIA Y CALZADO` (697) es evidentemente el padre de `ZAPATILLAS` y
  `JERSEYS`, pero eso no está en los datos. **Una variación de Woo trae `categories: []`**: las categorías
  viven en el producto padre.
- **Suciedad a decidir:** solapamientos (`CUBIERTAS` / `Cubiertas y Cámaras` / `CAMARAS`; `HERRAMIENTAS` /
  `INFLADORES Y HERRAMIENTAS` / `INFLADORES`; `LÍQUIDOS` / `LIQUIDOS DE FRENOS`, con y sin tilde),
  mayúsculas inconsistentes (`Taller`), bolsa de descarte (`OTROS`, 4) y entradas que no son rubro de
  producto (`QR PAGOS` 1, `SERVICES` 13, `ASPIRADORAS` 3, `FUSIBLES` 4, `SMARTWATCH` 5).
- La tabla `categorias_criticas` del legado existe y está **vacía**: creada y nunca usada. No es insumo.

## Decisiones tomadas, y por qué

1. **La jerarquía de Woo es EVIDENCIA EXTERNA, nunca el árbol propio.** Se importa, se guarda y se muestra,
   pero no se promueve a taxonomía automáticamente. Copiarla sería heredar la mezcla de marca y colección
   que este tramo viene a separar, y desmontarlo después es caro.
2. **Tres entidades separadas: categoría, marca y colección.** No comparten tabla ni semántica. Hoy
   comparten campo en Woo y eso es precisamente el defecto.
3. **Identidad propia estable, independiente de nombre y slug.** Renombrar o mover un nodo no puede romper
   plantillas (E12) ni lotes de publicación (E13).
4. **Un solo padre por categoría** (árbol/bosque), **un producto en varias categorías** pero con
   **exactamente una primaria** cuando esté listo para publicar. La polijerarquía haría ambiguos el
   breadcrumb, la herencia de plantillas, los conteos y los lotes de E13, que necesita una selección
   determinista.
5. **El mapeo a categorías de canal es por ID remoto, no por nombre**, por canal y por cuenta, y admite
   «sin equivalencia» y varios mapeos históricos.
6. **Archivar, no borrar** (`plataforma_app` no tiene DELETE en `catalog`, y además las propuestas y lotes
   históricos tienen que seguir siendo referenciables).
7. **Los packs se componen de VARIANTES VENDIBLES, no de modelos.** El inventario y la venta operan sobre
   SKU; componer a nivel modelo se pagaría carísimo en E5, cuando aparezca el libro de stock.
8. **Las colecciones tienen vigencia** (inicio/fin) y pertenencia muchos-a-muchos; no son ramas del árbol.
9. **Los packs nacen en borrador y sin reglas de negocio**: sin precio, sin reserva de stock, sin explosión
   de pedidos y sin publicación. Esas cuatro cosas quedan explícitamente diferidas.

## Decisiones cerradas por José (2026-09-20, con la jerarquía real a la vista)

Antes de preguntar se trajo la jerarquía real de Woo (`GET /products/categories`, lectura pura, 82
categorías). **73 de 82 tienen padre y el árbol tiene 3 niveles**: lo que nuestros datos guardaban era ese
árbol aplanado, no una lista plana. Eso disolvió D3 solo.

- **D1 — El árbol propio se diseña de cero.** La jerarquía de Woo NO se promueve: se importa como evidencia
  (tarea 1) y se mapea contra el árbol propio (tarea 5). El árbol propio se propone en la tarea 5 y José lo
  revisa; Woo queda como una correspondencia más, no como fuente.
- **D2 — Las cuatro raíces que no son rubro de producto:**
  - `Hotsale` (29) → **colección con vigencia**, fuera del árbol.
  - `SERVICES` (12) y `Taller` (11) → **rubro propio de servicios**, aparte del árbol de productos: no
    tienen stock, marca ni GTIN.
  - `FANTTIK` (7) → **marca canónica, no nodo**; sus hijos `INFLADORES` (3) y `ASPIRADORAS` (2) se recolocan
    bajo `ACCESORIOS`.
- **D3 — Los «solapamientos» no existían.** Eran padre e hijo, y la importación plana los había puesto al
  mismo nivel: `Cubiertas y Cámaras` ⊃ {`CUBIERTAS`, `CAMARAS`, `ACCESORIOS TUBELESS`};
  `INFLADORES Y HERRAMIENTAS` ⊃ `HERRAMIENTAS`; `LÍQUIDOS` ⊃ `LIQUIDOS DE FRENOS`. Tampoco eran anomalías
  `FUSIBLES` (cuelga de `TRANSMISIÓN`: son fusibles de shifter) ni `SMARTWATCH`/`QR PAGOS` (de `ACCESORIOS`).
  Ninguno se fusiona: la jerarquía ya los distinguía.
- **D4 — `BICICLETAS POR MARCA` y sus 14 hijos se colapsan a un árbol por TIPO de bici** (MTB, ruta, gravel,
  infantil, urbana…) con la marca como eje separado. «Bicicletas Trek» se responde filtrando marca, no con un
  nodo. `BICICLETAS INFANTILES` ya estaba cortada por tipo, no por marca. Profundidad: el árbol de Woo llega
  a 3 niveles y el propio no necesita más; no se fija un máximo en el esquema (una restricción de
  profundidad en la base impediría una reorganización legítima), pero sí se prohíben los ciclos.

La evidencia cruda de la jerarquía quedó en `docs/superpowers/specs/e2/woo-categorias-2026-09-20.md`.

### D5 — Los 4 solapamientos sin emparentar, cerrados por José (2026-09-20)

Aparecieron recién con las 82 categorías de Woo importadas (`solapamientos.sinEmparentar` del informe). Son
los únicos que la jerarquía del canal NO resolvía sola, y los cuatro eran la misma pregunta: manda el rubro o
manda la marca/material.

- **`INFLADORES Y HERRAMIENTAS` (70) engloba las dos cosas**, infladores y herramientas. Entonces
  `INFLADORES` (1209), que hoy cuelga de `FANTTIK`, pasa a colgar de 70 — y no de `ACCESORIOS` como decía D2.
  D2 queda corregida en esa mitad: de los dos hijos de FANTTIK, `ASPIRADORAS` (1208) va a `ACCESORIOS` (57) y
  `INFLADORES` va a 70, porque hay un rubro que ya es exactamente su lugar.
- **`ACCESORIOS TUBELESS` (96) está bien separado** colgando de `Cubiertas y Cámaras`: lo que está mal es el
  nombre, que se parece a `ACCESORIOS` (57) sin tener nada que ver. Se renombra EN NUESTRO ÁRBOL; la categoría
  de Woo no se toca (escribir en el canal no es parte de este tramo, y el mapeo va por id, no por nombre).
- **`LIQUIDOS DE FRENOS` (715) se queda bajo `LÍQUIDOS` (59)**, no bajo `FRENOS` (95). Manda el tipo de
  producto, no la función.
- **`CÁMARAS DEPORTIVAS` (1144) son cámaras de acción** y no tienen relación con las de rueda: se queda en
  `ACCESORIOS`. Y **`CAMARAS` (126) queda absorbida por `Cubiertas y Cámaras` (1477)**: no hay nodo propio de
  cámaras en el árbol nuestro, y la categoría 126 del canal mapea al nodo `Cubiertas y Cámaras`.

### D6 — `Cubiertas y Cámaras` queda como nodo hoja (2026-09-20)

Se absorben **las dos** hijas: `CUBIERTAS` (119) y `CAMARAS` (126) dejan de ser nodos y sus categorías de
canal mapean al nodo `Cubiertas y Cámaras` (1477). La distinción cubierta/cámara —y rodado, y las demás— pasa
a ser **atributo del modelo**, no lugar en el árbol, y se resuelve en la entrega de atributos, no acá.

Es la razón por la que este árbol puede ser corto: lo que varía por producto y se combina libremente (rodado
× tipo × medida) no es jerarquía. Ponerlo como nodos multiplica las ramas y después no se puede filtrar en
cruz. El árbol responde «qué clase de cosa es»; los atributos, «cuál».

`ACCESORIOS TUBELESS` (96) se llama **`INSUMOS TUBELESS`** en nuestro árbol. La categoría de Woo conserva su
nombre: el mapeo es por id.


## Estructura de archivos

```
plataforma/migrations/0015_catalogo_taxonomia.sql      (tareas 1, 5 y 7: un solo cambio de esquema)
plataforma/src/catalogo/taxonomia.ts                   (árbol propio, marcas, colecciones)
plataforma/src/catalogo/categorias-canal.ts            (importación de las categorías de cada canal)
plataforma/src/catalogo/informe-taxonomia.ts           (candidatos, solapamientos y cobertura)
plataforma/src/catalogo/packs.ts                       (composiciones, tarea 7)
scripts/catalogo-categorias-importar.mjs               (tarea 1)
scripts/catalogo-informe-taxonomia.mjs                 (tarea 3)
plataforma/test/catalogo/taxonomia.test.ts
plataforma/test/catalogo/categorias-canal.test.ts
plataforma/test/catalogo/packs.test.ts
docs/superpowers/specs/e1/schema.sql                   (el contrato, a mano, en cada tarea de esquema)
```

## Orden y cortes revisables

Las tareas 1 a 3 **entregan valor sin esperar ninguna decisión de José**, que es el ajuste que trajo la
revisión externa: antes el plan quedaba bloqueado en la decisión del árbol.

### Tarea 1 — Importar las categorías de cada canal como evidencia

`/products/categories` de Woo trae `id`, `parent`, `slug`, `name` y `count`; hoy **no se importa nada de
eso**. De ML ya tenemos los 207 códigos `MLA…` capturados como `categoria_canal`, y su nombre se resuelve
aparte. Tablas nuevas: `catalog.channel_categories` (por canal y cuenta, con `parent_externo`, `slug`,
`capturado_en` y `vigente_hasta`) y su histórico. En sombra, sin escribir en el canal.

**Aceptación:** el árbol de Woo queda reconstruible con una consulta recursiva; `INDUMENTARIA Y CALZADO`
aparece como padre de `ZAPATILLAS`; la corrida es idempotente y reanudable; una categoría que desaparece del
canal se marca `vigente_hasta` y no se borra.

### Tarea 2 — Marcas canónicas y colecciones con vigencia

Canonicalizar las 155 marcas del legado contra las 204 que ML declara; detectar las 15 categorías que son
marca mal usada. Colecciones como entidad propia con vigencia y pertenencia muchos-a-muchos; `Hotsale` migra
como primera colección, con su membresía actual como evidencia.

**Aceptación:** cada modelo tiene a lo sumo una marca canónica; las 15 categorías-marca quedan marcadas como
tales sin borrarse; `Hotsale` es consultable como colección con sus 183 productos; una colección vencida deja
de listar sin perder su historia.

### Tarea 3 — Informe de candidatos, solapamientos y cobertura

El insumo con el que José decide D1–D4: nombres normalizados, duplicados probables con su evidencia,
cantidad de productos, ejemplos, y **cobertura**: productos sin categoría útil, con varias candidatas, sólo
con marca o colección, o con clasificaciones contradictorias entre canales.

**Aceptación:** el informe reproduce los tres grupos medidos (65/15/1), lista los solapamientos conocidos y
es reproducible con un comando de sólo lectura.

### Tarea 4 — José decide el árbol (no es código)

Con la jerarquía real y el informe a la vista. Cierra D1–D4.

### Tarea 5 — El árbol propio, versionado

`catalog.taxonomy_nodes` con identidad propia, un solo padre, `archivado_en` y **versión del árbol**: E12
genera propuestas contra una versión concreta y E13 debe publicar exactamente la aprobada. Mapeo
`catalog.taxonomy_channel_map` por ID remoto, canal y cuenta, admitiendo «sin equivalencia».

**Aceptación:** no hay ciclos (verificado con un caso que los intenta); renombrar un nodo no cambia su ID ni
rompe mapeos; una versión pasada se puede reconstruir entera.

### Tarea 6 — Mapear los productos al árbol, con primaria explícita

Cada modelo contra el árbol propio, con **exactamente una categoría primaria** cuando esté completo, y las
secundarias sin límite. Lo que no se pueda mapear abre un caso para revisión, nunca se adivina.

**Aceptación:** consultas de negocio reales responden («qué cubiertas Maxxis tengo publicadas en los dos
canales»); ningún modelo tiene dos primarias; el conteo por rubro cuadra con el total del catálogo.

### Tarea 7 — Composiciones de packs y kits, en sombra

`catalog.pack_components`: **componentes por variante vendible**, con cantidad, unidad, versión y vigencia.
Nace en borrador. Prohibición de ciclos y de componentes archivados. **Sin** precio, reserva de stock,
explosión de pedidos ni publicación: diferidos explícitamente.

**Aceptación:** un pack se compone y se lee con sus componentes y cantidades; un ciclo es rechazado; una
venta futura puede reconstruir qué componentes tenía el pack en una fecha dada.

### Tarea 8 — Contrato del esquema y suite completa

`docs/superpowers/specs/e1/schema.sql` al día a mano y la lista de migraciones de
`test/migraciones.test.ts` actualizada — los dos mordieron en el tramo 2. Las dos suites en serie, sin nadie
más trabajando, al final del tramo.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Copiar la jerarquía de Woo como árbol propio | decisión 1: es evidencia; la promoción es explícita y humana |
| Componer packs por modelo y pagarlo en E5 | decisión 7: componentes por variante vendible |
| Un árbol sin versión rompe E12/E13 al renombrar | decisión 3 y tarea 5: identidad estable y versión |
| Importar categorías consume cupo de ML | `/products/categories` es de Woo; de ML ya tenemos los 207 códigos capturados, no hay barrido nuevo |
| El informe abre cientos de casos de revisión | la tarea 3 los CUENTA antes de que existan, como en el tramo 2 |
| Otra variable nueva sin declarar en compose | `E2-CFG-03` ya cubre los cuatro grupos y falla nombrándola |

## Rollback

Cada tarea de esquema es aditiva y con columnas nullable: el código viejo sigue funcionando. Apagar el tramo
es dejar de leer las tablas nuevas; no hay borrado de datos en ningún paso y nada se escribe en los canales,
así que **el rollback no puede dejar inconsistencia remota**.

### D7 — El árbol definitivo: dos niveles, el resto es faceta (2026-09-20)

José definió el árbol completo. La restricción que lo gobierna es de diseño de la home: **el menú despliega
el nivel 1 y muestra el nivel 2, y nada más**; todo lo que en Woo era un tercer nivel se alcanza por búsqueda
facetada sobre atributos. Queda en `plataforma/src/catalogo/arbol-fusionbikes.ts`: **65 nodos, 6 raíces,
profundidad 2**, con las 82 categorías de Woo con destino (nodo, absorción o fuera por decisión).

Raíces: `BICICLETAS POR MARCA` (15 hijas), `COMPONENTES Y REPUESTOS` (9), `ACCESORIOS` (16),
`INDUMENTARIA Y CALZADO` (13), `TALLER` (6, absorbió la raíz `LÍQUIDOS`), `SANTINI`.

Esto **revierte D4 y la mitad de D2**: las marcas de bici vuelven a ser nodos, y `FANTTIK` y `SANTINI` son
nodos visibles. Decisión del dueño del negocio, tomada con la jerarquía a la vista. Consecuencia asumida: la
marca vive en dos lugares, como nodo (un lugar en el menú) y como marca (un eje de filtrado). NO son
redundantes —si la marca sólo fuera nodo, filtrar por marca dejaría de funcionar— pero hay que mantener los
dos, y ahí es donde se van a desincronizar si nadie lo cuida.

Lo que **se convirtió en faceta** (20 categorías, `ABSORBIDAS`): el desglose de frenos, ruedas, dirección,
asientos, horquillas y pedales; `CUBIERTAS`/`CAMARAS`/`INSUMOS TUBELESS`; `SHIFTERS`/`FUSIBLES`;
`HERRAMIENTAS`/`INFLADORES`; `CALZAS`; `CHALECOS`. Cada una mapea al nodo que la absorbe, así que un modelo
que sólo tenía esa categoría cae en el padre en vez de quedar sin clasificar.

Lo que **sale del árbol**: `OTROS`, `QR PAGOS` y `SMARTWATCH` (un producto cada una, se clasifican a mano);
`Hotsale` (colección). `BICICLETAS SCHWINN` se queda, junto con la nueva `BICICLETAS REMBRANDT`.

Los 23 nodos nuevos que no existen en Woo (`PASTILLAS DE FRENO` y el resto del desglose de frenos,
`Dirección`, `CARAMAGNOLAS`, `CUBRE VAINA`, `CUERNITOS`, `SILLAS TRASERAS`, `PORTA CELULAR`, `BUZOS`,
`DESTORNILLADORES`, `HIDROLAVADORAS`…) NO entran como nodos: los que eran de tercer nivel son valores de
faceta, y los de segundo nivel que no tienen categoría de origen entran vacíos, sin nada que los alimente
automáticamente.

**FANTTIK queda como está** (José, 2026-09-20, cerrando B4 de la revisión de opt-2b). Consecuencia asumida y
explícita: `INFLADORES` (1209) se absorbe en `INFLADORES Y HERRAMIENTAS` y `ASPIRADORAS` (1208) en `FANTTIK`,
así que **un inflador Fanttik no aparece navegando el nodo FANTTIK**. Se encuentra por el rubro o filtrando
por marca, que es el eje que para eso existe. No se hace una excepción a los dos niveles.

## D8 — «Bicicletas Convencionales» de ML va al nodo RAÍZ (20/09)

ML mete 460 bicicletas (el 17% del catálogo) en una sola categoría y el árbol propio las separa en 15 nodos
por marca. Un mapeo apunta a UN nodo, así que no hay destino evidente. **Decisión de José: la categoría de ML
cae en la raíz `BICICLETAS POR MARCA` y la marca la resuelve el atributo de marca del modelo.** Es la misma
regla de D6 y D7: lo fino se resuelve por atributo y faceta, no multiplicando nodos. Consecuencia aceptada:
el nodo raíz queda con producto directo, no sólo con hijas.

## D9 — las diez primeras categorías de ML, aprobadas en bloque (20/09)

`Cubiertas de Bicicleta → Cubiertas y Cámaras`, `Cascos → CASCOS`, `Zapatillas de Ciclismo → ZAPATILLAS`,
`Lubricantes → LUBRICANTES`, `Lentes para Ciclismo → LENTES`, `Ciclocomputadoras → CICLOCOMPUTADORAS Y GPS`,
`Pedales → PEDALES Y TRABAS`, `Luces → LUCES Y SEGURIDAD`, `Piñones → TRANSMISIÓN`, más D8. Con esas diez
queda decidida **la mitad del catálogo** (51% medido sobre los pares modelo-categoría). Las 20 siguientes,
que llevan al 80%, se le presentan aparte.

`Piñones → TRANSMISIÓN` colapsa a propósito la granularidad de ML: por D7 el nivel de detalle vive en los
atributos, no en el árbol. Es también lo que va a bajar las 309 «contradicciones reales» del informe, que hoy
son casi todas este mismo colapso visto desde el otro lado.

## D10 — los nodos sin producto se publican vacíos (20/09)

Siete nodos no tienen ninguna categoría de Woo: SANTINI, BICICLETAS REMBRANDT, BUZOS, CUERNITOS, CUBRE VAINA,
PORTA CELULAR y SILLAS TRASERAS. **Se publican igual.** No mostrar un nodo vacío es una regla de la vidriera,
no del árbol: el árbol dice qué existe como categoría, y que hoy no haya mercadería es un estado del stock.
Deuda que esto crea, anotada: el menú tiene que saber no ofrecer un nodo sin producto.

## D11 — publicar la versión 2 (20/09)

José pidió el comando. Se escribió `scripts/catalogo-arbol-publicar.mjs` en vez de un UPDATE a mano, porque es
la primera acción del tramo que cambia lo que el sistema hace y hay una sola forma de romper algo acá:
`taxonomy_channel_map` apunta al NODO, que vive fuera de la versión, así que publicar una versión que no
contenga un nodo mapeado deja el mapeo apuntando a la nada y los modelos de esa categoría sin clasificar, en
silencio. El script lo verifica, exige el id de versión explícito (nunca «el último borrador»), comprueba que
los 65 nodos se alcancen desde una raíz y es dry-run por default. Verificado read-only antes de entregarlo:
65 alcanzables de 65, 6 raíces, 0 mapeos colgados, Woo 78 de 82 decididas, ML 0 de 206.

## D16 — `BICICLETAS INFANTILES` deja de ser nodo y pasa a atributo (21/09)

Una bici infantil Trek cae en `BICICLETAS INFANTILES` y en `BICICLETAS TREK`, los dos al mismo nivel, así que
la regla del nodo más específico no decide. Son 25 modelos. **José eligió la opción más costosa de las tres y
es la correcta:** la edad es una faceta, no una rama, que es exactamente D6 y D7. Requiere una **versión 3**
del árbol y volver a publicar.

**El riesgo que esta decisión crea, y la condición que la vuelve aceptable:** si el nodo desaparece y la
categoría de Woo 1538 pasa a apuntar a la raíz `bicicletas`, **el dato «es infantil» se pierde**. La versión 3
no se publica sin que el atributo esté escrito en el mismo movimiento, en la misma transacción que remapea.
Perder información al reorganizar es la única forma de que esta decisión salga mal.

La categoría de ML equivalente (`Bicicletas Infantiles`, hoy entre las 95 sin decidir) va también a la raíz
`bicicletas`, por el mismo criterio que D8.

## D17 — un producto que pertenece a dos nodos: primaria la función principal (21/09)

Pedales con potenciómetro (`CICLOCOMPUTADORAS Y GPS` + `PEDALES Y TRABAS`, 3 modelos), manijas integradas
Shimano (`FRENOS` + `TRANSMISIÓN`, 1), y similares: unos 10 en total. El pedal es un pedal que además mide; la
manija es un freno que además cambia. **Primaria la función principal, elegida a mano una por una**; la otra
queda secundaria, así que el producto aparece en las dos categorías con un origen claro. Se descartó la regla
automática «gana el nodo con menos productos» por ser una regla que adivina.

## D18 — los 451 sin nodo se miden antes de abrir casos (21/09)

Medido el 21/09: de los 451, **316 son sólo de ML con categorías sin mapear** (se resuelven mapeando, no a
mano), **130 no tienen ninguna categoría capturada** en ningún canal, y **5** tienen categoría de Woo y ningún
nodo (son los de las 4 categorías que salieron del árbol a propósito). Quedan **95 categorías de ML sin
decidir** y las 15 más grandes cubren casi todos los 316. **La pila real de trabajo a mano son 135 modelos, no
451**, y abrir 451 casos habría sumado ruido a una cola que ya tiene ~4.700 sin atender.

## Orden acordado para cerrar el tramo (21/09)

1. **Versión 3 del árbol**: quitar el nodo `infantiles`, remapear Woo 1538 a `bicicletas` **y escribir el
   atributo de edad en la misma transacción** (D16). Publicar.
2. **Mapear ~15 categorías más de ML**, las que cubren los 316 (D18).
3. **Clasificar** (tarea 6): 3.484 primarias automáticas, 43 por la regla del nodo más específico, ~10 a mano
   (D17), 25 resueltas por D16.
4. **Abrir caso** por los ~135 que queden.
5. **Tarea 7**: composiciones de packs, en sombra.

### D19 — las 6 contradicciones de BICICLETAS INFANTILES (José, 2026-09-21)

De los 25 modelos de la categoría, 6 tienen un atributo `edad` observado que contradice a Woo.
Reparto verificado en producción: 11 `Niños`, 8 sin dato, 5 `Adultos`, 1 con `Adultos` y `Niños`.

- **Las 5 con «Niño/Niña» en el título** (TWITTER FREEDOM R24, TW2000 Pro R20, TW2400 Pro R24,
  Topmega Vickfly R16 y R20) reciben `publico = infantil` con **`origen = 'persona'`**, no
  `regla_categoria`: el título y el rodado dicen infantil y el `edad = Adultos` de Woo es un error de
  carga, pero **la regla de categoría no alcanzaba para saberlo** — hizo falta mirar el producto.
  Escribirlas como `regla_categoria` haría que la tabla mienta en su primera corrida, y el `origen` es
  la única razón por la que la tabla existe.
- **La MTB R26 Venzo Loki 2.1** (21v, para adulto) **no** recibe faceta: la mal categorizada es Woo,
  no el atributo. Queda como deuda a corregir a mano en Woo.
- Las 5 y la excluida van por **lista explícita de ids**, no por una regla que lea títulos: una regla
  que adivina nos devuelve al problema que estamos cerrando; una lista de 6 ids es una decisión y se
  lee como tal. La exclusión es explícita para que un cambio del atributo en Woo no marque la Venzo
  como infantil sin que nadie lo decida.

Total de facetas de la corrida: **24** (19 por regla + 5 por persona).

### D20–D22 — ronda 2 de ML (José, 2026-09-21)

Eran «~15» categorías en la estimación y son **30**: la cola es larga y fina. Evidencia usada para cada
propuesta: el nodo en que el mapeo de Woo ya pone los modelos que están en los dos canales, contando el
más específico (Woo etiqueta padre e hijo a la vez).

- **D20 — 27 categorías mapeadas en bloque**, que resuelven 215 de los 316 modelos que sólo están en ML.
  Dos se cerraron leyendo títulos: *Camperas y Buzos* → `camperas` (17 de 17 son camperas, chalecos o
  rompevientos, ningún buzo) y *Limpiadores de Cadena* → `limpiadores` (8 líquidos y un solo aparato,
  «Limpiacadenas con reservorio», que se corrige a mano como las 12 grasas).
- **D21 — «Otros» (MLA9760) sin equivalencia**: sus modelos en común caen en 7 nodos distintos. Mismo
  criterio que D13.
- **D22 — «Bicicletas Infantiles» (MLA459678) y «Camicletas» (MLA424974) → `bicicletas` + faceta
  `publico = infantil`, en una sola transacción**: es D16 del lado de ML, y mapear sin la faceta pierde
  el dato. Se excluye por id la **Gravity Bling**, que son **4 modelos** con el mismo título (rodado 29,
  recomendada +14 años, 1×10 con frenos hidráulicos: de adulto).

**Lo que D22 enseña y vale más que la decisión: el atributo `edad` observado no es confiable en ninguna
dirección.** En Woo decía «Adultos» en bicis de niño (D19); en ML dice «Niños» y «edad mínima 8 años» en
una R29 de adulto. La regla de D16 sólo detecta contradicción cuando el atributo dice «Adultos», así que
una exclusión que dependa del atributo no protege nada: las 4 Gravity Bling habrían recibido la faceta
en automático. Toda exclusión va por id.

Los 4 Gravity Bling con título idéntico son además, casi seguro, un problema de identidad (E3), no de
taxonomía: se anota, no se resuelve acá.

### D23–D25 — cómo se clasifica (José, 2026-09-21)

`catalog.model_categories` ya distingue `origen = 'mapeo_canal'` de `'persona'`, con una sola primaria
vigente por modelo (índice único parcial) y salida forward-only (`quitado_en` + `motivo_salida`). Lo que
faltaba decidir no era dónde guardarlo, sino qué hace el sistema.

- **D23 — desacuerdo entre canales.** Si Woo y ML ponen un modelo en nodos distintos que no son padre e
  hijo, **se abre un caso y el modelo queda SIN primaria** hasta que José decida; los dos nodos quedan
  como secundarios. No gana ningún canal: los dos tienen errores de carga medidos (las 12 grasas en Woo,
  la Gravity Bling en ML) y elegir uno los convierte en primarias sin que nadie lo decida. Si un nodo es
  ancestro del otro, gana el más específico sin caso.
- **D24 — la decisión de una persona manda siempre.** Una clasificación con `origen = 'persona'` nunca la
  pisa una corrida automática. Si el canal cambia después, se abre un caso: el cambio del canal puede
  tener razón, y congelar una decisión vieja en silencio es tan malo como pisarla. Es la condición para
  que la futura interfaz de edición manual sirva.
- **D25 — lo nuevo se clasifica solo, al leerse del canal**: mapeada → nodo; categoría infantil → faceta;
  sin mapeo → caso. Nada queda sin clasificar en silencio.

**Tarea 6 se parte en dos por riesgo, no por capa.** 6a clasifica la foto actual con un script de
dry-run que corre José. 6b engancha la clasificación en la ingestión: es el primer cambio del tramo que
toca el worker de producción, así que se prueba en un contenedor aparte antes de desplegar y va
DESPUÉS de que 6a esté verificada en producción.
