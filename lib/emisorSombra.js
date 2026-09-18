/**
 * E1 T3 — emisor de la copia de sombra: convierte un recibo de `integration_events` en una señal y la
 * manda firmada a la API interna de la plataforma (`POST /internal/v1/reconciliation-signals`, corte C3).
 *
 * Corre DESPUÉS del ACK, dentro de la cola acotada de `lib/sombra.js`: un solo intento, 250 ms de techo.
 * La señal lleva canal, tópico E1, id remoto pelado y un fingerprint derivado del recibo; nunca payload,
 * PII ni credenciales. La cuenta la decide la plataforma por canal.
 */
import crypto from 'crypto';
import { firmarInterno } from './internoHmac.js';

export const RUTA_SENALES = '/internal/v1/reconciliation-signals';

// Equivalencia de avisos remotos con los ocho tópicos de E1 (diseño T3 §6) y cómo sacar el id remoto.
const ML = {
  orders: ['ml.orders', /^\/orders\/(\d{1,20})$/],
  orders_v2: ['ml.orders', /^\/orders\/(\d{1,20})$/],
  shipments: ['ml.shipments', /^\/shipments\/(\d{1,20})$/],
  questions: ['ml.questions', /^\/questions\/(\d{1,20})$/],
  messages: ['ml.messages', /^\/?([A-Za-z0-9_-]{1,128})$/],
  claims: ['ml.claims', /^\/(?:post-purchase\/v1\/)?claims\/(\d{1,20})$/],
  post_purchase: ['ml.claims', /^\/(?:post-purchase\/v1\/)?claims\/(\d{1,20})$/],
  items: ['ml.items', /^\/items\/([A-Z]{3}\d{1,15})$/],
};

/**
 * Destino de la señal para un recibo, o `null` si el aviso no pertenece a E1 (`excluded/unsupported_topic`).
 * Ampliar la tabla amplía E1 y exige decisión propia.
 */
export function destinoSenal(evento) {
  if (!evento) return null;
  let meta = {};
  try { meta = JSON.parse(evento.metadata_json || '{}'); } catch { return null; }
  const recurso = String(evento.resource_id || '');
  let channel; let topic; let id; let notificacion = null;
  if (evento.channel === 'ml') {
    const regla = ML[String(meta.topic || '')];
    const m = regla ? recurso.match(regla[1]) : null;
    if (!m) return null;
    channel = 'mercadolibre'; topic = regla[0]; id = m[1]; notificacion = meta.notification_id || null;
  } else if (evento.channel === 'woo') {
    const m = recurso.match(/^\/(orders|products)\/(\d{1,20})$/);
    if (!m) return null;
    channel = 'woocommerce'; topic = m[1] === 'orders' ? 'woo.orders' : 'woo.products'; id = m[2]; notificacion = meta.delivery_id || null;
  } else {
    return null;
  }
  return {
    channel, topic, resource_id: id,
    // Un recibo = un aviso: el event_id ya deduplica reentregas, y su hash cabe en el límite de la API.
    fingerprint: `ev:${crypto.createHash('sha256').update(evento.event_id).digest('hex')}`,
    ...(notificacion ? { notification_id: String(notificacion).slice(0, 256) } : {}),
    source: 'webhook_copy',
  };
}

/** Envía una señal ya armada. Resuelve con 202; cualquier otro caso rechaza con una razón normalizada. */
export function crearEnvioSenal({ url, keyring, fetch: hacerFetch = globalThis.fetch, timeoutMs = 1000 }) {
  const destino = new URL(RUTA_SENALES, new URL(url));
  const clave = keyring.keys[keyring.activeKeyId];
  if (!clave) throw new Error('clave activa de sombra ausente');
  return async function enviarSenal(senal) {
    const cuerpo = Buffer.from(JSON.stringify(senal));
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString('base64url');
    let r;
    try {
      r = await hacerFetch(destino, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          'x-fusion-key-id': keyring.activeKeyId, 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
          'x-fusion-signature': firmarInterno(clave, ts, nonce, 'POST', RUTA_SENALES, cuerpo),
        },
        body: cuerpo,
      });
    } catch {
      throw new Error('platform_unavailable');
    }
    await r.body?.cancel?.().catch?.(() => undefined);
    if (r.status === 202) return;
    // 400: el envelope es inválido (dato del recurso). 409: la plataforma dice que el canal o el
    // tópico no corresponden a una cuenta configurada (`channel_topic_mismatch`) — es un problema de
    // nuestra configuración, no del recurso. Ninguno de los dos se arregla reintentando.
    if (r.status === 400) throw new Error('invalid_resource');
    if (r.status === 409) throw new Error('cuenta_no_configurada');
    throw new Error('platform_unavailable');
  };
}

