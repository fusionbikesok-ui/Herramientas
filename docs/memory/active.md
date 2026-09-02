# Estado activo

Actualizado: 2026-09-02.

## Fuente de verdad

- Especificación vigente: `/opt/fusionbikes/herramientas/docs/superpowers/plans/plan-maestro-v2.md`.
- Índice de planificación: `/opt/fusionbikes/herramientas/docs/superpowers/INDEX.md`.
- Progreso verificable: `/opt/fusionbikes/herramientas/docs/superpowers/deliveries/README.md` y fichas E0–E24.
- E0 fue aprobada por el usuario el 2026-09-02; permanece `candidata` hasta registrar publicación efectiva y cierre formal del ciclo documental.
- La App remota `feature/stock-flow-ui` alineó `README.md` y `docs/backend-sync/README.md` en `ac4c48f` y `380640f`; no se publicó build móvil.
- El VPS `/opt/fusionbikes/herramientas` es producción real y sirve `conteo-confiable`.

## Base y cambios preservados

La reconstrucción partió de `bc13898f9faeffcde00f49616ce6cb858eff03a3` y se integró por fast-forward. Los cambios ajenos no confirmados en `db/index.js`, `routes/inventario.js`, `test/inventario.test.js` y `migrations/041_stock_rollout_skus.sql` conservaron exactamente sus hashes antes/después.

## Estado funcional verificado, no aceptación

- Preparación posee cola, claims, escaneo, fotos/evidencia y despacho idempotente. Candidatos históricos de fotos, hoja diaria y SLA requieren ancestry/diff y gates antes de integración.
- Etiquetas posee cola interna y endpoints/agente candidato; falta relevamiento y validación con impresora real.
- Backend móvil posee auth, dispositivos, notificaciones/inbox y contrato `/api/v1` parcial. La App remota tiene conexión real parcial; falta iPhone físico, contrato generado definitivo y offline común.
- Consulta rápida y movimientos/transferencias tienen implementaciones candidatas locales, pero no equivalen a E8–E10 aceptadas.
- Conteos, recepción e integraciones existen como herramientas legacy; aún no comparten el modelo E0–E24.

## Próxima acción

Completar gates de E1: revisar el candidato UI `9203e16` en `/tmp/fusion-e1-preparacion-ui`, ejecutar E2E responsive/axe, resolver o aceptar explícitamente la ausencia de claims en `GET /api/jornada/olas`, y realizar piloto/jornada observada. No desplegar runtime mientras E1 siga en desarrollo.

## Reglas inmediatas

- No declarar terminada una entrega por existir código o numeración previa.
- No iniciar `node server.js` contra la base real ni ejecutar suites concurrentes.
- Backend/web solo podrán publicarse automáticamente cuando el pipeline definido por el maestro esté implementado y verde; hoy una tarea documental no autoriza push, migración, PM2 ni deploy.
- Windows, hardware y App Store siempre exigen autorización explícita.
- No almacenar secretos, PII, conversaciones ni logs en memoria.
