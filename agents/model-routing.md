# Enrutamiento de modelos

`agents/routing.json` es la fuente **ejecutable** del reparto motor/modelo/esfuerzo/sandbox por
rol — `scripts/agent-routing.mjs` lo lee y `npm run verify:agents` lo cruza contra el frontmatter
de `.claude/agents/*.md` para los roles que corren en Claude. Este documento es la
**justificación en prosa**; si diverge del JSON, gana el JSON.

## Quién orquesta

La sesión de Claude Opus es siempre el orquestador: planifica con el usuario, despacha a los
roles y los encadena. Codex nunca orquesta — ejecuta un rol despachado vía `npm run agent:codex`
y devuelve un handoff que valida `agent-pipeline-policy.mjs`, exactamente el mismo contrato que
usa `npm run agent:claude`.

## Reparto

| Rol | Motor | Modelo | Esfuerzo | Sandbox | Motivo |
|---|---|---:|---|---|---|
| Orquestador | Claude | `opus` | — | — | Planifica, despacha, integra, corre `npm test` una sola vez y commitea |
| `hard-worker-backend` | Codex | `gpt-5.6-terra` | medium | workspace-write | Implementación acotada — **no** en el tramo chico, ver evidencia abajo |
| `hard-worker-frontend` | Codex | `gpt-5.6-terra` | medium | workspace-write | Implementación acotada — **no** en el tramo chico, ver evidencia abajo |
| `explorador` | Codex | `gpt-5.6-luna` | low | read-only | Único rol en el tramo chico: busca y sintetiza, no escribe |
| `tester` | Codex | `gpt-5.6-terra` | medium | workspace-write | Escribe tests que gatean producción; comparte modos de falla con quien implementó |
| `disenador-ux` | Codex | `gpt-5.6-terra` | medium | read-only | Flujo, estados y microcopy — ver nota de skills abajo |
| `disenador-ui` | Codex | `gpt-5.6-terra` | medium | read-only | Sistema visual, responsive y accesibilidad — ver nota de skills abajo |
| `revisor` | Claude | `sonnet` → `opus` | — | — | **Cross-review**: motor distinto del que escribió. Base sonnet por presupuesto; sube a opus solo si el diff toca un trigger |
| `auditor-despliegue` | Claude | `sonnet` → `opus` | — | — | Gate final independiente; no repite las pruebas del revisor. Misma escalera que el revisor |
| `probador-e2e` | Claude | `sonnet` | — | — | **Restricción de herramienta**: el MCP de Playwright está cableado en Claude, no en Codex — no es preferencia, es dependencia técnica. No escala: manejar un navegador no mejora con un modelo más caro |

### Evidencia del reparto

