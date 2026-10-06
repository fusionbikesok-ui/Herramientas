# P6 — Retiro del legado

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md` (§5.2, §6 punto 7, §6.1). Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada — ficha de orientación, no especificación decision-complete.** Requiere plan propio aprobado antes de iniciar.
- Objetivo: apagar workers, motores duplicados y pantallas antiguas del legado, y archivar sus tablas operativas, **sin perder evidencia ni romper la App**.
- **Regla no destructiva (obligatoria):** ninguna tabla, archivo SQLite ni ruta se borra hasta que existan, para esa vertical:
  1. **exportación firmada** del SQLite completo (hash, firma, copia en B2 con Object Lock) conservada como archivo inmutable;
  2. **crosswalk completo** SQLite → PostgreSQL de cada entidad migrada;
  3. **reconciliación** exacta registrada de entidades, relaciones, reservas y comandos;
  4. **vencimiento del plazo de compatibilidad:** 30 días de GET read-only con advertencia y métricas en cero uso, y para `/api/v1`, que la App ya no llame esa ruta (PM-162).
  Apagar un escritor es posible antes; **borrar** sólo después de los cuatro puntos. Las pantallas y rutas legacy efectivamente retiradas responden `410 Gone`.
- **P6 puede terminar con fachadas `/api/v1` delgadas todavía activas** mientras la App las use (PM-162). Lo que debe desaparecer es la **lógica legacy duplicada**, no la compatibilidad: una ruta v1 clasificada como fachada sobre v2 se conserva hasta que la App deje de llamarla.
- **Inventario `/api/v1` (medido 2026-09-13):**
  - Montajes en `server.js` (10): `/api/v1/auth`, `/api/v1/devices`, `/api/v1/notifications`, `/api/v1/inbox`, `/api/v1` (acciones de inbox ML), `/api/v1/workshop`, `/api/v1/identidad-productos`, `/api/v1/preparation`, `/api/v1` (hoy), `/api/v1` (operaciones).
  - Rutas que llama la App (`FusionBikes-App/src/api`): `auth/login`, `auth/logout`, `auth/refresh`, `meta`, `devices`, `notifications`, `notifications/:id/read`, `notifications/preferences`, `integration-notifications`, `inbox`, `inbox/:id/{detail,read,claim,assign,acknowledge,resolve}`, `claims/:id/actions/:id`, `conversations/:id/messages`, `questions/:id/reply`, `orders`, `today`, `preparation`, `preparation/queue`, `preparation/:id`, `preparation/:id/{take,scans,complete,claim/release}`, `preparation/:id/items/:id/confirm-manual`, `workshop`, `workshop/:id/{diagnostic,parts,state}`, `workshop/parts/:id/move`.
  - El plan de P6 debe **clasificar cada ruta** como (a) fachada delgada sobre v2, (b) todavía ejecuta lógica legacy, o (c) sin uso, con evidencia (código y métricas de llamadas). Sólo (a) sin uso de la App o (c) pueden retirarse.
- Responsable operativo: José. Técnico: asistente.
- Base, rama y worktree: se fija en el plan de P6.
- Feature flags y piloto: retiro por vertical, en orden inverso de riesgo.

## Subentregas

1. **P6.1 Inventario:** workers, crons, tablas, pantallas y rutas legacy por vertical, con dueño y uso medido.
2. **P6.2 Clasificación `/api/v1`:** fachada v2 / lógica legacy / sin uso, con evidencia.
3. **P6.3 Archivo:** exportación firmada, crosswalk y reconciliación por vertical.
4. **P6.4 Apagado:** escritores y workers legacy apagados por flag, con reversión documentada.
5. **P6.5 Read-only y 410:** pantallas y rutas legacy **no usadas por la App** pasan 30 días en lectura con advertencia y luego `410 Gone`. Las rutas `/api/v1` clasificadas como fachada sobre v2 **no** entran en este paso: siguen activas mientras la App las use.
6. **P6.6 Retiro físico:** borrar código y tablas sólo con los cuatro puntos cumplidos y aprobación de José.

## Gates y aceptación propios

- Gates del programa más §20 del maestro.
- Checklist de la regla no destructiva firmado por vertical antes de cualquier borrado.
- `/api/v1/meta` compatible con la App durante todo P6.
- Restauración del archivo SQLite firmado desde B2 probada antes de borrar la primera tabla.

## Métricas, SOP y riesgos

- Métricas: llamadas por ruta legacy/día, escritores legacy activos, tablas archivadas vs. borradas.
- SOP: retiro de una ruta, reversión de un apagado, consulta del archivo histórico.
- Riesgos: borrar evidencia necesaria para una disputa (archivo firmado e inmutable); romper la App (clasificación y métricas de uso antes de retirar).

## Evidencia técnica

- Commits integrados y candidatos: ninguno
- Migraciones, compatibilidad, backup y restauración: no ejecutado
- Tests exactos y resultado: no ejecutado
- Revisión independiente, E2E y auditoría de despliegue: no ejecutado

## Evidencia operativa

- Piloto, jornada observada y aceptación: no ejecutado

## Continuidad

- Estado externo relevante: No iniciado.
- Consultas para refrescar el inventario:
  - `grep -n "app.use('/api/v1" server.js`
  - `grep -rhoE "['\"\`]/api/v1/[^'\"\`?]*" /opt/fusionbikes/FusionBikes-App/src/api/*.ts | sort -u`
- Próxima acción exacta y reproducible: con P5 aceptado, escribir `docs/superpowers/plans/AAAA-MM-DD-p6-retiro-legacy.md` con la regla no destructiva, la clasificación de `/api/v1` y las subentregas P6.1–P6.6, y pedir aprobación a José.
- Confirmación: sin secretos ni datos personales.
