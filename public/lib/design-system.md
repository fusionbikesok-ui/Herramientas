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
