/**
 * Adaptadores de escritura contra Mercado Libre para la bandeja móvil (E6, tarea 2).
 *
 * Todo lo que se escribe en ML pasa por acá. Reglas que gobiernan el módulo, todas de
 * `docs/superpowers/specs/api-mercadolibre-especificacion.md`:
 *
 * - La app nunca llama a ML ni ve un token: manda a `/api/v1` y este módulo traduce.
 * - Se escribe únicamente sobre un caso que la persona puede ver. El identificador del path
 *   es un dato del cliente, no una autorización: sin esta comprobación alcanzaba con adivinar
 *   un número para escribirle al mediador de un reclamo ajeno, y los códigos de error servían
 *   de oráculo para enumerar qué existe en la cuenta.
 * - Antes de escribir se RELEE el recurso en ML. El estado local es una proyección y puede
 *   estar viejo; escribir sobre un caso que ML ya cerró es el error que hay que evitar.
 * - Mensajería posventa exige `?tag=post_sale` (§4.1). Sin el parámetro ML responde 404, que
 *   se lee como "no existe la conversación" y no lo es.
 * - El largo máximo del mensaje lo declara ML en el hilo (`seller_max_message_length`); no se
 *   fija en el código (§5.3).
 * - Para reclamos, la allowlist sale de `players[]` (§4.2) y una lista vacía en el detalle es
 *   desconocido, no "ninguna" (§4.3). Con desconocido se rechaza: no se escribe a ciegas.
 * - Enviar no garantiza que llegue: ML modera (§4.4). El resultado lo dice.
 */

import { mlFetch } from './mlClient.js';
import { accionesDelVendedor, ACCIONES_ECONOMICAS } from './mlAccionesCaso.js';

const now = () => new Date().toISOString();

/** Error de negocio con status HTTP, para que la ruta traduzca sin inventar códigos. */
export class AccionError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Mismo error para un caso inexistente y para uno ajeno. Distinguirlos permitiría enumerar
 * qué reclamos y preguntas tiene la cuenta probando identificadores.
 */
const noEncontrado = () => new AccionError(404, 'no_encontrado', 'Caso no encontrado');

/** Límite duro de seguridad. El límite real lo declara ML y siempre gana el menor. */
const LARGO_MAXIMO_ABSOLUTO = 2000;

function validarTexto(texto, maximo = LARGO_MAXIMO_ABSOLUTO) {
  if (typeof texto !== 'string' || texto.trim() === '') {
    throw new AccionError(422, 'texto_requerido', 'El texto no puede estar vacío');
  }
  const limpio = texto.trim();
  const tope = Math.min(maximo || LARGO_MAXIMO_ABSOLUTO, LARGO_MAXIMO_ABSOLUTO);
  if (limpio.length > tope) {
    throw new AccionError(422, 'texto_largo', `El texto supera el máximo de ${tope} caracteres`);
  }
  return limpio;
}

// ── Autorización sobre el caso ───────────────────────────────────────────────────────────

/**
 * Busca el caso de la bandeja que corresponde al recurso externo, con el MISMO filtro de
 * asignación que usan el listado y el detalle. Devuelve la fila o lanza 404.
 *
 * `resource_id` se guardó históricamente con y sin prefijo (`claim:123` y `123`), así que se
 * aceptan las dos formas en lugar de normalizar la base en esta entrega.
 */
function exigirCaso(db, { userId, resourceIds = [], packId = null }) {
  const condiciones = [];
  const params = [];
  if (resourceIds.length) {
    condiciones.push(`resource_id IN (${resourceIds.map(() => '?').join(', ')})`);
    params.push(...resourceIds);
  }
  if (packId) { condiciones.push('pack_id = ?'); params.push(packId); }
  if (!condiciones.length) throw noEncontrado();

  const fila = db.prepare(`SELECT * FROM inbox_items
    WHERE channel = 'ml' AND (${condiciones.join(' OR ')})
      AND (assigned_user_id IS NULL OR assigned_user_id = ?)
    ORDER BY inbox_id DESC LIMIT 1`).get(...params, userId);
  if (!fila) throw noEncontrado();
  return fila;
}

