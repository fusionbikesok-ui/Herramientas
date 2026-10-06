/**
 * E2 T1 tarea 9 — outbox durable del legado hacia la plataforma.
 *
 * Tres piezas:
 *   - `encolarEventoPlataforma`: se llama DENTRO de la transacción del cambio (una decisión del matcher). Es una
 *     escritura local y síncrona en SQLite: nunca espera a la red, así que el matcher no se frena aunque la
 *     plataforma esté caída.
 *   - `crearDespachadorOutbox`: reclama con lease y manda en orden, fuera de cualquier respuesta HTTP. Ante el
 *     primer fallo transitorio corta la vuelta, para no mandar un evento posterior antes que uno anterior de la
 *     misma decisión. Un rechazo (400) no se reintenta: queda 'rechazado' y alerta.
 *   - `estadoOutbox`: cuánto hay atrasado y rechazado, para la alerta.
 *
 * Dos interruptores, en el orden de la puesta en producción (plan, tarea 14): OUTBOX_PLATAFORMA_CAPTURA escribe
 * (paso 4, antes de la copia del matcher, para que no haya ventana de pérdida) y OUTBOX_PLATAFORMA_ENVIO manda
 * (paso 6). La firma usa el keyring de la sombra: es la misma clave que verifica la API interna de la plataforma.
 */
import crypto from 'crypto';
import { firmarInterno } from './internoHmac.js';
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';

export const RUTA_EVENTOS_CATALOGO = '/internal/v1/catalogo/eventos';
export const RUTA_EVENTOS_IDENTIDAD = '/internal/v1/catalogo/eventos-identidad';
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_TOPE_MS = 15 * 60_000;
const RETENCION_ENVIADOS_DIAS = 30;

const iso = (d) => d.toISOString();

/** La captura está encendida sólo con el valor exacto: un typo en el .env no la enciende a medias. */
export function capturaHabilitada(env = process.env) {
  return env.OUTBOX_PLATAFORMA_CAPTURA === 'true';
}

/**
 * La captura la hacen triggers de SQLite (migración 108), que no pueden leer el entorno: al arrancar, el legado
 * copia el interruptor a `outbox_config`. Se llama siempre, esté o no encendido el envío, para que apagar la
 * captura en el .env también la apague en la base.
 */
export function sincronizarCaptura(db, env = process.env) {
  db.prepare("INSERT INTO outbox_config (clave, valor) VALUES ('captura', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
    .run(capturaHabilitada(env) ? 'true' : 'false');
}

/**
 * Escribe el evento en la outbox. Síncrono: se llama dentro de `db.transaction(...)` del cambio, así viven o
 * mueren juntos. Con la captura apagada no escribe nada y devuelve null.
 */
export function encolarEventoPlataforma(db, tipo, payload, { eventoId = crypto.randomUUID(), ahora = new Date(), env = process.env } = {}) {
  if (!capturaHabilitada(env)) return null;
  db.prepare(`INSERT INTO outbox_plataforma (evento_id, tipo, payload, creado_en, proximo_en)
              VALUES (?, ?, ?, ?, ?)`).run(eventoId, tipo, JSON.stringify(payload), iso(ahora), iso(ahora));
  return eventoId;
}

export function backoffMs(intentos) {
  return Math.min(BACKOFF_TOPE_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, intentos - 1));
}

/** Error que la plataforma no va a aceptar nunca (400): reintentarlo no cambia nada. */
export class RechazoPlataforma extends Error {
  constructor(mensaje) { super(mensaje); this.name = 'RechazoPlataforma'; }
}

/**
 * `enviar(evento)` resuelve si la plataforma lo aceptó (o ya lo tenía), lanza `RechazoPlataforma` si es un 400,
 * y cualquier otro error se trata como transitorio.
 */
