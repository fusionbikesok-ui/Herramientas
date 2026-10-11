# Fase D: diseño visual de "Catálogo y vínculos"

Fecha: 2026-10-09. Spec funcional: `2026-10-09-fase-d-catalogo-y-vinculos.md` (R1-R7). Este documento solo decide estética; no cambia flujo ni lógica. Base: `public/lib/theme.css` + `components.css` (clases `.ui-*`). El sistema es **solo oscuro** (no hay tema claro): el contraste se verifica una vez, sobre `--surface #141A25` / `--bg #0C0F16`.

Dirección: herramienta de trabajo densa y calma, teclado primero en PC, toques en celular. Nada decora: `--accent` es solo interactivo/seleccionado (regla de components.css). El rojo se reserva a lo que frena (veto, operación fallida/frenada). El ámbar es "requiere acción o ojo". Verde = hecho o coincide. Gris = neutro. Todo estado = ícono + texto + color (nunca uno solo).

## (a) Estructura y jerarquía

### Marco de pantalla
- Cabecera: título "Catálogo y vínculos" (`--fs-titulo`, 700) + a la derecha "Atajos ?" (solo >=1024 px) y el interruptor "Atajos activados" (preferencia guardada).
- Banner sin conexión (fijo, ver estados) va **encima de todo**, `position: sticky; top: 0`.
- Pestañas: `.ui-tabs` con `role="tablist"`; 4 botones `.ui-btn` (Casos, Vínculos, Ejecución, Retenidas) con contador en el rótulo ("Ejecución · 2 fallidas", "Retenidas · 5"). Contador de fallidas con ícono ✗ y `--red` si >0; si no, gris. `aria-selected` activo = borde+texto `--accent` (patrón existente). Flechas izq/der mueven entre pestañas; Tab sale al panel.

### Pestaña Casos
Orden vertical: **Franja Estado** → **filtros** → **cola | detalle**.
- Franja Estado: fila de 5 indicadores (salud de lectura, conciliación, conflictos de bolsa, vendiendo sin respaldo, protección pendiente). Cada uno es un enlace-chip `--chip-*` (gris, "circuito sano"); con valor >0 y accionable pasa a `--chip-alert-*` (ámbar) con ícono ⚠ y número; en rojo solo "vendiendo sin respaldo" >0 (✗ + texto). Una línea, `--fs-meta`. En <=640 px se envuelve a 2 columnas (nunca scroll horizontal, nunca oculto).
- Filtros (Abiertos / Salteados / En intervención / Pausadas): chips `.ui-chip` botón, activo = `--chip-on-*`, con conteo.
- Cola (izquierda, `--cola-w` 22rem a >=1024): lista `role="listbox"`, tarjetas de caso. Detalle (derecha): `--surface` card, borde `--border`.
- Detalle, de arriba a abajo (nunca reordenar):
  1. Cabecera del caso: título ML (`--fs-titulo`), SKU/ID ML en `.ui-id`, chips PAUSADA/HERMANAS/INTERVENCIÓN.
  2. **Tarjeta de estado de operación** (solo si hay op fallida/frenada: roja fija; ver estados).
  3. Dos bloques separados lado a lado (apilados <768): **"Observado en ML"** (estado, cantidad; `--surface2`) y **"Lo que manda la regla"** (stock 0 por…/stock de Woo N; `--surface2`). Etiquetas `.ui-label`, valores `--fs-dato` 600. Si no coinciden: aviso `.ui-aviso--atencion` debajo, ancho completo, "⚠ ML todavía no refleja la regla" (no desaparece hasta que coincidan).
  4. Candidatos 1/2/3: filas seleccionables (radio visual), sin preselección; seleccionado = `--sel-bd`/`--sel-bg` + texto "Elegido" + ✓ (no solo borde). Cada fila: número grande (1/2/3 como atajo), título, SKU, foto 40px (la `f` agranda).
  5. **Matriz de atributos** (ver componentes).
  6. **Barra de acciones** (abajo del detalle; sticky bottom en <768 con `safe-area-inset-bottom`).
  7. Panel Historial `<details>` (`h`), cerrado.

