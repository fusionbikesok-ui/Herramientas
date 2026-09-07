/**
 * Detalle operativo de un caso de la bandeja (E6).
 *
 * La push lleva identificadores opacos y no es fuente de verdad: la app pide este detalle
 * antes de mostrar nada o de habilitar una acción. Por eso acá se resuelve contra la
 * proyección local del recurso externo y se decide qué sigue permitido.
 *
 * Las acciones NO se infieren en la app desde el tipo o la prioridad: se derivan del estado
 * externo y viajan explícitas. Así, un caso que Mercado Libre ya cerró deja de ofrecer
 * acciones aunque la notificación siga en el teléfono.
 */

/** Estados de pregunta en los que todavía se puede responder. */
const PREGUNTA_ABIERTA = new Set(['UNANSWERED']);

/** Estados de reclamo que dan por terminado el caso. */
const RECLAMO_CERRADO = new Set(['closed', 'cancelled', 'resolved']);

/**
 * Acciones que jamás se ofrecen como acción rápida desde una notificación.
 * Mueven dinero o cierran una disputa: van dentro del detalle y con confirmación explícita.
 */
const NUNCA_RAPIDAS = new Set(['refund', 'return', 'mediation']);

function preguntaDe(db, item) {
  // `ml_preguntas.id` es entero y `resource_id` viaja como texto.
  const id = Number(item.resource_id);
  if (!Number.isSafeInteger(id)) return null;
  return db.prepare('SELECT id, item_id, texto, estado, fecha_creacion, respondida_en FROM ml_preguntas WHERE id = ?').get(id) || null;
}

function reclamoDe(db, item) {
  return db.prepare('SELECT id, recurso, estado, titulo, detalle, type, reason_id, resource_id, fecha_creacion, cerrado_en FROM ml_reclamos WHERE id = ?')
    .get(String(item.resource_id)) || null;
}

function conversacionDe(db, item) {
  if (!item.conversation_id) return null;
  const conversacion = db.prepare('SELECT conversation_id, channel, external_thread_id, subject, status FROM conversations WHERE conversation_id = ?')
    .get(item.conversation_id);
  if (!conversacion) return null;
  // Solo lo necesario para entender el hilo. El payload crudo del proveedor no sale de acá.
  const mensajes = db.prepare(`SELECT message_id, direction, body, occurred_at, created_at
    FROM conversation_messages WHERE conversation_id = ? ORDER BY message_id`).all(item.conversation_id);
  return { conversacion, mensajes };
}

function accionesDePregunta(pregunta, estadoExterno) {
  const estado = estadoExterno || pregunta?.estado;
  return PREGUNTA_ABIERTA.has(estado) ? ['reply'] : [];
}

function accionesDeReclamo(reclamo, estadoExterno) {
  const estado = estadoExterno || reclamo?.estado;
  if (!estado || RECLAMO_CERRADO.has(estado)) return [];
  // Enviar un mensaje es lo único seguro sin confirmación: no mueve dinero ni cierra nada.
  return ['message'];
}

function accionesDeConversacion(datos, estadoExterno) {
  const estado = estadoExterno || datos?.conversacion?.status;
  if (!estado || estado === 'resolved' || estado === 'archived') return [];
  return ['reply'];
}

/**
 * Arma el detalle. Devuelve `null` si el caso no existe o no es de esta persona; quien
 * llama responde 404 en ambos casos, para no revelar la existencia de un caso ajeno.
 */
export function detalleDeCaso(db, inboxId, userId) {
  const item = db.prepare(`SELECT * FROM inbox_items
    WHERE inbox_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = ?)`).get(Number(inboxId), userId);
  if (!item) return null;

  const base = {
    id: String(item.inbox_id),
    kind: item.kind || 'otro',
    channel: item.channel,
    title: item.title,
    preview: item.preview,
    status: item.status,
    priority: item.priority || 'normal',
    version: item.version,
    external_id: item.resource_id == null ? null : String(item.resource_id),
    external_status: item.external_status || null,
    last_synced_at: item.last_synced_at || null,
    order_id: item.order_id || null,
    pack_id: item.pack_id || null,
    acknowledged_at: item.acknowledged_at || null,
    assigned_user_id: item.assigned_user_id || null,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };

  let acciones = [];

  if (base.kind === 'pregunta') {
    const pregunta = preguntaDe(db, item);
    base.producto = { item_id: item.item_id || pregunta?.item_id || null };
    base.pregunta = pregunta
      ? { texto: pregunta.texto, creada_en: pregunta.fecha_creacion, respondida_en: pregunta.respondida_en }
      : null;
    if (!base.external_status && pregunta?.estado) base.external_status = pregunta.estado;
    acciones = accionesDePregunta(pregunta, item.external_status);
  } else if (base.kind === 'reclamo') {
    const reclamo = reclamoDe(db, item);
    base.producto = { item_id: item.item_id || null };
    base.reclamo = reclamo
      ? {
        titulo: reclamo.titulo,
        detalle: reclamo.detalle,
        tipo: reclamo.type || null,
        motivo: reclamo.reason_id || null,
        recurso: reclamo.recurso || null,
        creado_en: reclamo.fecha_creacion,
        cerrado_en: reclamo.cerrado_en,
      }
      : null;
    if (!base.external_status && reclamo?.estado) base.external_status = reclamo.estado;
    acciones = accionesDeReclamo(reclamo, item.external_status);
  } else if (base.kind === 'mensaje') {
    const datos = conversacionDe(db, item);
    base.producto = { item_id: item.item_id || null };
    base.conversacion = datos
      ? { estado: datos.conversacion.status, asunto: datos.conversacion.subject, mensajes: datos.mensajes }
      : null;
    if (!base.external_status && datos?.conversacion?.status) base.external_status = datos.conversacion.status;
    acciones = accionesDeConversacion(datos, item.external_status);
  }

  base.available_actions = acciones;
  // Lo que se puede ofrecer desde la notificación es un subconjunto: nunca lo económico.
  base.quick_actions = acciones.filter((accion) => !NUNCA_RAPIDAS.has(accion));
  return base;
}