/** `enviar(trabajo)` para `crearColaSombra`: lee el recibo y lo manda como señal. */
export function crearEmisorSombra({ db, ...opciones }) {
  const enviarSenal = crearEnvioSenal(opciones);
  return async function enviar(trabajo) {
    const evento = db.prepare('SELECT event_id, channel, resource_id, metadata_json FROM integration_events WHERE event_id = ?').get(trabajo.eventId);
    const senal = destinoSenal(evento);
    if (!senal) throw new Error('invalid_resource');
    return enviarSenal(senal);
  };
}

/**
 * Importación auditada de las pérdidas (diseño T3 §11, E1-PGDOWN-01). Los recibos descartados porque la
 * plataforma no respondía son el contador durable fuera de PostgreSQL; cuando vuelve, se reenvían como
 * señal con el bloque `import`, y la plataforma deja un evento de auditoría encadenada una sola vez por
 * recibo. Sólo se marca `shadow_imported_at` con 202: lo que no se pudo importar sigue pendiente y visible.
 * Se detiene en el primer `platform_unavailable`: no tiene sentido martillar una plataforma caída. Un
 * `cuenta_no_configurada` NO detiene la tanda: bloquea sólo ese canal, para que un canal mal configurado no
 * impida recuperar las pérdidas de los otros.
 */
export async function importarPerdidas({ db, enviarSenal, limite = 100 }) {
  const filas = db.prepare(`SELECT event_id, channel, resource_id, metadata_json, shadow_reason, completed_at FROM integration_events
    WHERE shadow_status = 'discarded' AND shadow_reason IN ('platform_unavailable','platform_timeout','cuenta_no_configurada') AND shadow_imported_at IS NULL
    ORDER BY received_at LIMIT ?`).all(limite);
  const resultado = { importadas: 0, invalidas: 0, bloqueadas: 0, pendientes: filas.length, detenida: false };
  // Un canal sin configurar no puede frenar la recuperación de los demás: se saltea ESE canal y se sigue.
  // Detener toda la tanda dejaba una fila vieja de ML bloqueando pérdidas nuevas de Woo en cada vuelta.
  const canalesBloqueados = new Set();
  for (const f of filas) {
    if (canalesBloqueados.has(f.channel)) { resultado.bloqueadas++; continue; }
    const senal = destinoSenal(f);
    if (!senal || !f.completed_at) { resultado.invalidas++; continue; }
    try {
      await enviarSenal({ ...senal, import: { discarded_at: new Date(f.completed_at).toISOString(), reason: f.shadow_reason } });
    } catch (e) {
      if (e?.message === 'invalid_resource') { resultado.invalidas++; continue; }
      if (e?.message === 'cuenta_no_configurada') {
        // Basta un intento por canal y por vuelta: si la cuenta sigue sin configurar, insistir con los otros
        // recibos del mismo canal no arregla nada y llena el log.
        canalesBloqueados.add(f.channel);
        resultado.bloqueadas++;
        continue;
      }
      resultado.detenida = true;
      break;
    }
    db.prepare('UPDATE integration_events SET shadow_imported_at = ? WHERE event_id = ?').run(new Date().toISOString(), f.event_id);
    resultado.importadas++;
  }
  resultado.pendientes -= resultado.importadas;
  return resultado;
}