Jerarquía de acciones (una sola primaria):
1. **Vincular**: `.ui-btn--primario`, ancho 56 px en móvil. Deshabilitado con rojo: `aria-disabled="true"` (sigue enfocable), y **debajo del botón, siempre visible**, el texto "No se puede vincular: difiere {campos}. Lo confirma José." con ícono ✗ (`--red`), asociado por `aria-describedby`.
2. Secundarias neutras `.ui-btn`: **Saltear**, **No sincronizar**, **Deshacer** (aparece solo 10 s).
3. Solo admin, agrupadas aparte bajo el rótulo "Solo José" con candado: **Confirmar igual**, **Destrabar** (`.ui-btn--peligro` la primera; la segunda neutra), **Link de pago** (neutra). **El operador no las ve: no se renderizan** (ni deshabilitadas, ni espacio vacío; el grupo y su rótulo tampoco). Excepción documentada: en un caso rojo el operador sí lee la razón "Lo confirma José"; en intervención lee "Lo destraba José" (texto, no botón).
   - Esto difiere del patrón 8.5 de Matcher (admin-only deshabilitado con motivo) por decisión funcional del spec (criterio 2: "no ve"). No mezclar los dos.
4. Reintentar (Ejecución): admin únicamente, igual criterio.

Cada botón muestra el atajo como `<kbd>` pegado al texto (">=1024 px y atajos activos"): Vincular `Enter`, Saltear `s`, No sincronizar `n`, Deshacer `z`. En celular no se muestran los `<kbd>`.

### No sincronizar (panel/diálogo)
Diálogo modal (`role="dialog"`, foco atrapado, Esc cierra, foco vuelve al botón). En móvil es hoja inferior a pantalla casi completa. Contenido:
1. Radiogrupo de 3 variantes, cada una una tarjeta-radio de >=56 px con título y una línea:
   - **(a) Solo marcar.** "Dejamos de tocarle el stock. Cualquiera lo revierte."
   - **(b) Marcar y pausar en ML.** "Además se pausa la publicación en ML." (al elegirla aparece el alcance)
   - **(c) Solo marcar, revierte José.** "Un operador no puede revertirlo." 🔒
   Sin variante preseleccionada. Debajo de las tres, línea fija `--muted`: "En las tres, las ventas de esta publicación se retienen."
2. Campo **Motivo** (obligatorio, `<textarea>`, etiqueta visible con "(obligatorio)"). Vacío + enviar => error en línea fijo bajo el campo, ícono ✗, `aria-invalid`, foco al campo.
3. **Alcance de (b)**, solo si (b) elegida: bloque `.ui-aviso--atencion` "⚠ La pausa es de la publicación entera. Pausa también estas N variaciones:" lista (máx 6 visibles + "y N más" expandible), y casilla/botón de confirmación explícito "Entiendo, pausar las N". El botón final queda deshabilitado (con razón en texto) hasta marcar esa confirmación.
4. Pie: "Volver" (neutro, izquierda) y "Marcar no sincronizar" (primario). Tras guardar, (b) muestra "En cola para ML · mirá Ejecución" con enlace.

### Pestaña Vínculos
Buscador ancho completo arriba (`/` enfoca) + chips de filtro del Matcher. Resultados en tarjetas (<768) o `.ui-table` en `.ui-tablewrap` (>=768): vínculo vigente, hermanas por SKU y GTIN (con n), notas, orden de identificadores, "ver historial", "Revincular" (abre la misma matriz), "Revertir no sincronizar" (la (c) lo muestra solo a admin; a operador le muestra "🔒 Lo revierte José" como texto). Sección **Códigos en conflicto** como `<details open>` con título propio y contador, flujo idéntico al actual, reusando tarjetas; sin pestaña nueva.

