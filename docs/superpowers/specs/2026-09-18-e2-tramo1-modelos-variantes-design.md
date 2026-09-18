# E2 tramo 1 — modelos, variantes y claves externas (diseño)

**Fecha:** 2026-09-18 · **Estado:** diseño revisado, sin implementar · **Entrega:** E2, tramo 1 de 3
**Ficha:** `docs/superpowers/deliveries/E2-catalogo-modelo-importacion.md` · **Depende de:** E1 (sus barridos y su inbox)
**Revisión externa:** `docs/superpowers/evidence/e2/2026-09-18-E2-T1-revision-codex.md` (6 críticos, 6 altos, 5 medios
sobre la primera versión, commit `b44c23e`). Esta versión los incorpora; la tabla del §11 dice dónde.

## 1. Por qué este tramo primero

E2 se parte en tres tramos por valor, cada uno usable solo (decisión de José, 2026-09-18):

| Tramo | Contenido | Qué habilita solo |
|---|---|---|
| **T1** | modelos, variantes vendibles, representaciones en Woo y ML, identificadores y el cruce Woo↔ML | saber, en la base canónica, qué se vende, dónde y con qué SKU, y qué falta decidir |
| T2 | taxonomía, marcas, colecciones y atributos | búsqueda y filtros sobre el catálogo canónico |
| T3 | imágenes y composiciones de packs y kits | fichas completas y el stock de kits |

Terminar T1 **no** satisface la ficha de E2: la ficha exige además T2, T3, observación de 7 días, revisión
independiente y suite global. T1 se declara "terminado como tramo", nada más.

## 2. Línea base (2026-09-18, sólo lectura, commit `6eab8d4`)

| Dato | Valor |
|---|---|
| `data/fusion.sqlite` | 161.501.184 bytes, 164 tablas |
| `catalogo_cache` (Woo) | 5.235 filas |
| `ml_publicaciones_cache` | 6.969 filas activas o pausadas |
| Decisiones del matcher | 5.207: 1.774 `confirmar`, 1.057 `asignar`, 2.376 `omitir` |
| Publicaciones de ML con SKU de Woo | 2.794; sin ninguna decisión: ~1.800; con SKU que ya no existe en Woo: 1 |
| `identidad_casos` | 1.339: 1.212 verificados, 111 resueltos, 13 pendientes, 3 urgentes |
| Observaciones de E1 | `woo.products` 3.089 recursos; `ml.items` 271, **sólo los que cambiaron** |

## 3. Decisiones de José (2026-09-18)

| Tema | Decisión |
|---|---|
| Tramos | Tres, por valor (§1) |
| Fuente | Releer Woo y ML **desde el origen**, no desde los cachés del legado |
| Cómo se relee | **Camino A corregido**: una **lectura completa inicial forzada**, una sola vez, y después **E1 le pasa cada cambio a E2** en el mismo paso en que lo procesa. A futuro hay un solo lector del origen |
| Identidad sin resolver | Se importa como **caso visible**; nunca se adivina por nombre ni por GTIN |
| Cruce Woo↔ML | Las decisiones del matcher entran como **decisiones auditadas**, con quién y cuándo |
| Seguir al matcher | **Sincronización continua** mientras se siga decidiendo en el legado, con fecha de corte y hash; se corta cuando el matcher pase a la plataforma |
| Variante vendible | **Lo que está publicado en algún canal**, tenga o no SKU todavía |
| Variante sin SKU | Existe con el **SKU pendiente** y un caso abierto; una vez puesto, el SKU no cambia |
| Publicaciones "omitidas" | Entran **omitidas por decisión**, con un caso de revisión de **baja prioridad** |
| Modelo de variaciones de ML | Cada publicación guarda si es del **modelo viejo** o del **nuevo** (`user_product`) |

### Choque con el plan maestro, resuelto

El plan maestro fija que toda variante tiene un SKU `FB-{ID_WOO}` obligatorio e inmutable. La decisión de José dice que
existe todo lo que se vende. Se sostienen juntas así: **el SKU es obligatorio para cerrar el caso de la variante, no
para que la variante exista**, y es inmutable una vez asignado. Ficha y plan maestro se actualizan al aprobar.