export function crearDespachadorOutbox({ db, enviar, lote = 50, leaseMs = 60_000, ahora = () => new Date() }) {
  const reclamar = db.transaction((n) => {
    const t = ahora();
    const filas = db.prepare(`SELECT id, evento_id, tipo, payload, intentos, creado_en FROM outbox_plataforma
      WHERE (estado = 'pendiente' AND proximo_en <= ?) OR (estado = 'enviando' AND lease_hasta <= ?)
      ORDER BY id LIMIT ?`).all(iso(t), iso(t), n);
    const tomar = db.prepare(`UPDATE outbox_plataforma SET estado = 'enviando', lease_hasta = ?, intentos = intentos + 1 WHERE id = ?`);
    for (const f of filas) tomar.run(iso(new Date(t.getTime() + leaseMs)), f.id);
    return filas.map((f) => ({ ...f, intentos: f.intentos + 1 }));
  });
  const ok = db.prepare(`UPDATE outbox_plataforma SET estado = 'enviado', lease_hasta = NULL, enviado_en = ?, ultimo_error = NULL WHERE id = ?`);
  const reintentar = db.prepare(`UPDATE outbox_plataforma SET estado = 'pendiente', lease_hasta = NULL, proximo_en = ?, ultimo_error = ? WHERE id = ?`);
  const rechazar = db.prepare(`UPDATE outbox_plataforma SET estado = 'rechazado', lease_hasta = NULL, ultimo_error = ? WHERE id = ?`);
  // Lo que quedó reclamado en esta vuelta y no se llegó a mandar vuelve a pendiente sin gastar el intento.
  const devolver = db.prepare(`UPDATE outbox_plataforma SET estado = 'pendiente', lease_hasta = NULL, intentos = intentos - 1 WHERE id = ? AND estado = 'enviando'`);
  const purgar = db.prepare(`DELETE FROM outbox_plataforma WHERE estado = 'enviado' AND enviado_en < ?`);

  let apagando = false;
  return {
    async unaVuelta() {
      const r = { enviados: 0, reintentar: 0, rechazados: 0 };
      if (apagando) return r;
      const filas = reclamar(lote);
      for (let i = 0; i < filas.length; i++) {
        const f = filas[i];
        if (apagando) { for (const g of filas.slice(i)) devolver.run(g.id); break; }
        try {
          await enviar({ evento_id: f.evento_id, tipo: f.tipo, payload: JSON.parse(f.payload), creado_en: f.creado_en });
          ok.run(iso(ahora()), f.id);
          r.enviados++;
        } catch (e) {
          const detalle = String(e?.message || e).slice(0, 300);
          if (e instanceof RechazoPlataforma) {
            rechazar.run(detalle, f.id);
            r.rechazados++;
            continue;
          }
          reintentar.run(iso(new Date(ahora().getTime() + backoffMs(f.intentos))), detalle, f.id);
          r.reintentar++;
          // Orden: si éste no salió, los siguientes esperan. Mandar un evento posterior antes que uno anterior
          // de la misma decisión haría que la plataforma descarte el anterior como viejo al llegar tarde.
          for (const g of filas.slice(i + 1)) devolver.run(g.id);
          break;
        }
      }
      const limite = new Date(ahora().getTime() - RETENCION_ENVIADOS_DIAS * 86_400_000);
      purgar.run(iso(limite));
      return r;
    },
    detener() { apagando = true; },
  };
}

/** Para la alerta: eventos que llevan más de `minutos` sin salir, y los rechazados. */
export function estadoOutbox(db, { minutos = 30, ahora = new Date() } = {}) {
  const limite = iso(new Date(ahora.getTime() - minutos * 60_000));
  const q = (sql, ...p) => db.prepare(sql).get(...p).n;
  return {
    atrasados: q(`SELECT count(*) n FROM outbox_plataforma WHERE estado IN ('pendiente', 'enviando') AND creado_en < ?`, limite),
    pendientes: q(`SELECT count(*) n FROM outbox_plataforma WHERE estado IN ('pendiente', 'enviando')`),
    rechazados: q(`SELECT count(*) n FROM outbox_plataforma WHERE estado = 'rechazado'`),
  };
}

// Decisiones que tomó el sistema y no una persona (decisión de José: entran como decisiones del sistema, con
// su motivo). Los valores son los `origen` que existen hoy en sku_matcher_decisiones.
const ORIGENES_SISTEMA = {
  identidad_productos: 'identidad de productos', auto_seller_sku: 'autoasignación por SKU',
  guardia_ml_auto: 'corrección de Guardia ML', guardia_ml: 'corrección de Guardia ML',
};
const ESTADOS_ABIERTOS = new Set(['pendiente', 'urgente', 'tomado', 'intervencion']);

