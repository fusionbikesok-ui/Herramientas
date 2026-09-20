# E2 tramo 2 — atributos, imágenes y datos comerciales (diseño)

**Fecha:** 2026-09-20 · **Estado:** diseño, sin implementar · **Entrega:** E2, tramo 2 de 3
**Ficha:** `docs/superpowers/deliveries/E2-catalogo-modelo-importacion.md` · **Depende de:** E2 T1 (en producción desde el 2026-09-20)
**Revisión externa:** Codex, 2026-09-20 — 2 críticos, 3 altos, 2 medios sobre la primera versión, todos
incorporados. Los dos críticos eran defectos que habrían corrompido datos en producción: lo comercial en la
variante (2.093 variantes están en los dos canales y se habrían pisado) y un caso de identidad por modelo, que
`identity_cases` no admite. Más dos cosas que faltaban (§7 bis) y el backfill, el costo y el rollback (§7 ter).

## 1. Por qué este tramo, y por qué cambia la partición de E2

El diseño de T1 (2026-09-18, §1) partió E2 en tres tramos: T2 «taxonomía, marcas, colecciones y atributos» y
T3 «imágenes y composiciones de packs y kits». **José redefinió la partición el 2026-09-20**, por una razón
técnica que apareció al desplegar T1:

| Tramo | Antes | Ahora |
|---|---|---|
| T2 | taxonomía, marcas, colecciones, atributos | **lo que ya llega en el payload y se descarta**: atributos, imágenes, precio, stock, GTIN, marca |
| T3 | imágenes y packs/kits | **taxonomía propia, colecciones y packs/kits** |

El corte nuevo separa *capturar lo que el canal ya nos dio* de *decidir estructura propia de Fusion*. Lo
primero no necesita ninguna decisión de negocio y no cuesta una sola llamada extra al canal; lo segundo exige
definir una taxonomía que hoy no existe en ninguna parte.

## 2. El hueco concreto (medido el 2026-09-20)

El bootstrap de T1 leyó **5.235 productos de Woo y 4.050 ítems de ML**, y el adaptador guarda el producto
completo en `payload` (`src/reconciliacion/adaptadores/woo.ts`: `payload: p`). Pero el proyector lee sólo
seis campos y **descarta el resto en silencio**:

| Proyector | Campos que usa |
|---|---|
| `src/catalogo/woo.ts` | `id`, `type`, `status`, `name`, `sku`, `parent_id` |
| `src/catalogo/ml.ts` | `id`, `status`, `title`, `user_product_id`, `variations` |

Lo que llega y se tira, con su cobertura real en `catalogo_cache` (5.235 filas):

| Dato | Cobertura Woo | En ML |
|---|---|---|
| atributos | **5.108 / 5.235 (97,6 %)** | `atributos_json`, más `color` y `talle` ya separados |
| categorías | **5.235 (100 %)** | `category_id` |
| imagen | **5.201 (99,3 %)** | `thumbnail` |
| marca | **5.203 (99,4 %)**, 155 distintas | dentro de `atributos_json` |
| precio | 5.131 (98 %) | `precio` |
| stock | 5.235 (100 %) | `available_quantity` |
| GTIN | 887 (16,9 %) | `gtin` |

Hoy `catalog.product_models` tiene **solo `titulo`** y `catalog.sellable_variants` **solo `sku`**. El catálogo
canónico no puede responder «qué cubiertas Maxxis rodado 29 tengo publicadas», que es justamente para lo que
se construyó.

**Por qué no alcanza con volver a pedirlo después:** el payload vive cifrado en `integrations.inbox_messages`
(`payload_ciphertext`) y es **efímero** — se consume y se archiva. Si no se extrae al proyectar, recuperarlo
cuesta otro barrido completo del canal, y el 429 de ML del 2026-09-20 mostró lo caro que es eso.

## 3. Decisiones de José (2026-09-20)

