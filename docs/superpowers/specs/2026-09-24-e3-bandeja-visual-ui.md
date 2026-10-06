# E3 Bandeja de identidad: sistema visual (T6)

**Fecha:** 2026-09-24. **Entrada:** `2026-09-24-e3-bandeja-interfaz.md` (aprobada). Este documento sólo viste; no cambia el flujo.
**Estado:** propuesta para aprobación de José. Tokens ya agregados a `public/lib/theme.css` (bloque "Bandeja de identidad", al final de `:root`, más `.mk*`).

## 1. Base y tema

- El sistema del repo es **sólo oscuro** (`theme.css`); no hay tema claro. La bandeja lo hereda y no crea uno. Contraste verificado sólo en oscuro.
- Tipografía: la del matcher (`-apple-system, 'Segoe UI', sans-serif`); SKU y valores de atributo en `ui-monospace` (misma convención que `--tok-discriminant-font`).
- Fondo de página `--bg`, superficies `--surface`/`--surface2`, bordes `--border`/`--border2`. Ningún color nuevo: todo alias.

## 2. Jerarquía visual (qué salta primero)

1. **Lo que difiere.** Celda `≠`: fondo `--mk-diff-bg`, borde 2px `--mk-diff-bd`, texto en peso 700, los dos valores en monoespaciada.
2. **Lo que falta** (`—`): ámbar, borde punteado (forma distinta).
3. **Equivalente** (`≈`): celeste, con la normalización visible («Negro mate → negro»).
4. **Lo que coincide** (`✓`): sin fondo ni borde, peso 500, verde apagado. No compite.
5. Contradicciones fuertes (pack, rodado, marca): filas primero y **banda roja** en el encabezado del candidato: «≠ pack: publicación ×1, candidato ×2». Su fila lleva borde izquierdo 4px `--mk-diff`.
6. Sin puntaje: el candidato muestra «1.º sugerido» y chips de señales que coinciden (estilo `.mk--ok`). Nunca porcentaje ni barra.

Los tres canales (símbolo, texto, forma de borde/peso) son distintos por marca: nada depende sólo del color.

## 3. Tokens (nuevos, todos alias)

| Token | Uso |
|---|---|
| `--mk-ok / -diff / -miss / -eq` (+`-bg`, `-bd`) | color de cada marca; alias de success/critical/warning/accent |
| `--sel-bd`, `--sel-bg` | candidato seleccionado |
| `--fs-sm/md/lg` | tipografía fluida `clamp()` |
| `--sp-1/2/3` | espaciado fluido `clamp()` |
| `--col-min` | ancho mínimo de columna (14rem) |

Reutilizados tal cual: `--tap-min` (44px), `--tap-comfort`, `--chip-*`, `--skeleton-*`, `--critical/-warning/-success`, `--focus-color`, `--radius*`, `.api-estado*`.

## 4. Marcas (símbolo + texto)

| Marca | Texto visible | Ejemplo |
|---|---|---|
| ✓ | «✓ coincide» | verde, sin caja |
| ≠ | «≠ difiere» + valores «ML: 29 → cand.: 27,5» | caja roja gruesa |
| — | «— falta en candidato» / «— falta en ML» | caja ámbar punteada |
| ≈ | «≈ equivalente» + «Negro mate → negro» | caja celeste |

El símbolo es texto real dentro del elemento (no `::before` con `content`, que algunos lectores omiten) con `aria-hidden` no aplicado: el lector dice «difiere». El texto hace de nombre accesible; el símbolo es decoración adicional (`<span aria-hidden="true">≠</span> difiere`).

Contraste sobre `--surface` #141A25 (cálculo por luminancia relativa; sobre `--surface2` #1B2235 baja ~0,3 pero sigue arriba del piso):

