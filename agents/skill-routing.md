# Enrutamiento de skills

Este mapa evita que los diseñadores carguen todas las skills en todos los cambios. El agente
debe evaluar cada eje, seleccionar el paquete mínimo y reportar los identificadores usados.

Las skills locales se leen desde `.agents/skills/` y `.claude/skills/`. Las skills externas de
Claude se resuelven desde `/root/.claude/plugins/cache/` sin copiar archivos al repositorio.

## Paquete UX

Siempre que el cambio agregue o modifique flujo, estados o copy:

- `.agents/skills/codebase-design/SKILL.md` si cambia una frontera o interfaz de módulo.
- plugin `interaction-design` para estados, feedback, errores y navegación.
- plugin `designer-toolkit` → `ux-writing` para labels, mensajes y confirmaciones.
- plugin `design-ops` → `handoff-spec` para entregar el diseño al hard-worker.

Agregar según riesgo:

| Señal | Skills adicionales |
|---|---|
| Flujo nuevo o problema ambiguo | `design-research`, `ux-strategy` |
| Estados complejos o asincronía | `interaction-design` → `state-machine`, `error-handling-ux` |
| Decisión difícil de validar en papel | `.agents/skills/prototype/SKILL.md`, `prototyping-testing` |
| Cambio de términos de dominio | `.agents/skills/ubiquitous-language/SKILL.md`, `domain-modeling` |
| Accesibilidad cognitiva o contenido sensible | `cognitive-accessibility`, `accessible-content` |

## Paquete UI

Siempre que cambie HTML, CSS, componentes o responsive:

- plugin `ui-design` para layout, jerarquía y responsive.
- plugin `design-systems` para tokens, componentes y accesibilidad.
- plugin `design-ops` → `handoff-spec` y `design-qa-checklist`.
- `.claude/skills/web-design-guidelines/SKILL.md` y `writing-guidelines/SKILL.md` cuando
  aplique al HTML o al copy.

Agregar según riesgo:

| Señal | Skills adicionales |
|---|---|
| Pantalla existente con problemas visuales | `visual-critique` |
| Cambio de tokens o componentes compartidos | `design-systems` → `design-token`, `component-spec`, `design-system-governance` |
| Responsive o nuevos breakpoints | `ui-design` → `responsive-design`, `layout-grid` |
| Interacción visual compleja | `interaction-design` → `micro-interaction-spec`, `feedback-patterns` |
| Accesibilidad explícita | `design-systems` → `accessibility-audit`, `cognitive-accessibility` |

## Entrega mínima

Cada diseñador devuelve: contexto recibido, skills usadas, decisiones, estados de error,
criterios verificables para el hard-worker y riesgos que deben cubrir tester/E2E. Si una skill
externa no está disponible, lo declara y aplica el equivalente local; nunca afirma haber
ejecutado un plugin que no pudo abrir.
