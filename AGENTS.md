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