### Pestaña Ejecución
- Cabecera: contador "**N fallidas**" grande (`--fs-titulo`, 700) con ícono; N>0 => `--critical` + texto "ML rechazó {n}"; N=0 => `--success` "Sin fallidas". Al lado, "N frenadas" (ámbar) y "N en cola".
- **Pausas con riesgo**: bloque propio arriba de la lista, `.ui-aviso--atencion`, título "⚠ Pausas con riesgo": operaciones `pausar` (variante b) con hermanas afectadas, mostrando "pausa N variaciones" por fila. Se ve antes que la lista general.
- Lista: filas con estado en chip (ver "Operación"): En cola (gris, ↻), Aplicada (verde, ✓), Fallida (rojo, ✗, **fila con fondo `--critical-bg` y borde izquierdo 4 px, no se atenúa ni se oculta**), Frenada (ámbar, ⏸). Cada fila: título, SKU, hora, motivo. Admin ve **Reintentar** y **Confirmar impacto** a la derecha; el operador ve la fila idéntica sin esos botones y, en fallida, el texto "Reintenta José." El cambio encolada->aplicada se aplica en el sitio sin recargar y se anuncia por `aria-live="polite"`.

### Pestaña Retenidas
- Aviso fijo arriba `.ui-aviso--info`: "Se liberan solas cada 5 minutos cuando la causa se resuelve."
- Lista de ventas: pedido, publicación, causa, hace cuánto. Acción única **Liberar** (no hay Cancelar). Al tocar, la fila se expande con campo **Motivo (obligatorio)** y "Confirmar liberación". Si la causa sigue, resultado fijo en la fila: `.ui-aviso--atencion` "⚠ Se va a volver a retener." (queda hasta cerrarlo; no toast).
- Sin rol Ventas/Supervisor/Admin: la lista se lee, Liberar no se renderiza.

## Estados de R5 (todos fijos, sin toasts)

| Estado | Tratamiento |
|---|---|
| Cargando | Skeleton con silueta real (3 tarjetas de cola + bloque de detalle) con `--skeleton-*`; sin animación si `prefers-reduced-motion`. `aria-busy="true"` en el contenedor. |
| Cola vacía | `.api-estado--vacio` borde punteado: "No hay casos abiertos" + enlace "Ver salteados". |
| Caso normal | Como arriba. |
| Rojo (veto) | Fila(s) rojas en matriz; Vincular `aria-disabled` + razón visible. |
| Intervención | Detalle completo en **solo lectura**: encabezado con 🔒 y "En intervención. Lo destraba José." (`--warning`, `--fs-dato`), controles de candidatos y acciones no renderizados para el operador (admin ve Destrabar). Matriz sí visible. |
| Guardando | El botón pulsado muestra "Guardando…" (↻ girando si no hay reduced-motion) y queda `aria-disabled`; el resto de acciones bloqueadas; `aria-busy`. |
| Guardado | Solo tras 201/200: línea fija verde en el detalle "✓ Guardado · En cola para ML" + `Deshacer (10 s)` con cuenta visible (texto "quedan 7 s", no solo barra). La tarjeta de cola pasa al siguiente. Se anuncia por `role="status"`. |
| Deshaciendo | "Deshaciendo…" con el botón bloqueado; si ya empezó: `.ui-aviso--info` "Ya se mandó a ML; mirá Ejecución" con enlace (sin Deshacer). |
| Conflicto 409 | Bloque ámbar fijo sobre las acciones: "⚠ Alguien cambió este caso." El detalle ya está recargado; botón primario "Aplicar mi decisión sobre la versión nueva" y secundario "Descartar mi decisión". Se muestra el diff de lo que cambió (una línea). |
| Rechazada / error de acción | Bloque fijo rojo bajo la barra de acciones, ícono ✗ + mensaje de la tabla R5 + (si aplica) el enlace (Ejecución). Se limpia al cambiar de caso o resolver. `role="alert"`. |
| Error de carga | `.api-estado--error` con "Reintentar" (`.btn-reintentar` agrandado a 44 px). |
| Sin conexión | Banner sticky al tope, fondo `--critical-bg`, borde `--critical-bd`, ícono ✗, "Sin conexión. No se guardó nada." Todas las acciones `aria-disabled` y atenuadas con su razón "Sin conexión" en el botón primario. Desaparece solo al volver; `role="alert"` al aparecer. |
| Hermanas | **En la misma tarjeta** (no modal separado del detalle): el bloque de acciones se reemplaza por `.ui-aviso--atencion` "⚠ Esto cambia también {n} publicaciones hermanas. ¿Seguimos?", lista de hermanas (título + SKU), botones "Vincular las n" (primario) y "Volver". Foco al encabezado del bloque; Esc = Volver. (El criterio E2E dice "modal, Tab, Esc": implementar como región con foco gestionado que se comporta igual con teclado; si frontend prefiere `dialog`, ok, pero que viva visualmente dentro del detalle.) |
| Operación fallida/frenada | **Tarjeta roja fija** al tope del detalle (ver paso 2): fondo `--critical-bg`, borde `--critical-bd` 2 px, ícono ✗, título ("ML la rechazó" / "Frenada"), motivo, acción siguiente ("Reintenta José." / "Stock en 0 hasta resolver."), enlace "Ver en Ejecución" y, si hay ventas retenidas del ítem, "Ver N ventas retenidas" hacia Retenidas. No se puede cerrar; se va cuando la op cambia de estado. |
| Operación encolada / aplicada | Chip gris ↻ "En cola para ML" / chip verde ✓ "Aplicada en ML". |

