/**
 * Detalle operativo de un caso de la bandeja (E6).
 *
 * La push lleva identificadores opacos y no es fuente de verdad: la app pide este detalle
 * antes de mostrar nada o de habilitar una acción.
 *
 * Las acciones NO se infieren en la app desde el tipo o la prioridad: viajan explícitas. Y
 * para reclamos NO se derivan del estado local: la fuente es Mercado Libre, que las publica
 * por rol dentro de `players[]` (ver `lib/mlAccionesCaso.js` y §4.2 de la especificación de
 * ML). Acá se sirve lo último proyectado junto con `last_synced_at`, para que la app pueda
 * mostrar la frescura; la revalidación contra ML en vivo ocurre al EJECUTAR la acción, no al
 * leer, para no gastar cuota de ML cada vez que alguien abre una pantalla.
 *
 * `available_actions` es tri-estado a propósito:
 *   - array  → ML (o el estado local, para lo que no es de ML) declaró estas acciones
 *   - `null` → desconocido; no se habilita ni se esconde un botón con este dato (§4.3)
 * `actions_source` dice cuál de los dos casos es, para que la app no tenga que adivinar.
 */

import { accionesRapidas, deserializarAcciones, vencimientoDeMl } from './mlAccionesCaso.js';

/** Estados de pregunta en los que todavía se puede responder. */
const PREGUNTA_ABIERTA = new Set(['UNANSWERED']);

/** Estados de reclamo que dan por terminado el caso. */
const RECLAMO_CERRADO = new Set(['closed', 'cancelled', 'resolved']);

function preguntaDe(db, item) {
  // `ml_preguntas.id` es entero y `resource_id` viaja como texto, a veces con prefijo.
  const id = Number(String(item.resource_id || '').replace(/^question:/, ''));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return db.prepare('SELECT id, item_id, texto, estado, fecha_creacion, respondida_en FROM ml_preguntas WHERE id = ?').get(id) || null;
}

function reclamoDe(db, item) {
  const id = String(item.resource_id || '').replace(/^claim:/, '');
  if (!id) return null;
  return db.prepare('SELECT id, recurso, estado, titulo, detalle, type, reason_id, resource_id, fecha_creacion, cerrado_en FROM ml_reclamos WHERE id = ?')
    .get(id) || null;
}

function conversacionDe(db, item) {
  if (!item.conversation_id) return null;
  const conversacion = db.prepare('SELECT conversation_id, channel, external_thread_id, subject, status FROM conversations WHERE conversation_id = ?')
    .get(item.conversation_id);
  if (!conversacion) return null;
  // Solo lo necesario para entender el hilo. El payload crudo del proveedor no sale de acá.
  const mensajes = db.prepare('SELECT message_id, direction, body, occurred_at, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY message_id')
    .all(item.conversation_id);
  return { conversacion, mensajes };
}

/** Envuelve una acción local en la misma forma que las de ML, para que la app tenga un solo tipo. */
const accionLocal = (nombre) => ({ action: nombre, mandatory: false, due_date: null });

/**
 * Para preguntas la regla SÍ es el estado: la especificación (§5.2) confirma que
 * `/questions/{id}` no devuelve `available_actions` y que `UNANSWERED` es lo que habilita
 * responder. No hay contradicción con §4.2, que es solo para reclamos.
 */
function accionesDePregunta(pregunta, estadoExterno) {
  const estado = estadoExterno || pregunta?.estado;
  if (!estado) return null;
  return PREGUNTA_ABIERTA.has(estado) ? [accionLocal('reply')] : [];
}

function accionesDeConversacion(datos, estadoExterno) {
  const estado = estadoExterno || datos?.conversacion?.status;
  if (!estado) return null;
  if (estado === 'resolved' || estado === 'archived' || estado === 'blocked') return [];
  return [accionLocal('reply')];
}

/**
 * Arma el detalle. Devuelve `null` si el caso no existe o no es de esta persona; quien
 * llama responde 404 en ambos casos, para no revelar la existencia de un caso ajeno.
 */
export function detalleDeCaso(db, inboxId, userId) {
  const id = Number(inboxId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const item = db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = ?)')
    .get(id, userId);
  if (!item) return null;

  const base = {
    id: String(item.inbox_id),
    kind: item.kind || 'otro',
    channel: item.channel,
    title: item.title,
    preview: item.preview,
    status: item.status,
    priority: item.priority || 'normal',
    severidad: item.severidad || item.priority || 'normal',
    version: item.version,
    external_id: item.resource_id == null ? null : String(item.resource_id),
    external_status: item.external_status || null,
    last_synced_at: item.last_synced_at || null,
    order_id: item.order_id || null,
    pack_id: item.pack_id || null,
    area: item.area || null,
    acknowledged_at: item.acknowledged_at || null,
    acknowledged_by: item.acknowledged_by == null ? null : String(item.acknowledged_by),
    assigned_user_id: item.assigned_user_id == null ? null : String(item.assigned_user_id),
    created_at: item.created_at,
    updated_at: item.updated_at,
  };

  let acciones = null;
  let fuente = 'unknown';
  let vence = null;

  if (base.kind === 'pregunta') {
    const pregunta = preguntaDe(db, item);
    base.producto = { item_id: item.item_id || pregunta?.item_id || null };
    base.pregunta = pregunta
      ? { texto: pregunta.texto, creada_en: pregunta.fecha_creacion, respondida_en: pregunta.respondida_en }
      : null;
    if (!base.external_status && pregunta?.estado) base.external_status = pregunta.estado;
    acciones = accionesDePregunta(pregunta, item.external_status);
    if (acciones) fuente = 'local_state';
  } else if (base.kind === 'reclamo') {
    const reclamo = reclamoDe(db, item);
    base.producto = { item_id: item.item_id || null };
    base.reclamo = reclamo
      ? {
        numero: String(reclamo.id),
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

    const estado = item.external_status || reclamo?.estado;
    if (estado && RECLAMO_CERRADO.has(estado)) {
      // Un caso que ML cerró no ofrece acciones, y eso SÍ se sabe con certeza.
      acciones = [];
      fuente = 'ml_closed';
    } else {
      // Lo proyectado desde `players[]`. Ausente o vacío ⇒ desconocido, nunca "ninguna".
      acciones = deserializarAcciones(item.external_actions);
      fuente = acciones ? 'ml' : 'unknown';
      vence = vencimientoDeMl(acciones);
    }
  } else if (base.kind === 'mensaje') {
    const datos = conversacionDe(db, item);
    base.producto = { item_id: item.item_id || null };
    base.conversacion = datos
      ? { estado: datos.conversacion.status, asunto: datos.conversacion.subject, mensajes: datos.mensajes }
      : null;
    if (!base.external_status && datos?.conversacion?.status) base.external_status = datos.conversacion.status;
    acciones = accionesDeConversacion(datos, item.external_status);
    if (acciones) fuente = 'local_state';
  }

  base.available_actions = acciones;
  base.actions_source = fuente;
  // Lo ofrecible desde la notificación es un subconjunto: nunca lo económico, y vacío
  // mientras las acciones sean desconocidas.
  base.quick_actions = base.kind === 'reclamo' ? accionesRapidas(acciones) : (acciones || []);
  // El plazo que manda para un caso de ML es el de ML (§4.2), no un reloj propio.
  base.due_date = vence;
  return base;
}
