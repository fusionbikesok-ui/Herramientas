# P1 — Fundación en sombra

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md`. Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada**
- Objetivo y requisitos cubiertos: Esquema PostgreSQL, auditoría encadenada por hash, inbox/outbox/DLQ, autenticación y workers, sin ninguna escritura remota.
- Responsable operativo y técnico: José (usuario), valida los reportes de diferencias en sombra; técnico: asistente
- Base, rama y worktree: por definir
- Feature flags y alcance del piloto: por definir
- Decisiones de José (2026-09-13):
  - **Código:** carpeta nueva `plataforma/` dentro de este repo (no repo aparte); comparte tests,
    QA bajo demanda, backups y despliegue con el legado, que se vacía corte a corte.
  - **Claves de cifrado** de PII y secretos: archivo 600 en el VPS, fuera del repo y de la base, con
    copia que José guarda fuera del VPS (mismo criterio que la passphrase de Backblaze).
  - **Passkeys** (catálogo y administración): deben funcionar en iPhone, Mac/PC con biometría,
    computadoras sin biometría (iPhone como llave vía QR o llave USB) y Android.

## Evidencia técnica

- Commits integrados y candidatos: ninguno
- Migraciones, compatibilidad, backup y restauración: no ejecutado
- Tests exactos y resultado: no ejecutado
- Revisión independiente, E2E y auditoría de despliegue: no ejecutado

## Evidencia operativa

- Piloto, jornada observada y aceptación: no ejecutado

## Continuidad

- Estado externo relevante: Plan de plataforma aprobado 2026-09-13. **Bloqueado por el cierre de P0** (PostgreSQL + PITR probado pertenecen a P0, no a P1). VPS 2 CPU / 7,8 GB compartido (~3,4 GB libres); ampliación sin fecha. Passkeys: validación con autenticador virtual en P1; la prueba en dispositivos reales es condición para activarlas en P2, cuando exista `qa-herramientas` (decisión de José 2026-09-13).
- Próxima acción exacta y reproducible: cerrar P0 (PostgreSQL + PITR); luego ejecutar el paso 1 de `plans/2026-09-13-p1-fundacion-sombra.md` con José confirmando el plan corregido.
- Gates: los del programa de plataforma (corte <15 min, un solo escritor remoto, DR probado) más §20 del maestro.
- Confirmación: sin secretos ni datos personales.