/** Quién tomó una decisión del matcher. Lo usan los eventos y la copia, para que las dos vías digan lo mismo. */
export function actorDeDecision(origen, confirmadoPor) {
  const sistema = confirmadoPor === 'sistema' || Object.hasOwn(ORIGENES_SISTEMA, origen ?? '');
  return {
    actor: sistema ? 'sistema' : 'persona',
    motivo: origen ? (ORIGENES_SISTEMA[origen] ?? origen) : null,
    confirmadoPor: sistema ? null : (confirmadoPor || null),
  };
}

/** `ITEM|variación` → recurso y variación. Un dato que no tiene esa forma no lo va a aceptar la plataforma. */
function partirClave(clave) {
  const m = /^([A-Z]{3}[0-9]+)\|([0-9]*)$/.exec(String(clave ?? ''));
  if (!m) throw new RechazoPlataforma(`clave con forma inesperada: ${String(clave).slice(0, 60)}`);
  return { recurso: m[1], variacion: m[2] };
}

/**
 * La fila cruda que dejó el trigger, en el formato de la API interna del catálogo. Lo que no se puede traducir
 * es un rechazo local: queda marcado y alerta, en vez de viajar para que la plataforma devuelva 400.
 */
export function traducirEvento({ evento_id, tipo, payload, creado_en }) {
  if (tipo === 'matcher.decision') {
    const { recurso, variacion } = partirClave(payload.clave);
    if (payload.op === 'borrada') {
      return { ruta: RUTA_EVENTOS_CATALOGO, cuerpo: {
        evento_id, recurso, variacion, accion: 'revocar', sku: null, actor: 'persona', motivo: null, confirmado_por: null, ocurrido_en: creado_en } };
    }
    if (!['confirmar', 'asignar', 'omitir'].includes(payload.accion)) throw new RechazoPlataforma(`acción desconocida: ${payload.accion}`);
    const { actor, motivo, confirmadoPor } = actorDeDecision(payload.origen, payload.confirmado_por);
    return { ruta: RUTA_EVENTOS_CATALOGO, cuerpo: {
      evento_id, recurso, variacion, accion: payload.accion,
      sku: payload.accion === 'omitir' ? null : (payload.sku || null),
      actor, motivo, confirmado_por: confirmadoPor, ocurrido_en: creado_en,
    } };
  }
  if (tipo === 'identidad.caso') {
    const { recurso, variacion } = partirClave(payload.ml_key);
    const urgente = payload.estado === 'urgente' || ['urgente', 'critica'].includes(payload.severidad);
    return { ruta: RUTA_EVENTOS_IDENTIDAD, cuerpo: {
      evento_id, caso_legado: String(payload.id), recurso, variacion,
      prioridad: urgente ? 'urgente' : 'normal', abierto: ESTADOS_ABIERTOS.has(payload.estado),
      detalle: { estado: payload.estado ?? null, clasificacion: payload.clasificacion ?? null, direccion: payload.direccion ?? null },
      ocurrido_en: creado_en,
    } };
  }
  throw new RechazoPlataforma(`tipo desconocido: ${tipo}`);
}

/** El envío real: POST firmado a la API interna del catálogo. */
export function crearEnvioEventoCatalogo({ url, keyring, fetch: hacerFetch = globalThis.fetch, timeoutMs = 5000 }) {
  const base = new URL(url);
  const clave = keyring.keys[keyring.activeKeyId];
  if (!clave) throw new Error('clave activa ausente para la outbox');
  return async function enviarEvento(evento) {
    const { ruta, cuerpo: datos } = traducirEvento(evento);
    const cuerpo = Buffer.from(JSON.stringify(datos));
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString('base64url');
    let r;
    try {
      r = await hacerFetch(new URL(ruta, base), {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-fusion-key-id': keyring.activeKeyId, 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
          'x-fusion-signature': firmarInterno(clave, ts, nonce, 'POST', ruta, cuerpo),
        },
        body: cuerpo,
      });
    } catch {
      throw new Error('plataforma_no_disponible');
    }
    await r.body?.cancel?.().catch?.(() => undefined);
    if (r.status === 200) return;
    // 400: el evento está mal formado y reenviarlo no lo arregla. Todo lo demás (401 por reloj o clave en
    // rotación, 409 por cuenta sin configurar, 5xx) puede resolverse solo o con una corrección nuestra.
    if (r.status === 400) throw new RechazoPlataforma('evento_invalido');
    throw new Error(`plataforma_${r.status}`);
  };
}

