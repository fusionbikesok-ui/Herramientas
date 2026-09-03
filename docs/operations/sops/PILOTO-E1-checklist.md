# Piloto E1 — checklist de validación operativa

Código: PILOTO-E1 · Versión: 0.1 · Estado: pendiente de ejecución

Esta checklist prepara una jornada controlada. No sustituye la aceptación del responsable ni autoriza despliegue.

## Prevalidación sintética reproducible

Ejecutar desde `/opt/fusionbikes/herramientas`, sin cargar credenciales ni datos reales:

```bash
npm run e1:demo
npx vitest run test/jornada.test.js test/preparacion-render.test.js --reporter=dot --no-file-parallelism --testTimeout=30000
```

Registrar la salida completa sanitizada. La prevalidación solo habilita la práctica guiada; no cambia el estado de la entrega. Debe informar `ok:true` en la demo y **74/74** en la suite dirigida, o dejar asentada la diferencia antes de continuar.

## Preparación

- Fecha y turno: ____________________
- Responsable: ____________________
- Supervisor: ____________________
- Flag/entorno: ____________________
- Base y commit probado: ____________________
- Hora de apertura confirmada en Buenos Aires: ____________________
- Integraciones y agente de impresión revisados: sí / no / no aplica

## Casos mínimos

| Caso | Resultado esperado | Evidencia | Resultado |
|---|---|---|---|
| Pedido web antes de 15:00 | Entra a preparación y conserva el límite | | pendiente |
| ML con límite individual | Límite interno = externo menos 30 min | | pendiente |
| Flex | Límite de salida 17:00 | | pendiente |
| Pedido nuevo durante ola | Mini-ola sin alterar lo ya recogido | | pendiente |
| ML dentro de 30 min | Mini-ola urgente congelada | | pendiente |
| ML vencido | Sigue urgente hasta resolver o diferir explícitamente | | pendiente |
| Doble toque/recarga | No duplica ni pierde estado | | pendiente |
| Pedido retenido | Visible, no pickeable y escalado | | pendiente |
| SLA sin hora | Diferido con motivo, sin inventar horario | | pendiente |
| Cierre | Pendientes y alertas quedan visibles para la próxima jornada | | pendiente |

## Observación de jornada

- Inicio/fin de observación: ____________________
- Pedidos procesados: ______
- Mini-olas creadas: ______
- Alertas no reconocidas: ______
- Errores recuperables: ______
- Pedidos diferidos y motivo: ____________________
- Interrupciones o pérdida de estado: ____________________
- Tiempo de reconocimiento de urgentes: ____________________

## Criterio de salida

No aceptar si existe pérdida/duplicación de pedido, SLA incorrecto, estado oculto, acción no idempotente o alerta urgente sin trazabilidad. Registrar cada hallazgo con pedido de prueba, hora, actor y captura sanitizada.

## Firmas

- Operario: ____________________ Fecha: __________
- Supervisor: ____________________ Fecha: __________
- Responsable del proceso: ____________________ Fecha: __________
