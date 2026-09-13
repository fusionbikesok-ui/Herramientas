# P4 — Pedidos y preparación

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md`. Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada**
- Objetivo y requisitos cubiertos: Orden canónica, espejo ML→Woo idempotente, asignaciones, prioridad ML hasta `dispatch_confirmed`, picking, empaque verificado y despacho. Absorbe E1, E2, E4, E12 y la línea GP (incluidas GP13–GP15) y la retención de ventas.
- Responsable operativo y técnico: por definir
- Base, rama y worktree: por definir
- Feature flags y alcance del piloto: por definir

## Evidencia técnica

- Commits integrados y candidatos: ninguno
- Migraciones, compatibilidad, backup y restauración: no ejecutado
- Tests exactos y resultado: no ejecutado
- Revisión independiente, E2E y auditoría de despliegue: no ejecutado

## Evidencia operativa

- Piloto, jornada observada y aceptación: no ejecutado

## Continuidad

- Estado externo relevante: No iniciado. Legado: 2 ventas ML retenidas al 2026-09-12 liberables desde Guardia ML.
- Próxima acción exacta y reproducible: Esperar P3.
- Gates: los del programa de plataforma (corte <15 min, un solo escritor remoto, DR probado) más §20 del maestro.
- Confirmación: sin secretos ni datos personales.
