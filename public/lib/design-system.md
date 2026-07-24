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
