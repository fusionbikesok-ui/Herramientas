# Planes vigentes y su estado

Índice de navegación. **No reemplaza** a los documentos enlazados: el estado de cada entrega lo prueban sus fichas,
PR y commits, no este resumen. Actualizado: 2026-10-16.

| Plan | Documento | Estado |
|---|---|---|
| Plan maestro E0–E26 | [plan-maestro.md](plan-maestro.md) · índice [INDEX.md](INDEX.md) · decisiones [decisions/plan-maestro-decisions.md](decisions/plan-maestro-decisions.md) | Vigente. El progreso se prueba por fichas (`deliveries/`), p. ej. [E26 cierre](deliveries/E26-consolidacion-cierre.md). |
| E1 — PostgreSQL en sombra | [Ficha E1](deliveries/E1-fundacion-sombra.md) · [Seguimiento del 16/10](evidence/e1/2026-10-16-seguimiento-capacidad.md) | Mensajes y envíos ya completan dentro de sus intervalos; siete bajas resueltas. r4 desplegado por otra sesión, en observación. Sin aceptación: faltan 24–48 h sostenidas y siete días verdes; reporte del 15/10 rojo por faltantes históricos. |
| Consolidación de herramientas (fases A–E) | [specs/2026-10-03-consolidacion-herramientas.md](specs/2026-10-03-consolidacion-herramientas.md) | A, B, C y D desplegadas. E en curso (ver abajo). |
| Fase E — webhooks primero, crons reducidos | [specs/2026-10-11-fase-e-webhooks-design.md](specs/2026-10-11-fase-e-webhooks-design.md) | En curso. Detalle abajo. |
| Etiquetas en Preparación + menos scroll | Borrador en revisión (todavía no está en el repo) | Diseño v4 en revisión con Codex; sin implementar. |

## Fase E — estado por entrega

La Fase E del legado y E1 de PostgreSQL tienen criterios de aceptación separados. El despliegue de webhooks no acredita la campaña de Sombra.

| Entrega | Qué | Estado | Referencia |
|---|---|---|---|
| E-0 | Base de recibos/trabajos durables | Desplegada 12/10 | PR #20, migración 126 |
| E-1a | Pedidos por evento | Desplegada 12/10 + hotfix 14/10 | master `3c5167f3`, `4cf08fbf` |
| E-1b | Pedidos Woo por evento y alta de webhooks | Implementación incorporada; firmas 17–19 reparadas y webhooks activos el 15/10 18:11 UTC. Entrega natural comprobada el 16/10: 101 webhooks Woo completados; los 3 pedidos web nuevos tienen su `order.woo` hecho entre 0 y 2 min después, sin errores ni incidentes. `pedidos_cache.fecha` está en hora de Argentina | `bee4c796`, migración 129; [evidencia de recuperación](evidence/e1/2026-10-15-recuperacion-sombra.md) |
| E-1c | Bajas Woo confirmadas + `product.restored` | Desplegada 15/10 01:08 UTC | PR #29, migración 130 |
| E-2 | `item.project` durable (ML items/stock) | Desplegada 15/10 01:23 UTC | PR #30 |
| E-3 | Control medido (missed_feeds, monitor Woo, barridos) | Desplegada 15/10 11:26 UTC | PR #32, migración 131 |
| E-3 fix | Medición de barrido (solo activas) | Desplegada 15/10 13:34 UTC | PR #34 |
| E-3 fix | Estado de ítems fuera de caché (−~3.000 GET/día) | Desplegada 15/10 13:34 UTC | PR #35, migración 132 |
| E-4 | Envíos ML → Preparación (cancelación, Full, chips) | Desplegada 15/10 12:31 UTC | PR #33 |
| E-5 en adelante | Bajar frecuencia de crons, de a uno por semana, solo con `diferencias_sin_evento` en 0 o explicada | Pendiente | Primer candidato: `syncPedidosCache`, tras una semana de E-4 |

## Pendientes conocidos fuera de plan
- Sombra: conservar la captura de corrientes sin consumidor para las próximas entregas, por decisión de José del 15/10. No confundir esos pendientes con reintentos fallidos de consumidores activos.
- Panel ML Developers: desmarcar topics que no se usan y verificar `invoices` (0 avisos en 7 días).
- Revisar en pantalla la cola de Preparación con envíos ML reales (chips "Etiqueta lista"/"Demorado").