| Tema | Decisión | Por qué |
|---|---|---|
| Partición de E2 | Redefinida (§1) | separar «capturar lo que ya vino» de «decidir estructura propia» |
| Modelo de datos | **Híbrido: JSONB crudo + columnas derivadas** | no perder nada del origen y a la vez poder consultar e indexar lo que se usa |
| Canales que difieren | **Guardar ambos y abrir un caso de identidad** | fiel al origen, ninguna fusión automática, y la divergencia queda visible como trabajo |
| Taxonomía propia | **Fuera de T2** | no existe en ninguna parte; `producto_fusion_atributos` y `categorias_criticas` están **vacías** en el legado |

## 4. Modelo de datos

### 4.1 Lo crudo, por representación

El payload se guarda **en la representación, no en el modelo**: cada canal describe el mismo producto a su
manera, y el modelo es la unión de varias representaciones.

```
catalog.external_representations
  + atributos_crudos   jsonb    -- attributes[] de Woo / attributes[] de ML, tal cual
  + comercial_crudo    jsonb    -- precio, stock, moneda, imágenes, GTIN, categorías del canal
  + capturado_en       timestamptz
```

Sin `NOT NULL`: una representación proyectada por T1 no los tiene y no hay que reproyectar el catálogo entero
para que T2 sirva. Se llenan al pasar el próximo cambio de ese recurso, y el §7 explica el relleno dirigido.

### 4.2 Lo derivado, consultable

```
catalog.model_attributes
  model_id uuid NOT NULL REFERENCES catalog.product_models(id)
  representation_id uuid NOT NULL REFERENCES catalog.external_representations(id)
  nombre_normalizado text NOT NULL   -- 'marca', 'color', 'talle', 'rodado', …
  valor text NOT NULL
  observado_en timestamptz NOT NULL
  vigente_hasta timestamptz          -- NULL = vigente; con fecha = el canal dejó de afirmarlo
  UNIQUE (representation_id, nombre_normalizado, valor)
```

**La procedencia es la representación, no el canal** (alto de la revisión Codex): `canal` solo no alcanza,
porque **un mismo canal puede tener varias publicaciones vinculadas al mismo modelo** y con `(model_id,
nombre, valor, canal)` dos publicaciones de ML que afirman lo mismo colapsan en una fila y se pierde cuál lo
dijo. Con `representation_id` la fila sabe exactamente de dónde salió, y el canal se obtiene por join.

**`vigente_hasta` implementa «ningún borrado»** (alto de la revisión): cuando un canal deja de informar un
atributo que antes informaba, la fila **no se borra** — se le pone fecha. Eso respeta que la app no tiene
DELETE y deja historia de lo que el canal decía antes. Una consulta normal filtra `vigente_hasta IS NULL`.

```
catalog.model_images
  model_id, representation_id, url, orden, observado_en, vigente_hasta
  UNIQUE (representation_id, url)
```

La unicidad por representación y no por modelo (medio de la revisión): dos canales pueden publicar la misma
URL y cada uno conserva su procedencia; y las imágenes propias de una variación de ML cuelgan de **su**
representación, que es la que las trae.

Y lo comercial derivado **en la representación, NO en la variante**:

```
catalog.external_representations
  + precio numeric(12,2)        -- del canal que esta representación observa
  + moneda text
  + stock_canal integer
  + gtin text
```

**Por qué no en la variante (defecto crítico de la primera versión, revisión Codex 2026-09-20):** una variante
puede estar publicada en Woo y en ML a la vez, y **2.093 variantes ya lo están** (medido en producción). Con
columnas en `sellable_variants`, cada proyección de un canal habría pisado el precio y el stock del otro, en
silencio y sin dejar rastro — justo lo contrario de «guardar ambos» y de «el precio es del canal». La
representación ya tiene la identidad correcta: cuenta, recurso y variación.

**`gtin` es evidencia, nunca autoridad** (invariante acumulativo del plan maestro): se guarda y se muestra,
no se usa para casar identidades. La cobertura del 16,9 % lo confirma como insuficiente para decidir.

### 4.3 Normalización de nombres de atributo

