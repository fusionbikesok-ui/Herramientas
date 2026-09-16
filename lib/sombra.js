/**
 * E1 T3 · corte C2 — ciclo de vida de la copia de sombra.
 *
 * Qué es esto y qué NO es:
 *
 * El webhook del legado ya deja un recibo durable antes del ACK, en `integration_events`
 * (lib/workerIntegrationJobs.js). Este módulo NO crea otro recibo: sólo administra el ciclo de vida de
 * la copia hacia la plataforma, sobre esas mismas filas, y la cola que la intenta DESPUÉS del ACK.
 *
 * Invariantes que no se negocian (PM-179, PM-180, diseño T3 §3-§5):
 *   - El ACK nunca espera a PostgreSQL, ni a la plataforma, ni a una API remota.
 *   - Un solo intento por aviso. Nada de reintentos acá: si la copia se pierde, la reparación es el
 *     barrido independiente, no una cola que crece.
 *   - La cola es acotada y descarta de forma síncrona y auditable: cola llena es `queue_full`, no una
 *     promesa suelta ni memoria ilimitada.
 *   - La copia nace apagada (`SOMBRA_COPIA_ENABLED` distinto de 'true').
 *
 * Los valores válidos de `shadow_status` y `shadow_reason` viven acá porque SQLite no puede agregar un
 * CHECK a una tabla existente sin reconstruirla, y `integration_events` es caliente (~1.400 filas/día).
 * Este módulo es la única fuente de verdad de esos valores.
 */

const ESTADOS = Object.freeze(['pending', 'queued', 'attempting', 'copied', 'discarded', 'excluded', 'abandoned']);
const RAZONES = Object.freeze([
  'unsupported_topic', 'foreign_account', 'queue_full', 'platform_timeout',
  'platform_unavailable', 'invalid_resource', 'process_stopped', 'response_not_finished',
]);
const TERMINALES = Object.freeze(['copied', 'discarded', 'excluded', 'abandoned']);

// Cola: capacidad 256, dos en vuelo, un intento, 250 ms de techo por llamada local (diseño §5).
const CAPACIDAD = 256;
const CONCURRENCIA = 2;
const TIMEOUT_MS = 250;
// Un intento vencido de este proceso se abandona: sin esto una fila queda `attempting` para siempre.
const INTENTO_VENCIDO_MS = 60_000;
const RETENCION_DIAS = 400;

// Defensa de la cuenta ajena (decisión de José, 2026-09-16). El legado hoy responde 200 sin persistir
// justamente para que nadie infle la base mandando user_id al azar; persistirlo exige este límite.
// Mismo patrón que el rate limit de /login (lib/auth.js): mapa en memoria con sweep perezoso, porque
// sin sweep un atacante que rota IP deja una entrada por IP para siempre en un proceso que vive semanas.
const AJENA_MAX_POR_VENTANA = 20;
const AJENA_VENTANA_MS = 60 * 60 * 1000;
const AJENA_REGISTROS_ANTES_DE_SWEEP = 200;

const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const sombraEstados = ESTADOS;
export const sombraRazones = RAZONES;
export const sombraTerminales = TERMINALES;
export const sombraLimites = Object.freeze({ CAPACIDAD, CONCURRENCIA, TIMEOUT_MS, INTENTO_VENCIDO_MS, RETENCION_DIAS });
export const bootId = BOOT_ID;

export function copiaHabilitada(env = process.env) {
  return env.SOMBRA_COPIA_ENABLED === 'true';
}

function ahora() {
  return new Date().toISOString();
}

function validar(estado, razon) {
  if (!ESTADOS.includes(estado)) throw new Error(`estado de sombra inválido: ${estado}`);
  if (razon !== null && razon !== undefined && !RAZONES.includes(razon)) {
    throw new Error(`razón de sombra inválida: ${razon}`);
  }
}

/**
 * Marca el estado de sombra de un evento ya persistido. Devuelve true si tocó la fila.
 * No inventa filas: si el evento no existe, no hace nada (el recibo lo crea el handler del legado).
 */
