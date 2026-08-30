# Estado activo

Actualizado: 2026-08-30.

## Fuente de verdad

- El único plan activo es `docs/superpowers/plans/plan-maestro-v2.md`.
- Producción sirve `conteo-confiable`; `master` permanece separado hasta ejecutar la
  consolidación controlada del plan maestro.
- El despliegue y la publicación siguen fuera de esta integración local.

## En curso

- Hito U0 vence el 2026-09-04 y tiene precedencia: cerrar Conteo de Inventario y Preparación de
  Pedidos de punta a punta en el VPS, y congelar contrato/UX de ambos módulos para la app.
- El cierre móvil de U0 es definición, no publicación. La ejecución queda en el orden Base común →
  Preparación → Inventario → Consolidación.
- P0.1 Claims acepta `claims` y `post_purchase`, consulta el recurso autoritativo y conserva
  el comportamiento fail-open con diagnóstico durable; la corrección actual sigue pendiente
  de revisión final.
- P1 Claims aporta el diseño de eventos/jobs durables, inbox, conversaciones, notificaciones
  lógicas, entregas push y lectura operativa móvil; la implementación actual sigue pendiente
  de revisión final y el acceso exige permiso `notificaciones-ml`.
- Hito 7 aporta una única autenticación móvil JWT con refresh ligado al dispositivo, rutas
  `/api/v1/devices` y `/api/v1/notifications`, preferencias, FCM HTTP v1 y reservas de envío
  idempotentes. Claims usa el mismo middleware móvil; el panel web conserva cookies.
- Claims ocupa la migración `029`; el lease incremental de integration jobs usa la migración
  `035` sin modificar 029; Hito 7 conserva su migración `030` según el plan.
- El proveedor push real está configurado como FCM en el entorno de producción; sus credenciales
  permanecen solo en `.env`; en producción `PUSH_REAL_ENABLED=true` habilita envíos y su ausencia o
  valor distinto pausa ambos workers sin consumir intentos; test/development conserva el proveedor
  mock cuando la variable está ausente.
  `mock` queda reservado para desarrollo y pruebas.

## Estado de cierre

- P0.1 y P1 backend tienen cambios locales pendientes de revisión; los conteos y auditorías
  anteriores quedan invalidados por este diff y no certifican el cierre.
- P0.2 tiene configuración local verificada para JWT, HMAC Woo, ML y FCM; la URL operativa de ML es
  `/api/ml/notificacion` bajo el dominio de producción y los topics fueron confirmados por el
  responsable operativo.
- P0.3 tiene evidencia histórica sobre `d6a021a`, pero requiere repetir verificación después de
  integrar el diff actual; no se declara certificado por esta worktree.
- El cliente móvil Claims queda subordinado a App 3 para no desplazar U0; su handoff UX sigue en
  `docs/superpowers/specs/claims-p2-mobile-ux.md`.
- App 0 y el cliente móvil pertenecen al otro chat/repositorio. Este repo conserva únicamente los
  contratos backend; no se atribuyen aquí builds, tests ni artefactos móviles.
- Ningún ítem de U0 está autorizado a desplegarse por esta actualización documental: cada cambio
  futuro conserva revisión, tests, E2E, auditoría y aprobación previa a modificar producción.