## (b) Componentes

Reusan `.ui-btn`, `.ui-chip`, `.ui-id`, `.ui-label`, `.ui-aviso*`, `.ui-tabs`, `.ui-table`, `.ui-card`, `.api-estado*`. Nuevos (prefijo `cv-`, en CSS de la página; promover a components.css solo si se repiten):

- **`.cv-caso` (tarjeta de cola).** `<button role="option">` ancho completo, `--surface`, borde `--border`, radio 10, padding .75rem, `min-height` 64. Contenido en 3 líneas: (1) título, 2 líneas máx con elipsis, 600, `--fs-dato`; (2) motivo `--muted` `--fs-meta`; (3) a la izquierda plata en juego "$ 1.250.000 en juego" (`--text`, 700, tabular-nums; si es 0, "Sin plata en juego" `--muted`), a la derecha chips. Estados: normal; hover borde `--border2`; **seleccionada** borde `--sel-bd` + fondo `--sel-bg` + `aria-selected="true"` + barra izquierda 4 px (no solo color: también la barra y el contraste de fondo); foco = outline global 2 px; salteado = línea "Salteado por X" con ícono ↷ en `--muted`. Chips: PAUSADA (gris, ⏸), HERMANAS n (gris, ⧉; ámbar si n>0 y bloquea), INTERVENCIÓN (`--warning`, 🔒). Texto en mayúsculas del spec, `--fs-label`.
- **`.cv-matriz`.** `<table>` real con `<caption class="sr-only">`, columnas Atributo | Publicación ML | Candidato elegido | Estado. Filas: título, SKU, GTIN, color, talle, rodado, transmisión, velocidades. En <768 px cada fila es una tarjeta apilada (cabecera con atributo + estado, debajo dos líneas "ML: …" / "Candidato: …"): sin scroll horizontal, sin columnas ocultas, orden DOM idéntico.
- **`.cv-sem` (semáforo, reusa `.mk` de theme.css y tokens `--mk-*`).** Siempre `[ícono] [texto]` en pill:

  | Estado | Ícono | Texto | Tokens | Otros canales |
  |---|---|---|---|---|
  | Rojo | ✗ | **Difiere** | `--mk-diff`, `-bg`, `-bd` | borde 2 px sólido; fila con fondo `--critical-bg`; valores en `--tok-discriminant-font` |
  | Ámbar | ⚠ | **Falta** (un lado vacío) / **Difiere** (formato) | `--mk-miss` | borde discontinuo (dashed) |
  | Verde | ✓ | **Coincide** | `--mk-ok` | sin fondo ni borde; fila atenuada (`--muted`) para no competir |
  | Gris | – | **No aplica** | `--muted` | sin borde; valores "—" |

  Rótulo "leve": en la fila GTIN con ámbar "Difiere", segundo pill pegado "leve" (`--fs-label`, `--warning`, borde punteado) + `title`/texto accesible "leve: sigue vendiendo". También para SKU igual con GTIN/título contradictorio. Si el ámbar "Falta" y "Difiere por formato" conviven, el texto los distingue ("Falta" vs "Difiere (formato)"); no usar "Difiere" ámbar sin el calificador salvo GTIN+leve.
  Valores a comparar: fuente monoespaciada solo para SKU/GTIN/códigos (`.ui-id`); el resto proporcional. Toggle `d` "Solo diferencias" oculta filas verdes y grises (botón con `aria-pressed`, visible en todos los tamaños).
