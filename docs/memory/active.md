# Estado activo

Actualizado: 2026-08-29.

## Fuente de verdad

- El único plan activo es `docs/superpowers/plans/plan-maestro-v2.md`.
- Producción sirve `conteo-confiable`; `master` permanece separado hasta ejecutar la
  consolidación controlada del plan maestro.
- El despliegue y la publicación siguen fuera de esta integración local.

## En curso

- P0.1 Claims acepta `claims` y `post_purchase`, consulta el recurso autoritativo y conserva
  el comportamiento fail-open con diagnóstico durable.
- P1 Claims aporta eventos/jobs durables, inbox, conversaciones, notificaciones lógicas,
  entregas push y lectura operativa móvil; el acceso exige permiso `notificaciones-ml`.
- Hito 7 aporta una única autenticación móvil JWT con refresh ligado al dispositivo, rutas
  `/api/v1/devices` y `/api/v1/notifications`, preferencias, FCM HTTP v1 y reservas de envío
  idempotentes. Claims usa el mismo middleware móvil; el panel web conserva cookies.
- Claims ocupa la migración `029`; Hito 7 debe aplicarse después con la migración `030`.
- El proveedor push real y sus credenciales continúan pendientes de configuración segura;
  `mock` es solo para desarrollo y pruebas.

## Estado de cierre

- P0.1 y P1 backend están integrados en `conteo-confiable` y tienen revisión, auditoría,
  suite global y E2E web documentados.
- P0.2 (secretos por entorno, HMAC Woo, topics/URL ML y proveedor push) requiere configuración
  y evidencia manual; no se inventan valores ni se guardan secretos en el repositorio.
- P0.3 requiere health, PM2 y migraciones verificados después del próximo deploy manual.
- P2 cliente móvil se desarrolla en otro chat; el handoff UX es
  `docs/superpowers/specs/claims-p2-mobile-ux.md` en el worktree de trabajo.
