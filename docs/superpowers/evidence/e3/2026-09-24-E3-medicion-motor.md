# E3 — medición del motor de matching antes de rediseñarlo

Fecha: 2026-09-24. Sólo lectura contra producción (Postgres vía `auditor_e2_readonly`) y contra el
SQLite legado (`data/fusion.sqlite`, sólo abierto `readonly`). No se escribió nada. Scripts en
`/tmp/claude-0/e3-medicion/` (temporales, no committeados).

## 1. Auto-vínculo por SKU exacto

Regla de la ficha E3: GTIN nunca auto-vincula. Se mide sólo coincidencia exacta de SKU.

### `omitida_revisar` (2227 casos abiertos)

Estos casos SÍ tienen `representation_id` (100%: 0 sin representación). De los 2227, **192 tienen
`sku_observado`** en su representación (2035 no tienen ese dato capturado — mismo hueco de
`capturado_en` visto en la evidencia de aceptación de E2, sección 5c/5d).

De esos 192 con `sku_observado`:

| resultado | n |
|---|---|
| coincide con UN solo SKU de `sellable_variants` | 17 |
| coincide con varios (empate) | 0 |
| no coincide con ninguno | 175 |

Consulta y salida: `/tmp/claude-0/e3-medicion/01-auto-vinculo-sku.sql` / `.out`.

### `sku_pendiente` (2098 casos abiertos) — CORREGIDO

**Corrección de opt-62, verificada**: la medición original usaba el join equivocado.
`identity_cases.representation_id` está NULL para este tipo de caso (el caso cuelga de
`variant_id`, no de `representation_id`), pero la representación de canal SÍ existe: se llega por
`external_representations.variant_id = identity_cases.variant_id`, no por `representation_id` ni
por "mismo `model_id`" como midió la primera versión. Con el join correcto:

| | n |
|---|---|
| total `sku_pendiente` abiertos | 2098 |
| con al menos una representación (por `variant_id`) | 2091 |
| con `sku_observado` cargado en esa representación | 527 |
| coincide con UN solo SKU de `sellable_variants` | 146 |
| coincide con varios (empate) | 0 |
| no coincide con ninguno | 381 |

Consulta y salida: `/tmp/claude-0/e3-medicion/03-auto-vinculo-sku-pendiente-corregido.sql` /
`.out`, cobertura en `04-cobertura-sku-pendiente.sql`/`.out`. (opt-62 midió independientemente
2098/529/148/381/0 sobre el mismo join; la diferencia de 2 en "con sku_observado" y de 2 en
"un solo match" es esperable entre corridas — la tabla sigue recibiendo escrituras en producción — no
una discrepancia de método.)

**Resumen del punto 1, corregido**: de 4325 casos abiertos de estos dos tipos, **163 (146 + 17,
3.8%)** tendrían auto-vínculo inmediato por SKU exacto hoy con los datos ya capturados — no 17 como
decía la primera versión de este documento.

### Por qué el proyector no vinculó ya estos 163 casos (aunque el SKU coincide exacto)

La primera versión de este documento atribuía el problema a que faltaba backfill de atributos
(E2 T2). **Esa conclusión estaba mal y no salía de ningún dato**: el backfill de E2 T2 está
completo (86.632 atributos, confirmado por opt-62). La causa real está en la regla de vínculo de
`plataforma/src/catalogo/aplicar.ts`, revisada con cita exacta:

- **Los 146 `sku_pendiente` con SKU coincidente**: `vincularMl` (`aplicar.ts:204-239`) **nunca
  compara el `sku_observado` de la publicación contra `sellable_variants.sku`**. El único camino de
  vínculo automático en ML es una fila vigente en `catalog.matcher_decisions` con
  `accion IN ('confirmar', 'asignar')` (`aplicar.ts:215-229`); si no existe esa decisión, cae
  siempre a `sku_pendiente` (`aplicar.ts:236-238`), sin importar que el SKU observado coincida
  exacto con una variante existente. La comparación de Woo (`obs.sku.estado === 'canonico'`,
  `aplicar.ts:157,173`, definida en `woo.ts:27-28` como `valor === skuCanonicoDe(idWoo)`, formato
  `FB-{ID_WOO}`) sólo aplica al canal Woo — ML no tiene un equivalente. Es decir: el motor de
  matching automático por SKU exacto simplemente no existe para ML hoy; sólo existe la vía de
  decisión ya tomada (matcher legado/humano). Esto es justamente lo que E3 se propone construir.
