# E2 tramo 2 — atributos, imágenes y datos comerciales (diseño)

**Fecha:** 2026-09-20 · **Estado:** diseño, sin implementar · **Entrega:** E2, tramo 2 de 3
**Ficha:** `docs/superpowers/deliveries/E2-catalogo-modelo-importacion.md` · **Depende de:** E2 T1 (en producción desde el 2026-09-20)

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
  nombre_normalizado text NOT NULL   -- 'marca', 'color', 'talle', 'rodado', …
  valor text NOT NULL
  canal text NOT NULL                -- de dónde salió este valor
  recurso text NOT NULL              -- qué representación lo afirmó
  observado_en timestamptz NOT NULL
  UNIQUE (model_id, nombre_normalizado, valor, canal)
```

La unicidad incluye `canal` **a propósito**: dos canales pueden afirmar valores distintos y los dos se
guardan. Eso es lo que permite detectar la divergencia en lugar de que una escritura pise la otra.

```
catalog.model_images
  model_id, url, orden, canal, recurso, observado_en
  UNIQUE (model_id, url)
```

Y en la variante, lo comercial derivado:

```
catalog.sellable_variants
  + precio numeric(12,2)        -- del canal, no autoridad de Fusion
  + moneda text
  + stock_canal integer
  + gtin text
  + comercial_observado_en timestamptz
```

**`gtin` es evidencia, nunca autoridad** (invariante acumulativo del plan maestro): se guarda y se muestra,
no se usa para casar identidades. La cobertura del 16,9 % lo confirma como insuficiente para decidir.

### 4.3 Normalización de nombres de atributo

Woo dice `{"name":"Marca","option":"Maxxis"}`; ML lo trae dentro de `atributos_json` con su propio id. La
normalización es **léxica y conservadora**: minúsculas, sin acentos, sin espacios extremos. `Marca` → `marca`,
`Tipo de Producto` → `tipo_de_producto`. **No hay diccionario de sinónimos en T2**: `rodado` y
`diametro_de_rodado` quedan como dos atributos distintos, y unificarlos es decisión de negocio que pertenece a
T3 o a E3.

Un valor múltiple de Woo (`{"name":"Talle","option":"41, 42, 43, 44, 45"}`, que es real en el catálogo) se
guarda **como cinco filas**, una por valor, partiendo por coma. Esto se especifica porque es la diferencia
entre que el atributo sea consultable o sea un string opaco.

## 5. La divergencia entre canales

Cuando dos canales afirman valores distintos para el mismo `nombre_normalizado` de un modelo, se abre un caso
de identidad de tipo nuevo **`atributo_divergente`**, con los dos valores y su canal en el detalle.

El CHECK de `catalog.identity_cases.tipo` es cerrado (9 valores hoy), así que **el tipo nuevo exige migración**
y ampliar los tipos de TS en el mismo commit, o no compila — la lección de T1.

Precedente que se sigue: `user_product_divergente` (424 casos abiertos) hace exactamente esto y nadie fusiona
nada solo.

**Lo que NO abre caso:** un canal que informa un atributo y el otro que no lo informa. Ausencia no es
contradicción — si abriera caso, los 5.235 productos generarían miles de casos vacíos de información.

## 6. Invariantes

1. **Una transacción por mensaje**, como T1. Los atributos de un recurso se escriben con su representación.
2. **La versión remota vieja no pisa.** Si `comercial_observado_en` es posterior a la versión del mensaje, no
   se escribe: el mismo criterio de T1 para no retroceder.
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
9. Suite de `plataforma/` en verde y tests que fallan si se revierte cada punto.

## 10. Riesgos

| Riesgo | Mitigación |
|---|---|
| El JSONB crudo infla la tabla | son 12.849 filas, no millones; medir el tamaño antes y después y dejarlo en la evidencia |
| La normalización léxica junta cosas distintas | conservadora a propósito: sólo minúsculas y acentos, sin sinónimos |
| Miles de casos `atributo_divergente` de golpe | la ausencia no abre caso (§5); medir en el ensayo antes de encender en producción |
| Los cachés del legado están atrasados | acotado a atributos descriptivos, con origen marcado (§7) |
