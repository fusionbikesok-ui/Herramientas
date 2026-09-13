# GP6: Despachos, agrupación y evidencia

**Estado:** publicada  
**Superficie:** Gestión de envíos / VPS  
**Dependencia:** GP5 publicada

## Objetivo

Permitir que los pedidos preparados se agrupen en despachos, se embalen y se registren con tracking externo y evidencia fotográfica, manteniendo separado el trabajo de preparación de la salida física.

## Alcance inicial

- Cola de pedidos `listos para despachar` proveniente de preparaciones completas.
- Creación de un despacho con uno o más pedidos compatibles.
- Validación de que un pedido no pertenezca a dos despachos activos.
- Escaneo del código interno y del tracking por el preparador/embalador.
- Fotos de paquete y evidencia asociadas al despacho.
- Cierre auditable del despacho y estado individual de cada pedido.
- Sin carga de tracking a MercadoLibre; el tracking se registra localmente y se conserva el canal correspondiente.

## Criterios de aceptación

- No se puede agrupar una preparación incompleta o con evidencia obligatoria faltante.
- Un despacho abierto puede retomarse después de salir de la pantalla.
- Tracking duplicado o perteneciente a otro despacho se rechaza.
- El despachador sólo recibe paquetes cerrados y evidenciados.
- Todas las transiciones registran actor, hora y motivo cuando corresponda.
- Suite completa sólo al cerrar GP6.

## Evidencia previa al gate 2026-09-09

- La cola y los lotes de despacho ya existen en `routes/preparacion.js`.
- Las pruebas focalizadas cubren creación idempotente, agrupación por canal, escaneo, tracking, conflictos, cierre, salida y anulación.
- La suite focalizada de preparación quedó en `225/225` verdes.
- No se carga tracking en MercadoLibre: el endpoint devuelve `TRACKING_NO_APLICA`.
- Los eventos de lote conservan actor, hora y detalle.

## Gate ejecutado 2026-09-09

Suite completa ejecutada al cerrar la entrega:

- `128` archivos pasaron.
- `2408` tests pasaron.
- `51` tests quedaron omitidos.
- Duración: `2179,58 s`.

Resultado: **verde**. GP6 queda publicada y habilita GP7.