Medido en [arXiv 2607.21656](https://arxiv.org/html/2607.21656v1) (cross-model code review):

- **Codex escribe → Claude revisa: +18.1 pp** (71.6% → 89.7%). La dirección inversa **daña**
  (−8.6 pp). Por eso ningún gate se mueve a Codex, nunca.
- Ese +18.1 pp se midió con un escritor **GPT-5.5 a esfuerzo high**, no con el tramo chico. Por
  eso los roles que escriben código o tests arrancan en `terra`/medium: con `luna`/low no hay
  evidencia de que la ganancia se sostenga, y cada ciclo de rework gasta una pasada de revisor,
  que es la parte cara.
- El paper **no halló ninguna condición revisada que le ganara a Opus trabajando solo**, lo que
  fija el techo de la escalera de implementación: el último escalón cambia de motor.

**Incertidumbre conocida:** bajar los gates a `sonnet` como fila base **no está medido**. El
+18.1 pp se obtuvo con Opus revisando; nadie publicó Sonnet revisando Codex. La dirección del
cross-review se mantiene (Sonnet sigue siendo proveedor distinto del que escribió), pero la
magnitud es una apuesta. Se mitiga con la escalada automática por triggers. Si aparecen bugs que
Sonnet dejó pasar en diffs sin trigger, la corrección es volver `revisor` a `opus` en la base.

**Nota sobre `disenador-ux`/`disenador-ui` en Codex**: solo tiene sentido si los plugins de
diseño (`ui-design`, `design-systems`, `interaction-design`, `designer-toolkit`, `design-ops`,
`design-research`, `ux-strategy`, `visual-critique`, `accessible-content`,
`cognitive-accessibility`) están symlinkeados en `~/.codex/skills/` — sin eso pierden más de la
mitad del router de `agents/skill-routing.md`. Verificar con `codex exec ... "Listá tus skills"`
antes de asumir que están disponibles.

## Escalera por riesgo (no negociable)

Si el diff toca **sync ML↔Woo, esquema sqlite, concurrencia o `guardia_ml_*`**, hay **dos
escaleras distintas**, y se disparan de forma distinta a propósito:

**Implementación (`ladder`, roles Codex)** — sube por decisión explícita del orquestador con
`--escalate`: escalón 1 `gpt-5.6-sol`/high, escalón 2 **cambia de motor y lo escribe Opus**. El
orquestador de Codex rechaza el escalón 2 y redirige a `npm run agent:claude`.

**Gates (`ladder_gates`, roles Claude)** — suben **solos** de `sonnet` a `opus` cuando
`triggersTocados()` detecta que el diff toca un path de riesgo. No depende de que el orquestador
se acuerde: con presupuesto semanal, Opus tiene que gastarse donde el riesgo lo justifica, y esa
decisión no puede quedar librada a la memoria de nadie. El motivo queda registrado en el handoff
(`escalated: true`, `motivo_escalada`).

La detección vive en `triggersTocados()` (`scripts/agent-dispatch-common.mjs`) y lee los `paths`
de cada trigger en `agents/routing.json`. **`concurrencia` no tiene `paths`** y nunca dispara
sola: no vive en un archivo sino en el código (claims por lease, `expected_version`,
transacciones). Si el orquestador ve un diff que toca invariantes de concurrencia, escala a mano
con `--escalate`. Está documentado como limitación, no como olvido.

**Evidencia de por qué esta regla existe:** un bug de concurrencia en el worker de Guardia
(`lib/guardiaMl.js`, invariante de `responsable` sin escribir antes de encolar una operación)
rompió el 100% de las escrituras en producción durante días **con la suite de vitest en verde**.
Ningún test despachaba una operación con `operador` seteado contra un caso sin `responsable` —
un gate barato tampoco lo hubiera atrapado, porque el síntoma no aparecía en el código que
cambió, sino en una interacción entre dos endpoints y el worker. Ver
`.agents/skills/concurrencia-guardia/SKILL.md`.

## Reglas operativas

1. Mantener como máximo un hard-worker activo y un gate activo. No abrir agentes paralelos para
   explorar lo mismo ni repetir una revisión ya cerrada.
2. `hard-worker-*` y `tester` van en `gpt-5.6-terra`/medium; solo `explorador` usa
   `gpt-5.6-luna`/low, porque es el único que no escribe nada. Ningún rol que escriba código o
   tests baja al tramo chico — `npm run verify:agents` lo rechaza.
3. `disenador-ux` y `disenador-ui` usan `gpt-5.6-terra`/medium por defecto; `high` se reserva
   para una decisión ambigua de flujo, accesibilidad o sistema visual.
4. `revisor` y `auditor-despliegue` corren en Claude `sonnet` sobre el diff final, y suben solos
   a `opus` si el diff toca un trigger. Una sola vez cada uno. Si encuentran fallos, se reabre
   únicamente el rol de desarrollo necesario y se repite solo el gate afectado — no ambos por
   costumbre. Repetir un gate en opus por un diff sin trigger es gastar el recurso escaso.
5. El orquestador no reenvía transcripciones completas: entrega commit base, diff resumido,
   rutas afectadas, tests ejecutados y bloqueos vía task file. La memoria activa sigue siendo el
   checkpoint.
6. Cada evidencia se liga a `diff_fingerprint` (SHA-256 de base+HEAD+diff); los gates no repiten
   validaciones para la misma huella.
7. Para cada cambio: tests dirigidos una vez durante la implementación y suite completa una vez
   después del último commit, corrida siempre por el orquestador (los gates en `read-only` no
   pueden correr `npm test`: escriben `.sqlite` temporales que el sandbox no permite).
8. `--force-engine` en `orchestrate-codex.mjs`/`orchestrate-claude.mjs` es el escape hatch para
   sacar un rol de su motor por defecto; usarlo deja constancia explícita en el handoff, nunca en
   silencio.

### Escalera de decisión

`luna/low` → solo lectura y síntesis, nada que escriba en el repo; `terra/medium` → fila base de
toda implementación, test y diseño; `sol/high` → implementación sobre superficie de alto riesgo
(escalón 1); `opus` → techo, cuando ni `sol/high` revisado alcanza (escalón 2). Volver a un nivel
inferior después de resolver la incertidumbre es obligatorio.

Del lado de los gates la escalera es más corta y automática: `sonnet` es la fila base y `opus`
entra solo por trigger. La regla práctica, con presupuesto semanal, es que **Opus se gasta en
revisar riesgo, no en revisar volumen**.