Woo dice `{"name":"Marca","option":"Maxxis"}`; ML lo trae dentro de `atributos_json` con su propio id. La
normalización es **léxica y conservadora**: minúsculas, sin acentos, sin espacios extremos. `Marca` → `marca`,
`Tipo de Producto` → `tipo_de_producto`. **No hay diccionario de sinónimos en T2**: `rodado` y
`diametro_de_rodado` quedan como dos atributos distintos, y unificarlos es decisión de negocio que pertenece a
T3 o a E3.

Un valor múltiple de Woo (`{"name":"Talle","option":"41, 42, 43, 44, 45"}`, que es real en el catálogo) se
guarda **como cinco filas**, una por valor. Esto es la diferencia entre que el atributo sea consultable o sea
un string opaco, y afecta al **22 % de los atributos** (110 de 500 en una muestra real).

Reglas de la partición, porque «partir por coma» a secas rompe valores legítimos (medio de la revisión Codex,
confirmado con datos el 2026-09-20): **se parte por coma seguida de espacio (`/,\s/`), no por coma sola**, porque
en este catálogo **la coma es también el separador decimal**. Hay 21 valores reales donde partir por coma sola
inventa datos: `Talle: "40, 42, 42,5, 43, 45, 46"` daría siete filas con un `5` que no es ningún talle, y
`Largo: "110, 117,5, 122,5"` daría cinco largos en vez de tres. La lista de texto libre **no** resuelve esto:
`talle` y `largo` son multivalor legítimos y no se pueden excluir sin perder la partición que sí corresponde.
Se verificó sobre los 5.235 productos que **no existe ningún valor con coma-sin-espacio que sea un separador
legítimo**, así que la regla no pierde nada. Después de partir se hace `trim` de cada parte y se descartan las
vacías; **se conserva además el valor
entero como venía en `atributos_crudos`**, así que una partición equivocada se corrige reproyectando sin
volver al canal (invariante 3). **No se parte** cuando el atributo está en la lista de los que admiten coma
como parte del valor (`descripcion`, `observaciones` y los de texto libre): esa lista se fija en el commit y se
justifica con los datos, no se adivina en tiempo de ejecución.

## 5. La divergencia entre canales

Cuando dos canales afirman valores distintos para el mismo `nombre_normalizado` de un modelo, se abre un caso
de identidad de tipo nuevo **`atributo_divergente`**, con los dos valores y su canal en el detalle.

**El caso cuelga de una representación, no del modelo** (defecto crítico de la primera versión, revisión Codex
2026-09-20): `catalog.identity_cases` **no tiene `model_id`**, y su `identity_cases_objeto_check` exige
`variant_id` o `representation_id` — un caso por modelo era literalmente ininsertable. Se cuelga de la
representación que introduce el valor divergente, que además es la que hay que ir a mirar para resolverlo.

**Un caso por representación agrupa todos sus atributos divergentes**, porque
`identity_cases_un_abierto_representacion` admite un solo caso abierto por (representación, tipo,
`detalle->>'caso_legado'`). El detalle lleva una lista de atributos en conflicto y **se actualiza** cuando
aparece uno nuevo; no se abre un caso por atributo. Sin esto, el segundo atributo divergente de la misma
representación violaría el índice y abortaría la transacción del mensaje.

El CHECK de `catalog.identity_cases.tipo` es cerrado (9 valores hoy), así que **el tipo nuevo exige migración**
y ampliar los tipos de TS en el mismo commit, o no compila — la lección de T1.

Precedente que se sigue: `user_product_divergente` (424 casos abiertos) hace exactamente esto y nadie fusiona
nada solo.

**Lo que NO abre caso:** un canal que informa un atributo y el otro que no lo informa. Ausencia no es
contradicción — si abriera caso, los 5.235 productos generarían miles de casos vacíos de información.

## 6. Invariantes

1. **Una transacción por mensaje**, como T1. Los atributos de un recurso se escriben con su representación.
2. **La versión remota vieja no pisa, con el mismo reloj que usa T1.** La comparación es contra
   `external_representations.version_remota` (`text`, la que el adaptador ya escribe) y **no contra un
   timestamp propio inventado** (alto de la revisión Codex): en Woo la versión es `date_modified_gmt` y en ML
   es un hash, así que el orden total lo define el adaptador —`versionKind` `temporal` o `hash`— exactamente
   como en E1. Reusar ese criterio en lugar de crear otro evita dos relojes que discrepan.
