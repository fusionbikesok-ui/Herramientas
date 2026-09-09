# GP6: Despachos, agrupación y evidencia

**Estado:** desarrollo  
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

## Gate

Se validará con datos genéricos y una muestra controlada: seleccionar pedidos listos, agrupar, escanear códigos, cargar tracking externo, fotografiar paquete, cerrar y reabrir el despacho. Si la suite completa queda verde, se publica GP6 y se avanza a GP7.