| Texto | Contra | Ratio aprox. |
|---|---|---|
| `--text` #E4EAF4 | surface | ~14:1 |
| `--green` #34D399 (✓) | surface | ~9:1 |
| `--red` #F87171 (≠) | surface / con `--red-bg` encima | ~6,3:1 / ~5,8:1 |
| `--amber` #FBBF24 (—) | surface | ~10:1 |
| `--accent` #2DB8E8 (≈, foco) | surface | ~7,8:1 |
| `--muted` #8493B0 (etiquetas) | surface | ~5,6:1 |
| **`--muted2` #5B6B8C** | surface | **~3,3:1: NO usar para texto**; sólo decorativo |
| Bordes de marca / foco (no texto) | surface | >3:1 (1.4.11) |

Estimaciones manuales: `probador-e2e` debe confirmarlas con axe. Que cumpla AA no es lo mismo que "se ve bien": lo segundo es la jerarquía de §2.

## 5. Matriz (container query, sin @media)

Contenedor del caso: `container-type: inline-size`. Ancho: columnas `auto-fit` con mínimo `--col-min`; en angosto, lista de pares.

```css
.caso { container: caso / inline-size; }
.matriz { display: grid; gap: var(--sp-1);
  grid-template-columns: minmax(min(8rem,100%), .6fr)
    repeat(auto-fit, minmax(min(var(--col-min),100%), 1fr)); }
.matriz > * { min-width: 0; overflow-wrap: anywhere; }
.celda { padding: var(--sp-2); font-size: var(--fs-md); line-height: 1.5; }
.sku { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.celda__etiqueta { display: none; }               /* etiqueta sólo en modo lista */

/* Angosto: cada atributo es un bloque «etiqueta: ML / candidato». Umbral por contenedor. */
@container caso (max-width: 40rem) {
  .matriz { display: block; }
  .fila { display: grid; gap: var(--sp-1); padding-block: var(--sp-2); border-bottom: 1px solid var(--border); }
  .celda__etiqueta { display: block; color: var(--muted); font-size: var(--fs-sm); }
}
```

Nota: `@container` no es `@media`, permitido por la spec. Cada fila es `role="row"` o una lista `dl`; en modo lista se usa `<dl>` por atributo para conservar el sentido. Encabezados de columna `sticky` sólo en modo matriz (`top` con `scroll-padding-top` igual).

- **Alineación de filas:** usar `subgrid` (`grid-template-rows: subgrid`) o una sola grilla con `display: contents` en `.fila` para que las alturas se igualen sin alturas fijas.
- **Modo matriz (≥40rem de contenedor):** columna de etiquetas + ML + hasta 3 candidatos; con 3840px entran los candidatos de la búsqueda como columnas extra (`auto-fit`). Columna ML con fondo `--role-anchor-bg`, borde `--role-anchor-bd`; encabezado «Publicación ML».
- **Modo lista (<40rem):** ML arriba como bloque; cada candidato debajo con su encabezado y sus pares «etiqueta / ML / candidato». Orden de filas idéntico.
- Encabezado del candidato: «1.º sugerido» + título completo (nunca cortado), SKU mono, señales, radio nativo ≥44px con label completa.

## 6. Candidato seleccionado

Columna (o bloque) con `border: 2px solid var(--sel-bd)`, fondo `--sel-bg`, y una etiqueta **«Seleccionado»** (texto, no sólo borde) en el encabezado más el radio marcado. En modo lista, el mismo borde rodea todo el bloque del candidato.

```css
.cand { border: 1px solid var(--border); border-radius: var(--radius); }
.cand:has(input:checked) { border: 2px solid var(--sel-bd); background: var(--sel-bg); }
.cand:has(input:checked) .cand__sel { display: inline; }   /* «Seleccionado» */
.cand__sel { display: none; }
.cand input[type=radio] { inline-size: var(--tap-min); block-size: var(--tap-min); }
```

## 7. Chips de prioridad (cabecera)

Botones-chip con `min-height: var(--tap-min)`, `flex-wrap: wrap`, `gap: var(--sp-1)`; el texto es «Conflictos 12» (contador dentro del chip, texto completo, sin cortar). Activo: `--chip-on-*` con `aria-pressed="true"` y además un ✓ delante (no sólo color). Conflictos lleva icono ⚠ + `--chip-alert-*` sólo cuando hay >0 (ámbar = accionable, criterio del matcher). Orden fijo por prioridad: conflictos, D5, SKU exacto, activas con stock, resto; «no decidibles» al final, atenuado pero con texto legible (`--muted`, no `--muted2`).