- **`.cv-dato` (Observado en ML / Lo que manda la regla).** Dos paneles `.ui-panel`, etiqueta arriba, valor abajo. El aviso de desfase vive fuera (ver detalle).
- **`.cv-estado-op` (chip + tarjeta).** Variantes: encolada, aplicada, fallida, frenada. Ver tabla.
- **`.cv-banner` (sin conexión / aviso fijo).** Variantes: offline (rojo), conflicto (ámbar), error (rojo), info (azul). Todas con ícono, `role="alert"` (rojo/ámbar) o `status` (info/ok).
- **`.cv-lock`.** Ícono 🔒 + texto adyacente obligatorio ("Lo destraba José", "Solo José"); el ícono tiene `aria-hidden`, el texto da el significado.
- **`.cv-kbd`.** `<kbd>` 1.4rem mín., borde `--border2`, fondo `--surface2`, monoespaciada, `--fs-label`. Solo >=1024 px con atajos activos.
- **`.cv-hoja-atajos`.** Diálogo `?`: tabla de dos columnas (tecla | acción) con las 10 teclas de R6, interruptor "Activar atajos" arriba (switch con texto "Activados/Apagados"). Esc cierra. Solo existe >=1024 px; en <1024 px el botón "Atajos" no se renderiza.

### Botones: variantes y estados
Primario (`.ui-btn--primario`: Vincular, Vincular las n, Marcar no sincronizar, Aplicar mi decisión). Neutro (`.ui-btn`). Peligro (`.ui-btn--peligro`: Confirmar igual). Estados de todos: normal / hover (borde `--border2`) / foco (outline global) / `aria-disabled` (opacidad .55 + razón en texto) / cargando ("Guardando…"). Usar `aria-disabled` en vez de `disabled` cuando hay razón que leer, para que se pueda enfocar y el lector la anuncie.

## (c) Tokens

### Reusados (sin tocar)
`--surface, --surface2, --bg, --border, --border2, --text, --muted, --accent, --accent-dim, --sel-bd, --sel-bg, --mk-ok/diff/miss (+bg/bd), --critical/warning/success (+bg/bd), --chip-*, --chip-alert-*, --tok-discriminant-font, --skeleton-*, --tap-min, --tap-comfort, --radius, --radius-pill, --fs-titulo/dato/cuerpo/meta/label, --sp-*`.

### Nuevos propuestos (NO edité `theme.css`; no es imprescindible, el frontend puede declararlos en el `:root` de la página o agregarlos)
```css
/* Catálogo y vínculos (Fase D) */
--cv-cola-w:        22rem;               /* ancho de la cola en >=1024 px */
--cv-detalle-min:   30rem;               /* ancho mínimo del detalle antes de apilar */
--cv-sem-na:        var(--muted);        /* "No aplica": gris, texto 5.67:1 sobre --surface */
--cv-op-fallida-bg: var(--critical-bg);  /* tarjeta/fila de operación fallida o frenada */
--cv-op-fallida-bd: var(--critical-bd);
--cv-lock:          var(--warning);      /* candado de solo lectura/solo admin */
--cv-offline-bg:    var(--critical-bg);  /* banner sin conexión */
--cv-offline-bd:    var(--critical-bd);
```
Motivo: todos son alias de tokens ya auditados; nombran el significado (qué es "fallida", qué es "candado") para no disparar `var(--red)` por todo el código. No hay color nuevo, no hay contraste nuevo que verificar. El único valor propio es el ancho de cola.

