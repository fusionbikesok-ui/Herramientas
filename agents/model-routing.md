# Enrutamiento de modelos

Esta tabla es la fuente de verdad para el adaptador de agentes de Codex. Los frontmatter de
`.claude/agents/` son la fuente equivalente cuando el pipeline corre dentro de Claude Code.

| Rol | Modelo Codex | Esfuerzo | Modelo Claude | Motivo |
|---|---|---:|---|---|
| Orquestador | modelo de la sesión raíz | heredado | sesión principal | Mantiene contexto, gates e integración |
| `hard-worker-backend` | `gpt-5.6-luna` | low | `haiku` | Implementación acotada y repetitiva |
| `hard-worker-frontend` | `gpt-5.6-luna` | low | `haiku` | Implementación acotada y repetitiva |
| `explorador` | `gpt-5.6-luna` | low | `haiku` | Búsqueda y síntesis puntual |
| `tester` | `gpt-5.6-terra` | medium | `sonnet` | QA, tests y lectura de fallos |
| `probador-e2e` | `gpt-5.6-terra` | medium | `sonnet` | Interacción de navegador y evidencia |
| `disenador-ux` | `gpt-5.6-terra` | high | `sonnet` | Flujo, estados y microcopy |
| `disenador-ui` | `gpt-5.6-terra` | high | `sonnet` | Sistema visual, responsive y accesibilidad |
| `revisor` | `gpt-5.6-sol` | high | `opus` | Hallazgos de correctitud y arquitectura |
| `auditor-despliegue` | `gpt-5.6-sol` | high | `opus` | Gate independiente antes de publicar |

La economía no permite degradar un gate: si una tarea de desarrollo resulta arquitectónica o
de alto riesgo, el orquestador puede escalarla explícitamente a `gpt-5.6-sol`/`opus` y debe
dejar constancia en el handoff.
