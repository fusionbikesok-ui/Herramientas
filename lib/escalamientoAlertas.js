/**
 * Reloj de escalamiento de la bandeja (E6, tarea 5b; §14 del plan maestro).
 *
 * Los temporizadores viven acá y no en la app a propósito: un teléfono apagado, sin señal o
 * con la app cerrada no puede ser responsable de que una alerta urgente escale. El VPS barre
 * por reloj y decide; la app solo muestra y reconoce.
 *
 * Reconocer NO es resolver. Reconocer dice "lo estoy mirando" y frena la repetición; el caso
 * sigue abierto y sigue contando como trabajo pendiente. Resolver lo cierra. Son dos campos y
 * dos endpoints distintos porque son dos hechos distintos, y confundirlos hace que un caso
 * mirado y abandonado desaparezca de la bandeja.
 *
 * Para casos de Mercado Libre el plazo que manda es el de ML (`due_date` de una acción
 * obligatoria, §4.2 de la especificación de ML), no estos temporizadores: un reloj propio
 * puede contradecir al de ellos y el que manda es el de ellos.
 */

const MINUTO = 60 * 1000;

/**
 * Política por severidad, en minutos.
 *  - `repetir`: cada cuánto se vuelve a notificar mientras nadie reconozca. `null` = no repite.
 *  - `escalar`: a los cuántos minutos sin reconocer sube a supervisión. `null` = no escala.
 *  - `objetivo`: plazo de atención esperado; se informa, no dispara nada por sí solo.
 */
export const POLITICA = {
  urgente: { repetir: 2, escalar: 5, objetivo: 5 },
  alta: { repetir: 15, escalar: null, objetivo: 15 },
  normal: { repetir: null, escalar: null, objetivo: null },
  baja: { repetir: null, escalar: null, objetivo: null },
};

/** Severidades que hacen correr el reloj. El resto no se siembra nunca. */
export const SEVERIDADES_QUE_REPITEN = Object.keys(POLITICA).filter((s) => POLITICA[s].repetir !== null);

/**
 * `priority` del contrato viejo → severidad. `urgent` viene del handoff del chat: Fabri IA
 * derivó a una persona y hay alguien esperando del otro lado.
 *
 * Vive acá y no en el worker porque antes había dos traducciones: la ruta degradaba `urgent`
 * a `normal` (los valores de `priority` no son claves de `POLITICA`) mientras el worker sí lo
 * traducía. El mismo caso se listaba como normal y el reloj lo trataba como urgente.
 */
export function severidadDePrioridad(priority) {
  if (priority === 'urgent') return 'urgente';
  if (priority === 'high') return 'alta';
  return 'normal';
}

/**
 * Normaliza una severidad. Acepta también los valores de `priority`, para que el llamador no
 * tenga que saber cuál de los dos campos le tocó.
 *
 * Un valor que no se reconoce se registra: antes caía a `normal` en silencio y, como `normal`
 * no repite, un `'URGENTE'` mal cargado apagaba el reloj sin dejar rastro.
 */
export function severidadDe(valor) {
  if (valor == null || valor === '') return 'normal';
  if (Object.hasOwn(POLITICA, valor)) return valor;
  if (valor === 'urgent' || valor === 'high') return severidadDePrioridad(valor);
  console.warn(`[escalamiento] severidad desconocida "${valor}"; se trata como normal y no repite`);
  return 'normal';
}

const iso = (ms) => new Date(ms).toISOString();
const enMs = (texto) => {
  const t = Date.parse(texto);
  return Number.isNaN(t) ? null : t;
};

/**
 * Próxima repetición de un caso recién creado o recién notificado.
 * Devuelve `null` para lo que no repite, que es lo que apaga el reloj sin ramas especiales.
 */
export function proximaRepeticion(severidad, desde = Date.now()) {
  const politica = POLITICA[severidadDe(severidad)];
  return politica.repetir === null ? null : iso(desde + politica.repetir * MINUTO);
}

/**
 * ¿Corresponde escalar a supervisión? Solo si la política lo define, ya pasó el plazo, nadie
 * reconoció y no se escaló antes. La última condición es la que evita escalar en cada vuelta
 * del worker en lugar de una sola vez.
 */
export function debeEscalar(item, ahora = Date.now()) {
  const politica = POLITICA[severidadDe(item.severidad)];
  if (politica.escalar === null) return false;
  if (item.acknowledged_at) return false;
  if (item.escalated_at) return false;
  const creado = enMs(item.created_at);
  if (creado === null) return false;
  return ahora - creado >= politica.escalar * MINUTO;
}

/** Casos cuyo reloj ya venció y siguen sin reconocer. */
export function casosVencidos(db, ahora = Date.now()) {
  return db.prepare(`SELECT * FROM inbox_items
    WHERE next_repeat_at IS NOT NULL
      AND next_repeat_at <= ?
      AND acknowledged_at IS NULL
      AND status NOT IN ('resolved', 'archived')
    ORDER BY next_repeat_at ASC
    LIMIT 200`).all(iso(ahora));
}

