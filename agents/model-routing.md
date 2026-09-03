# Enrutamiento de modelos

Esta tabla es la fuente de verdad para el adaptador de agentes de Codex. Los frontmatter de
`.claude/agents/` son la fuente equivalente cuando el pipeline corre dentro de Claude Code.

| Rol | Modelo Codex | Esfuerzo | Modelo Claude | Motivo |
|---|---|---:|---|---|
| Orquestador | `gpt-5.6-terra` | low | sesión principal | Mantiene contexto, gates e integración; escala solo por riesgo |
| `hard-worker-backend` | `gpt-5.6-luna` | low | `haiku` | Implementación acotada y repetitiva |
| `hard-worker-frontend` | `gpt-5.6-luna` | low | `haiku` | Implementación acotada y repetitiva |
| `explorador` | `gpt-5.6-luna` | low | `haiku` | Búsqueda y síntesis puntual |
| `tester` | `gpt-5.6-luna` | low | `sonnet` | QA dirigido y lectura de fallos; escala solo si se atasca |
| `probador-e2e` | `gpt-5.6-luna` | low | `sonnet` | Flujo de navegador repetible; escala solo si hay ambigüedad |
| `disenador-ux` | `gpt-5.6-terra` | medium | `sonnet` | Flujo, estados y microcopy |
| `disenador-ui` | `gpt-5.6-terra` | medium | `sonnet` | Sistema visual, responsive y accesibilidad |
| `revisor` | `gpt-5.6-sol` | high | `opus` | Hallazgos de correctitud y arquitectura |
| `auditor-despliegue` | `gpt-5.6-sol` | high | `opus` | Gate independiente antes de publicar |

La economía no permite degradar un gate: si una tarea de desarrollo resulta arquitectónica o
de alto riesgo, el orquestador puede escalarla explícitamente a `gpt-5.6-sol`/`opus` y debe
dejar constancia en el handoff.

## Política de economía de tokens (2026-08-22)

La sesión raíz usa `gpt-5.6-terra` con esfuerzo `low` por defecto. Se sube a `medium` solo
cuando hay una decisión técnica o de producto que no puede resolverse con evidencia local; no
se usa `high`, `xhigh` ni `max` para implementar o contestar estados.

Reglas operativas:

1. Mantener como máximo un hard-worker activo y un gate activo. No abrir agentes paralelos para
   explorar lo mismo ni repetir una revisión ya cerrada.
2. `explorador` y `hard-worker-*` quedan en `gpt-5.6-luna/low`. `tester` y `probador-e2e` usan
   `gpt-5.6-luna/low` para pruebas dirigidas; solo suben a `gpt-5.6-terra/medium` si aparece
   un fallo difícil de aislar.
3. `disenador-ux` y `disenador-ui` usan `gpt-5.6-terra/medium` por defecto; `high` se reserva
   para una decisión ambigua de flujo, accesibilidad o sistema visual.
4. `revisor` y `auditor-despliegue` conservan `gpt-5.6-sol/high`, pero se ejecutan una sola vez
   sobre el diff final. Si encuentran fallos, se reabre únicamente el rol necesario y se repite
   solo ese gate.
5. El orquestador no reenvía transcripciones completas: entrega commit base, diff resumido,
   rutas afectadas, tests ejecutados y bloqueos. La memoria activa sigue siendo el checkpoint.
6. Cada evidencia se liga a `diff_fingerprint` (SHA-256 de base+HEAD+diff); los gates no
   repiten validaciones para la misma huella.
7. Para cada cambio: tests dirigidos una vez durante la implementación y suite completa una vez
   después del último commit. No se repiten suites por mensajes de progreso ni se sondea Claude
   hasta que responda.

### Escalera de decisión

`luna/low` → trabajo repetitivo y lectura puntual; `terra/low` → coordinación y cambios normales;
`terra/medium` → diseño, depuración o prueba con incertidumbre; `sol/high` → única revisión o
auditoría final. Volver a un nivel inferior después de resolver la incertidumbre es obligatorio.
