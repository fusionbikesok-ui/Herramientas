# P3 — Stock

Programa: `/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-13-plataforma-auditable-catalogo-identidad-stock-pedidos.md` (§3.4, §6, §7). Orden vigente: §19.0 del plan maestro.

## Identidad

- Entrega / estado: **planificada — ficha de orientación, no especificación decision-complete.** Requiere plan propio aprobado antes de iniciar.
- Objetivo: libro de stock append-only como autoridad, con **recepción y conteos como escritores del libro** (PM-161). Absorbe E8, E9 (ubicaciones), E10, E11, E14 y E16, incluida la corrección de conteos con auditoría (spec 2026-09-11) como ajustes del libro.
- Invariantes que el plan de P3 debe hacer cumplir (en base, no sólo en código):
  - **Libro append-only:** movimientos, ubicaciones, conteos, ajustes, reservas, asignaciones, retenciones y salidas; ninguna cantidad se sobrescribe sin movimiento causal.
  - **Disponible = existencia − reservas − retenciones.**
  - **Reserva al aprobar el pago**, nunca antes.
  - **Sin doble descuento Woo/Fusion:** durante la transición no restar pedidos que Woo ya descontó; al transferir autoridad, Woo pasa a ser proyección del libro.
  - **Disminuciones fail-safe:** se ejecutan primero y ante duda se baja o pausa.
  - **Aumentos fail-closed:** bloqueados hasta confirmar identidad, saldo, reservas y observación remota fresca.
  - **Packs y kits:** stock publicado ajustado por la composición versionada.
  - **Agrupación `user_product`:** publicaciones que comparten bolsa se escriben como un solo recurso remoto (causa del bucle de reactivaciones jul–sep 2026).
  - **Múltiples publicaciones por variante:** se expone el stock completo en cada una aceptando la ventana de sobreventa declarada.
  - **Alerta de sobreventa < 2 minutos** con push, panel y email, acuse y escalamiento.
  - Apertura provisional desde Woo; los conteos físicos certifican progresivamente cada variante.
- Responsable operativo: José. Técnico: asistente.
- Base, rama y worktree: `plataforma/`, rama por subentrega; se fija en el plan de P3.
- Feature flags y piloto: se fijan en el plan de P3 (canario por SKU/cuenta).

## Subentregas (un único corte final de la vertical)

1. **P3.1 Esquema:** libro, ubicaciones, reservas y restricciones; tests de invariantes y concurrencia.
2. **P3.2 Importación:** apertura provisional desde Woo y pedidos pagados abiertos, con crosswalk y hashes.
3. **P3.3 Dominio:** reglas de reserva, retención, salida, disminución/aumento, packs y agrupación `user_product`.
4. **P3.4 UI:** recepción, conteo y corrección auditada como escritores del libro (responsive, WCAG 2.2 AA).
5. **P3.5 Sombra:** proyección del libro comparada contra Woo y ML sin escribir.
6. **P3.6 Simulación:** ventas simultáneas, bolsas compartidas, packs y fallos remotos en QA.
7. **P3.7 Campaña correctiva:** diferencias de apertura, ubicaciones sin mapear, bolsas en conflicto.
8. **P3.8 Cutover:** congelar escritores legacy de stock (sync, recepción, conteos), delta final, conciliación exacta, único ejecutor remoto, canario y ampliación.

## Gates y aceptación propios

- Gates del programa más §20 del maestro.
- Proyección del libro = stock Woo por variante al corte (diferencias cero o explicadas y ajustadas con movimiento causal).
- Tests de concurrencia de reservas y de doble descuento en verde.
- Alerta de sobreventa medida < 2 min en QA con el simulador.
- Recepción y conteos ya no escriben en Woo después del corte.

## Métricas, SOP y riesgos

- Métricas: variantes certificadas por conteo, diferencias proyección vs. Woo, aumentos bloqueados, alertas de sobreventa y tiempo a acuse.
- SOP: conteo y corrección, apertura de variante nueva, respuesta a alerta de sobreventa, reversión del corte.
- Riesgos: doble descuento en la ventana de transición; apertura provisional con errores de Woo (mitigar certificando por conteo antes de ampliar).

## Evidencia técnica

- Commits integrados y candidatos: ninguno
- Migraciones, compatibilidad, backup y restauración: no ejecutado
- Tests exactos y resultado: no ejecutado
- Revisión independiente, E2E y auditoría de despliegue: no ejecutado

## Evidencia operativa

- Piloto, jornada observada y aceptación: no ejecutado

## Continuidad

- Estado externo relevante: No iniciado. Medido 2026-09-13: 0 movimientos en el libro legacy, 1 producto con ubicación mapeada, 0 conflictos de bolsa compartida.
- Consultas para refrescar cifras (solo lectura):
  - `SELECT COUNT(*) FROM stock_movements;`
  - `SELECT COUNT(*) FROM producto_ubicacion;`
  - `SELECT COUNT(*) FROM inventario_sesiones WHERE estado='confirmada';`
- Próxima acción exacta y reproducible: con P2 aceptado, escribir `docs/superpowers/plans/AAAA-MM-DD-p3-stock.md` con cada invariante y las subentregas P3.1–P3.8, y pedir aprobación a José.
- Confirmación: sin secretos ni datos personales.
