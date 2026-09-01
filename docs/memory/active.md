# Estado activo

Actualizado: 2026-09-01.

## Fuente de verdad

- El plan único vigente es `/opt/fusionbikes/herramientas/docs/superpowers/plans/plan-maestro-v2.md`.
- El VPS `/opt/fusionbikes/herramientas` es producción real y sirve `conteo-confiable`.
- El despliegue, reinicio de PM2 y publicación siguen siendo manuales.

## Estado actual

- La base funcional previa a E0 está en `334d48d`; E0 quedó documentada e integrada en el commit
  `b8e289d`.
- El contenido de E0 quedó integrado localmente en `conteo-confiable` mediante `b8e289d` (checkout actual `4ec4458`): plan por entregas,
  memoria de operaciones y App, corrección de contexto y rutas absolutas. No se hizo push ni deploy.
- Preparación tiene cola continua, toma exclusiva, fotos, evidencia, estados y control de despacho
  idempotente. E1 quedó integrada localmente en `conteo-confiable`; la rama continúa con E2–E6
  hasta el commit verificable `5afd5d4`, con
  hoja por jornada, alta inicial de pendientes, bloqueo sin fecha, reconciliación de fotos limitada
  y limpieza de archivos en carreras idempotentes. No se hizo push, deploy ni reinicio.
- E2 ya encola la etiqueta interna 50×25 al completar evidencia y expone claim/lease/resultado/
  reintento en la cola. El agente configurable está en `/opt/fusionbikes/herramientas/tools/windows-label-agent/`;
  falta validar el adaptador con el modelo de impresora real antes de instalarlo.
- E3 tiene autenticación móvil, refresh/logout, dispositivos y contrato OpenAPI verificable por CI;
  las pruebas locales de auth/dispositivo/servidor pasan 27/27. La conexión de la App a producción
  y la validación en iPhone/Android todavía requieren el gate de la App. En la rama remota
  `fusionbikesok-ui/FusionBikes-App:feature/stock-flow-ui` se fijó modo HTTP por defecto y se eliminó
  el fallback silencioso a datos simulados cuando falla el backend (commits `44a0264a` y `2038beeb`).
- E4: notificaciones, inbox y operaciones móviles del backend pasan 17/17 tests. La App remota
  carga la bandeja desde `/api/v1/notifications` y marca lecturas contra el backend en modo HTTP
  (commits `b2755b56` y `216433ed`); deep links y validación en dispositivos todavía requieren
  prueba física.
- E5 tiene `/api/inventario/consulta-rapida`: búsqueda de solo lectura por SKU/EAN/nombre,
  stock comercial Woo, stock ML cacheado, compromisos conocidos y campos físicos/entrantes nulos
  cuando todavía no existe línea base de ubicaciones. Su prueba específica pasa 1/1.
- E6 tiene el libro `stock_movements` y usa las ubicaciones existentes de inventario; las
  transferencias exigen origen, destino, saldo suficiente, motivo e idempotencia. La prueba
  focalizada de consulta, transferencia, balance e insuficiencia pasa 3/3 en `5afd5d4`.
- Inventario tiene conteos y cierre seguro, pero todavía no tiene el libro de movimientos y saldos
  físicos por ubicación definido en el programa de stock.
- La App usa `feature/stock-flow-ui` como base. Su prototipo de stock con edición absoluta debe
  reemplazarse por movimientos, tareas y conteos.
- La memoria local bajo `/opt/fusionbikes/herramientas/docs/memory/` es la fuente canónica de
  contexto; cualquier Codebase Memory MCP futuro deberá espejarla y no sustituirla.

## Pendientes inmediatos

1. E2: validar adaptador, instalación automática y escenarios con impresora real.
2. E3: fijar el contrato y conectar/validar la App en iPhone y Android.
3. E4: bandeja operativa móvil y alertas reales.
4. Revisar E6 con auditoría independiente y diseñar la habilitación por familia/SKU antes de
   aceptar escrituras de movimientos en operación.

## Reglas de operación

- No declarar integrado un commit solo por su mensaje: comprobar ancestry y diff real.
- No iniciar `node server.js` contra la base real ni ejecutar suites concurrentes.
- Cualquier cambio de `/opt/fusionbikes/herramientas/public/` requiere E2E responsive; toda entrega requiere revisión, tests y
  auditoría antes de ser publicable.
- La memoria conserva decisiones durables, no transcripciones, logs, secretos ni credenciales.
