# Traspaso a Claude — plan consolidado

> **Handoff histórico sustituido.** No usar su orden ni commits como estado vigente. Continuar desde
> `/opt/fusionbikes/herramientas/docs/memory/active.md`, el maestro E0–E24 y la ficha de entrega en
> `/opt/fusionbikes/herramientas/docs/superpowers/deliveries/`.

Actualizado: 2026-08-28.

## Fuente de verdad

La fuente que era vigente al redactar este handoff fue:

`docs/superpowers/plans/plan-maestro-v2.md`

Todos los planes y trackers anteriores fueron eliminados de `master` y
`conteo-confiable`. Su historia permanece en Git, pero no deben usarse para
decidir trabajo nuevo.

También se limpió `docs/memory/active.md`: solo contiene el estado vigente y no
debe volver a convertirse en una cronología de sesiones.

## Huecos incorporados al plan

Se recuperó e incorporó el pendiente exclusivo del plan antiguo de `master`:

- Cerrar revisión formal, tests dirigidos, E2E móvil y auditoría del flujo de
  asociación de GTIN/EAN desconocido durante Preparación.
- Verificar candidatos pendientes, conflictos, reemplazo explícito del código,
  conservación local cuando Woo falla, reintento operativo y responsive a 390 px.

El plan maestro también contiene los huecos operativos de Claims reales de
MercadoLibre, configuración, persistencia de eventos, cola y DLQ, inbox,
conversaciones, notificaciones, push, app móvil, inventario, Preparación, sync,
pruebas y consolidación de ramas.

## Orden vigente

1. Cerrar P0: Claims reales de MercadoLibre, configuración y evidencia operativa.
2. Implementar el primer corte vertical de la app:
   pregunta ML → evento durable → inbox → notificación → push simulado → deep
   link → lectura/resolución → auditoría.
3. Continuar las prioridades de app móvil, inventario, Preparación y sync.
4. Consolidar `master` y `conteo-confiable` mediante el procedimiento de la
   Prioridad 6.

## Reglas de coordinación

- No crear planes paralelos ni recuperar instrucciones de documentos borrados.
- Si aparece un pendiente nuevo o un hueco comprobado, actualizar directamente
  `plan-maestro-v2.md`.
- Mantener el trabajo en worktrees aislados.
- Respetar el pipeline de revisión, tests, E2E cuando haya UI y auditoría.
- No reiniciar PM2, modificar producción ni cambiar configuración real sin una
  autorización explícita y los gates correspondientes.

## Estado de ramas

- Producción sirve `conteo-confiable`.
- Ambas ramas tienen el mismo `plan-maestro-v2.md` y el mismo `active.md`.
- `conteo-confiable` quedó actualizado en los commits `83d6a1b`, `fa0f1c3` y
  `c275e26`.
- `master` quedó actualizado en el commit `5e415af`.
- Los cambios son documentales; no se hizo push ni se reinició PM2.
