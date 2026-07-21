# Diseño: Equipo de subagentes de Claude Code

**Fecha:** 2026-07-21
**Proyecto:** `/opt/fusionbikes/herramientas` (FusionBikes — integración ML ↔ Woo)
**Autor:** Matías + Claude

## Objetivo

Armar un equipo persistente de subagentes de Claude Code, cada uno especializado en un
rol, para desarrollar el proyecto con una separación clara de responsabilidades
(planear → desarrollar → revisar → testear → auditar antes de desplegar). El equipo debe
sobrevivir a sesiones nuevas sin reconfiguración.

## Restricción técnica que condiciona el diseño

En Claude Code los **subagentes no se llaman entre sí**: cada uno corre aislado, hace su
tarea y devuelve un informe. El único que puede despacharlos y encadenarlos es la **sesión
principal**. Por eso el "orquestador" del modelo mental del usuario **es la sesión en vivo**
(yo), no un subagente. Los demás roles sí son subagentes.

## Arquitectura (Enfoque A)

```
Usuario ⇄ Orquestador (sesión principal) ── despacha ──▶ subagentes
                 │
                 ├─▶ explorador        (búsqueda, apoyo)
                 ├─▶ hard-worker        (desarrollo)
                 ├─▶ revisor            (revisa el diff; NO escribe)
                 ├─▶ tester             (vitest, QA)
                 └─▶ auditor-despliegue (gate obligatorio pre-deploy)
```

- **Orquestador = sesión principal.** Planea con el usuario, despacha al pipeline,
  integra resultados y reporta. Encodeado además como comando `/feature`.
- **Pipeline por defecto:** plan → hard-worker → revisor → (hard-worker corrige) →
  tester → auditor-despliegue → luz verde → desplegar a mano.
- Cualquier subagente puede despacharse suelto cuando haga falta.

## Los 5 subagentes

Archivos en `.claude/agents/*.md`. Todos: reportan **en español**, conocen el entorno
(staging→prod a mano, git local sin remoto, `npm test` con vitest, ESM + better-sqlite3,
integración ML↔Woo) y la **regla de despliegue obligatoria** (auditoría + tests verdes +
UI responsive sin nada oculto).

| Agente | Rol | Herramientas | Modelo | Escribe código |
|---|---|---|---|---|
| `hard-worker` | Todo el desarrollo | Todas | opus | Sí |
| `revisor` | Revisa el diff del hard-worker | Read, Grep, Glob, Bash | opus | **No** |
| `tester` | Escribe/corre vitest, reproduce bugs | Read, Edit, Write, Bash, Grep, Glob | sonnet | Solo tests |
| `auditor-despliegue` | Gate pre-deploy (regla obligatoria) | Read, Grep, Glob, Bash, playwright | opus | No |
| `explorador` | Búsqueda rápida, devuelve conclusión | Read, Grep, Glob, Bash | sonnet | No |

## Skills embebidas en cada agente

Las skills viven en `.agents/skills/` (sistema Matt Pocock) y **no están registradas como
skills nativas de Claude Code**; varias tienen `disable-model-invocation: true`. Por eso
**no** se pasan como herramientas ni se dejan al mecanismo `Skill`. En su lugar, el prompt
de cada agente **referencia por ruta los `SKILL.md` correspondientes** y le indica leerlos y
seguirlos (los agentes tienen `Read`). Esto es robusto: funciona sin registro, sin importar
`disable-model-invocation`, y sobrevive a sesiones nuevas.

| Agente | Skills que sigue (`.agents/skills/<x>/SKILL.md`) |
|---|---|
| `hard-worker` | `implement`, `tdd`, `prototype`, `diagnosing-bugs`, `migrate-to-shoehorn`, `resolving-merge-conflicts` |
| `revisor` | `code-review`, `codebase-design`, `improve-codebase-architecture`, `ubiquitous-language` |
| `tester` | `tdd`, `qa`, `diagnosing-bugs` |
| `auditor-despliegue` | `code-review`, `git-guardrails-claude-code`, `setup-pre-commit` |
| `explorador` | `research`, `wayfinder` |
| Orquestador (sesión) | `grilling`, `grill-with-docs`, `request-refactor-plan`, `to-prd`, `to-issues`, `codebase-design`, `handoff`, `ask-matt` |

## Persistencia y disparadores entre sesiones

Dos formas de disparar el pipeline, **ambas activas**:

1. **Automático** (sin tipear nada): el flujo queda escrito como instrucción de proyecto en
   `CLAUDE.md` (raíz del repo, leído al arrancar cada sesión). Cuando el usuario pide
   crear/cambiar una función, la sesión principal dispara el pipeline sola.
2. **Inicio forzado**: comando `/feature` (skill del proyecto en `.claude/skills/feature/`)
   que encodea el mismo pipeline para gatillarlo explícitamente.

Persistencia de las piezas:

- Los 5 agentes son archivos `.md` en `.claude/agents/` → **cada sesión nueva los detecta
  automáticamente**.
- Nota en `MEMORY.md` que registra la existencia del equipo y apunta a `CLAUDE.md`, al
  comando y al spec.
- Todo commiteado a git (branch de trabajo → integración a mano por el usuario).

## Flujo del comando `/feature`

1. Planear con el usuario (grilling ligero) qué se va a construir.
2. Despachar `hard-worker` con el plan.
3. Despachar `revisor` sobre el diff; si hay hallazgos, devolver al `hard-worker` a corregir
   (loop hasta que el revisor dé OK).
4. Despachar `tester` para asegurar vitest verde y cobertura del cambio.
5. Despachar `auditor-despliegue` como gate final (regla obligatoria).
6. Reportar luz verde/roja al usuario. El deploy a prod lo hace el usuario a mano.

## Fuera de alcance (YAGNI)

- Agentes autónomos / cron (el usuario los descartó por ahora).
- Un subagente `orquestador` explícito (redundante: la sesión principal ya lo es).
- Registrar las skills de `.agents/` como skills nativas (se referencian por ruta).

## Criterio de éxito

- Abrir una sesión nueva, pedir "arranquemos una función" y que el equipo esté disponible
  sin reconfigurar.
- Cada agente responde en español y respeta la separación de roles (el revisor no escribe).
- El `auditor-despliegue` bloquea si algún test falla o hay UI oculta/no responsive.