```css
.chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.chip-pri { display: inline-flex; align-items: center; gap: .4em; min-height: var(--tap-min);
  padding: 0 var(--sp-2); border-radius: var(--radius-pill); min-width: 0; overflow-wrap: anywhere;
  background: var(--chip-bg); border: 1px solid var(--chip-bd); color: var(--chip-txt); }
.chip-pri[aria-pressed=true] { background: var(--chip-on-bg); border-color: var(--chip-on-bd); color: var(--chip-on-txt); }
```

## 8. Fotos y visor

- Miniatura fluida: `inline-size: 100%; aspect-ratio: 4 / 3; object-fit: contain; background: var(--surface2)` (la altura sale del ratio, no fija). Sin foto: mismo recuadro con texto «Sin foto» (esqueleto/estado consistente).
- Es un `<button>` (≥44px, foco visible) que abre el visor.
- **Visor:** `<dialog>` modal, fondo `--danger-veil`-like `rgba(6,8,13,.92)` (token existente `--danger-veil`; alias sugerido `--veil` si se repite), imagen `max-inline-size: 100%; max-block-size: 90dvh; object-fit: contain`, botón «Cerrar (Esc)» ≥44px arriba a la derecha, título del producto y SKU debajo (completos). Con varias fotos (ML y candidatos), flechas ← → y texto «ML» / «Candidato 2». El foco vuelve al botón que lo abrió.

## 9. Estados y avisos

- **Cargando:** esqueleto de la matriz con las mismas filas y columnas (mismo `grid`, `--skeleton-base`, shimmer; con `prefers-reduced-motion` sin animación). Sin spinner ciego. `aria-busy="true"`.
- **Vacío:** `.api-estado--vacio` «No quedan casos en este filtro» + botón «Cambiar filtro».
- **Error / sin conexión:** `.api-estado--error` con `role="alert"`, botón «Reintentar» ≥44px (hoy `.btn-reintentar` mide ~27px: **subirlo a `min-height: var(--tap-min)` en esta pantalla**). Sin conexión: banner ámbar «Sin conexión: tus decisiones se conservan y se guardan al volver».
- **Guardando/guardado:** indicador junto al contador «Caso 12 de 340»: «⟳ Guardando…» (neutro) → «✓ Guardado» (`--success`); fallo → «⚠ No se guardó» (`--critical`) con enlace al aviso persistente. Cambio de texto, no sólo de color; `role="status"`.
- **Conflicto 409 (persistente):** franja fija sobre el caso, `background: var(--warning-bg); border: 2px solid var(--warning-bd); border-inline-start: 6px solid var(--warning)`, icono ⚠, texto «Este caso cambió mientras lo revisabas; tu elección se conserva» y botón primario «Aplicar mi decisión sobre la versión nueva». `role="alert"`, no se cierra sola. Las celdas que cambiaron llevan etiqueta «Cambió» (texto) además del borde.

```css
.aviso { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3); border-radius: var(--radius); font-size: var(--fs-md); line-height: 1.5; }
.aviso > * { min-width: 0; overflow-wrap: anywhere; }
.aviso--conflicto { background: var(--warning-bg); border: 2px solid var(--warning-bd);
  border-inline-start: 6px solid var(--warning); color: var(--text); }
.aviso .btn { min-height: var(--tap-min); min-inline-size: var(--tap-min); }
```

- **Aviso de deshacer (10 s):** barra inferior (o fija en flujo si hay poco espacio), `--surface2` con borde `--border2`: «Vinculado a FB-123. Caso 12 de 340.» + botón «Deshacer (z)» ≥44px. La cuenta regresiva es una barra fina (`--progress-fill`) **más** el botón siempre disponible; no expira el texto para lector (`role="status"`). Con `prefers-reduced-motion` la barra no anima. Si ya venció, el aviso desaparece sin drama; deshacer queda sólo desde el historial (admin).
- **Historial del caso:** lista tipo feed reusando `--act-rail` (línea vertical) con «Quién · cuándo · qué» y la decisión previa; columna derecha si entra (`auto-fit`), si no un `<details>` (`h`).