/**
 * Una vuelta del barrido. Devuelve qué hizo, para que el worker lo registre y los tests lo
 * afirmen sin espiar la base.
 *
 * `notificar` recibe cada caso a re-notificar; se inyecta para no acoplar el reloj al
 * transporte de push, que es lo que hace testeable esta lógica sin APNs.
 */
export function barrerEscalamiento(db, { ahora = Date.now(), notificar = () => {} } = {}) {
  const vencidos = casosVencidos(db, ahora);
  // Ordenado por vencimiento: ante un pico se atrasan los más nuevos en vez de perderse
  // casos. Si se llena la ventana conviene enterarse antes de que sea un problema.
  if (vencidos.length === 200) {
    console.warn('[escalamiento] la ventana de 200 casos vencidos se llenó; puede haber atraso');
  }
  const repetidos = [];
  const escalados = [];

  for (const item of vencidos) {
    const severidad = severidadDe(item.severidad);
    const escalar = debeEscalar(item, ahora);

    db.transaction(() => {
      if (escalar) {
        db.prepare('UPDATE inbox_items SET escalated_at = ?, updated_at = ? WHERE inbox_id = ?')
          .run(iso(ahora), iso(ahora), item.inbox_id);
        escalados.push(item.inbox_id);
      }
      // Tras escalar sigue repitiendo cada `repetir` minutos hasta el reconocimiento: el
      // escalamiento avisa a alguien más, no apaga el reloj.
      db.prepare('UPDATE inbox_items SET next_repeat_at = ? WHERE inbox_id = ?')
        .run(proximaRepeticion(severidad, ahora), item.inbox_id);
    })();

    repetidos.push(item.inbox_id);
    notificar({ item, escalado: escalar, severidad });
  }

  return { repetidos, escalados, revisados: vencidos.length };
}

/**
 * Reconoce un caso: frena la repetición sin cerrarlo.
 *
 * `userId` NO es solo para auditar: filtra. Sin el filtro, cualquiera podía apagar el reloj
 * de escalamiento de una alerta urgente ajena, que es justo lo que el reloj existe para
 * evitar. Un caso de otra persona se responde igual que uno inexistente, para no revelar que
 * existe.
 *
 * Idempotente por diseño — reconocer dos veces no cambia quién ni cuándo lo reconoció
 * primero, que es el dato que importa para auditar.
 */
export function reconocer(db, { inboxId, userId, ahora = Date.now() }) {
  const item = db.prepare(`SELECT * FROM inbox_items
    WHERE inbox_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = ?)`).get(inboxId, userId);
  if (!item) return { missing: true };
  if (item.acknowledged_at) return { item, yaReconocido: true };
  db.prepare(`UPDATE inbox_items SET acknowledged_at = ?, acknowledged_by = ?, next_repeat_at = NULL,
    version = version + 1, updated_at = ? WHERE inbox_id = ?`)
    .run(iso(ahora), userId, iso(ahora), inboxId);
  return { item: db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ?').get(inboxId), yaReconocido: false };
}

/**
 * Reasigna conservando la historia: quién, a quién y cuándo. Una columna sola guardaría solo
 * el último movimiento, y §14 pide la historia completa.
 *
 * Mismo filtro que `reconocer`: solo se puede mover un caso propio o sin dueño. Mover un caso
 * ajeno es robárselo, y hoy no hay un rol de supervisión que lo justifique; cuando exista,
 * este es el punto donde se abre la excepción y no antes.
 */
export function reasignar(db, { inboxId, aUsuario, actor, motivo = null, esperado = null, ahora = Date.now() }) {
  return db.transaction(() => {
    const item = db.prepare(`SELECT * FROM inbox_items
      WHERE inbox_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = ?)`).get(inboxId, actor);
    if (!item) return { missing: true };
    if (esperado !== null && item.version !== esperado) return { conflict: item };
    db.prepare('UPDATE inbox_items SET assigned_user_id = ?, version = version + 1, updated_at = ? WHERE inbox_id = ?')
      .run(aUsuario, iso(ahora), inboxId);
    db.prepare(`INSERT INTO inbox_assignments (inbox_id, from_user_id, to_user_id, actor_user_id, motivo, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(inboxId, item.assigned_user_id, aUsuario, actor, motivo, iso(ahora));
    return { item: db.prepare('SELECT * FROM inbox_items WHERE inbox_id = ?').get(inboxId) };
  })();
}

/**
 * Deduplicación: una alerta repetida del mismo hecho no crea un caso nuevo mientras el
 * anterior siga sin reconocerse. Devuelve el caso vivo con esa clave, si existe.
 */
export function casoVivoConClave(db, dedupeKey) {
  if (!dedupeKey) return null;
  return db.prepare(`SELECT * FROM inbox_items WHERE dedupe_key = ?
    AND status NOT IN ('resolved', 'archived') ORDER BY inbox_id DESC LIMIT 1`).get(dedupeKey) || null;
}
