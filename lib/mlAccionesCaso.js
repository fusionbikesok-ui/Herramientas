/**
 * Acciones disponibles de un caso de Mercado Libre.
 *
 * Todo lo de acá sale de `docs/superpowers/specs/api-mercadolibre-especificacion.md`, que es
 * la fuente de la integración. Tres cosas que la especificación dejó probadas y que este
 * módulo existe para respetar:
 *
 * - §4.2 `available_actions` NO está en la raíz del reclamo: vive dentro de `players[]`, por
 *   rol, y sus elementos son objetos `{action, mandatory, due_date}`, no strings.
 * - §4.3 el detalle y la búsqueda se contradicen para el mismo reclamo. Mientras no se
 *   resuelva cuál miente, una lista vacía en el detalle es DESCONOCIDO, no "ninguna acción".
 *   Con desconocido no se habilita ni se esconde un botón.
 * - §4.2 `mandatory` y `due_date` son el plazo de ML. Para casos de ML se usa ese plazo y no
 *   un temporizador propio, porque un reloj inventado puede contradecir al de ellos.
 */

/** Rol del vendedor en un reclamo. Somos siempre la parte reclamada. */
export const ROL_VENDEDOR = 'respondent';

/**
 * Acciones que jamás se ofrecen desde la pantalla bloqueada: mueven dinero o cierran una
 * disputa de forma irreversible (§5.5). Van dentro del detalle y con confirmación explícita.
 */
export const ACCIONES_ECONOMICAS = new Set([
  'refund', 'partial_refund', 'allow_partial_refund', 'allow_return', 'open_dispute',
  'return_review_ok', 'return_review_fail',
]);

/** Lo único seguro de ejecutar sin confirmación: escribir no mueve dinero ni cierra nada. */
const ACCIONES_MENSAJE = new Set(['send_message_to_mediator', 'send_message', 'reply']);

/**
 * Normaliza un elemento de `available_actions`. Acepta el objeto que devuelve ML y también un
 * string, porque no todos los endpoints de ML son consistentes y un string suelto no debería
 * hacer caer la lectura de un caso.
 */
function normalizarAccion(cruda) {
  if (typeof cruda === 'string') return { action: cruda, mandatory: false, due_date: null };
  if (!cruda || typeof cruda !== 'object' || typeof cruda.action !== 'string') return null;
  return {
    action: cruda.action,
    mandatory: cruda.mandatory === true,
    due_date: typeof cruda.due_date === 'string' ? cruda.due_date : null,
  };
}

/**
 * Extrae las acciones del vendedor de un reclamo de ML.
 *
 * Devuelve `null` cuando no se puede afirmar nada —no hay `players`, no aparece nuestro rol,
 * o la lista vino vacía— y un array cuando ML sí declaró acciones. La distinción entre `null`
 * y `[]` es la regla de §4.3 y es la razón de ser de esta función: quien llama debe poder
 * diferenciar "ML dice que no hay acciones" de "no sabemos qué permite ML".
 */
export function accionesDelVendedor(reclamoMl, rol = ROL_VENDEDOR) {
  const players = reclamoMl?.players;
  if (!Array.isArray(players) || players.length === 0) return null;
  const player = players.find((p) => p?.role === rol);
  if (!player) return null;
  const crudas = player.available_actions;
  if (!Array.isArray(crudas) || crudas.length === 0) return null;
  const acciones = crudas.map(normalizarAccion).filter(Boolean);
  return acciones.length ? acciones : null;
}

/**
 * Subconjunto ofrecible como acción rápida desde una notificación: nunca lo económico.
 * Con acciones desconocidas devuelve lista vacía — ante la duda no se ofrece el atajo, que
 * es el lado seguro del error.
 */
export function accionesRapidas(acciones) {
  if (!Array.isArray(acciones)) return [];
  return acciones.filter((a) => !ACCIONES_ECONOMICAS.has(a.action) && ACCIONES_MENSAJE.has(a.action));
}

/**
 * Vencimiento más próximo entre las acciones obligatorias. Es el plazo que manda para el
 * escalamiento de un caso de ML (§4.2). `null` si ML no declaró ninguno.
 */
export function vencimientoDeMl(acciones) {
  if (!Array.isArray(acciones)) return null;
  const fechas = acciones
    .filter((a) => a.mandatory && a.due_date)
    .map((a) => a.due_date)
    .sort();
  return fechas[0] || null;
}

/** Serializa para persistir en `inbox_items.external_actions`. `null` se guarda como NULL. */
export function serializarAcciones(acciones) {
  return Array.isArray(acciones) && acciones.length ? JSON.stringify(acciones) : null;
}

/** Lee lo persistido. Un JSON corrupto se trata como desconocido, no como "ninguna". */
export function deserializarAcciones(texto) {
  if (!texto) return null;
  try {
    const valor = JSON.parse(texto);
    if (!Array.isArray(valor) || valor.length === 0) return null;
    return valor.map(normalizarAccion).filter(Boolean);
  } catch {
    return null;
  }
}
