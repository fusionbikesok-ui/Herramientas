# Agentes de apoyo — especificación retirada

Esta especificación de 2026-07-21 describía un pipeline, modelos fijos y gates encadenados.
Quedó retirada: no se usa para despachar trabajo ni para elegir motor, modelo o esfuerzo.

La política vigente está en [CLAUDE.md](/opt/fusionbikes/herramientas/CLAUDE.md),
[AGENTS.md](/opt/fusionbikes/herramientas/AGENTS.md) y
[docs/agent-coordination.md](/opt/fusionbikes/herramientas/docs/agent-coordination.md): los
roles de `.claude/agents/` son ayudas opt-in. Se invoca un diseñador solo al diseñar; revisor,
tester, E2E o auditor solo cuando su aporte independiente justifica el costo. No hay cadena ni
gate automático.