3. **Lo derivado se recalcula desde lo crudo, nunca al revés.** Si la normalización cambia, se reproyecta
   desde `atributos_crudos` sin volver al canal. Es la razón de guardar el crudo.
4. **Ningún borrado.** Un atributo que desaparece del canal se marca, no se elimina (la app no tiene DELETE).
5. **El precio y el stock son del canal, no de Fusion.** Se guardan como observación con su fecha; Fusion no
   los toma como autoridad y T2 no habilita ninguna escritura remota.

## 7. Relleno de lo ya proyectado

Las 12.849 representaciones que T1 dejó no tienen atributos. Tres caminos, y el elegido es el tercero:

| Camino | Costo | Problema |
|---|---|---|
| Barrido completo de Woo y ML | 2 bootstraps | el 429 de ML del 2026-09-20 mostró que cuesta horas |
| Esperar el cambio natural | cero | un producto que no cambia nunca no se llena nunca |
| **Releer desde `catalogo_cache` / `ml_publicaciones_cache`** | una consulta local | el caché puede estar atrasado respecto del canal |

**Se rellena desde los cachés del legado**, que ya tienen los datos con la cobertura del §2, y cada fila
rellenada queda marcada con su origen (`capturado_en` y el canal). Contradice la decisión de T1 de «releer
desde el origen, no desde los cachés» — **y la contradicción es deliberada y acotada**: T1 hablaba de
*identidad* (qué es cada cosa y con qué SKU), donde un caché atrasado corrompe decisiones; acá se trata de
*atributos descriptivos*, donde un color desactualizado se corrige en el próximo cambio del producto y no
afecta ninguna identidad. Esto se anota como decisión, no se esconde.

## 7 bis. Lo que se agrega por la revisión (Codex, 2026-09-20)

**La categoría del canal se proyecta consultable**, no sólo dentro del JSONB. Llega con **cobertura del 100 %**
en los dos canales (5.235 `categorias_json` en Woo con 165 combinaciones distintas; 6.969 `category_id` en ML) y
el objetivo del tramo es poder consultar lo que ya se recibió. Va en la misma tabla de atributos, con
`nombre_normalizado = 'categoria_canal'`, así que no hace falta una tabla nueva ni definir taxonomía propia —
eso sigue siendo T3. Sin esto, «qué cubiertas tengo» obliga a escarbar JSONB.

**Los atributos de cada variación de ML se proyectan en su propia representación.** El proyector ya recibe cada
objeto de variación (`src/catalogo/ml.ts`, `payload.variations`) y **3.522 publicaciones de ML son variantes**:
si sólo se proyectaran los atributos del ítem padre, el color y el talle de cada variación —que es justo lo que
distingue una variante de otra— se perderían. Cada variación tiene su representación desde T1, y ahí van.

## 7 ter. Backfill, costo y rollback

**El relleno va por lotes con checkpoint durable**, no en una transacción gigante: se reusa la forma de
`catalog.bootstrap_runs` (lote configurable, posición confirmada, reanudable) que ya funcionó en T1 con 9.285
recursos. Una sola transacción sobre 12.849 representaciones tomaría la tabla el tiempo que dure y bloquearía al
proyector, que está en producción.

**Costo estimado, para dimensionar antes de escribir la migración:** 12.849 representaciones × ~1,6 atributos
promedio (medido) ≈ **21.000 filas** en `model_attributes`, más ~13.000 en `model_images`. Con la partición de
valores múltiples (22 % de los atributos) el número sube a ~26.000. Son decenas de miles, no millones: no
requiere particionado. El JSONB crudo por representación sí puede activar TOAST en los payloads grandes de ML;
**se mide el tamaño de la tabla antes y después del backfill y queda en la evidencia**.

**Índices desde el principio**, porque la consulta de aceptación los necesita: `(nombre_normalizado, valor)`
para «qué tiene marca Maxxis» y GIN sobre `atributos_crudos` sólo si la medición muestra que se consulta el
crudo. Un índice que no se usa es costo de escritura en cada proyección.

