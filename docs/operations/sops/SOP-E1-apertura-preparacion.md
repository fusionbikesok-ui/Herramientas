# SOP-E1: Apertura, olas y preparación diaria

Código: SOP-E1 · Versión: 0.1 · Vigencia: borrador · Dueño: Supervisor de depósito · Entrega: E1

## Propósito

Abrir la jornada, confirmar los límites de despacho y preparar pedidos sin perder pedidos nuevos, prioridad ML ni evidencia de estado.

## Roles y permisos

- Operario: consulta tareas, reclama una ola, prepara y registra avances.
- Despacho: consulta paquetes aprobados y confirma la salida física.
- Supervisor: resuelve claims, retenciones, reasignaciones y excepciones.

## Antes de empezar

- [ ] Confirmar fecha y hora en `America/Argentina/Buenos_Aires`.
- [ ] Abrir la jornada desde el panel; las reglas de horario son del servidor.
- [ ] Revisar el preflight de integraciones, pendientes y agente de impresión.
- [ ] Verificar que la impresora y el puesto de trabajo estén disponibles.
- [ ] Revisar pedidos arrastrados y alertas sin resolver.

## Reglas de despacho

- Web: límite normal de preparación 15:00.
- MercadoLibre/Andreani: el límite externo es la entrega al centro de despacho; el límite interno es 30 minutos anterior y puede cambiar por paquete.
- Flex: salida máxima 17:00 para permitir el regreso del transporte antes del cierre de las 19:00.
- Sin hora SLA confirmada: no adivinar; dejar diferido, visible y con motivo.
- Fuera de ventana: preparar solo si el supervisor lo autoriza; dejar fecha, motivo y auditoría para el siguiente día.

## Flujo normal

1. Abrir la jornada y confirmar las reglas mostradas.
2. Reclamar la ola inicial. Al congelarla, sus integrantes no cambian.
3. Preparar cada pedido y persistir cada acción inmediatamente.
4. Los pedidos nuevos entran en mini-olas; un ML cuyo límite vence o venció dentro de la ventana urgente se separa en mini-ola prioritaria.
5. Si el pedido está retenido, no pickearlo: mantenerlo visible y escalarlo.
6. Completar evidencia y aprobar la preparación según el SOP de fotos vigente.
7. Dejar el paquete en “listo para despacho”; la etiqueta interna se procesa por su cola independiente.
8. Al cierre, el supervisor revisa pendientes, diferidos y alertas; no se borran ni se ocultan.

## Excepciones y recuperación

- Doble toque o recarga: repetir la acción debe ser idempotente y conservar el estado del servidor.
- Pedido nuevo durante picking: no altera cantidades ya recogidas; genera mini-ola.
- Última unidad para ML urgente: reasignar con auditoría; reabrir preparación web afectada.
- SLA vencido: mantener prioridad urgente hasta resolución o diferimiento explícito.
- Red caída: no confirmar estados finales que requieran servidor; conservar la tarea y reintentar según la contingencia autorizada.
- Claim sin reconocimiento: aviso a 10 minutos y liberación a 15 minutos.

## Cierre y auditoría

Registrar actor, hora, pedido/ola, motivo de diferimiento, cambios de asignación y errores recuperables. No incluir PII en capturas o etiquetas más allá de lo necesario para operar.

## Práctica y aceptación

- Fecha de práctica: pendiente.
- Participantes: pendiente.
- Evidencia de piloto: pendiente.
- Aceptación del responsable: pendiente.

Este documento es un borrador operativo de E1: no autoriza despliegue ni reemplaza la validación en una jornada real.