export function marcarSombra(db, eventId, estado, { razon = null, ackAt = null, enqueueAt = null, completedAt = null, attemptId = null } = {}) {
  validar(estado, razon);
  // La cola corre DESPUÉS del ACK: un intento en vuelo puede sobrevivir al cierre de la base (apagado
  // del proceso). Escribir ahí tira 'database connection is not open' dentro de una promesa suelta.
  // La fila queda activa y la cierra `abandonarHuerfanas` en el próximo arranque, que es su trabajo.
  if (db.open === false) return false;
  const r = db.prepare(`UPDATE integration_events SET
      shadow_status = ?, shadow_reason = ?,
      ack_at = COALESCE(?, ack_at), enqueue_at = COALESCE(?, enqueue_at), completed_at = COALESCE(?, completed_at),
      boot_id = ?, attempt_id = COALESCE(?, attempt_id)
    WHERE event_id = ?`)
    .run(estado, razon, ackAt, enqueueAt, completedAt, BOOT_ID, attemptId, eventId);
  return r.changes === 1;
}

/**
 * Al arrancar, toda fila activa de OTRO proceso quedó huérfana: su intento no existe más.
 * Se abandona con razón explícita en vez de dejarla eternamente `attempting`.
 */
export function abandonarHuerfanas(db) {
  const r = db.prepare(`UPDATE integration_events
      SET shadow_status = 'abandoned', shadow_reason = 'process_stopped', completed_at = ?
    WHERE shadow_status IN ('pending','queued','attempting')
      AND (boot_id IS NULL OR boot_id <> ?)`).run(ahora(), BOOT_ID);
  return r.changes;
}

/** Intentos vencidos de ESTE proceso: la respuesta nunca llegó y nadie los va a cerrar. */
export function abandonarVencidos(db, vencidoMs = INTENTO_VENCIDO_MS) {
  const limite = new Date(Date.now() - vencidoMs).toISOString();
  const r = db.prepare(`UPDATE integration_events
      SET shadow_status = 'abandoned', shadow_reason = 'process_stopped', completed_at = ?
    WHERE shadow_status = 'attempting' AND boot_id = ? AND COALESCE(enqueue_at, received_at) < ?`)
    .run(ahora(), BOOT_ID, limite);
  return r.changes;
}

/**
 * Purga de 400 días. Sólo alcanza filas con la sombra terminada Y el trabajo legacy cerrado: no se
 * trunca el historial de un evento en curso. Es la primera retención sobre esta tabla, que hoy crece
 * sin límite, así que va por lotes chicos para no bloquear escrituras del webhook.
 */
export function purgarSombra(db, { dias = RETENCION_DIAS, lote = 500 } = {}) {
  const limite = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const ids = db.prepare(`SELECT event_id FROM integration_events
      WHERE shadow_status IN (${TERMINALES.map(() => '?').join(',')})
        AND status IN ('completed','dead_lettered')
        AND received_at < ?
      LIMIT ?`).all(...TERMINALES, limite, lote).map((f) => f.event_id);
  if (!ids.length) return 0;
  const marcas = ids.map(() => '?').join(',');
  return db.transaction(() => {
    db.prepare(`DELETE FROM integration_event_history WHERE event_id IN (${marcas})`).run(...ids);
    return db.prepare(`DELETE FROM integration_events WHERE event_id IN (${marcas})`).run(...ids).changes;
  })();
}

const ajenaPorIp = new Map(); // ip -> { n, desde }
let registrosAjena = 0;

function sweepAjena() {
  const limite = Date.now() - AJENA_VENTANA_MS;
  for (const [ip, st] of ajenaPorIp) if (st.desde < limite) ajenaPorIp.delete(ip);
}

/**
 * ¿Se puede persistir este aviso de cuenta ajena? Hasta AJENA_MAX_POR_VENTANA por IP y hora.
 * Pasado el techo se cuenta y se descarta sin escribir: la traza vale, hacer crecer la base no.
 */