## 4. De dónde sale el catálogo

La primera versión suponía que el inbox de E1 ya tenía todo. **No es así**, verificado en el código: el inbox es una
**cola de un solo consumidor** (`0001_esquema_base.sql:217`), sólo encola cuando la versión o el hash cambian
(`motor.ts:87`), las vueltas completas de Woo leen sólo identificadores (`woo.ts:124`), y el payload se borra a los
90 días. De ahí salen las dos piezas nuevas:

### 4.1 E1 le pasa cada cambio a E2 (fan-out en el mismo paso)

Cuando el worker de E1 procesa un mensaje de `woo.products` o `ml.items`, **en la misma transacción** en que escribe
su observación llama al proyector de catálogo. Si la proyección falla, falla la transacción entera y el mensaje vuelve
a la cola: no hay forma de que E1 lo dé por hecho y E2 no lo haya visto. No hay un segundo consumidor compitiendo.

### 4.2 La lectura completa inicial (bootstrap)

Una tarea explícita, **una sola vez por cuenta**, que emite **todo** el catálogo con contenido, sin importar si
cambió, marcado como `bootstrap`:

- **Woo:** paginado de productos y variaciones con todos sus campos (no `_fields=id`).
- **ML:** el scan de ítems más multiget de 20: con ~7.000 ítems, **unas 70 páginas de scan y unas 350 multigets**.

Reglas, porque la cuota de ML es compartida con órdenes, señales y `missed_feeds`:

- Pasa por el **gateway del legado**, que ya aplica el tope de lecturas de la sombra (`GATEWAY_ML_SHADOW_RPM`,
  hoy 60). No se agrega un límite propio: el que manda es el del legado, compartido con todo lo demás.
- **Checkpoint durable por página**: un 429 o una caída a mitad del catálogo retoma desde la última página
  confirmada, no desde el principio.
- Las multigets de una página van **de a una**, no en paralelo: el adaptador actual las lanza juntas
  (`ml.ts:340`) y eso no respeta un tope por minuto.
- Corre en un horario de poca venta, elegido en el plan.

### 4.3 Las decisiones del matcher (sincronización continua)

No están en Woo ni en ML: viven sólo en el legado, en una tabla que **se pisa y se borra sin historial**
(`sku_matcher_decisiones`, upsert en `cobertura.js:876`, borrado en `cobertura.js:922`). Por eso no alcanza una copia:

- **Arranque:** una copia **consistente** del legado (backup en caliente de SQLite, no una lectura mientras se escribe),
  con `corte_en`, conteo y hash.
- **Después:** el legado **emite un evento** a la plataforma cada vez que el matcher confirma, asigna, omite o borra
  una decisión, firmado con HMAC como la copia de sombra. Sin evento, no hay cambio silencioso.
- **Red de seguridad:** una conciliación diaria compara la tabla completa del legado contra lo vigente en E2 y abre un
  caso por cada diferencia.
- Cada decisión tiene **vigencia** (`vigente_desde`, `vigente_hasta`): una nueva decisión sobre la misma publicación
  cierra la anterior, y un borrado del legado cierra la vigente con motivo `revocada_en_legado`. Nunca se reescribe.

## 5. Modelo de datos (T1)

### 5.1 Tablas

