# Bandeja de identidad — auditoría con pantalla real (sesión)

**Fecha:** 2026-09-26. Complementa `2026-09-26-bandeja-auditoria-codex.md` (Codex sólo leyó código).
**Método y límites:** Chromium (Playwright) contra un harness local (`scripts/qa/bandeja-harness/`) que sirve el `public/` real y simula la API con **5 casos sintéticos** (sin candidatos, sku_pendiente, atributo_divergente, user_product_divergente, 3 candidatos). **No es la base anonimizada**: QA (`qa.sh`) no levanta la plataforma que responde `/api/bandeja-identidad`, así que la bandeja no se puede ver ahí. Las fotos son SVG 800×600 generados; los títulos largos son realistas. Los tamaños de foto dependen del layout, no del contenido; el alto de las matrices depende de la cantidad de atributos (aquí 4–6). Capturas: `capturas-2026-09-26/` (`<res>-<caso>-pliegue.png` y `-completa.png`).

## Medición (viewport → alto total del documento; botones de decisión)

| Caso | 1440×900: doc / botón Vincular (top) | 1280×800: doc / botón Vincular (top) |
|---|---|---|
| 1 sin candidatos | 1861 (2,1 pantallas) / — (no hay Vincular; Buscar en y=1338) | 1756 (2,2) / Buscar en y=1250 |
| 2 sku_pendiente (1 cand.) | 1942 (2,2) / 1363 | 1881 (2,4) / 1320 |
| 3 atributo_divergente (1 cand.) | 2007 (2,2) / 1427 | 1941 (2,4) / 1380 |
| 4 user_product_divergente (1 cand.) | 1920 (2,1) / 1341 | 1834 (2,3) / 1273 |
| 5 tres candidatos | 2190 (2,4) / 1610 | 2116 (2,6) / 1555 |

- **La decisión nunca está en el pliegue**: botones entre 1273 y 1610 px con un viewport de 800–900. Hay que bajar 0,5–0,8 pantallas (≈ 450–750 px) sólo para poder clicar. Con teclado no hace falta, pero entonces se decide sin ver la comparación completa.
- **Cromo fijo antes del caso**: topbar 53 px + barra de filtros ≈ 70 px + línea "Todo guardado" ≈ 50 px → ≈ 175 px; el encabezado del caso (título en 2 líneas + prioridad + link) suma ≈ 190 px. La matriz empieza en y≈340–375.
- **Fotos** (natural 800×600): con 1–2 columnas de candidato la foto mide **505×378 (1440)** / **446×334 (1280)**; con 3 candidatos baja a **270×202** / **238×178**. La foto Woo se ve bien con 1 candidato, pero la fila de foto ocupa ≈ 405 px de alto por sí sola y empuja título/SKU/atributos bajo el pliegue. **La foto ML: 0 de 5 casos.** Siempre "Sin foto ML" dentro de un recuadro vacío de ≈ 505×380 (en el caso 1, 820×620) que ocupa lo mismo que una foto real.
- **Cortes**: 0 elipsis/`overflow` truncando texto (los títulos se parten, no se cortan). Lo "cortado" es lo que queda **bajo el pliegue**, no texto truncado.
- **Acciones**: 6–8 botones **a todo el ancho, apilados** (≈ 330–390 px de alto) bajo la matriz y bajo los radios de candidatos; sin jerarquía visual entre "Vincular" y "No vincular esta publicación".
- **Doble representación**: cada candidato aparece en la matriz (foto, título, SKU) y otra vez como radio (título + SKU + rank). En el caso 5 la grilla + radios ocupan ≈ 790 + 200 px.

## Costo de decidir (medido con teclado real)

| Acción | Resultado medido |
|---|---|
| `1` | selecciona (radio marcado), **0 POST** |
| `1` + `Enter` | 1 POST `vincular`; pasa al caso siguiente. **2 teclas** |
| con ratón | click en radio + scroll ≈ 500–750 px + click en "Vincular seleccionado": 2 clics + scroll |
| `z` (≤ 10 s) | deshace: POST nuevo `sin_candidato` con `revierte:<decisión>` y vuelve al caso |
| `o` | omite sin escribir; `?` apartar (POST `/apartar`); `/` abre buscador |
| `x` sin caso confirmable | **no hace nada** (sólo aplica al grupo Confirmar) |
| deshacer | aviso **fijo abajo (y≈848 de 900)**, dice "Podés deshacerlo unos segundos"; no muestra cuenta regresiva |

## Hallazgos de Codex: confirmar / refutar

| # | Hallazgo (Codex) | Veredicto | Evidencia |
|---|---|---|---|
| C1 | Foto ML nunca aparece | **CONFIRMADO, y peor**: no es sólo `foto: null` en `bandeja.js:551`; la API tampoco la entrega (`publicacion` en `plataforma/src/api/identidad-interna.ts:225,321` no tiene `foto`). | 0/5 casos; recuadro vacío de 505×380. El legado ya guarda `thumbnail` en `ml_publicaciones_cache`: el arreglo es backend + UI, no sólo UI. |
| C2 | Decisión bajo la comparación y una segunda lista | **CONFIRMADO** | Vincular en y=1273–1610, viewport 800–900 (tabla arriba). |
| C3 | Vincular requiere seleccionar y confirmar (2 acciones) | **CONFIRMADO** | `1` = 0 POST; `1`+`Enter` = 1 POST. Ya existe deshacer con `z`. |
| C4 | Mala sugerencia puede parecer candidata principal | **PARCIAL** | Sólo el candidato "SKU de ML coincide" trae la leyenda "Sugerencia del sistema"; los demás dicen "1.º sugerido". No hay evidencia junto al botón; "Por qué" está en la última fila de la matriz (bajo el pliegue). Es riesgo real de sesgo, pero no medible acá (datos sintéticos). |
| A1 | Comparación redundante | **CONFIRMADO** | Candidato repetido en matriz y radios. |
| A2 | Acciones con jerarquía débil | **CONFIRMADO** | 6–8 botones iguales apilados a ancho completo. |
| A3 | Búsqueda manual no es de primera clase | **CONFIRMADO** (parcial): `/` abre el buscador y funciona; los resultados se agregan como columnas "Búsqueda N" de la misma matriz (no se probó con resultados reales: el harness devuelve 0). |
| A4 | Fotos pequeñas y no comparables | **PARCIAL**: con 1 candidato la foto es grande (505×378) y el visor `f` existe; con 3 candidatos baja a 270×202 / 238×178. El problema mayor es que ML no tiene foto y que ML/candidato no se ven a la vez con el título. |
| A5 | Sin zona de decisión sticky | **CONFIRMADO**: scroll de página completo (`HTML:1861/900`); únicamente el aviso de deshacer es `fixed`. |

