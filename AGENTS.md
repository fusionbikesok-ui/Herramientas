# FusionBikes Herramientas

Trabajá en español. La definición operativa principal está en `CLAUDE.md` y el pipeline de
desarrollo en `.claude/skills/feature/SKILL.md`.

## Carga de contexto

Leé primero `docs/memory/INDEX.md` y `docs/memory/active.md`. Después abrí únicamente los
módulos que el índice relacione con la tarea. No cargues toda `docs/memory/`, todos los
planes históricos ni toda la documentación por defecto.

Para cambios de código usá el pipeline `feature`. Antes de cada revisión, actualizá solo la
memoria relacionada con el diff y mantené `active.md` breve. Para cambios operativos o
documentales sin código, actualizá el módulo relacionado antes de informar el resultado.
Nunca guardes secretos, credenciales, transcripciones, razonamiento interno o logs
transitorios en la memoria.

## Si te despacharon como rol de un pipeline

El orquestador es siempre la sesión de Claude Opus (nunca vos). Si el prompt te asigna un rol,
leé completo `.claude/agents/<rol>.md` antes de actuar y devolvé únicamente el JSON de handoff
que pide — nada de Markdown ni transcripción. El router de skills por rol está en
`agents/skill-routing.md`; el reparto de motor/modelo por rol en `agents/routing.json`.
