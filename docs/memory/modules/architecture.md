## Permisos de aplicaciones del VPS — publicado 2026-10-15

`integrations/management-migration/permissions.mjs` define el catálogo compartido por Usuarios y el gateway independiente. Los permisos se almacenan en `user_permisos`; no requieren migración ni asignación automática. El gateway lee `/api/auth/me` en cada petición, clasifica el destino ya validado y deniega a usuarios comunes cualquier ruta sin clasificación. Conserva firmas, CSRF, Origin y bloqueos de operaciones trasladadas a WordPress. Rechaza parámetros de despacho repetidos, combinaciones ambiguas y claves/separadores que PHP interpretaría de forma distinta a Node.

`routes/usuarios.js` sincroniza transaccionalmente los permisos de Mensajería con `mensajeria_roles` y audita cambios en `mensajeria_roles_audit`; protege al último supervisor. Un rol explícito anterior ya no contradice lo que se guarda desde Usuarios.

# Arquitectura y contratos internos

## Hechos durables

- La aplicación usa Node.js/Express con módulos ESM, SQLite mediante `better-sqlite3` y
  Vitest.
- El contrato HTTP documentado está en `docs/api-contrato.md`; consultarlo solo cuando el
  cambio afecte endpoints o consumidores.
- El login móvil acepta exactamente una de dos formas de asociación: `device_id`, o
  `platform` + `push_token`; la combinación de ambas responde 422. Sus fallos se limitan por
  usuario+IP y por IP agregada, con un umbral agregado más amplio para IPs compartidas.
- En producción `buildApp` exige FCM y valida antes de abrir la base las credenciales Firebase
  (`projectId`, email y private key PEM). Las llamadas OAuth y FCM tienen timeout explícito;
  un timeout devuelve un error reintentable y libera su temporizador.
- La API móvil implementada se monta bajo `/api/v1` con Bearer JWT separado de la sesión web.
  Los refresh tokens móviles se almacenan hasheados y ligados a `device_tokens`; el esquema
  vigente del backend integrado es `user_version=30`: Claims P1 ocupa `029` y Hito 7 `030`.
- El delivery push usa `PUSH_PROVIDER=mock` solo para desarrollo (estado `simulado`) o FCM
  HTTP v1 real con credenciales fuera del repositorio. Las reservas de delivery se persisten
  antes del side effect mediante una clave de idempotencia durable.
- La ingesta interna del plugin WordPress Live Chat entra por `POST /v1/events`, verifica HMAC
  SHA-256 sobre el cuerpo crudo con una ventana máxima de 300 segundos y deduplica por
  `event_id`. Proyecta atómicamente `integration_events`, `inbox_items`, notificaciones por
  usuario con dispositivo activo y deliveries push; los handoffs se priorizan en el worker.
- El programa canónico usa E0–E26 y está en `/opt/fusionbikes/herramientas/docs/superpowers/plan-maestro.md`; sus dependencias forman un DAG explícito y las fichas separadas prueban progreso.
- E1 añade `plataforma/`: Node 24 con TypeScript nativo, PostgreSQL, Fastify y `pg` con SQL explícito. API, worker y scheduler son procesos separados y la sombra está conectada al legado por recibos, señales y gateway GET. El legado conserva la autoridad operativa. Sus contratos públicos iniciales son `/api/v2/health` e `/api/v2/incidents` en `openapi/platform-v2.yaml`.
- La API móvil de Preparación e Inventario vive bajo `/api/v1`, comparte servicios de negocio con
  el panel y nunca reutiliza rutas web autenticadas por cookies. Toda mutación reintentable exige
  idempotencia y toda edición concurrente, versión esperada con conflicto `409` sin sobrescritura.
- El objetivo E13 permite captura provisional offline de operaciones de piso sobre tareas descargadas. El envelope incluye operación, dispositivo, usuario, lease, versión base y hora real; el servidor acepta, reconoce repetición idempotente o devuelve conflicto explícito, sin `last-write-wins`.

## Decisiones vigentes

- Decisión del 2026-10-15: conservar la captura de pedidos, envíos y demás corrientes sin consumidor para las entregas posteriores; no borrar sus pendientes ni marcarlos artificialmente como procesados. La frescura de captura y los errores de consumidores activos se evalúan por separado.
- Recuperación de Sombra desplegada el 2026-10-15: una llamada individual por página y checkpoints separados de scan/bulk de ML permiten avanzar con cupo parcial; requiere el motor y la gestión de corridas reanudables, ausentes en la imagen heredada. El relector individual de mensajes envía `x-format-new: true`. Plan y validación en `docs/superpowers/plans/2026-10-15-recuperacion-sombra.md`. No implica aceptación de E1: faltan medición de capacidad y siete días verdes.
- Compatibilidad de rollback: una imagen previa al checkpoint `fase: contenido` de items no puede reanudarlo. Con worker detenido, cerrar esas corridas incompletas sin bajas y reiniciar la vuelta completa desde cero antes de volver a la imagen anterior; conservar el cursor final previo y las observaciones.
- El paginado de envíos conserva la pausa de 300 ms entre lecturas aunque cada envío tenga su propio checkpoint; dividir páginas no habilita ráfagas nuevas.
- El alcance de cambios del programa vive en `docs/superpowers/deliveries/`; un plan auxiliar no altera el maestro ni una ficha.
- Las especificaciones de diseño viven en `docs/superpowers/specs/`.
- Vigencia, archivos, decisiones y progreso se enrutan desde `/opt/fusionbikes/herramientas/docs/superpowers/INDEX.md`.

## Cuándo actualizar

Solo ante cambios de arquitectura, contratos, estructura canónica o decisiones transversales.