Además: Codex dice que a 1280 "los títulos se parten": confirmado, sin elipsis. Codex dice "no hay scroll horizontal": confirmado (0 desbordes).

## Hallazgos adicionales (no están en Codex)

1. **La pantalla no dice qué tipo de caso es** (atributo_divergente, user_product_divergente, sku_pendiente…): sólo "Prioridad: Conflicto/Resto". Además el front lee `detalle.tipo_caso` (`bandeja.js:852`) pero la API devuelve `tipo` (`identidad-interna.ts:319`): el dato llega `undefined`. Es el dato que más orienta la decisión ("qué debo mirar").
2. **Caso sin candidatos**: 1861 px de documento para mostrar una sola columna; el recuadro vacío de foto ML ocupa 620 px. Acciones útiles (Buscar) en y=1338.
3. **El aviso de deshacer no comunica cuánto dura** (10 s, `VENTANA_DESHACER_MS`) y `z` no se anuncia en el botón.
4. **`x` es silencioso** fuera del grupo Confirmar; el pie de ayuda no lo aclara.
5. Encabezado del caso repite el título ML a 24 px en 2 líneas y luego otra vez en la matriz (fila Título): ≈ 100 px duplicados por caso.
6. Precio sin formato de miles ("189900 ARS") y stock sin contexto de comparación con el candidato (precio/stock del candidato tampoco cambian la decisión, pero ocupan una fila).

## Opinión sobre la propuesta de Codex

Acuerdo en el diseño de "estación": ML y candidato lado a lado, foto grande arriba, **sólo diferencias** en el centro (ordenadas: difiere > falta > equivalente), barra de decisión fija abajo, tipo de caso visible, una sola representación por candidato. Las mediciones justifican que el caso quepa en 1440×900 sin scroll: chrome ≈ 175 px + encabezado ≈ 60 px + foto ≈ 300 px + diferencias ≈ 250 px + barra ≈ 80 px.

Desacuerdo parcial: un candidato de una sola tecla es peligroso **mientras el motor no esté calibrado** (top-1 incorrecto frecuente, sesgo de aceptación por posición). Pero el costo actual de 2 teclas + scroll no viene de la tecla extra: viene de tener que **bajar para ver el botón** y de no ver evidencia junto al candidato.

### Cómo cerrar el conflicto con la decisión S3 (25/09: dos teclas)

Propuesta en tres niveles, sin cambiar la regla de seguridad de fondo:

1. **Dos pasos siempre, pero en pantalla**: `1/2/3` **selecciona y resalta** el candidato y muestra la barra de decisión ya visible con "Enter = Vincular a <SKU> (2 diferencias)". `Enter` confirma. Con la barra sticky y las diferencias arriba, el segundo paso es una lectura de 1 s, no un scroll. Esto respeta S3 al pie de la letra y elimina casi todo el costo real.
2. **Enter directo sólo sin contradicciones**: si el candidato seleccionado no tiene ningún atributo `difiere`/`falta` y es único, `1` puede vincular directo **con deshacer visible** (banner arriba de la barra, cuenta regresiva de 10 s, `z`). Cuando hay contradicciones, sigue siendo `1` + `Enter`. Requiere que José reabra S3 sólo para este subcaso.
3. **Sin candidato a un toque de distancia**: `x` (no es ninguno) y `?` (apartar) ya son de una tecla y reversibles: mantenerlos.

Recomendación: implementar (1) primero (cumple S3), medir tiempo por caso y tasa de deshacer con el motor real, y **sólo si** la tasa de deshacer es baja habilitar (2). No habilitar vinculación directa con score como criterio de confianza: el motor no está calibrado.

## Prioridad sugerida (impacto / esfuerzo)

1. Barra de decisión sticky y layout de dos columnas (ML | candidato) con foto grande y sólo diferencias; una única representación del candidato (arregla C2, A1, A2, A5).
2. Foto ML: exponer `thumbnail` (legado, `ml_publicaciones_cache`) o `foto` en `publicacion` de la API y usarla (C1).
3. Mostrar el tipo de caso y arreglar `tipo_caso`/`tipo` (adicional 1).
4. Cuenta regresiva del deshacer y atajo visible (adicional 3–4).
5. Sólo entonces evaluar Enter directo en casos sin contradicciones (opinión, punto 2).

## Pendiente de diseño (anotado)

- Dashboard: detección de "publicación con stock en ML y sin vínculo" (pedido aparte de José, no cubierto acá).
- Repetir la medición con la base anonimizada cuando QA levante la plataforma, para validar el número de atributos por caso y el comportamiento con resultados de búsqueda reales.
