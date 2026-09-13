# P1 — Fundación en sombra

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md`. Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada**
- Objetivo y requisitos cubiertos: Esquema PostgreSQL, auditoría encadenada por hash, inbox/outbox/DLQ, autenticación y workers, sin ninguna escritura remota.
- Responsable operativo y técnico: José (usuario), valida los reportes de diferencias en sombra; técnico: asistente
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

- Estado externo relevante: Plan de plataforma aprobado 2026-09-13. P0 cumplido salvo PITR (llega con PostgreSQL en esta entrega). VPS actual 2 CPU / 7,8 GB compartido con chatbot, Ollama y fusion-vision (~4 GB libres); ampliación decidida sin fecha: PostgreSQL arranca en Docker con límites de memoria.
- Próxima acción exacta y reproducible: escribir el plan de implementación de P1 (esquema PostgreSQL, auditoría encadenada, inbox/outbox/DLQ, auth, workers, PITR) con presupuesto de RAM, y confirmarlo con José antes de instalar.
- Gates: los del programa de plataforma (corte <15 min, un solo escritor remoto, DR probado) más §20 del maestro.
- Confirmación: sin secretos ni datos personales.
