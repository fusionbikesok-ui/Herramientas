# Estado activo

Actualizado: 2026-08-28.

## Fuente de verdad

- El único plan activo es `docs/superpowers/plans/plan-maestro-v2.md`.
- Producción sirve `conteo-confiable`; `master` permanece separado hasta ejecutar la
  consolidación controlada de la Prioridad 6 del plan maestro.
- Los planes, trackers y estados históricos fueron retirados de la superficie activa; su
  trazabilidad permanece en Git.

## En curso

- P0.1 Claims reales: el webhook acepta `claims` y `post_purchase` con paths vigentes y
  consulta siempre `GET /post-purchase/v1/claims/{id}`; persiste datos completos o fail-open.
- Mantener abiertos los bloqueos P0 restantes de configuración y evidencia operativa.
- Construir el backbone de eventos, trabajos, bandeja, conversaciones y notificaciones que
  alimentará la aplicación operativa.
- El backend móvil de autenticación y dispositivos ya existe en `conteo-confiable`; el cliente
  móvil y sus cortes verticales siguen pendientes según el plan maestro.
- La integración de horarios de corte de Preparación debe terminar su pipeline antes de entrar
  en la rama servida.

## Próximo paso

1. Cerrar P0 con pruebas de contrato y configuración verificable.
2. Implementar el primer corte vertical: pregunta de Mercado Libre → evento durable → bandeja →
   notificación → push simulado → deep link → lectura/resolución → auditoría.
3. Consolidar `master` y `conteo-confiable` únicamente sin agentes activos, con suites
   secuenciales, E2E y auditoría de despliegue.
