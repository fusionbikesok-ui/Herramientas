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

## Decisiones abiertas — requieren a José

- **D1. El árbol propio.** Se decide en la tarea 4, con la jerarquía real a la vista. No antes: hacerlo
  sobre la lista aplanada obligaría a rehacer mapeos.
- **D2. Las entradas que no son rubro de producto** (`QR PAGOS`, `SERVICES`, `ASPIRADORAS`, `FUSIBLES`,
  `SMARTWATCH`): ¿se excluyen del árbol, se agrupan en un rubro «no ciclismo», o son productos legítimos?
- **D3. Los solapamientos** (`CUBIERTAS` vs `Cubiertas y Cámaras`): ¿se fusionan, o son rubros distintos?
- **D4. Profundidad máxima del árbol** y si `BICICLETAS POR MARCA` sobrevive como nodo o desaparece al
  separarse la marca.

Ninguna bloquea las tareas 1 a 3.

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
