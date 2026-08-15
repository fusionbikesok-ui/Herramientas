# Design System — FusionBikes Herramientas

## Contador de Inventario

### Tokens visuales

Agregados en `public/lib/theme.css` para el Contador de Inventario v2:

#### Interactividad móvil
- `--tap-min: 44px` — área mínima táctil (WCAG 2.5.5), botones y chips en mobile.

#### Chips (filtros, estado, conteos)
- `--chip-bg: var(--surface2)` — fondo chip desactivado.
- `--chip-bd: var(--border)` — borde chip desactivado.
- `--chip-txt: var(--muted)` — texto chip desactivado.
- `--chip-on-bg: var(--accent-dim)` — fondo chip activado (acento tenue).
- `--chip-on-bd: var(--accent)` — borde chip activado (acento sólido).
- `--chip-on-txt: var(--accent)` — texto chip activado (acento sólido).

#### Diferencias (contado vs. stock real)
- `--diff-neg: var(--critical)` — diferencia negativa (contamos menos de lo que hay).
- `--diff-pos: var(--success)` — diferencia positiva (contamos más de lo que hay).
- `--diff-zero: var(--muted)` — sin diferencia (coincide con stock real).

#### Estados de sesión
- `--state-pending: var(--muted)` — producto aún no contado.
- `--state-counted: var(--success)` — producto ya contado.
- `--state-unlinked: var(--warning)` — EAN sin asociar a SKU (acción requerida).

#### Barra de progreso (confirmación de ajustes)
- `--progress-track: var(--surface2)` — fondo de la pista.
- `--progress-fill: var(--accent)` — relleno (progreso).

#### Peligro (confirmación de ajuste, irreversible)
- `--danger: var(--red)` — color rojo para iconos/acentos de peligro.
- `--danger-bg: var(--red-bg)` — fondo rojo tenue (botón).
- `--danger-bd: var(--red-bd)` — borde rojo tenue (botón).
- `--danger-solid: var(--red)` — rojo sólido (acento fuerte).
- `--danger-on: #2A0505` — texto sobre fondo rojo sólido (WCAG AA ≥4.5:1).
- `--danger-veil: rgba(6,8,13,.92)` — velo oscuro en modal de confirmación.

#### Bottom sheet (panel EAN nuevo)
- `--sheet-bg: var(--surface)` — fondo del sheet.
- `--sheet-bd: var(--border2)` — borde superior del sheet.

Todos los colores verificados para WCAG 2.2 AA (contraste ≥4.5:1 en textos).

---

## Feed de Actividad (Preparación de Pedidos)

Registro cronológico de eventos en el detalle de un pedido. Componentes compartidos
(Atomic Design liviano): sólo 3 piezas que se repiten — `.act-head` (header colapsable),
`.feed-item` (entrada) y `.chip-jump` (chip de salto). No se creó jerarquía atómica completa:
la sección tiene un único layout propio.

### Tokens nuevos
- `--tap-comfort: 56px` — blanco de toque **cómodo** para controles de ancho completo
  (header colapsable). `--tap-min` (44px) sigue siendo el piso; acá se sube porque el
  operario toca con guantes / una sola mano mientras sostiene un bulto.
- `--act-rail: var(--border)` — línea vertical del timeline. Alias para no hardcodear
  el borde y poder ajustar el rail sin tocar todos los bordes de la app.
- `--act-deleted-veil: rgba(12,15,22,.55)` — velo del badge "✕" sobre miniatura borrada.
- `--act-deleted-hatch: rgba(248,113,113,.55)` — trama diagonal 45° sobre miniatura borrada.
  Es la señal **no cromática** de "borrada" (además de dashed + grayscale + texto), para que
  se distinga sin depender del rojo (daltonismo protán/deután).
- `--act-new-hold: 6s` — cuánto se mantiene la marca "nuevo" antes de atenuarse sola.

### Tokens reusados (no se inventó color nuevo)
`--surface`, `--surface2`, `--border`, `--border2`, `--text`, `--muted`, `--muted2`,
`--azul/--accent`, `--blue-bg`, `--blue-bd`, `--green`, `--red`, `--red-bd`, `--amber`,
`--amber-bd`, `--purple/--violet`, `--chip-bg/--chip-bd/--chip-txt`, `--radius`, `--tap-min`.