## 10. Ayuda de atajos (`?`)

`<dialog>` modal, `width: min(100% - 2rem, 48rem)`, `max-height: 90dvh; overflow: auto` (scroll vertical permitido). Tabla de dos columnas «Tecla / Acción», teclas como `<kbd>` (fondo `--surface2`, borde `--border2`, mono, min 44px de alto de fila, no de la tecla). Arriba: interruptor «Atajos de una tecla: activados» (checkbox nativo con label, 44px) para WCAG 2.1.4. Cerrar con `Esc` y botón visible «Cerrar». Cuando está apagado, la barra lateral no muestra hints de tecla.

## 11. Foco, espaciado y accesibilidad

- Foco: `--focus-color` 2px + offset 2 (ya en theme.css). Sobre fondos `--sel-bg` se mantiene visible (accent contra surface ~7,8:1). `html { scroll-padding-block: 6rem; }` (o `scroll-padding-top` igual a la altura de la barra fija) para 2.4.11.
- 1.4.12: nada con altura fija; `line-height: 1.5` base; contenedores crecen. Párrafos largos: `max-inline-size: 75ch` sólo en texto de ayuda.
- Prohibidos (verificable con grep): `@media` de layout, `nowrap`, `ellipsis`, `line-clamp`, `height:` fija en títulos/SKU/atributos. Ojo: el `.chip` del matcher usa `white-space: nowrap`; **no reutilizar esa clase**, usar `.chip-pri`.
- `prefers-reduced-motion` y `prefers-contrast` no son layout, se pueden usar `@media` para ellos.

## 12. Especificación por ancho

- **375px (contenedor <40rem):** cabecera con chips envueltos en varias líneas; luego bloque ML (foto arriba, título, SKU, precio/stock, link a ML); luego cada candidato como bloque con radio, «1.º sugerido», banda de contradicción y filas de atributo «Etiqueta / ML: … / Cand.: … + marca». Aviso de guardado y de deshacer ocupan el ancho completo; botones apilados.
- **1280px:** matriz de 5 columnas (etiquetas, ML, 3 candidatos) con encabezados sticky; historial debajo o a la derecha si el contenedor lo permite.
- **≥2560/3840px:** cola a la izquierda, caso al centro, historial/evidencia a la derecha, más columnas de búsqueda; ningún `max-width` sobre datos.

## 13. Huecos de la spec (a resolver antes de implementar)

1. No define el **orden y la lista de atributos** ni cómo se agrupan cuando hay `otros_atributos` (propuesta: núcleo fijo primero, luego los otros alfabéticos bajo un subtítulo «Otros atributos»).
2. Falta el valor de la marca **cuando ambos lados faltan** (¿se oculta la fila?). Propuesta: ocultar.
3. No aclara **qué muestra «Seleccionado»** cuando el operador aún no eligió (¿ninguno preseleccionado?). Propuesta: ninguno, para no sesgar hacia el 1.º.
4. Visor: no dice si compara ML contra candidato lado a lado. Propuesta: v1 una foto por vez.
5. Umbral 40rem del container query es una propuesta a validar con el barrido 320–3840.
6. Falta el ancho de la **cola** lateral (propuesta: `minmax(min(16rem,100%), 1fr)` en un grid `auto-fit`).
7. Sin tema claro en el repo: la spec habla de "claro y oscuro"; no aplica.
8. `.btn-reintentar` global mide <44px; corregirlo en `theme.css` afectaría otras pantallas (decidir si se cambia global).

## Skills

Usadas: criterio de `design-systems` (tokens por alias) y auditoría manual contra Web Interface Guidelines (sin WebFetch de referencias: la spec ya trae la investigación). Omitidas: `ui-ux-pro-max` (ya hay sistema), `frontend-design`/`taste-skill` (dirección heredada), navegador (no disponible: capturas y axe las hace `hard-worker-frontend`/`probador-e2e`).
