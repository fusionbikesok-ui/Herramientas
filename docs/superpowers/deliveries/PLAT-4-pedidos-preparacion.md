# P4 — Pedidos y preparación

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md` (§3.5, §6, §7). Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada — ficha de orientación, no especificación decision-complete.** Requiere plan propio aprobado antes de iniciar.
- Objetivo: orden canónica en el núcleo con espejo ML→Woo, asignaciones, prioridad ML, picking, empaque verificado y despacho. Absorbe E1, E2, E4, E12, la línea GP y la retención de ventas de Guardia ML.
- Comportamiento crítico que el plan de P4 debe fijar y probar:
  - **Webhooks durables:** se guardan antes de responder; se relee el recurso remoto; duplicados, desorden y reintentos no crean efectos dobles.
  - **Espejo Woo sin segunda reserva:** toda venta ML crea una orden espejo Woo correlacionada e idempotente; la reserva vive sólo en el libro de P3. Precio de línea según la regla vigente (precio de contado de la web, nunca el de ML) y el pedido espejo no se modifica después salvo cancelación o nota privada.
  - **Prioridad ML hasta `dispatch_confirmed`:** una venta ML paga desplaza pedidos Woo/locales no despachados.
  - **Pedido desplazado → retenido, nunca cancelado ni reintegrado automáticamente:** se libera su asignación, se bloquean preparación y salida, y se abre una incidencia con aviso.
  - **Cancelación verificada:** la reserva se libera sólo después de verificar el estado remoto.
  - **Devoluciones en cuarentena:** no vuelven a disponible hasta clasificación humana.
  - **`packed_verified` y `dispatch_confirmed` son eventos distintos;** al despachar, la reserva se convierte en salida sin volver a cambiar el disponible.
  - **Línea GP:**
    - GP13 = editar datos del pedido;
    - GP14 = editar productos del pedido;
    - **GP15 = cálculo económico del pedido** (cuotas, reintegros y su efecto en el total). **No** es sincronización de precios de catálogo ni de ML, que quedan fuera de este programa (plan §8).
  - **Retención de ventas:** reemplaza el comportamiento del legado entregado el 2026-09-13 (liberación automática al resolver el bloqueo, aviso push/panel y recordatorio único a las 2 h) sin perder ninguna de esas garantías.
- Responsable operativo: José. Técnico: asistente.
- Base, rama y worktree: `plataforma/`, rama por subentrega; se fija en el plan de P4.
- Feature flags y piloto: se fijan en el plan de P4 (canario por cuenta de canal y tipo de envío).

## Subentregas (un único corte final de la vertical)

1. **P4.1 Esquema:** orden canónica, estados separados (pedido, pago, asignación, picking, empaque, despacho, entrega, cancelación, devolución) y restricciones.
2. **P4.2 Importación:** pedidos abiertos y en preparación desde el legado, con crosswalk y hashes.
3. **P4.3 Dominio:** ingesta de webhooks, espejo Woo, prioridad, desplazamiento y retención, cancelación verificada, devoluciones, GP13–GP15.
4. **P4.4 UI:** gestión de pedidos, preparación y despacho sobre API v2; la App migra pantalla por pantalla por OTA.
5. **P4.5 Sombra:** órdenes y estados del núcleo comparados contra el legado sin crear espejos.
6. **P4.6 Simulación:** ventas simultáneas, desplazamientos, cancelaciones y fallos remotos en QA con el simulador.
7. **P4.7 Campaña correctiva:** pedidos trabados, reservas retenidas y diferencias detectadas en sombra.
8. **P4.8 Cutover:** congelar escritores legacy de pedidos y preparación, delta final, conciliación exacta, único ejecutor remoto, canario y ampliación.

## Gates y aceptación propios

- Gates del programa más §20 del maestro.
- 0 pedidos espejo duplicados en simulación y sombra; 0 segundas reservas.
- Desplazamiento probado: pedido local retenido, sin cancelación ni reintegro automático, con aviso < 2 min.
- `/api/v1/meta` compatible con la App en cada paso (PM-162).

## Métricas, SOP y riesgos

- Métricas: tiempo venta→espejo Woo, pedidos retenidos y su antigüedad, desplazamientos, cancelaciones verificadas, devoluciones en cuarentena.
- SOP: pedido desplazado, devolución, cancelación con verificación remota, reversión del corte.
- Riesgos: duplicar pedidos Woo en la ventana del corte (reserva idempotente y un solo ejecutor); romper la App (fachada `/api/v1` y OTA por pantalla).

## Evidencia técnica

- Commits integrados y candidatos: ninguno
- Migraciones, compatibilidad, backup y restauración: no ejecutado
- Tests exactos y resultado: no ejecutado
- Revisión independiente, E2E y auditoría de despliegue: no ejecutado

## Evidencia operativa

- Piloto, jornada observada y aceptación: no ejecutado

## Continuidad

- Estado externo relevante: No iniciado. Medido 2026-09-13: 0 ventas retenidas por Guardia ML; 2.156 pedidos en gestión de pedidos; 294 preparaciones.
- Consultas para refrescar cifras (solo lectura):
  - `SELECT estado, COUNT(*) FROM guardia_ml_pedidos_retenidos GROUP BY estado;`
  - `SELECT estado_operativo, COUNT(*) FROM gestion_pedidos GROUP BY estado_operativo;`
  - `SELECT estado, COUNT(*) FROM preparaciones GROUP BY estado;`
- Próxima acción exacta y reproducible: con P3 aceptado, escribir `docs/superpowers/plans/AAAA-MM-DD-p4-pedidos-preparacion.md` con cada comportamiento crítico y las subentregas P4.1–P4.8, y pedir aprobación a José.
- Confirmación: sin secretos ni datos personales.
