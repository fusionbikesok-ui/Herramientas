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
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_TOPE_MS = 15 * 60_000;
const RETENCION_ENVIADOS_DIAS = 30;

const iso = (d) => d.toISOString();

/** La captura está encendida sólo con el valor exacto: un typo en el .env no la enciende a medias. */
export function capturaHabilitada(env = process.env) {
  return env.OUTBOX_PLATAFORMA_CAPTURA === 'true';
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
    const filas = db.prepare(`SELECT id, evento_id, tipo, payload, intentos FROM outbox_plataforma
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
          await enviar({ evento_id: f.evento_id, tipo: f.tipo, payload: JSON.parse(f.payload) });
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

/** El envío real: POST firmado a la API interna del catálogo. */
export function crearEnvioEventoCatalogo({ url, keyring, fetch: hacerFetch = globalThis.fetch, timeoutMs = 5000 }) {
  const destino = new URL(RUTA_EVENTOS_CATALOGO, new URL(url));
  const clave = keyring.keys[keyring.activeKeyId];
  if (!clave) throw new Error('clave activa ausente para la outbox');
  return async function enviarEvento({ evento_id, tipo, payload }) {
    if (tipo !== 'matcher.decision') throw new RechazoPlataforma(`tipo desconocido: ${tipo}`);
    const cuerpo = Buffer.from(JSON.stringify({ evento_id, ...payload }));
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString('base64url');
    let r;
    try {
      r = await hacerFetch(destino, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-fusion-key-id': keyring.activeKeyId, 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
          'x-fusion-signature': firmarInterno(clave, ts, nonce, 'POST', RUTA_EVENTOS_CATALOGO, cuerpo),
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