- **Los 17 `omitida_revisar` con SKU coincidente**: verificado con consulta directa
  (`/tmp/claude-0/e3-medicion/05-omitida-revisar-corregido.sql`/`.out` más el cruce contra
  `matcher_decisions`), **los 2227 casos `omitida_revisar` (los 17 incluidos) tienen una decisión
  vigente `accion = 'omitir'`** en `catalog.matcher_decisions` para esa misma
  `(channel_account_id, recurso, variacion_normalizada)`. `vincularMl` respeta esa decisión antes
  de mirar nada más: `if (decision?.accion === 'omitir') return { ..., omitida: true,
  casoSobreRepresentacion: { tipo: 'omitida_revisar', ... } }` (`aplicar.ts:220-225`) — el SKU
  coincidente nunca se llega a evaluar porque la decisión explícita de omitir corta antes. No es un
  bug: es una decisión humana/legada previa que el proyector respeta a propósito. Que el SKU ahora
  coincida es información nueva desde que se tomó esa decisión, y el sistema actual no la revisa
  sola — hace falta revisar/revertir esas 17 decisiones a mano, o que E3 agregue una revisión
  automática cuando cambian los datos observados.

## 2. Precisión del motor actual (muestra estratificada de decisiones)

Fuente: `sku_matcher_decisiones` del SQLite legado (5261 decisiones totales: 2376 omitir, 1832
confirmar, 1053 asignar). Muestra estratificada proporcional de 299 decisiones (300 objetivo, un
redondeo la dejó en 299), congelada en `/tmp/claude-0/e3-medicion/muestra-300.json` (claves
`item_id|variation_id` + `sku`/`wc_nombre`/`accion` reales, para reusar sin volver a samplear).

De las 299, 16 no tenían la publicación ML todavía en `ml_publicaciones_cache` (expiró del caché o
cambió de estado) → 283 procesadas contra `lib/matcherEngine.js` (mismo motor de servidor que usa
`routes/matcher.js`, vía `construirWC` + `construirMLdesdeApi` + `candidatosDeItem`).

`omitir` no tiene `sku` real (por definición: la decisión fue no vincular), así que top1/top3 sólo
se mide sobre `confirmar` + `asignar` (158 filas con `sku_real`).

| | n | top1 correcto | top3 correcto | top1 incorrecto con score ≥0.8 |
|---|---|---|---|---|
| general | 158 | 84 (53.2%) | 129 (81.6%) | 47 (29.7%) |
| confirmar | 99 | 63 (63.6%) | 81 (81.8%) | 20 |
| asignar | 59 | 21 (35.6%) | 48 (81.4%) | 27 |

Salida completa: `/tmp/claude-0/e3-medicion/resultado-motor-actual.json`,
`/tmp/claude-0/e3-medicion/resumen-motor-actual.json`, log de corrida en `medir-motor.out`.

**Lectura**: el motor acierta el top3 en 4 de cada 5 casos, pero el top1 falla casi la mitad de las
veces — y en 47 de 158 (30%) el top1 incorrecto viene con score alto (≥0.8), que es la situación más
peligrosa para un auto-vínculo: el motor está "seguro" y equivocado. `asignar` (publicaciones sin
SKU todavía, el caso más difícil, sin punto de partida) es sensiblemente peor que `confirmar`
(verificar un SKU ya puesto).

## 3. Con atributos de Gemini

Extracción de atributos (`modelo`, `talle`, `color`, `rodado`, `pack`/cantidad, `marca`) sobre los
títulos de las dos puntas (ML y WC) de las 158 filas con `sku_real`, en lotes de hasta 40 títulos,
JSON, temperatura 0, mismo modelo y función (`llamarGemini`) que usa `routes/gemini.js`
(`gemini-3.1-flash-lite`), con la clave `GEMINI_KEY` del `.env` (misma que usa Recepción).

