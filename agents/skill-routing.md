# Enrutamiento de skills

Este mapa evita que los diseñadores carguen todas las skills en todos los cambios. El agente
debe evaluar cada eje, seleccionar el paquete mínimo y reportar los identificadores usados.

Las skills locales se leen desde `.agents/skills/` y `.claude/skills/`. Las skills externas de
Claude se resuelven desde `/root/.claude/plugins/cache/` sin copiar archivos al repositorio.

`disenador-ux`/`disenador-ui` corren en Codex (`agents/model-routing.md`). Codex descubre
`.agents/skills/` directamente, incluidos symlinks de directorio — `.claude/skills/feature`,
`web-design-guidelines`, `writing-guidelines`, `vercel-composition-patterns` y
`vercel-react-best-practices` están symlinkeados ahí para que Codex los vea sin duplicarlos. Los
plugins de diseño (`ui-design`, `design-systems`, `interaction-design`, `designer-toolkit`,
`design-ops`, `design-research`, `ux-strategy`, `visual-critique`, `accessible-content`,
`cognitive-accessibility`) están symlinkeados en `~/.codex/skills/` — si un plugin nuevo se
agrega a `/root/.claude/plugins/cache/designer-skills/`, symlinkearlo ahí también o el
diseñador en Codex no lo va a ver.

**Pendiente, no en este cambio**: `context7` (docs de librerías) y el MCP de Playwright no están
cableados en Codex — un rol en Codex que necesite docs de una librería o pruebas de navegador no
tiene esas capacidades; por eso `probador-e2e` sigue en Claude.

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
