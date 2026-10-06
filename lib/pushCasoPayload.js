/**
 * Carga de la notificación push de un caso de la bandeja (E6, tarea 3).
 *
 * La push es un AVISO, no una fuente de verdad: lleva identificadores opacos y el teléfono
 * pide el detalle fresco antes de mostrar o habilitar nada. De ahí las dos reglas que
 * gobiernan este módulo:
 *
 * 1. Carga mínima. No viaja el cuerpo de la conversación, ni el nombre del cliente, ni la
 *    foto, ni los permisos. Una push se muestra en la pantalla bloqueada de un teléfono que
 *    puede estar sobre una mesa: lo que va adentro lo ve cualquiera que pase. Además queda
 *    en los servidores del proveedor, que no son nuestros.
 * 2. La categoría la elige el backend, y tiene que ser una de las que la app registró al
 *    arrancar. iOS resuelve la categoría por identificador: si el backend manda una que la
 *    app no conoce, la notificación llega SIN botones y nadie se entera de por qué.
 *
 * Los identificadores de acá y los de `src/notifications/notificationSetup.ts` en la App son
 * el mismo conjunto y se mueven juntos.
 */

export const CATEGORIA_PREGUNTA = 'question_reply';
export const CATEGORIA_CONVERSACION = 'conversation_reply';
export const CATEGORIA_RECLAMO = 'claim_open';
export const CATEGORIA_SISTEMA = 'system_open';

/** Tipo de caso de la bandeja → categoría iOS. Lo desconocido cae en sistema, sin acciones. */
const CATEGORIA_POR_TIPO = {
  pregunta: CATEGORIA_PREGUNTA,
  mensaje: CATEGORIA_CONVERSACION,
  reclamo: CATEGORIA_RECLAMO,
};

/** Segmento de la ruta por tipo. Sin esto el deep link no dice qué pantalla abrir. */
const SEGMENTO_POR_TIPO = {
  pregunta: 'questions',
  mensaje: 'conversations',
  reclamo: 'claims',
};

export function categoriaDeCaso(kind) {
  return CATEGORIA_POR_TIPO[kind] || CATEGORIA_SISTEMA;
}

/**
 * Deep link tipado: `inbox/<tipo>/<inbox_id>`.
 *
 * El tipo va en la ruta para que la app monte la pantalla correcta sin una ida y vuelta
 * previa. El identificador es el del caso de la bandeja, no el de Mercado Libre: es la clave
 * del contrato (`/api/v1/inbox/:id/detail`) y no revela nada del recurso externo.
 */
export function deepLinkDeCaso(kind, inboxId) {
  const segmento = SEGMENTO_POR_TIPO[kind];
  return segmento ? `inbox/${segmento}/${inboxId}` : `inbox/${inboxId}`;
}

/**
 * `time-sensitive` atraviesa el modo concentración; el resto no. Se reserva para lo urgente
 * de verdad: si todo es time-sensitive, la persona apaga las notificaciones y se pierde todo.
 */
function nivelDeInterrupcion(severidad) {
  return severidad === 'urgente' ? 'time-sensitive' : 'active';
}

/** Título por tipo. Genérico a propósito: describe la clase de trabajo, no el caso. */
const TITULO_POR_TIPO = {
  pregunta: 'Nueva pregunta',
  mensaje: 'Mensaje de un cliente',
  reclamo: 'Reclamo de un cliente',
};

/**
 * Arma la carga. `item` es una fila de `inbox_items`.
 *
 * El cuerpo NO lleva el texto del cliente. Lleva de qué publicación o pedido se trata, que
 * alcanza para decidir si vale la pena abrir y no expone la conversación en la pantalla
 * bloqueada.
 */
export function payloadDeCaso(item, opciones = {}) {
  const kind = item.kind || 'otro';
  const severidad = item.severidad || item.priority || 'normal';
  const referencia = item.item_id || item.order_id || item.pack_id || null;

  return {
    titulo: TITULO_POR_TIPO[kind] || 'Trabajo pendiente',
    cuerpo: referencia ? `Sobre ${referencia}` : 'Tocá para ver el caso',
    // Datos: solo identificadores y enrutamiento. Nada de contenido ni de permisos.
    inbox_id: String(item.inbox_id),
    case_type: kind,
    resource_id: item.resource_id == null ? '' : String(item.resource_id),
    deep_link: deepLinkDeCaso(kind, item.inbox_id),
    event_id: item.event_id || `inbox-${item.inbox_id}`,
    categoryId: categoriaDeCaso(kind),
    interruptionLevel: nivelDeInterrupcion(severidad),
    severidad,
    // Marca que esto es una repetición del reloj de escalamiento y no un caso nuevo: sin
    // esto la persona no distingue "otro reclamo" de "el mismo que no atendiste".
    repeticion: opciones.repeticion === true ? '1' : '0',
    escalado: opciones.escalado === true ? '1' : '0',
  };
}
