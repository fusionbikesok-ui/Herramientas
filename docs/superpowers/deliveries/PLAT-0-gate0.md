# P0 — Gate 0: infraestructura, DR, QA y capacidad

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md`. Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **en curso** (backups B2, disco y monitoreo externo cumplidos; PITR, QA y Node 24 pendientes)
- Objetivo y requisitos cubiertos: Backblaze B2 con cifrado, versionado y Object Lock; backups PostgreSQL con WAL y PITR (RPO 5 min, RTO 1 h) con restauración probada; respaldo incremental de uploads; al menos 30 GB libres y uso ≤70%; QA separado con datos anonimizados; monitoreo externo; Node 24. Absorbe la parte de recuperación y staging de E23.
- Responsable operativo y técnico: por definir
- Base, rama y worktree: por definir
- Feature flags y alcance del piloto: por definir
- Decisiones QA (usuario, 2026-09-13): mismo VPS con stack y base propios (plan §2.2/§8);
  **bajo demanda** (se levanta para probar y se apaga); acceso **solo local en el VPS**
  (`127.0.0.1`, lo levanta y opera el asistente; Cloudflare no se puede modificar por ahora); MercadoLibre y WooCommerce **simulados** (sin credenciales reales en QA);
  anonimización obligatoria de **clientes** (nombre, email, teléfono, dirección, DNI) y
  **usuarios internos** (claves reales eliminadas, cuentas de prueba). Fotos de preparación y
  precios/costos no se anonimizan en esta etapa.

## Evidencia técnica

- Commits integrados y candidatos: ninguno
- Migraciones, compatibilidad, backup y restauración: 2026-09-13 backup cifrado a B2 (base, .env, uploads incremental) con clave sin borrado; restauración de base y .env idéntica e íntegra; uploads verificados 3.736/3.736 por hash; descarga completa limitada por el tope diario de B2 (ver operations-vps). PITR PostgreSQL: no aplica aún.
- Tests exactos y resultado: 2026-09-13 suite completa en contenedor `node:24-bookworm-slim` (v24.21.0) sobre clon de `conteo-confiable`: 140 archivos verdes; `better-sqlite3` y `sharp` cargan. Único fallo: `agent-pipeline-policy.test.js` por falta de `git` en la imagen slim (herramienta fuera de uso). `scannerZoomState.test.js` corregido con `vi.stubGlobal` (en Node ≥21 `navigator` es de solo lectura). La migración de producción a Node 24 no se hizo: requiere decisión.
- Revisión independiente, E2E y auditoría de despliegue: no ejecutado

## Evidencia operativa

- Piloto, jornada observada y aceptación: no ejecutado

## Continuidad

- Estado externo relevante: 2026-09-13: 34 GB libres, 66% usado (**cumple**, margen chico: uploads crece ~1,6 GB/mes). Node v20.20.2 en producción; suite verde en Node 24. DR externo funcionando desde 2026-09-13; cuenta B2 sin tarjeta por decisión del usuario (restauración completa limitada por topes gratis, ver operations-vps).
- Próxima acción exacta y reproducible: decidir migración de producción a Node 24; definir entorno QA separado; antes de ~8 GB en el bucket decidir tarjeta, lifecycle o proveedor.
- Gates: los del programa de plataforma (corte <15 min, un solo escritor remoto, DR probado) más §20 del maestro.
- Confirmación: sin secretos ni datos personales.