/**
 * La alerta: eventos atrasados (más de `minutos` sin salir) o rechazados abren un incidente; cuando se
 * normalizan, se cierra solo. Sin esto, una plataforma caída durante horas dejaría al catálogo desactualizado
 * y nadie lo notaría hasta la conciliación del día siguiente.
 */
export function revisarOutbox(db, { minutos = 30, ahora = new Date() } = {}) {
  const e = estadoOutbox(db, { minutos, ahora });
  const base = { integracion: 'plataforma', proceso: 'outbox_plataforma' };
  if (e.atrasados > 0) {
    abrirOActualizarIncidente(db, {
      ...base, tipoError: 'outbox_atrasada', severidad: 'alta',
      mensajeHumano: `Hay ${e.atrasados} cambios del matcher que no llegan a la plataforma desde hace más de ${minutos} minutos.`,
      mensajeTecnico: `pendientes=${e.pendientes} atrasados=${e.atrasados}`, contexto: e,
    });
  } else confirmarCicloSano(db, { ...base, tipoError: 'outbox_atrasada' });
  if (e.rechazados > 0) {
    abrirOActualizarIncidente(db, {
      ...base, tipoError: 'outbox_rechazada', severidad: 'alta',
      mensajeHumano: `La plataforma rechazó ${e.rechazados} cambios del matcher: no se van a reintentar solos.`,
      mensajeTecnico: `rechazados=${e.rechazados}`, contexto: e,
    });
  } else confirmarCicloSano(db, { ...base, tipoError: 'outbox_rechazada' });
  return e;
}

/**
 * Arranca el despachador desde server.js. Apagado salvo OUTBOX_PLATAFORMA_ENVIO=true; media configuración
 * lo deja apagado con un log y nunca impide que el legado arranque. Devuelve null si no arrancó.
 */
export function iniciarOutboxPlataforma(db, { env = process.env, cargarKeyring, log = console } = {}) {
  sincronizarCaptura(db, env);
  if (capturaHabilitada(env)) log.log('[outbox] captura de cambios del matcher y de identidad encendida');
  if (env.OUTBOX_PLATAFORMA_ENVIO !== 'true') return null;
  if (!env.SOMBRA_PLATAFORMA_URL || !env.SOMBRA_KEYRING_FILE) {
    log.error('[outbox] OUTBOX_PLATAFORMA_ENVIO=true sin SOMBRA_PLATAFORMA_URL o SOMBRA_KEYRING_FILE: despachador apagado');
    return null;
  }
  const intervalo = Number(env.OUTBOX_PLATAFORMA_INTERVALO_MS) > 0 ? Number(env.OUTBOX_PLATAFORMA_INTERVALO_MS) : 10_000;
  const lote = Number(env.OUTBOX_PLATAFORMA_LOTE) > 0 ? Number(env.OUTBOX_PLATAFORMA_LOTE) : 50;
  const despachador = crearDespachadorOutbox({
    db, lote, enviar: crearEnvioEventoCatalogo({ url: env.SOMBRA_PLATAFORMA_URL, keyring: cargarKeyring(env.SOMBRA_KEYRING_FILE) }),
  });
  let enCurso = false;
  const vuelta = setInterval(() => {
    if (enCurso) return;
    enCurso = true;
    despachador.unaVuelta()
      .then((r) => { if (r.enviados || r.reintentar || r.rechazados) log.log(`[outbox] enviados=${r.enviados} reintentar=${r.reintentar} rechazados=${r.rechazados}`); })
      .catch((e) => log.error('[outbox] vuelta falló:', e.message))
      .finally(() => { enCurso = false; });
  }, intervalo);
  vuelta.unref?.();
  const alerta = setInterval(() => { try { revisarOutbox(db); } catch (e) { log.error('[outbox] alerta falló:', e.message); } }, 5 * 60_000);
  alerta.unref?.();
  log.log(`[outbox] despachador encendido: cada ${intervalo} ms, lote ${lote}`);
  return { detener() { clearInterval(vuelta); clearInterval(alerta); despachador.detener(); } };
}
