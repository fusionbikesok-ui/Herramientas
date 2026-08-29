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

## Decisiones vigentes

- Los planes de cambios normales o grandes viven en `docs/superpowers/plans/`.
- Las especificaciones de diseño viven en `docs/superpowers/specs/`.

## Cuándo actualizar

Solo ante cambios de arquitectura, contratos, estructura canónica o decisiones transversales.