// ── Idempotencia ─────────────────────────────────────────────────────────────────────────

/**
 * Idempotencia. Un reintento por red cortada no debe mandarle dos respuestas al comprador.
 *
 * Estados de una clave:
 *  - `en_curso`: hay una ejecución en vuelo. Un segundo intento recibe 409.
 *  - `ok`: terminó bien; el reintento devuelve el resultado guardado sin volver a escribir.
 *  - `incierto`: falló DESPUÉS de haber mandado la escritura a ML. Es el estado que faltaba:
 *    antes cualquier fallo borraba la clave, así que un timeout con la escritura ya aceptada
 *    por ML permitía que el reintento la mandara de nuevo. Para mensajes y acciones de
 *    reclamo, que son append-only, eso significaba que el comprador recibía dos veces lo
 *    mismo — exactamente lo que la idempotencia existe para impedir.
 *
 * Un fallo ANTERIOR al envío (validación, relectura, acción no permitida) sí borra la clave:
 * ahí no se escribió nada y el reintento debe poder ejecutarse de verdad.
 */
export function asegurarTablaIdempotencia(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_action_keys (
    idempotency_key TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    accion          TEXT NOT NULL,
    recurso         TEXT NOT NULL,
    estado          TEXT NOT NULL,
    resultado       TEXT,
    created_at      TEXT NOT NULL
  )`);
  // Sin este índice no se puede purgar la tabla, que crece con cada escritura.
  db.exec('CREATE INDEX IF NOT EXISTS idx_mobile_action_keys_fecha ON mobile_action_keys(created_at)');
}

function reservarClave(db, { clave, userId, accion, recurso }) {
  asegurarTablaIdempotencia(db);
  const previa = db.prepare('SELECT * FROM mobile_action_keys WHERE idempotency_key = ?').get(clave);
  if (previa) {
    if (previa.user_id !== userId || previa.recurso !== recurso) {
      throw new AccionError(409, 'clave_reutilizada', 'La clave de idempotencia ya se usó para otra operación');
    }
    if (previa.estado === 'en_curso') {
      throw new AccionError(409, 'accion_en_curso', 'La acción todavía se está ejecutando');
    }
    if (previa.estado === 'incierto') {
      // No se sabe si ML la recibió. Repetirla puede duplicar; darla por hecha puede perderla.
      // Se devuelve el caso a la persona, que puede ver el hilo y decidir.
      throw new AccionError(409, 'resultado_incierto',
        'No se pudo confirmar si Mercado Libre recibió el envío anterior. Abrí el caso y revisá el hilo antes de reintentar');
    }
    return { repetida: true, resultado: previa.resultado ? JSON.parse(previa.resultado) : null };
  }
  db.prepare(`INSERT INTO mobile_action_keys (idempotency_key, user_id, accion, recurso, estado, created_at)
    VALUES (?, ?, ?, ?, 'en_curso', ?)`).run(clave, userId, accion, recurso, now());
  return { repetida: false, resultado: null };
}

const cerrarClave = (db, clave, resultado) =>
  db.prepare("UPDATE mobile_action_keys SET estado = 'ok', resultado = ? WHERE idempotency_key = ?")
    .run(JSON.stringify(resultado), clave);

const liberarClave = (db, clave) =>
  db.prepare('DELETE FROM mobile_action_keys WHERE idempotency_key = ?').run(clave);

const marcarIncierta = (db, clave) =>
  db.prepare("UPDATE mobile_action_keys SET estado = 'incierto' WHERE idempotency_key = ?").run(clave);

/**
 * Ejecuta con idempotencia. `fn` recibe un `marcarEnviado()` que debe llamarse JUSTO ANTES de
 * mandar la escritura a ML: a partir de ese punto un fallo deja la clave en `incierto` en vez
 * de borrarla, porque ya no se puede afirmar que no se escribió.
 */
async function conIdempotencia(db, datos, fn) {
  const { repetida, resultado } = reservarClave(db, datos);
  if (repetida) return { ...resultado, repetida: true };
  let enviado = false;
  try {
    const salida = await fn(() => { enviado = true; });
    cerrarClave(db, datos.clave, salida);
    return { ...salida, repetida: false };
  } catch (e) {
    if (enviado) marcarIncierta(db, datos.clave);
    else liberarClave(db, datos.clave);
    throw e;
  }
}

// ── Llamadas a ML ────────────────────────────────────────────────────────────────────────

/**
 * Opciones de lectura. `manual: true` da prioridad interactiva y permite UN reintento ante
 * 429, que en un GET es inofensivo.
 */
const LECTURA = { manual: true };

/**
 * Opciones de ESCRITURA. Deliberadamente sin `manual`: el reintento de `mlFetch` ante un 429
 * repite la misma request sin mirar el método, y un 429 devuelto después de que ML ya procesó
 * el POST duplicaría el mensaje. Sin `manual`, un cooldown activo devuelve un 429 sintético
 * sin llegar a ML, que es el lado seguro: es preferible pedirle a la persona que reintente
 * antes que mandarle dos mensajes al comprador.
 */
const ESCRITURA = {};

/** Traduce una respuesta de ML que no es 2xx a un error de negocio con status propio. */
function fallaMl(resp, contexto) {
  if (resp?.status === 429) {
    throw new AccionError(503, 'ml_sin_cupo', 'Mercado Libre está limitando las llamadas; reintentá en un momento');
  }
  if (resp?.status === 401 || resp?.status === 403) {
    throw new AccionError(502, 'ml_sin_permiso', `Mercado Libre rechazó la operación (${contexto})`);
  }
  throw new AccionError(502, 'ml_error', `Mercado Libre respondió ${resp?.status ?? 'sin status'} (${contexto})`);
}

const ok = (resp) => resp && resp.status >= 200 && resp.status < 300;

// ── Preguntas ────────────────────────────────────────────────────────────────────────────

/**
 * Responde una pregunta. `POST /answers` no existía en el repositorio: es la primera vez que
 * el sistema puede responder una pregunta desde algún lado (§5.2).
 */
export async function responderPregunta(db, mlCfg, { questionId, texto, userId, clave }) {
  const id = String(questionId);
  const caso = exigirCaso(db, { userId, resourceIds: [`question:${id}`, id] });

  return conIdempotencia(db, { clave, userId, accion: 'question_reply', recurso: `question:${id}` }, async (marcarEnviado) => {
    // Releer antes de escribir: el estado local puede estar viejo y responder dos veces la
    // misma pregunta es visible para el comprador.
    const actual = await mlFetch(db, mlCfg, 'GET', `/questions/${id}?api_version=4`, null, LECTURA);
    if (!ok(actual)) fallaMl(actual, 'lectura de la pregunta');
    if (actual.data?.status !== 'UNANSWERED') {
      // El estado crudo de ML va al log, no al cuerpo: al cliente le alcanza con saber que ya
      // no se puede responder.
      console.warn(`[acciones] pregunta ${id} en estado ${actual.data?.status}, no se responde`);
      throw new AccionError(409, 'pregunta_no_abierta', 'La pregunta ya no admite respuesta');
    }
    const limpio = validarTexto(texto);

    marcarEnviado();
    const resp = await mlFetch(db, mlCfg, 'POST', '/answers', { question_id: Number(id), text: limpio }, ESCRITURA);
    if (!ok(resp)) fallaMl(resp, 'envío de la respuesta');

    // Releer y proyectar el estado real, en lugar de asumir ANSWERED.
    const despues = await mlFetch(db, mlCfg, 'GET', `/questions/${id}?api_version=4`, null, LECTURA);
    const estadoFinal = ok(despues) ? (despues.data?.status || 'ANSWERED') : 'ANSWERED';
    proyectarPregunta(db, id, estadoFinal, caso.inbox_id);
    return { question_id: id, external_status: estadoFinal, moderado: false };
  });
}

function proyectarPregunta(db, questionId, estado, inboxId) {
  const ts = now();
  db.prepare('UPDATE ml_preguntas SET estado = ?, respondida_en = COALESCE(respondida_en, ?), actualizado_en = ? WHERE id = ?')
    .run(estado, estado === 'ANSWERED' ? ts : null, ts, Number(questionId));
  db.prepare(`UPDATE inbox_items SET external_status = ?, last_synced_at = ?, updated_at = ?, version = version + 1
    WHERE inbox_id = ?`).run(estado, ts, ts, inboxId);
}

// ── Mensajería posventa ──────────────────────────────────────────────────────────────────

/** Formas en las que se observó `conversation_status`. Lo que no encaja se trata como no apto. */
function puedeEscribir(hilo) {
  if (hilo?.can_reply === false) return false;
  const estado = hilo?.conversation_status;
  if (estado == null) return true;
  const valor = typeof estado === 'string' ? estado : estado.status || estado.substatus;
  if (typeof valor !== 'string') return true;
  return valor !== 'blocked' && valor !== 'closed';
}

/**
 * Envía un mensaje al comprador por pack. `?tag=post_sale` es obligatorio: sin él ML
 * responde 404 y parece que la conversación no existe (§4.1).
 */
export async function enviarMensajePack(db, mlCfg, { packId, texto, userId, clave }) {
  const pack = String(packId);
  const sellerId = String(mlCfg?.userId || '');
  if (!sellerId) throw new AccionError(500, 'ml_sin_vendedor', 'Falta el identificador de vendedor de Mercado Libre');
  const caso = exigirCaso(db, { userId, packId: pack, resourceIds: [`pack:${pack}`] });

  return conIdempotencia(db, { clave, userId, accion: 'conversation_reply', recurso: `pack:${pack}` }, async (marcarEnviado) => {
    const ruta = `/messages/packs/${pack}/sellers/${sellerId}?tag=post_sale`;
    const hilo = await mlFetch(db, mlCfg, 'GET', ruta, null, LECTURA);
    if (!ok(hilo)) fallaMl(hilo, 'lectura del hilo');

    if (!puedeEscribir(hilo.data)) {
      throw new AccionError(409, 'conversacion_bloqueada', 'Mercado Libre no permite escribir en esta conversación');
    }

    const destinatario = String(hilo.data?.buyer_id ?? hilo.data?.to?.user_id ?? '');
    if (!destinatario) {
      // Mandar un destinatario vacío haría que ML devuelva un error genérico que no dice nada.
      throw new AccionError(409, 'sin_destinatario', 'Mercado Libre no devolvió el comprador de esta conversación');
    }

    // El máximo lo dice ML, no el código (§5.3).
    const limpio = validarTexto(texto, Number(hilo.data?.seller_max_message_length) || undefined);

    marcarEnviado();
    const resp = await mlFetch(db, mlCfg, 'POST', ruta, {
      from: { user_id: sellerId }, to: { user_id: destinatario }, text: limpio,
    }, ESCRITURA);
    if (!ok(resp)) fallaMl(resp, 'envío del mensaje');

    // ML modera (§4.4): enviarlo no garantiza que llegue, y el resultado lo declara.
    const moderacion = resp.data?.message_moderation?.status || null;
    const ts = now();
    db.prepare('UPDATE inbox_items SET last_synced_at = ?, updated_at = ?, version = version + 1 WHERE inbox_id = ?')
      .run(ts, ts, caso.inbox_id);
    return { pack_id: pack, moderado: moderacion !== null && moderacion !== 'clean', moderacion };
  });
}

// ── Reclamos ─────────────────────────────────────────────────────────────────────────────

/** Endpoint de ML por acción permitida. Solo lo no económico se expone acá. */
const RUTA_POR_ACCION = {
  send_message_to_mediator: (id) => `/post-purchase/v1/claims/${id}/actions/send-message`,
  send_message: (id) => `/post-purchase/v1/claims/${id}/actions/send-message`,
};

/**
 * Ejecuta una acción sobre un reclamo, con la allowlist que ML declara para nuestro rol.
 *
 * La revalidación acá no es opcional: `available_actions` depende del rol, del estado y del
 * momento, así que lo que era válido cuando se pintó la pantalla puede no serlo al tocar el
 * botón.
 */
export async function ejecutarAccionReclamo(db, mlCfg, { claimId, accion, texto, userId, clave }) {
  const id = String(claimId);
  if (ACCIONES_ECONOMICAS.has(accion)) {
    // Estas existen en ML pero no se ejecutan por este camino: mueven dinero o cierran una
    // disputa y necesitan confirmación explícita en una entrega propia (§5.5).
    throw new AccionError(422, 'accion_economica', 'Esta acción no se ejecuta desde la bandeja móvil');
  }
  const construirRuta = RUTA_POR_ACCION[accion];
  if (!construirRuta) throw new AccionError(422, 'accion_desconocida', `Acción no soportada: ${accion}`);
  const caso = exigirCaso(db, { userId, resourceIds: [`claim:${id}`, id] });

  return conIdempotencia(db, { clave, userId, accion: `claim:${accion}`, recurso: `claim:${id}` }, async (marcarEnviado) => {
    const actual = await mlFetch(db, mlCfg, 'GET', `/post-purchase/v1/claims/${id}`, null, LECTURA);
    if (!ok(actual)) fallaMl(actual, 'lectura del reclamo');

    const estado = actual.data?.status;
    if (estado && estado !== 'opened') {
      console.warn(`[acciones] reclamo ${id} en estado ${estado}, no se opera`);
      throw new AccionError(409, 'reclamo_cerrado', 'El reclamo ya no está abierto');
    }

    let permitidas = accionesDelVendedor(actual.data);
    if (permitidas === null) {
      // §4.3: el detalle devuelve `[]` para los tres players en casos donde la búsqueda sí
      // declara acciones. Una lista vacía acá es DESCONOCIDO, y con desconocido no se
      // escribe: se confirma contra la búsqueda, que es el otro endpoint que las publica.
      permitidas = await accionesDesdeBusqueda(db, mlCfg, id);
    }
    if (permitidas === null) {
      throw new AccionError(409, 'acciones_desconocidas',
        'Mercado Libre no declara qué acciones permite en este reclamo; abrí el detalle y reintentá');
    }
    if (!permitidas.some((a) => a.action === accion)) {
      throw new AccionError(409, 'accion_no_permitida', 'Mercado Libre no permite esta acción en el reclamo');
    }

    const limpio = validarTexto(texto);
    marcarEnviado();
    const resp = await mlFetch(db, mlCfg, 'POST', construirRuta(id), { message: limpio }, ESCRITURA);
    if (!ok(resp)) fallaMl(resp, `acción ${accion}`);

    const ts = now();
    db.prepare('UPDATE inbox_items SET last_synced_at = ?, updated_at = ?, version = version + 1 WHERE inbox_id = ?')
      .run(ts, ts, caso.inbox_id);
    const moderacion = resp.data?.message_moderation?.status || null;
    return { claim_id: id, accion, moderado: moderacion !== null && moderacion !== 'clean', moderacion };
  });
}

/**
 * Acciones del vendedor según la BÚSQUEDA de reclamos abiertos.
 *
 * Existe porque el detalle y la búsqueda se contradicen (§4.3) y la búsqueda es la que sí
 * devolvió acciones para el caso observado. Se exporta porque la reconciliación la usa para
 * poblar `inbox_items.external_actions`: sin eso el campo quedaría siempre nulo y las
 * acciones de reclamo no se encenderían nunca.
 */
export async function accionesDesdeBusqueda(db, mlCfg, claimId) {
  const resp = await mlFetch(db, mlCfg, 'GET',
    `/post-purchase/v1/claims/search?status=opened&players.user_id=${mlCfg?.userId ?? ''}&players.role=respondent`,
    null, LECTURA);
  if (!ok(resp)) return null;
  const lista = resp.data?.data || resp.data?.results || [];
  const encontrado = lista.find((c) => String(c?.id) === String(claimId));
  return encontrado ? accionesDelVendedor(encontrado) : null;
}
