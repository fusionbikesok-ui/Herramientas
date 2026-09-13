# P2 — Catálogo e identidad

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md`. Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada**
- Objetivo y requisitos cubiertos: Modelos y variantes vendibles, relaciones, evidencia, matcher único y un solo ejecutor. Reemplaza UM1.1–UM1.6, E9 (familias e identidad), Matcher, Cobertura, Guardia y el vigía de formato. Incluye corregir los 39 SKU vendibles fuera de `FB-{ID}`.
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

- Estado externo relevante: No iniciado. Legado vigente con 5 casos de identidad abiertos (Jose) que siguen valiendo hasta el corte. Comportamiento del legado a preservar: vigía de formato, auto-vínculo por `seller_sku` exacto y único, liberación de ventas retenidas.
- Próxima acción exacta y reproducible: Esperar P1.
- Gates: los del programa de plataforma (corte <15 min, un solo escritor remoto, DR probado) más §20 del maestro.
- Confirmación: sin secretos ni datos personales.
