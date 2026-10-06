# FusionBikes Herramientas

Trabajá en español. La definición operativa principal está en `CLAUDE.md`.

## Carga de contexto

Leé primero `docs/memory/INDEX.md` y `docs/memory/active.md`. Después abrí únicamente los
módulos que el índice relacione con la tarea. No cargues toda `docs/memory/`, todos los planes
históricos ni toda la documentación por defecto.

Antes de informar un cambio, actualizá solo la memoria relacionada cuando corresponda y mantené
`active.md` breve. Para cambios operativos o documentales, actualizá el módulo relacionado antes
de informar el resultado. Nunca guardes secretos, credenciales, transcripciones, razonamiento
interno o logs transitorios en la memoria.

## Si te despacharon como agente

Leé completo `.claude/agents/<rol>.md` antes de actuar. Los roles son consultas puntuales:
respondé con conclusiones y evidencia útil para la tarea, sin handoff formal ni cadena implícita.
No hay modelo, esfuerzo o pipeline prescrito por el repositorio.