**Cupo usado: 6 consultas de 40 permitidas** (2 lotes de títulos ML tuvieron un 503 reintentado
por `llamarGemini` y no se recuperaron en ese lote; no hubo ningún 429, no se cortó por cupo).
Tiempos por consulta (ms): 8145, 90127, 7446, 6098, 15070, 19943 — total 146.8s. El lote de 90s fue
un reintento con backoff tras un 503 inicial. Metadata completa: `/tmp/claude-0/e3-medicion/gemini-meta.json`.

158 de 158 claves quedaron con atributos extraídos en ambas puntas (los 2 lotes con 503 fueron
lotes distintos de las 40 que sí completaron; no hubo hueco final).

### Cómo se combinó con el motor

Sin gastar más cupo: para cada fila, se tomó el **top3 original** que ya había dado el motor
(sección 2) y se reordenó dentro de ese top3 por la fracción de atributos ML no-nulos (extraídos
por Gemini) que aparecen como substring (normalizado, sin acentos) en el `wc_nombre` de cada
candidato — primero ese criterio, empate se resuelve por el score original del motor. Es una
combinación deliberadamente simple (comparar contra el `wc_nombre` completo en vez de extraer
atributos también del lado WC candidato-por-candidato, que hubiera costado una consulta extra por
candidato y superaba el objetivo de medición, no de construir el rediseño).

| | n | top1 correcto | top3 correcto |
|---|---|---|---|
| con motor solo (sección 2) | 158 | 84 (53.2%) | 129 (81.6%) |
| con atributos de Gemini (re-rankeo del top3) | 158 | 85 (53.8%) | 129 (81.6%) |

Salida: `/tmp/claude-0/e3-medicion/resultado-con-gemini.json`,
`/tmp/claude-0/e3-medicion/resumen-con-gemini.json`.

**Lectura, sin inflar el resultado**: la mejora es marginal (+1 caso de 158) y el top3 no cambió,
porque el re-rankeo sólo puede mover el orden DENTRO del top3 que ya calculó el motor — si el SKU
correcto no entró en ese top3 en primer lugar, ningún criterio de atributos lo rescata. El criterio
de comparación usado (substring contra el nombre completo) también es débil: un atributo correcto
puede no matchear por diferencias de redacción entre el título ML y el nombre WC. Esto sugiere que
el valor de los atributos estructurados está más en **ampliar el conjunto de candidatos considerado**
(no sólo re-rankear el top3 ya elegido por el motor actual) y en comparar atributo-contra-atributo
extraído de ambas puntas (no título-completo-contra-atributo), no en un post-filtro liviano como el
medido acá — es una hipótesis de diseño para E3, no una conclusión medida.

## Resumen para diseñar E3

1. **Corregido (ver punto 1)**: el cuello de botella real para auto-vínculo por SKU exacto NO es la
   cobertura de datos capturados — el backfill de E2 T2 está completo. Es que **ML no tiene ningún
   camino de auto-vínculo por SKU exacto**: `vincularMl` sólo actúa sobre decisiones ya tomadas en
   `matcher_decisions` (`aplicar.ts:204-239`), nunca compara `sku_observado` contra
   `sellable_variants.sku` directamente. Con el join correcto, 163 casos (146 `sku_pendiente` + 17
   `omitida_revisar`) tienen ya un SKU coincidente exacto disponible y aun así siguen abiertos: para
   `sku_pendiente` porque el criterio simplemente no existe hoy; para `omitida_revisar` porque una
   decisión explícita `accion='omitir'` previa lo bloquea a propósito (`aplicar.ts:220-225`). Esto
   es exactamente lo que E3 tiene que construir: el auto-vínculo por SKU exacto en ML no está
   implementado, no es que falle por falta de datos.
2. El motor actual: top3 81.6%, top1 53.2%, con 30% de "top1 incorrecto pero confiado" (score
   ≥0.8) — ese 30% es el riesgo concreto de un auto-vínculo automático sin revisión humana.
3. Agregar atributos de Gemini como post-filtro del top3 ya calculado aporta poco (+0.6pp en
   top1, nada en top3). Si se van a usar atributos estructurados, el diseño debería usarlos para
   ampliar/re-generar candidatos, no sólo reordenar los que ya trae el motor actual.
