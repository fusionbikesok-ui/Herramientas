# Tracker: plan de Preparación (provincia, direcciones, notas, despacho)

Plan completo: `docs/superpowers/plans/2026-08-26-preparacion-provincia-direcciones-despacho.md`
(copiado del plan de sesión, ver abajo). Este archivo trackea el estado de ejecución fase por
fase para no perder contexto entre sesiones — mismo patrón que
`2026-08-25-tracker-plan-jose.md`.

## Estado

| Ítem | Estado | Rama/commit | Nota |
|---|---|---|---|
| Fase 1 — Provincia y armado de dirección | ✅ **Desplegado** | `fix-provincia-andreani` → mergeado a `conteo-confiable` (`d7b7d97`, `3fd1719`) | 2026-08-26. Verificado contra 40 pedidos reales. Revisor sin hallazgos de correctitud. |
| Fase 2 — Confirmar envío vs. facturación | ✅ **Desplegado** | `prep-direccion-envio-facturacion` → mergeado (`e323850`) | 2026-08-26. Verificado contra 100 pedidos reales (1% con diferencia real). |
| Fase 3 — Nota del pedido visible | ✅ **Desplegado** | `prep-notas-pedido` → mergeado (`1418833`) | 2026-08-26. ML sin campo equivalente, confirmado contra API real. |
| Correcciones del revisor (retroactivo) | ✅ **Desplegado** | `6879410` | Migración `.sql`, `api-contrato.md`, focus trap del modal, transacción anidada. Re-revisado sin hallazgos nuevos. |
| Auditor-despliegue | 🟡 **Sin cerrar** | — | El agente se trabó esperando su propia corrida de tests y no emitió veredicto 🟢/🔴. Retomar. |
| Fase 4 — Unificar pedidos del mismo comprador | ⬜ Pendiente | — | Hay evidencia real: 3 clusters de pedidos duplicados (mismo domicilio/teléfono) en la muestra de 40. |
| Fase 5 — Horarios de corte y cola de despacho | ⬜ Pendiente | — | — |
| Fase 6 — Etiqueta interna + control de despacho | ⬜ Pendiente | — | Depende de Fase 5 (fecha_despacho) y Fase 4 (vínculos). |

## Pendiente de cobertura E2E

`probador-e2e` no llegó a cubrir 768px ni el modal de direcciones específicamente en 390px
(cubrió el resto de responsive en 390px). Cubrir cuando se retome el auditor o en el próximo
despacho de e2e.

## Regla operativa (agregada 2026-08-26, pedido explícito del usuario)

Todo cambio de código en este repo pasa por el pipeline `hard-worker → revisor →
tester/probador-e2e → auditor-despliegue` antes de darse por cerrado. No autoevaluarse. Ver
`agents/model-routing.md` y `.claude/agents/*.md` para la especificación de cada rol.