### Decisiones y motivo
- **Jerarquía**: pesa más el **producto** (800) que el verbo (600) y que la persona (700 a
  11.5px). El operario busca "qué pasó con esta bici", no "qué hizo Juan".
- **Marca "nuevo"**: fondo `--blue-bg` + borde-izquierdo 3px `--azul` + pill "NUEVO".
  Ambiental, no estridente; se atenúa a los `--act-new-hold`. No se usa verde/rojo porque
  "nuevo" no es un juicio de valor.
- **Error de carga en ámbar, no rojo**: la sección es *fail-open*, no bloquea la preparación;
  el rojo está reservado en esta app a fallas que sí frenan la operación.
- **Vacío en borde punteado + `--muted`**: comunica "todavía no hay datos", no "se rompió".

### Contraste verificado (WCAG 2.2 AA)
Sobre `--surface #141A25`: `--text` 14.6:1 · `--muted` 5.67:1 ✓ · `--azul` 7.65:1 ·
`--green` 9.17:1 · `--amber` 9.95:1 · `--red` 6.36:1.
Sobre fila "nuevo" (`--blue-bg` compuesto ≈ #172A39): `--muted` 4.76:1 ✓ · `--text` 12.2:1.
**`--muted2` (#5B6B8C) da 3.33:1 sobre `--surface` → NO se usa para texto de datos**
(nombre / hora / SKU); queda reservado a glifos decorativos y separadores. En Actividad el
texto secundario va con `--muted`.

### Nota de enlace
`public/preparacion/index.html` NO enlaza `theme.css` (tiene `--amber #F5B942` en conflicto).
Estos 5 tokens deben replicarse con el mismo nombre y valor en su `:root` local.

---

## Cobertura de Catálogo (rediseño accionable)

Reemplaza el informe de 5 pestañas por una herramienta de trabajo: cola de a una, matcher
inverso WC→ML, multi-publicación y "Solo ML" accionables. Ver
`docs/superpowers/plans/2026-08-10-cobertura-accionable.md` (decisiones) y
`docs/superpowers/plans/2026-08-10-cobertura-flujo-ux.md` (flujo). Este bloque define el
sistema visual; **no** hay lógica de negocio ni JS acá — eso lo escribe `hard-worker-frontend`.

Atomic Design liviano: 3 componentes nuevos que se repiten entre pantallas —
`.title-diff` (resaltado de títulos), `.conf-badge` (confianza en 3 niveles) y
`.match-card` (tarjeta de comparación, con variante compacta para lista de candidatos y
Multi-publicación/Solo ML). El resto (barra de progreso, tarjetas de marca, skeleton) reusa
patrones y tokens que ya existen en la app (`--progress-*`, `--chip-*`, `--accent-dim`).

### 1. Resaltado de diferencias en los títulos (`.title-diff`)

El motor (`lib/matcherEngine.js`) tiene que devolver el título tokenizado con, por cada
token, dos banderas: `difiere: boolean` y `discriminante: boolean` (modelo/medida/marca).
La UI no decide esto, solo lo pinta. Tres tratamientos, cada uno cambia **más de un canal**
(fondo + peso + forma), nunca solo color — así funciona para quien no distingue rojo/verde
y con luz de depósito sobre la pantalla:

| Tipo de token | Texto | Fondo | Borde | Peso | Forma extra |
|---|---|---|---|---|---|
| Coincide | `--tok-match-txt` (muted) | ninguno | ninguno | normal | se atenúa, recede visualmente |
| Difiere, genérico | `--tok-diff-txt` | `--tok-diff-bg` (ámbar 10%) | `--tok-diff-bd` dashed 1px abajo | 600 | — |
| Difiere y es discriminante | `--tok-discriminant-txt` | `--tok-discriminant-bg` (rojo 10%) | `--tok-discriminant-bd` solid 1px, radius 4px, como chip | 700 | `font-family: var(--tok-discriminant-font)` (monospace — misma convención que SKU en el resto de la app) |

Ejemplo con el caso medido del plan: "Pedales Shimano **M520**" vs "Pedales Shimano
**M540**" — "Pedales" y "Shimano" en `--tok-match-txt` (atenuados, no llaman la atención);
"M520"/"M540" en fondo rojo, negrita, monoespaciado: literalmente el único par de palabras
que salta al ojo en 0,3 s, exactamente lo que el hallazgo del plan pide.

Por qué monoespaciado y no solo color: dos códigos que difieren en un carácter (`M520` vs
`M540`) alineados en fuente monoespaciada hacen que la posición del carácter que cambia
quede fija entre ambos títulos — ayuda a la lectura rápida incluso en blanco y negro.

Regla de "genérico vs. discriminante" la fija el motor (extracción ya prevista en
`matcherEngine.js`: color/talle/medida/marca/código alfanumérico), no un heurístico de la UI.
Si el motor no puede clasificar un token que difiere, cae en "genérico" (nunca en
"coincide" — subestimar el riesgo es peor que sobre-marcarlo).

### 2. Confianza en tres niveles (`.conf-badge`)

Nunca porcentaje. Badge de texto+icono+color, los tres canales redundantes:

| Nivel | Texto | Icono | Color |
|---|---|---|---|
| Alta | "Coincidencia alta" | `✓` | `--conf-alta` / `--conf-alta-bg` / `--conf-alta-bd` |
| Media | "Revisar bien" | `⚠` | `--conf-revisar` / `--conf-revisar-bg` / `--conf-revisar-bd` |
| Baja | "Poco parecido" | `✕` | `--conf-baja` / `--conf-baja-bg` / `--conf-baja-bd` |

Jerarquía: va **arriba de los precios**, debajo de las fotos/títulos (nivel 1 de la
tarjeta) — es la primera pregunta que el usuario responde antes de mirar detalle. No es un
`<h1>`: 13px/600, badge con padding 3px 10px, radius pill (`--radius-pill`, ya existe). No
compite en tamaño con el título; compite en atención por posición y color, no por tamaño.

Mapeo con el matcher inverso: alta = score alto Y sin discrepancia en ningún token
discriminante; media = score medio O al menos un token discriminante en duda (no en
franca contradicción); baja = contradicción franca en algún token discriminante
(ese es justo el caso M520/M540: aunque el score de bolsa de palabras dé 80%, si hay un
token discriminante que difiere, el nivel de confianza **no puede ser "alta"** — esta regla
es la que traduce el hallazgo del plan a la UI y tiene que vivir en el motor, no en un ajuste
visual después).

### 3. Tarjeta de comparación (`.match-card`)

**Mobile (375px), nivel 1 sin scroll:**
```
┌─────────────────────────────┐
│ [Coincidencia alta ✓]        │  13px, badge
│ ┌───────┐   ┌───────┐        │
│ │ foto  │   │ foto  │        │  ~120px cada una, lado a lado, gap 8px
│ │  WC   │   │  ML   │        │  (2 × 120 + 8 + padding ≈ 264px < 343px útil en 375)
│ └───────┘   └───────┘        │
│ Pedales Shimano M520          │  título WC, .title-diff, 14px/1.35
│ Pedales Shimano M540          │  título ML, .title-diff, 14px/1.35
└─────────────────────────────┘
```
Nivel 2 (precios/stock/categoría) va debajo, 12px, dos columnas `WC | ML`, texto
`--muted`/`--text` alternado — no reduce el nivel 1, se agrega después sin empujarlo fuera
de la pantalla porque nivel 1 por sí solo ya cabe en menos de 400px de alto. Atributos
completos (variación, color, talle) quedan tras un `<details>`/toggle, cerrado por default.

Acciones: `[ Confirmar vínculo ]` ancho completo, `--tap-comfort` (56px) de alto — el pulgar
no tiene que apuntar. Debajo, fila de 4 acciones de igual peso visual entre sí (texto +
icono, sin relleno de color, `--tap-min` 44px cada una): `Abrir en ML` · `Solo local` ·
`Hay que publicarlo` · `Saltear`. Si no entran los 4 en una fila a 375px, pasan a grid 2×2 —
nunca scroll horizontal ni menú oculto (son acciones frecuentes, no un menú secundario).

**Desktop (1280px):** no es la misma tarjeta estirada. Cambia la disposición, no la
jerarquía: fotos más grandes (~180px) y **los dos títulos en columnas lado a lado** en vez
de apilados (aprovecha el ancho, reduce el recorrido del ojo entre los dos títulos que hay
que comparar — más relevante en desktop porque hay espacio para ponerlos uno junto al otro
sin que se corten). Nivel 2 pasa a una fila de 4-6 columnas (precio WC, precio ML, stock WC,
stock ML, categoría WC, categoría ML) en vez de two-column apilado. El botón de confirmar
deja de ser ancho completo (no hace falta la comodidad del pulgar en mouse/trackpad) pero
mantiene el mismo tamaño de tap (`--tap-comfort`) y sigue siendo el más grande de la fila de
acciones — la jerarquía se mantiene, la geometría se adapta.

**Variante compacta** (candidatos #2/#3, filas de Multi-publicación y Solo ML): mismo
`.title-diff` en los títulos, sin fotos grandes (thumbnail 40px), sin nivel 2 visible
(a demanda), acciones como iconos con `aria-label` en vez de texto largo. No es un
componente nuevo — es `.match-card--compact`, mismos tokens.

### 4. Barra de progreso de dos niveles

No requiere tokens nuevos: reusa `--progress-track`/`--progress-fill` (ya definidos para
Contador de Inventario). Primaria: barra + fracción "34/99" a la derecha, 14px/600. Debajo,
**una sola línea, 12px, `--muted`, sin ícono de logro ni animación**: "Hoy resolviste 12 ·
desinmovilizaste $2.1M" — texto plano, no gráfico ni medalla (pedido explícito del usuario:
utilidad, no gamificación). El total global de faltantes NO va en esta pantalla (ya se vio
en la entrada); si se necesita, es un link "ver todo", no una tercera cifra compitiendo por
atención.

### 5. Tarjetas de marca (pantalla de entrada) y "Seguir donde quedé"

Tarjetas de marca: layout tipo chip grande, no tabla. Cada una: nombre de marca (600),
conteo (`--muted`, 12px) y valor inmovilizado (`--text`, 13px/600) en la misma línea o
apiladas si el nombre es largo. Fondo `--surface`, borde `--border`; al `:hover`/`:focus`
borde `--accent`. Sin tokens nuevos.

"Seguir donde quedé" es el elemento más grande y más arriba, con tratamiento de
**highlight**, no de tarjeta más: fondo `--accent-dim`, borde `--accent` — el mismo patrón
que `--chip-on-bg`/`--chip-on-bd` ya usa para "activo" en Contador de Inventario. Reusar ese
patrón en vez de inventar un nuevo "destacado" mantiene la app consistente: "esto está
activo/es tu próximo paso" siempre se ve igual en toda la app.

### 6. Alerta de sobreventa (Multi-publicación)

Máxima urgencia de esa sección → reusa `--critical`/`--critical-bg`/`--critical-bd` (ya
alias de rojo, reservados en la app a lo que de verdad frena/alarma — igual que en Feed de
Actividad). Fila con stock 0 en una publicación que covive con otras del mismo SKU: icono
`⚠` + texto explícito "posible sobreventa" (nunca solo el número en rojo — el 0 solo no
comunica riesgo a quien no lo sepa de memoria) + fondo `--critical-bg` tenue en toda la fila,
no solo el número. Acciones de esa fila (`Pausar`/`Desvincular`) quedan con el mismo peso
que en filas sanas — la urgencia está en la alerta, no en botones gritones.

### 7. Estados

**Skeleton (carga inicial de tarjetas de marca):** bloques con `--skeleton-base` de fondo y
`--skeleton-highlight` como barrido (`background-position` animado, `prefers-reduced-motion`
respetado — sin animación si el usuario lo pide). Reproduce la silueta real de una tarjeta
de marca (nombre + conteo + valor), no un rectángulo genérico — así no “salta” el layout
cuando llega el dato real.

**Vacíos:** borde punteado `--border` + texto `--muted`, mismo patrón que Feed de
Actividad. Nunca pantalla en blanco sin salida — siempre con el link a la sección
alternativa que sí puede tener trabajo (Multi-publicación, Solo ML).

**Vinculado a MLA123 vs. Guardado · se sincroniza con ML apenas se pueda — la distinción
que no puede diluirse.** Dos estados que van a convivir en el mismo historial y tienen que
distinguirse incluso escaneando rápido con el celular en la mano:

| | Vinculado (éxito confirmado) | Pendiente de sincronizar |
|---|---|---|
| Icono | `✓` (check sólido, círculo relleno) | `↻` (flechas circulares — forma de "en proceso", no de check) |
| Color | `--success` / `--success-bg` / `--success-bd` | `--warning` / `--warning-bg` / `--warning-bd` |
| Texto | "Vinculado a **MLA123**" (ID en monospace) | "Guardado · se sincroniza con ML apenas se pueda" |
| Refuerzo | ninguno adicional — es el estado final | badge secundario persistente "pendiente de sync" en el historial hasta que el push confirme |

Tres canales distintos (ícono de forma distinta, no solo de color; color; y el texto que ya
la spec de UX exige que sea literalmente otra frase) — ninguno de los tres solo. El estado
"pendiente" además se anuncia con `aria-live="polite"` cuando cambia (ver accesibilidad
abajo), y en el historial se lista en su propia sub-agrupación visible ("2 pendientes de
sincronizar" como encabezado propio arriba de la lista), no mezclado sin marca entre los
vinculados. Este badge no se reutiliza en ningún otro lado de la app con otro significado.

### Tokens nuevos en `theme.css` y motivo

- `--tok-match-txt/--tok-diff-*/--tok-discriminant-*` — resaltado de títulos, con
  `--tok-discriminant-font: monospace` como canal no cromático (ver §1). Sin esto no hay
  forma de que la tarjeta cumpla el requisito central del plan (defensa contra M520/M540).
- `--conf-alta/--conf-revisar/--conf-baja` (+ `-bg`/`-bd`) — alias semánticos sobre
  `--success/--warning/--critical` ya existentes, para no repetir `var(--success)` disperso
  por el código y documentar en un solo lugar qué significa cada nivel de confianza.
- `--skeleton-base/--skeleton-highlight` — no existían tokens de skeleton en la app (Contador
  de Inventario y Feed de Actividad usan estados vacíos/error, pero no loading shimmer).
  Reusan `--surface2`/`--border2` como base para no introducir grises nuevos.

Todos los demás componentes (barra de progreso, tarjetas de marca, highlight "seguir donde
quedé", alerta de sobreventa, estado vinculado/pendiente) **reusan tokens existentes**
(`--progress-*`, `--chip-on-*`/`--accent-dim`, `--critical-*`, `--success-*`, `--warning-*`)
— no se creó color nuevo donde el sistema ya cubría el caso.

### Contraste verificado (WCAG 2.2 AA)

Los tokens nuevos son variantes de opacidad de colores ya auditados en el resto de la app
(mismo patrón que `--red-bg`/`--amber-bg`/`--green-bg` documentado en Feed de Actividad:
texto claro sobre fondo tenue con base oscura da contraste alto porque el fondo compuesto
sigue siendo oscuro). Verificación puntual de los pares nuevos:

- `--tok-diff-txt` (`--text` #E4EAF4) sobre `--tok-diff-bg` (ámbar 10% sobre `--surface`,
  compuesto ≈ `#22242A`): contraste ≈ 13.8:1 ✓✓ (muy por encima de 4.5:1).
- `--tok-discriminant-txt` (`--text`) sobre `--tok-discriminant-bg` (rojo 10% sobre
  `--surface`, compuesto ≈ `#2B232D`): contraste ≈ 13.4:1 ✓✓.
- `--tok-match-txt` (`--muted` #8493B0) sobre `--surface` (sin fondo propio, hereda el de la
  tarjeta): 5.67:1 ✓ (mismo valor ya verificado en Feed de Actividad).
- Badges de confianza: mismo patrón que `--critical`/`--warning`/`--success` sobre sus
  `-bg` respectivos, ya en uso en el panel "Requiere tu atención" del home — no se reabre
  esa verificación.
- Bordes (`--tok-diff-bd`, `--tok-discriminant-bd`, `--conf-*-bd`) son componentes no-texto
  (WCAG 1.4.11, piso 3:1 contra el fondo adyacente): mismos valores de opacidad (`.35`) que
  `--red-bd`/`--amber-bd`/`--green-bd`, ya en uso como borde de estado en toda la app.

### 8. Matcher unificado (2026-08-14) — absorbe Cobertura + Matcher viejo + Vínculos

**Punto de partida: el sistema de Cobertura (§1-§7 arriba), no uno nuevo.** Cobertura ya
enlaza `theme.css` sin overrides locales — igual que el Matcher viejo y Vínculos, así que
no hay conflicto de tokens que resolver al fusionar (los tres ya comparten paleta). Lo que
sí hay que resolver es cómo ese sistema absorbe dos pantallas más sin que la tarjeta de
trabajo (`.match-card`) pierda protagonismo. Ver
`docs/superpowers/plans/2026-08-11-matcher-unificado.md` (plan + flujo cerrado 2026-08-14)
para las decisiones de producto — acá solo el sistema visual.

**No se retiran `.chip`, `.pub-card`, `.pill-tabs` de Vínculos ni `.match-card`/`.conf-badge`
de Cobertura como conceptos**: la sección Problemas (que absorbe Sospechosos) reusa
`.pub-card` + `.chip.alta/.media/.ninguna` de Vínculos casi tal cual (ya están bien resueltos
y auditados), la cola sigue usando `.match-card` de Cobertura. El Matcher viejo
(`candidate-card`, `attr-badge`, colores hardcodeados `rgba(245,166,35,...)`) **no se porta**:
su master-detail queda reemplazado por la cola de a una: es exactamente el patrón que ya
se retiró en Cobertura, no había motivo para mantener una segunda versión.

#### 8.1 Tarjeta que no se espeja: cómo se distingue el lado fijo del candidato

**La decisión de diseño más importante de la entrega.** WC (Web) siempre en el mismo lugar
de la tarjeta, ML siempre en el mismo lugar — nunca se invierte el layout según la
dirección. Lo que cambia es **cuál de los dos lados lleva la etiqueta de rol**, con tres
canales redundantes (nunca solo color):

| Canal | Lado fijo ("Punto de partida") | Lado candidato ("Candidato") |
|---|---|---|
| Pill de rol sobre la foto | texto "Punto de partida", `--role-anchor-txt` (muted) sobre `--role-anchor-bg` (gris, chip neutro) | texto "Candidato" (o "Candidato #2/#3" en la variante compacta), `--role-candidate-txt` (accent) sobre `--role-candidate-bg` (accent-dim) — **mismo lenguaje visual que "seguir donde quedé" y los filtros activos**: en toda la app, acento tenue = "esto es tu próximo paso" |
| Fondo de la columna | `--surface2` (calmo, ya resuelto) | `--surface` (default de la tarjeta, sin tratamiento especial — es la foto que se está evaluando, no necesita "asentarse") |
| Frase de contexto arriba de la tarjeta | — | una sola línea, 11px uppercase `--muted`, arriba del badge de confianza: *"Producto de la Web sin publicación → buscando candidato en ML"* o *"Publicación de ML sin producto → buscando candidato en la Web"* según la dirección activa |

Con los tres canales, alguien que alterna de dirección en la misma sesión no depende de
memorizar "izquierda es fijo hoy": lo lee en la pill de cada foto y, si duda, en la frase de
arriba. Ninguna clase nueva de color: `--role-anchor-*`/`--role-candidate-*` son alias sobre
`--chip-*`/`--chip-on-*` ya existentes (ver theme.css).

En la variante compacta (candidatos #2/#3, filas de listas), el pill de rol se reduce a un
número ("#2") sobre el mismo `--role-candidate-bg`, sin la palabra completa — ya hay
suficiente contexto porque están debajo del candidato #1 con la etiqueta completa.

#### 8.2 Tira de chips de secciones, persistente

Va debajo del selector de dirección (subheader), **no sticky** — a diferencia del topbar y
el selector de dirección, que sí lo son. Motivo: el presupuesto de sticky a 375px ya lo
gastan el topbar (54px) + el selector de dirección (44px, ver §8.4); si la tira de chips
también quedara fija, entre las tres franjas se comerían ~190px permanentes de un viewport
de 812px (23%) antes de llegar a la tarjeta, que es donde está el trabajo. No sticky, la
tira scrollea con el resto — sigue siendo alcanzable con un swipe hacia arriba desde
cualquier vista secundaria, que es lo que pide el punto 3 del brief ("no hay que volver al
inicio para pasar de Historial a Multi-publicación").

**Fila única con scroll horizontal**, no wrap a dos líneas (evita que la tira empuje la
tarjeta hacia abajo de forma impredecible según cuántos chips entren). Los 4 chips
frecuentes sueltos + un chip final "Más ▾" que expande los 2 raros **en la misma fila**
(no un menú aparte): mismo patrón que ya usa `.buscar-manual` (details/toggle) en Cobertura,
adaptado a chip. Altura `--tap-min` (44px), igual que `.chip-jump` en Seguimientos.

**Estados (criterio ya escrito para Seguimientos, `public/preparacion/index.html:54-57`,
se aplica igual acá):**

- **En 0**: chip neutro, no interactivo visualmente distinto — `<span>` en vez de `<button>`
  si no hay nada que ver, mismos tokens `--chip-bg/--chip-bd/--chip-txt` (gris). Toda la
  tira en gris = "circuito sano", léase de un vistazo sin contar números.
- **Con contenido, accionable** (*Hay que publicarlo*, *Problemas*): `--chip-alert-bg`/
  `--chip-alert-bd`/`--chip-alert-txt` (ámbar) — son las dos secciones que representan
  trabajo pendiente real, no una condición del negocio. Solo estas dos pueden ponerse
  ámbar, y solo cuando el contador es mayor a 0.
- **Con contenido, informativo** (*Multi-publicación*, *Sin stock*, y los dos detrás de
  "Más": *Huérfanos*, *Omitidas*): quedan en gris **aunque el contador suba** —
  `--chip-bg/--chip-bd/--chip-txt`, igual que en 0. Multi-publicación es intencional
  (ver memoria `matcher-multi-publicacion`: 1 SKU → N publicaciones no es un error);
  Sin stock puede ser stock agotado transitorio; Huérfanos se limpia solo; Omitidas es
  "fuera del trabajo normal, mirar cuando se quiera". Un chip ámbar que solo crece enseña
  a ignorar la tira entera — es el mismo razonamiento que ya está escrito para
  "despachados sin verificar" en Seguimientos, y se reutiliza literal acá.

**Tensión para el orquestador/`disenador-ux`:** el brief de esta tarea lista 6 secciones
fijas (4 frecuentes + 2 tras "Más"), pero el plan de flujo (2026-08-14) agrega dos
secciones nuevas por la simetría ML→WC: *"Hay que crearlo en la web"* y *"Solo ML"*
(equivalentes exactos de *"Hay que publicarlo"* y *"Solo local"*, del otro lado). No están
en la lista de 6 chips. No decido esto — es alcance de `disenador-ux`/producto, no de
sistema visual — pero dejo resuelto el tratamiento para cuando se sume: *"Hay que crearlo
en la web"* es accionable (mismo tipo que "Hay que publicarlo" → ámbar con contenido) y
*"Solo ML"* es informativo (mismo tipo que "Solo local" → gris siempre). Si se agregan,
son dos chips más en la misma fila con scroll horizontal, mismos tokens, sin rediseñar el
componente.

#### 8.3 Línea calma del push de SKUs

Mismo renglón donde hoy vive "Actualizado hace 3 min" (`.refresco-bar` en Cobertura), dos
estados excluyentes:

| Estado | Texto | Color | Ícono |
|---|---|---|---|
| Sano | "sincronizando sola cada 10 min · SKUs al día" | `--muted`, 12px, sin negrita | ninguno — mudo a propósito |
| Trabado | "⚠ Push de SKUs trabado hace 23 min · 14 pendientes [Ver]" | `--warning`, 12px/600 | `⚠` |

Sin tokens nuevos (reusa `--muted`/`--warning` ya auditados). El motivo de que el estado
sano tenga texto y no desaparezca está en el plan (2026-08-14): "algo que desaparece cuando
todo está bien deja sin dónde mirar el día que alguien dude si sigue funcionando." "[Ver]"
en trabado es un link inline `--accent`, no un botón — va a Huérfanos/detalle del push, no
abre un modal nuevo.

#### 8.4 Selector de dirección + progreso de dos niveles en el subheader

Sticky, debajo del topbar (topbar 54px + este bloque ≈ 44px = ~98px fijos a 375px — la
tira de chips y la barra de progreso NO están dentro de este sticky, ver §8.2). Segmented
control de 2 pills, 50/50 de ancho a 375px, `--tap-min` de alto:

```
┌──────────────────────┬──────────────────────┐
│ Sin publicación (693) │ Sin producto (3638)  │  ← activa: --accent, --accent-dim bg
└──────────────────────┴──────────────────────┘
```

Reusa el patrón `.pill-tab.active` ya en Vínculos (borde+texto `--accent`, fondo
`--accent-dim`), no una tercera variante de "activo". La barra de progreso de dos niveles
(§4 arriba) va **debajo** de este segmented control, pero fuera del sticky, junto a la
tira de chips — así el cambio de dirección siempre está a un toque, sin que el progreso
compita por el espacio fijo.

#### 8.5 Acciones admin-only: deshabilitadas con motivo visible

`Pausar publicación` y `Desvincular` se muestran siempre, nunca ocultas. Para quien no es
administrador (Joaco): `disabled` + `aria-disabled="true"`, mismo tratamiento visual que
`.btn:disabled` ya existe en Vínculos (`opacity:.5`), **más** una etiqueta persistente al
lado (no tooltip — no hay hover en celular): "🔒 Solo administradores", 11px `--muted`,
visible siempre que el botón está deshabilitado, no solo al intentar tocarlo. El candado es
el canal no-textual (por si alguien no lee la frase completa a las apuradas), el texto es
explícito para que quede claro que es un permiso y no una función rota. Tap target se
mantiene en `--tap-min` (44px) aunque esté deshabilitado — así se puede tocar para
confirmar que "no pasa nada" en vez de asumir que el botón ni está ahí. Sin tokens nuevos.

#### 8.6 Piezas menores reusadas sin cambios

- **Toast "ya lo resolvió otra persona"** (concurrencia optimista): el `.toast` base de
  Cobertura ya tiene una variante neutra por defecto (`border-color:var(--border2)`, sin
  `.ok`/`.pendiente`/`.error`) — se usa tal cual para "Ya lo resolvió Fulano: vinculado a
  MLA123 [Ver] [Deshacer]". No es ni éxito propio ni error; no necesita ni verde ni rojo.
- **Publicación borrada mientras estaba en la cola**: mismo tratamiento que "trabado" en
  §8.3 — `--warning`, línea inline dentro del slot de la tarjeta ("Ya no existe en ML, se
  movió a Huérfanos"), la cola avanza sola al siguiente ítem.
- **Aviso de primera visita** ("ya no subís nada, la cola se arma sola"): reusa
  `.highlight-card` (fondo `--chip-on-bg`, borde `--chip-on-bd`) ya definido para "seguir
  donde quedé" en Cobertura — incluso puede ser el mismo bloque con dos estados según si es
  la primera visita del usuario o no, en vez de dos componentes distintos.

### Contraste verificado — bloque Matcher unificado (WCAG 2.2 AA)

Todos los tokens nuevos de esta sección son **alias sin cambiar el valor** de tokens ya
auditados en bloques anteriores de este documento: `--chip-alert-*` = `--warning-*` (9.95:1
sobre `--surface`, ver Feed de Actividad); `--role-anchor-*` = `--chip-*` (texto `--muted`
5.6-5.7:1, ya auditado); `--role-candidate-*` = `--chip-on-*` (`--accent` sobre
`--accent-dim`, patrón ya en producción en "seguir donde quedé" — no se reabre esa
verificación). No hay contraste nuevo que verificar porque no hay color nuevo.

**Piso de accesibilidad además del contraste:**
- Objetivos táctiles: `--tap-comfort` (56px) en el botón primario de la tarjeta,
  `--tap-min` (44px) en el resto — mismos tokens ya usados en Contador de Inventario para
  "operario de pie con una mano".
- Foco visible: hereda el `:focus-visible` global de `theme.css`, sin que ninguna tarjeta lo
  suprima (candidatos, filas de Multi-publicación y Solo ML son todos elementos enfocables).
- El refresco de contenido (nueva tarjeta al confirmar/descartar, toast de "Deshacer",
  cambio de estado vinculado→pendiente) tiene que anunciarse con una región
  `aria-live="polite"` — silenciosa visualmente, obligatoria para que un lector de pantalla
  no se quede una tarjeta atrás. Esto es contrato de implementación para
  `hard-worker-frontend`, no CSS: documentado acá para que no se pierda.
- Ningún estado descrito en este documento depende solo de color: todos tienen icono de
  forma distinta y/o texto explícito como mínimo un canal adicional (ver tablas de §1, §2 y
  §7).
