# Piloto E4 — lotes y despacho

Checklist para una prueba acotada, sin declarar aceptación ni mezclarla con el
despacho general. Ejecutar únicamente con autorización del responsable de
depósito y con rollback preparado.

## Preparación

- [ ] Confirmar fecha de jornada, canales incluidos y responsable del piloto.
- [ ] Seleccionar 2–5 pedidos reales ya preparados y aprobados, o pedidos
      sintéticos en un entorno aislado.
- [ ] Verificar que cada paquete tenga un control de despacho único.
- [ ] Confirmar que la hoja ML y la hoja Andreani/Web estén separadas.
- [ ] Confirmar conexión y credenciales de Woo en el entorno de prueba; no usar
      credenciales de producción en una demo.
- [ ] Registrar estado inicial: lote, paquete, tracking, estado Woo y jobs.

## Ejecución

- [ ] Crear un lote ML y un lote Web/Andreani separados.
- [ ] Verificar que iniciar un lote congele sus miembros.
- [ ] Intentar agregar un paquete ya asignado y confirmar rechazo sin duplicado.
- [ ] Escanear un código ajeno y confirmar rechazo visible.
- [ ] Escanear un paquete válido dos veces y confirmar una sola mutación.
- [ ] Asociar tracking; repetir el mismo tracking y rechazar un tracking distinto.
- [ ] Cerrar un lote completo y confirmar todos los eventos esperados.
- [ ] Confirmar salida física una sola vez y verificar que se cree un único job
      `dispatch.woo`.
- [ ] Consultar auditoría con supervisor/auditor y confirmar actor, hora y
      detalle; verificar que un operario sin permiso reciba 403.

## Fallos controlados

- [ ] Intentar cerrar con un paquete pendiente y confirmar bloqueo o motivo
      excepcional explícito.
- [ ] Simular Woo caído y confirmar reintento durable; al agotar intentos,
      confirmar `dead_lettered` y alerta accionable.
- [ ] Recargar la pantalla durante el ciclo y confirmar que el lote conserve su
      estado y miembros.

## Cierre y rollback

- [ ] Comparar esperados, escaneados, tracking, salida y jobs con el registro
      inicial.
- [ ] Confirmar que no existan paquetes ajenos, duplicados ni estados parciales
      sin explicación.
- [ ] Si falla un gate, anular el lote con motivo y conservar los eventos.
- [ ] Registrar hallazgos, tiempos, capturas sin PII y próxima acción.
- [ ] No publicar ni ampliar el flag sin revisión independiente.

## Criterio de resultado

`aprobado para observación` requiere todos los checks críticos, cero
duplicados, auditoría íntegra y reconciliación de Woo. Una falla de integración
o hardware mantiene E4 en desarrollo; no se corrige editando estados a mano.

## Evidencia aislada

- Ejecutado el 2026-09-03 con `npm run e2e:e4`.
- Resultado: lotes ML/Web separados, escaneo idempotente, tracking, cierre,
  salida y auditoría: **OK**.
- Alcance: base temporal y pedidos sintéticos; no prueba Woo ni transportista
  reales y no equivale a publicación, observación o aceptación.
