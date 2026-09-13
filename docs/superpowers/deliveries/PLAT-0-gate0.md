# P0 — Gate 0: infraestructura, DR, QA y capacidad

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md`. Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **en curso** (backups B2 y disco cumplidos; PITR, QA, monitoreo y Node 24 pendientes)
- Objetivo y requisitos cubiertos: Backblaze B2 con cifrado, versionado y Object Lock; backups PostgreSQL con WAL y PITR (RPO 5 min, RTO 1 h) con restauración probada; respaldo incremental de uploads; al menos 30 GB libres y uso ≤70%; QA separado con datos anonimizados; monitoreo externo; Node 24. Absorbe la parte de recuperación y staging de E23.
- Responsable operativo y técnico: por definir
- Base, rama y worktree: por definir
- Feature flags y alcance del piloto: por definir

## Evidencia técnica

- Commits integrados y candidatos: ninguno
- Migraciones, compatibilidad, backup y restauración: 2026-09-13 backup cifrado a B2 (base, .env, uploads incremental) con clave sin borrado; restauración de base y .env idéntica e íntegra; uploads verificados 3.736/3.736 por hash; descarga completa limitada por el tope diario de B2 (ver operations-vps). PITR PostgreSQL: no aplica aún.
- Tests exactos y resultado: no ejecutado
- Revisión independiente, E2E y auditoría de despliegue: no ejecutado

## Evidencia operativa

- Piloto, jornada observada y aceptación: no ejecutado

## Continuidad

- Estado externo relevante: 2026-09-13 tras limpieza y rotación: 35 GB libres, 65% usado (**cumple**). Node v20.20.2. DR externo funcionando desde 2026-09-13.
- Próxima acción exacta y reproducible: subir el tope diario de descarga de B2 y repetir la restauración completa de uploads; guardar la passphrase fuera del VPS (confirmar); alerta si `backups/estado-nube.json` tiene `ultimo_ok` > 26 h; luego QA separado, monitoreo externo y Node 24.
- Gates: los del programa de plataforma (corte <15 min, un solo escritor remoto, DR probado) más §20 del maestro.
- Confirmación: sin secretos ni datos personales.