export function permitirCuentaAjena(ip, ahoraMs = Date.now()) {
  const clave = String(ip || 'sin-ip');
  if (++registrosAjena >= AJENA_REGISTROS_ANTES_DE_SWEEP) { registrosAjena = 0; sweepAjena(); }
  const st = ajenaPorIp.get(clave);
  if (!st || ahoraMs - st.desde > AJENA_VENTANA_MS) {
    ajenaPorIp.set(clave, { n: 1, desde: ahoraMs });
    return true;
  }
  st.n += 1;
  return st.n <= AJENA_MAX_POR_VENTANA;
}

export function reiniciarDefensaCuentaAjena() {
  ajenaPorIp.clear();
  registrosAjena = 0;
}

/**
 * Cola posterior al ACK. Acotada, con un intento y timeout: su trabajo es intentar la copia sin poder
 * dañar al legado. `enviar` es la función que habla con la plataforma; recibe el trabajo y debe
 * resolver o rechazar — este módulo no sabe HTTP.
 */
export function crearColaSombra({ db, enviar, capacidad = CAPACIDAD, concurrencia = CONCURRENCIA, timeoutMs = TIMEOUT_MS, alFinalizar = null }) {
  const pendientes = [];
  let enVuelo = 0;
  let maximoVisto = 0;
  let detenida = false;
  const enCurso = new Set();
  const metricas = { encolados: 0, copiados: 0, descartados: 0, llenos: 0, timeouts: 0, detenidos: 0 };

  function bombear() {
    if (detenida) return;
    while (enVuelo < concurrencia && pendientes.length) {
      const trabajo = pendientes.shift();
      enVuelo += 1;
      const promesa = intentar(trabajo).finally(() => { enVuelo -= 1; enCurso.delete(promesa); bombear(); });
      enCurso.add(promesa);
    }
  }

  async function intentar(trabajo) {
    const attemptId = `${BOOT_ID}-${++metricas.encolados}`;
    marcarSombra(db, trabajo.eventId, 'attempting', { attemptId, enqueueAt: trabajo.enqueueAt });
    let temporizador;
    try {
      await Promise.race([
        enviar(trabajo),
        new Promise((_, rechazar) => { temporizador = setTimeout(() => rechazar(new Error('platform_timeout')), timeoutMs); }),
      ]);
      marcarSombra(db, trabajo.eventId, 'copied', { completedAt: ahora(), attemptId });
      metricas.copiados += 1;
    } catch (error) {
      const razon = error?.message === 'platform_timeout' ? 'platform_timeout' : 'platform_unavailable';
      if (razon === 'platform_timeout') metricas.timeouts += 1;
      marcarSombra(db, trabajo.eventId, 'discarded', { razon, completedAt: ahora(), attemptId });
      metricas.descartados += 1;
    } finally {
      clearTimeout(temporizador);
      if (alFinalizar) alFinalizar(trabajo);
    }
  }

  return {
    /** Encola un aviso ya ACKeado. Cola llena descarta en el acto, de forma auditable. */
    encolar(eventId) {
      if (pendientes.length >= capacidad) {
        metricas.llenos += 1;
        metricas.descartados += 1;
        marcarSombra(db, eventId, 'discarded', { razon: 'queue_full', completedAt: ahora() });
        return false;
      }
      const enqueueAt = ahora();
      marcarSombra(db, eventId, 'queued', { enqueueAt });
      pendientes.push({ eventId, enqueueAt });
      maximoVisto = Math.max(maximoVisto, pendientes.length);
      bombear();
      return true;
    },
    /**
     * Apagado ordenado: deja de aceptar y de bombear, abandona lo que nunca llegó a intentarse y espera
     * a los intentos en vuelo. Sin esto un apagado (o un test que rota la base) deja escrituras
     * colgadas contra una conexión ya cerrada. No reintenta nada: sigue valiendo un solo intento.
     */
    async detener() {
      detenida = true;
      while (pendientes.length) {
        const trabajo = pendientes.shift();
        metricas.detenidos += 1;
        metricas.descartados += 1;
        marcarSombra(db, trabajo.eventId, 'abandoned', { razon: 'process_stopped', completedAt: ahora() });
      }
      await Promise.allSettled([...enCurso]);
      return this.estado();
    },
    estado() {
      return { profundidad: pendientes.length, enVuelo, maximoVisto, capacidad, detenida, ...metricas };
    },
  };
}
