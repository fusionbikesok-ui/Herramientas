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
- El programa canónico usa E0–E24 y está en `/opt/fusionbikes/herramientas/docs/superpowers/plans/plan-maestro-v2.md`; las fichas separadas prueban progreso.
- La API móvil de Preparación e Inventario vive bajo `/api/v1`, comparte servicios de negocio con
  el panel y nunca reutiliza rutas web autenticadas por cookies. Toda mutación reintentable exige
  idempotencia y toda edición concurrente, versión esperada con conflicto `409` sin sobrescritura.
- El objetivo E13 permite captura provisional offline de operaciones de piso sobre tareas descargadas. El envelope incluye operación, dispositivo, usuario, lease, versión base y hora real; el servidor acepta, reconoce repetición idempotente o devuelve conflicto explícito, sin `last-write-wins`.

## Decisiones vigentes

- Los planes de cambios normales o grandes viven en `docs/superpowers/plans/`.
- Las especificaciones de diseño viven en `docs/superpowers/specs/`.
- Vigencia, archivos, decisiones y progreso se enrutan desde `/opt/fusionbikes/herramientas/docs/superpowers/INDEX.md`.

## Cuándo actualizar

Solo ante cambios de arquitectura, contratos, estructura canónica o decisiones transversales.