## (d) Responsive

- **360 px**: una columna, orden DOM = visual: marco, pestañas (scroll horizontal permitido solo en la tira de pestañas, `.ui-tabs`), franja Estado (2 col), filtros (envuelven), **cola completa** (tarjetas a ancho completo, 3 líneas), **detalle debajo**. Seleccionar un caso hace `scrollIntoView` al encabezado del detalle y mueve el foco allí; "Volver a la cola" (botón, 44 px) al tope del detalle. Nada oculto: la cola no se colapsa ni se mueve a un drawer. Dos paneles Observado/Regla apilados. Matriz como tarjetas apiladas. Barra de acciones sticky al fondo (Vincular 56 px de ancho completo; el resto en grid 2x2 `--tap-min`), con `padding-bottom: env(safe-area-inset-bottom)`. Diálogos = hoja inferior. Sin `<kbd>`, sin botón de atajos. Cero scroll horizontal en 320-1600.
- **768 px**: sigue apilado (cola arriba, `max-height: 40vh` con scroll interno **solo si hay más de 6 casos**, y esto se avisa con "N casos" en el título de cola), detalle abajo. Observado/Regla lado a lado. Matriz en tabla real. Barra de acciones en línea (no sticky).
- **1440 px (>=1024 ya aplica)**: grid `var(--cv-cola-w) minmax(var(--cv-detalle-min), 1fr)`, `gap: var(--sp-3)`, contenedor máx 90rem centrado. Cola con scroll propio (`position: sticky; top: 0; max-height: 100vh`), detalle con scroll de página. Franja Estado en una fila. `<kbd>` y botón "Atajos ?" visibles. Candidatos con foto 56 px.

## (e) Accesibilidad por componente

Contraste (oscuro, único tema), sobre `--surface #141A25` salvo que se indique: `--text` 14.6:1; `--muted` 5.67:1 (única opción de texto secundario; `--muted2` 3.33:1 **prohibido para texto**); `--accent` 7.65; `--green` 9.17; `--amber` 9.95; `--red` 6.36. Texto `--text` sobre `-bg` tenues de 10% ≈ 12-13:1 (auditado en design-system.md). `.ui-btn--primario` (`--accent` sobre `--accent-dim` compuesto) >7:1. Bordes `-bd` 35%: componentes no-texto >=3:1 contra fondo adyacente según los pares ya aprobados. Pill "leve" en `--warning` sobre fondo: 9:1. **Cumple WCAG 2.2 AA en contraste.** Distinto de "se ve bien": el riesgo real es la densidad de la matriz con 8 filas × 4 columnas; por eso se atenúan las verdes y existe `d`.