**Rollback:** el tramo es aditivo —columnas y tablas nuevas, ningún cambio a lo existente—, así que apagarlo es
dejar de escribir: el catálogo de T1 sigue funcionando igual. La migración inversa es `DROP` de lo nuevo, y
**no se ejecuta con el proyector encendido**. Los `GRANT` no hacen falta: `0013_catalogo.sql` dejó un
`ALTER DEFAULT PRIVILEGES` en el esquema `catalog`, así que las tablas nuevas heredan `SELECT, INSERT, UPDATE`
para `plataforma_app` (verificado el 2026-09-20).

**El volumen de casos `atributo_divergente` se acota antes de encender**, y es el riesgo más serio del tramo:
**2.093 variantes tienen representaciones en los dos canales**, así que la comparación se hace sobre esas y no
sobre las 12.849. Antes de activarlo en producción se corre un ensayo en seco que cuenta cuántos casos abriría;
si el número es inatendible, el tramo se despliega **con la comparación apagada** (una variable, como
`CATALOGO_CANARIO` en T1) y los atributos se capturan igual. Capturar es el valor; comparar es opcional.

## 8. Fuera de alcance

Taxonomía propia de Fusion, colecciones, packs y kits (son T3). Unificar sinónimos de atributos. Escribir
nada en Woo ni en ML. UI. Tocar el matcher.

## 9. Criterio de aceptación

1. Migración que agrega las columnas, las dos tablas y el tipo `atributo_divergente`, con los tipos de TS
   ampliados en el mismo commit y `lock_timeout` de 5 s.
2. El proyector de Woo y el de ML llenan crudo y derivado en la misma transacción de la representación.
3. Un valor múltiple de Woo produce una fila por valor.
4. Dos canales con valores distintos para el mismo atributo abren **un** caso `atributo_divergente`; un canal
   que calla **no** abre caso.
5. Una versión remota vieja no pisa lo comercial más nuevo.
6. La normalización se recalcula desde el crudo sin tocar el canal.
7. El relleno desde los cachés deja marcado el origen y es idempotente.
8. Consulta de humo que hoy es imposible: **«qué variantes publicadas tienen marca Maxxis»** devuelve filas.
9. Lo comercial (precio, stock, GTIN) se escribe en la **representación**: dos canales sobre la misma variante
   conservan sus dos valores y ninguno pisa al otro. Test con una variante en Woo y ML a la vez.
10. Un segundo atributo divergente de la misma representación **actualiza** el caso abierto en lugar de violar
   `identity_cases_un_abierto_representacion`.
11. Un atributo que el canal deja de informar queda con `vigente_hasta` y **no se borra**.
12. El backfill avanza por lotes con checkpoint y es reanudable: cortarlo a la mitad y retomarlo no duplica ni
   saltea.
13. El ensayo en seco informa cuántos casos `atributo_divergente` se abrirían, antes de encender.
14. Suite de `plataforma/` en verde y tests que fallan si se revierte cada punto.

## 10. Riesgos

| Riesgo | Mitigación |
|---|---|
| El JSONB crudo infla la tabla | ~21.000 filas derivadas estimadas (§7 ter); medir el tamaño antes y después y dejarlo en la evidencia |
| La normalización léxica junta cosas distintas | conservadora a propósito: sólo minúsculas y acentos, sin sinónimos |
| Miles de casos `atributo_divergente` de golpe | la ausencia no abre caso (§5); un caso por representación y no por atributo; sólo se comparan las 2.093 variantes con dos canales; ensayo en seco que los cuenta y, si es inatendible, se enciende la captura con la comparación apagada (§7 ter) |
| El backfill bloquea al proyector en producción | por lotes con checkpoint reanudable, nunca una transacción sobre las 12.849 (§7 ter) |
| Dos canales se pisan el precio | lo comercial vive en la representación, no en la variante (§4.2) |
| Los cachés del legado están atrasados | acotado a atributos descriptivos, con origen marcado (§7) |
