# GP7: Recuperar ventas

**Estado:** publicada  
**Superficie:** Gestión de pedidos / Home  
**Dependencia:** GP3 y GP4 publicadas

## Objetivo

Dar prioridad operativa a oportunidades de recuperación sin borrar pedidos cancelados ni mezclar esta vista con los pedidos activos.

## Alcance

- Cancelados de WooCommerce y MercadoLibre dentro del plazo vigente.
- Carritos abandonados provenientes del plugin disponible en WooCommerce.
- Vigencia hasta el cierre del día hábil siguiente al pedido o abandono.
- Distinción visible entre “cierra hoy” y “cierra mañana”, usando el calendario de la tienda.
- Consolidación por cliente para no mostrar múltiples fallidos cuando ya existe una compra exitosa o varias oportunidades de la misma persona.
- Botón WhatsApp: copia únicamente el teléfono normalizado de Argentina, sin `+54`.
- Botón Email: abre un recuadro con destinatario, asunto y cuerpo copiable, incluyendo el contenido del carrito/pedido.
- Plantillas rotativas y genéricas para iniciar la conversación.
- Botón separado “Marcar como contactado”; el clic en WhatsApp o Email no marca automáticamente el contacto.
- Auditoría de si nunca fue contactado, quién lo marcó, fecha, hora y canal.
- Al concretarse una compra exitosa, la oportunidad sale de esta vista; el pedido cancelado y los intentos permanecen en el historial.

## Fuera de alcance

- Borrar o modificar el pedido cancelado original.
- Guardar por ahora el motivo de cancelación.
- Enviar mensajes automáticamente.
- Mostrar la vista de recuperación dentro de “Requieren atención”.

## Entregas internas

1. Consulta unificada de cancelados y carritos abandonados.
2. Regla de fecha hábil y vencimiento.
3. Consolidación por cliente y ocultamiento de oportunidades ya recuperadas.
4. Acciones manuales WhatsApp, Email y registro explícito de contacto.
5. Preview con datos genéricos y estados de auditoría.

## Criterios de aceptación

- La vista sólo muestra oportunidades vigentes y no elimina datos históricos.
- Un pedido exitoso del mismo cliente oculta sus fallidos de Recuperar ventas.
- El vencimiento se calcula hasta el cierre del día hábil siguiente, no como 24 horas corridas.
- WhatsApp y Email preparan/copían datos, pero nunca registran contacto por sí solos.
- “Marcar como contactado” exige canal y registra usuario, fecha y hora.
- Suite focalizada verde antes del gate.
- Suite completa sólo al cerrar GP7; si queda verde, se publica GP7 y se abre GP8.

## Gate

Entregas internas completadas. Evidencia focalizada:

- `test/gestionPedidosRoute.test.js`: 11/11 verdes.
- Smoke de preview: login, listado, Recuperar ventas, detalle y render sin errores.
- Acciones reales conectadas a la API, sin registrar contacto al preparar/copiarlos.

Suite completa ejecutada al cerrar GP7:

- `128` archivos pasaron.
- `2411` tests pasaron.
- `51` tests quedaron omitidos.
- Duración: `2084,76 s`.

Resultado: **verde**. GP7 queda publicada y habilita GP8.