| Tabla | Qué representa | Reglas que hace cumplir la base |
|---|---|---|
| `catalog.product_models` | el producto como concepto | nunca vendible; `origen` en `woo_padre`, `woo_simple`, `ml_familia`, `ml_clasico`, `ml_simple`; archivo con `archivado_en` y motivo, nunca borrado |
| `catalog.sellable_variants` | lo que se vende | `model_id` **obligatorio**; `sku` nulo mientras está pendiente, **único cuando no es nulo**; un trigger impide cambiarlo una vez puesto; `version` para concurrencia |
| `catalog.external_representations` | cada aparición en un canal | `tipo` en `contenedor` (padre Woo, ítem clásico de ML con variaciones) o `vendible`; un `contenedor` apunta a un modelo y **nunca** a una variante, un `vendible` apunta a una variante; clave única `(canal, cuenta, recurso, variacion_normalizada)` con **`variacion_normalizada` no nula** (`''` sin variación), porque un `UNIQUE` común admite duplicados con `NULL`; guarda `sku_observado` (lo que dice el canal), `user_product_id`, `estado_remoto`, `version_remota`, `observado_en`, la corrida de procedencia y `archivado_en` |
| `catalog.matcher_decisions` | la evidencia del legado | append-only; `accion`, `origen`, `confirmado_por`, `actualizado_en_legado`, `vigente_desde`, `vigente_hasta`, motivo de cierre y de qué copia o evento vino |
| `catalog.identity_cases` | lo que falta decidir | ver §5.3; cada caso apunta a su representación o variante y se cierra con evento |

### 5.2 Cómo se arma cada cosa

| En el canal | Modelo | Variante | Representaciones |
|---|---|---|---|
| Woo, producto simple | uno, `woo_simple` | una | una `vendible` |
| Woo, padre variable | uno, `woo_padre` | ninguna para el padre | una `contenedor` |
| Woo, cada variación | el del padre | una | una `vendible` |
| ML, ítem simple **con** decisión | el de la variante del SKU | la del SKU | una `vendible` |
| ML, ítem clásico con variaciones | uno, `ml_clasico`, si no se vincula a uno de Woo | una por variación | una `contenedor` para el ítem y una `vendible` por variación |
| ML, ítems `user_product` de la misma familia | **uno solo** para la familia, `ml_familia`, con `user_product_id` como clave | una por ítem | una `vendible` por ítem |
| ML sin decisión | el que corresponda por las reglas de arriba | **variante con SKU pendiente** | la que corresponda, más caso `sku_pendiente` |
| ML con `omitir` | — | ninguna | representación marcada **omitida por decisión**, más caso `omitida_revisar` de baja prioridad |

### 5.3 SKU de Woo: el observado y el canónico no son lo mismo

El SKU canónico es `FB-{ID_WOO}`, pero lo que Woo tiene cargado puede no coincidir (el legado admite SKU vacío y
duplicado: `db/schema.sql:1`, `routes/woo.js:759`). Por eso:

- Se guarda siempre `sku_observado` tal como está en Woo.
- La variante recibe `FB-{ID_WOO}` **sólo si** el observado coincide con ese formato y no está repetido.
- Si no, la variante queda con SKU pendiente y un caso: `woo_sin_sku`, `woo_sku_duplicado` o `woo_sku_no_canonico`.

Tipos de caso en total: `sku_pendiente`, `omitida_revisar`, `sku_inexistente_en_woo`, `woo_sin_sku`,
`woo_sku_duplicado`, `woo_sku_no_canonico`, `decision_en_conflicto` (la conciliación del matcher encontró una
diferencia) e `identidad_legado` (los pendientes y urgentes de `identidad_casos`).

## 6. Resolver una variante con SKU pendiente

Asignarle un SKU a la variante pendiente sólo es válido si **ese SKU todavía no existe**. Si ya lo tiene otra variante,
hay que **fusionar**, y eso es una operación explícita, transaccional e idempotente:

1. Bloquea la variante provisoria, la variante destino y sus representaciones, con `version` esperada: una resolución
   concurrente sobre cualquiera de las tres responde 409 sin efecto parcial.
2. Mueve las representaciones y los casos de la provisoria a la destino.
3. Archiva la provisoria con motivo `fusionada_en <id>`; su identidad no se reutiliza nunca.
4. Cierra el caso y deja el evento de auditoría con quién, cuándo y qué decisión del matcher la originó.

Corregir una asignación equivocada no reescribe el SKU inmutable: se desvincula la representación con un evento
compensatorio y se reasigna, igual que cualquier otra decisión.

## 7. Interfaz

`GET /api/v2/catalog/models`, `/variants` y `/reconciliation`, sólo lectura, paginados por cursor, con errores
`{code,message,correlation_id,details?}` y autorización por capacidad. `/reconciliation` devuelve los conteos del §8.

