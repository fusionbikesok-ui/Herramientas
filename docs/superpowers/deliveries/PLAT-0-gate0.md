# P0 — Gate 0: infraestructura, DR, QA y capacidad

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md`. Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada**
- Objetivo y requisitos cubiertos: Backblaze B2 con cifrado, versionado y Object Lock; backups PostgreSQL con WAL y PITR (RPO 5 min, RTO 1 h) con restauración probada; respaldo incremental de uploads; al menos 30 GB libres y uso ≤70%; QA separado con datos anonimizados; monitoreo externo; Node 24. Absorbe la parte de recuperación y staging de E23.
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

- Estado externo relevante: Medido 2026-09-13: disco 91% usado, 8,9 GB libres de 96; Node v20.20.2; DR externo nunca funcionó. **No cumple el gate.**
- Próxima acción exacta y reproducible: Inventariar qué ocupa el disco (snapshots SQLite ad hoc, tarballs de uploads, duplicados) sin borrar nada, y proponer qué retirar recién después de verificar copia en B2. Requiere autorización para contratar B2 e instalar servicios.
- Gates: los del programa de plataforma (corte <15 min, un solo escritor remoto, DR probado) más §20 del maestro.
- Confirmación: sin secretos ni datos personales.
