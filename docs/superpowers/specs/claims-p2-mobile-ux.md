# Handoff P2 móvil Claims

Estado: entregable para el otro chat; no autoriza despliegue ni activa push real.

## Contexto y alcance

App interna para depósito, ventas y administración (~20 personas) en Android/iOS y Wi‑Fi
variable. El backend ya integrado expone `/api/v1/auth`, `/api/v1/devices`,
`/api/v1/inbox`, `/api/v1/notifications` y `/api/v1/operaciones`; el contrato canónico es
`openapi/mobile-v1.yaml`.

La primera vertical debe cubrir: login, refresh/logout persistentes, registro/revocación de
dispositivo, inbox paginada con `next_cursor`, detalle de Claim, conversación de solo lectura,
marcar leído, tomar, resolver con control de versión, push, deep link y lectura offline limitada.

## Invariantes

- El inbox es la fuente de verdad; push solo avisa y el deep link siempre revalida sesión,
  permiso y visibilidad con `GET /api/v1/inbox/:id`.
- Access token solo en memoria; refresh token y `device_id` solo en almacenamiento seguro del SO.
- Offline permite leer la última información confirmada, pero nunca encola ni simula `read`,
  `take` o `resolve`.
- Resolver solo está disponible online, con versión confirmada; un `409` obliga a actualizar y
  confirmar otra vez, sin reintento automático.
- Push no contiene PII, tokens, IDs externos ni texto completo: título `Nuevo Claim asignable` y
  resumen seguro.
- La conversación es solo lectura: no mostrar campo ni acción de respuesta.

## Estados y microcopy mínimo

- Sin conexión: `Sin conexión. Mostramos la última información guardada.`
- Bandeja vacía: `No tenés Claims pendientes.`
- Error de carga: `No pudimos actualizar la bandeja.` + `Reintentar`.
- Conflicto: `Este Claim cambió mientras lo veías. Actualizalo antes de resolver.`
- Éxito: `Claim resuelto.`
- Push denegado: permitir continuar y explicar cómo activarlo luego.
- Logout sin red: borrar secretos localmente, sin afirmar revocación en servidor.

## Criterios de aceptación

Login/refresh/logout, permisos, dispositivos, paginación, deep links, offline, conflictos 409,
push simulado y navegación pasan tests del cliente y E2E en Android/iOS a 375/412 px. El otro
chat debe devolver commit, lockfile, tests, reporte E2E y cualquier configuración manual pendiente;
este repositorio ejecutará luego revisión, suite global y auditoría antes de integrar.