- **Pestañas**: patrón tablist/tab/tabpanel; flechas; `aria-controls`. Contador forma parte del nombre accesible.
- **Cola**: `role="listbox"` con `aria-activedescendant` o roving tabindex; **una sola parada de Tab** en la cola, flechas ↑/↓ mueven entre casos, Enter/clic abre. Foco inicial al abrir la pestaña: primer caso (criterio 12).
- **Orden de tabulación**: pestañas -> franja Estado -> filtros -> cola (1 parada) -> detalle (cabecera -> candidatos -> matriz -> acciones -> historial). El detalle no roba el foco al navegar la cola con flechas; solo al activar (Enter/clic) o en 360 px.
- **Semáforo**: el estado es texto + ícono (`aria-hidden` en el ícono); la celda no lleva `aria-label` que repita. Fila roja anuncia "Difiere" dentro de la celda de Estado. `<th scope="row">` en la columna Atributo.
- **Acción deshabilitada con razón**: `aria-disabled` + `aria-describedby` hacia el texto de razón; el texto es visible, no tooltip (no hay hover en celular).
- **Solo admin**: lo no permitido para el operador no existe en el DOM (no se oculta con CSS), así no queda en el árbol accesible.
- **Candado**: ícono decorativo + texto; nunca solo ícono.
- **Estados**: errores/conflicto/offline `role="alert"`; guardado/aplicada/cola `role="status"` (`aria-live="polite"`); cargando `aria-busy`. Los errores no desaparecen solos (WCAG 3.3.1 y sin límite de tiempo).
- **Deshacer 10 s**: ventana corta, texto "quedan N s" actualizado cada segundo (no cada 100 ms) y anunciado con `polite` solo al inicio y a los 3 s; el botón sigue accesible por teclado (`z`) y por Tab. Si vence, el mensaje cambia a "Ya no se puede deshacer" (no desaparece sin aviso). WCAG 2.2.1: la ventana es la del spec (decisión funcional); ofrecer también Deshacer vía Ejecución no está en alcance.
- **Diálogos (No sincronizar, hermanas, atajos, foto)**: `role="dialog"`/`aria-modal`, foco atrapado, Esc, foco vuelve al disparador, título con `aria-labelledby`.
- **Atajos (WCAG 2.1.4)**: solo con foco fuera de campos de texto; interruptor para apagarlos; Esc nunca está secuestrado. Teclas de una letra se desactivan dentro de `input/textarea/select`.
- **Foco visible (2.4.7, 2.4.13)**: outline global 2 px `--accent`, offset 2. Ningún componente nuevo lo suprime; en tarjetas de cola seleccionadas el foco y la selección son distinguibles (outline vs barra+fondo).
- **Objetivos táctiles (2.5.8)**: `--tap-min` 44 px en móvil, >=24 px en PC; Vincular 56 px en móvil. Chips accionables de la cola (HERMANAS, etc.) son informativos, no interactivos, así no hay botones diminutos.
- **Reflow (1.4.10)**: sin scroll horizontal a 320 px de ancho CSS; texto escalable a 200%.
- **Movimiento**: skeleton y ↻ girando se detienen con `prefers-reduced-motion`.

## (f) Lo que hard-worker-frontend debe respetar

1. Una sola acción primaria por vista; jerarquía de la sección "Jerarquía de acciones". No agregar botones verdes/rojos sólidos.
2. Ningún estado va solo en color: siempre ícono + texto. Verificar con escala de grises. Los textos del semáforo son exactamente **Difiere / Falta / Coincide / No aplica**, y GTIN ámbar lleva "leve".
3. Acciones de admin **no se renderizan** para el operador (no `display:none`). Cuando hay razón, se muestra el texto, no el botón.
4. Errores, conflicto y offline son bloques fijos, nunca toasts; "Guardado" solo después de 200/201; la tarjeta roja de operación fallida no se puede cerrar.
5. Hermanas se confirman dentro del detalle; (b) muestra el alcance y exige su confirmación antes del botón final; motivo obligatorio en No sincronizar, Confirmar igual, Destrabar y Liberar.
6. Copy exacto de R5 (tabla) y de este documento; no reformular.
7. Colores solo por tokens (sección (c)); cero literales hex. Si falta un token, declarar los de la propuesta, mismo nombre y valor; no crear otros.
8. Layout: 360 apilado sin ocultar nada; 768 apilado con matriz tabla; >=1024 dos columnas. Sin scroll horizontal (excepto la tira de pestañas).
9. Atajos y `<kbd>` solo >=1024 px; interruptor guardado en el navegador; sin atajos dentro de campos de texto; 360 px sin atajos.
10. Foco: orden descripto en (e); el foco no salta al detalle mientras se navega la cola con flechas; foco al encabezado de bloques de error/hermanas al aparecer.
11. Respetar `prefers-reduced-motion`, `safe-area-inset-bottom` y `aria-live` en cambios encolada->aplicada.
12. Sacar capturas reales a 360 y 1440 (claro no aplica) y pasarlas a `probador-e2e` para validar tamaños y contraste; este documento no se verificó en navegador.
