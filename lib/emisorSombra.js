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

/** `enviar(trabajo)` para `crearColaSombra`. Resuelve con 202; cualquier otro caso rechaza con una razón normalizada. */
export function crearEmisorSombra({ db, url, keyring, fetch: hacerFetch = globalThis.fetch, timeoutMs = 1000 }) {
  const base = new URL(url);
  const destino = new URL(RUTA_SENALES, base);
  const clave = keyring.keys[keyring.activeKeyId];
  if (!clave) throw new Error('clave activa de sombra ausente');
  return async function enviar(trabajo) {
    const evento = db.prepare('SELECT event_id, channel, resource_id, metadata_json FROM integration_events WHERE event_id = ?').get(trabajo.eventId);
    const senal = destinoSenal(evento);
    if (!senal) throw new Error('invalid_resource');
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
    // 400/409: la plataforma rechaza el envelope o la cuenta; reintentar no lo arregla.
    if (r.status === 400 || r.status === 409) throw new Error('invalid_resource');
    throw new Error('platform_unavailable');
  };
}