## 8. Qué se considera terminado (como tramo)

**Denominadores independientes, por cuenta y por tipo:** padres Woo, simples Woo, variaciones Woo, ítems ML simples,
ítems ML clásicos, variaciones ML clásicas e ítems `user_product`, cada uno separado en activos, pausados y
cerrados. Cada fila del origen termina en exactamente una de: importada, caso con causa, o rechazada con causa. Nada se
descarta en silencio.

**Cruce íntegro, conjunto por conjunto** (no "todo tiene decisión y viceversa", que contradice los pendientes):

| Conjunto | Tiene que corresponder con |
|---|---|
| decisiones vigentes `confirmar`/`asignar` | representaciones vinculadas a la variante de ese SKU |
| publicaciones sin decisión vigente | variantes con SKU pendiente y caso `sku_pendiente` abierto |
| decisiones vigentes `omitir` | representaciones omitidas con caso `omitida_revisar` |
| decisiones cuyo SKU no existe en Woo | caso `sku_inexistente_en_woo` |

**Hash de la importación:** SHA-256 sobre las filas de representaciones, variantes y decisiones vigentes, ordenadas
por su clave natural, **excluyendo** ids generados y marcas de tiempo, con la corrida y el corte que se usaron. Dos
importaciones sobre la **misma corrida** dan el mismo hash; sobre fuentes vivas distintas pueden diferir y eso no es un
defecto.

**Escenarios contractuales de `npm run test:e2`**, que falla si falta alguno: restricciones SQL, importación repetida,
padre no vendible, SKU inmutable, variante con SKU pendiente, omitida con caso, SKU inexistente en Woo, Woo simple sin
SKU, SKU duplicado en Woo, ML clásico con varias variaciones, dos ítems de una misma familia `user_product`,
publicación pendiente que recibe un SKU ya existente (fusión), dos resoluciones concurrentes, revocación de una
decisión en el legado, recurso sin cambios desde antes del bootstrap, payload vencido, 429 a mitad del scan de ML con
retoma desde el checkpoint, duplicado con variación vacía, baja y reaparición de una representación, y conciliación
por cuenta cubriendo variaciones anidadas.

## 9. Despliegue y reversión

Sólo lectura: el proyector escribe únicamente en `catalog.*` y no hay escritor remoto. Se comparan conteos, relaciones y
hashes durante 7 días. Reversión: apagar el proyector, el fan-out y la API de catálogo, conservando el esquema. El
fan-out se apaga con un flag propio, así E1 sigue funcionando sin E2.

## 10. Preguntas que quedan para el plan

1. El horario del bootstrap de ML.
2. Qué hacer con un payload del inbox que ya venció cuando se lo necesita (hoy: forzar relectura de ese recurso).

## 11. Cómo se resolvió cada hallazgo de la revisión externa

| # | Hallazgo | Dónde |
|---|---|---|
| 1 | El inbox es de un solo consumidor | §4.1 fan-out en la misma transacción |
| 2 | El inbox no es un snapshot completo | §4 y §4.2 bootstrap forzado; §10.2 |
| 3 | Fusión de una variante pendiente | §6 |
| 4 | Familias `user_product` | §5.1 y §5.2 |
| 5 | Ítems clásicos de ML | §5.1 `contenedor`/`vendible` y §5.2 |
| 6 | `UNIQUE` con `NULL` | §5.1 `variacion_normalizada` no nula |
| 7 | Modelos de ML sin Woo | §5.2 |
| 8 | SKU de Woo vacío, duplicado o no canónico | §5.3 |
| 9 | La barrida de ML y la cuota | §4.2 |
| 10 | Corte inconsistente del matcher | §4.3 |
| 11 | Vigencia de las decisiones | §4.3 y §5.1 |
| 12 | Vigencia y archivo de representaciones | §5.1 |
| 13 | Hash no definido | §8 |
| 14 | Denominadores | §8 |
| 15 | Cruce mal formulado | §8, tabla por conjunto |
| 16 | T1 no satisface la ficha | §1 |
| 17 | Escenarios faltantes | §8 |
