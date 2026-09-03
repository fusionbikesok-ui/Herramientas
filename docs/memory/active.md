# Estado activo

Actualizado: 2026-09-03.

## Fuente de verdad

- Especificación vigente: `/opt/fusionbikes/herramientas/docs/superpowers/plans/plan-maestro-v2.md`.
- Índice de planificación: `/opt/fusionbikes/herramientas/docs/superpowers/INDEX.md`.
- Progreso verificable: `/opt/fusionbikes/herramientas/docs/superpowers/deliveries/README.md` y fichas E0–E24.
- E0 fue aprobada por el usuario el 2026-09-02 y figura `aceptada` en el índice de entregas. No implica despliegue de código.
- La App remota `feature/stock-flow-ui` alineó `README.md` y `docs/backend-sync/README.md` en `ac4c48f` y `380640f`; no se publicó build móvil.
- El VPS `/opt/fusionbikes/herramientas` es producción real y sirve `conteo-confiable`.

## Base y cambios preservados

La reconstrucción partió de `bc13898f9faeffcde00f49616ce6cb858eff03a3` y se integró por fast-forward. Los cambios ajenos no confirmados en `db/index.js`, `routes/inventario.js`, `test/inventario.test.js` y `migrations/041_stock_rollout_skus.sql` conservaron exactamente sus hashes antes/después.

## Estado funcional verificado, no aceptación

- Preparación posee cola, claims, escaneo, fotos/evidencia y despacho idempotente. E1 tiene correcciones locales para arrastre entre jornadas, elegibilidad efectiva, transición/polling de claims, aviso de vencimiento, compatibilidad 042→043 y ventanas SLA confirmadas. E2 suma perfiles versionados, snapshot de requisitos, idempotencia/fingerprint, auditoría atómica, retención con holds y recuperación de cola por lease; suite 241/241 y smoke E2E + axe verde en tres viewports. Queda validación operativa real, revisión independiente y aceptación.
- E1 registra además la confirmación de horarios de apertura por operador, rechaza una negativa explícita, bloquea asignaciones si `items_json` no es verificable, restringe la configuración de zonas y ayudas, detecta cambios externos o snapshots ausentes en pedidos ya tomados, crea retornos físicos pendientes para unidades asignadas y reproduce asignaciones idempotentemente antes de validar versión; `test/jornada.test.js` queda en 53/53.
- Etiquetas posee cola interna y endpoints/agente candidato; falta relevamiento y validación con impresora real.
- E3 está en desarrollo: el agente admite Bearer JWT revocable, el permiso `etiquetas` y recuperación de leases; faltan modelo/driver/puerto, Windows e impresora real.
- E4 está en desarrollo: lotes separados ML/Web, miembros congelados, tracking, escaneo idempotente, confirmación de salida física, auditoría propia y worker Woo con reintento/dead-letter tienen migraciones 050–056, API/UI, pruebas de integración y E2E visual aislada (`npm run e2e:e4`); falta revisión independiente, tracking integrado con Woo/transportista y piloto.
- E5 aún no puede iniciar en la App: `/opt/fusionbikes/FusionBikes-App` no existe; HTTPS requiere autenticación y SSH respondió `Repository not found` el 2026-09-03. No se guardaron credenciales. El lado VPS valida contrato móvil 1.0.0 (42 rutas, SHA-256 `a01d188a3b875f93143e708f7809c9fd003a9fa69ef692bb54572af44dea9267`) y auth/dispositivo 13/13, pero falta checkout y iPhone real.
- Backend móvil posee auth, dispositivos, notificaciones/inbox y contrato `/api/v1` parcial. La App remota tiene conexión real parcial; falta iPhone físico, contrato generado definitivo y offline común.
- Consulta rápida y movimientos/transferencias tienen implementaciones candidatas locales, pero no equivalen a E8–E10 aceptadas.
- Conteos, recepción e integraciones existen como herramientas legacy; aún no comparten el modelo E0–E24.

## Próxima acción

E2 conserva pendientes externos de revisión independiente y piloto/jornada observada; E3 ya está en desarrollo técnico con autenticación del agente validada, pero requiere relevamiento de impresora, prueba Windows/hardware, revisión y piloto antes de candidata. No desplegar runtime mientras las entregas sigan sin aceptación.

## Hallazgo agregado

- Auditoría de webhooks: Woo `/api/woo/webhook/order` y ML `/api/ml/notificacion` tienen garantías distintas; Woo dispara trabajo en background sin intención durable previa al ACK y ML deja varios topics en `audit-only`. El plan maestro incorpora en E6/E11 un contrato común, cola durable, reconciliación por entidad, matriz de cobertura y pruebas de crash/duplicado/fuera de orden.

## Reglas inmediatas

- No declarar terminada una entrega por existir código o numeración previa.
- No iniciar `node server.js` contra la base real ni ejecutar suites concurrentes.
- Backend/web solo podrán publicarse automáticamente cuando el pipeline definido por el maestro esté implementado y verde; hoy una tarea documental no autoriza push, migración, PM2 ni deploy.
- Windows, hardware y App Store siempre exigen autorización explícita.
- No almacenar secretos, PII, conversaciones ni logs en memoria.

## UM1 — Guardia ML

- UM1 urgente está en desarrollo. Separa Guardia ML, Corrección y Consulta; la cobertura válida es publicación+variación con SKU Woo exacto.
- Gate auditoría 2026-09-03: 🔴. Tests y E2E están verdes, pero el checkout `conteo-confiable` está 1 commit detrás de `master`, contiene un diff acumulado de E1–E4/UM1 y no permite atribuir un diff final aislado; no hacer merge ni deploy hasta congelar/rebasar en un worktree seguro y repetir los gates.
- El primer rollout es solo lectura, con escaneo al abrir/cada 15 minutos y frescura máxima de 30 minutos. Los casos activos con stock sin vínculo se crean como incidencias; el backlog inicial queda pendiente de validación del Administrador designado.
- Los pedidos ML sin cobertura se retienen en Fusion sin alterar estado/notas de Woo. Vínculos, pausas y stock remoto permanecen deshabilitados hasta el gate operativo.
- La especificación completa está en la sección 18.1 del Maestro y la evidencia en `docs/superpowers/deliveries/UM1-guardia-ml.md`.

## Decisiones E1 incorporadas

- E1 queda especificada, pero no implementada con estas nuevas reglas: ola inicial de elegibles, mini-olas normales, ML urgente en ola activa, búsqueda por zonas manuales, ayuda física registrada y escaneo unitario en mesa.
- PC muestra tablero operativo; celular web muestra una tarea; tablet futura es tablero compartido sin PII. E1 permanece `desarrollo` y la demo sintética solo puede llevarla a `candidata`.
- La documentación separa E1 (jornada/olas/búsqueda/mesa) de E2 (embalaje/fotos/aprobación/listo para despacho). No se autoriza cambio de código en esta actualización documental.
