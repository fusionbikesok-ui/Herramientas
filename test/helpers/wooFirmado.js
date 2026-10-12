import crypto from 'crypto';

export const SECRETO_WOO = 'secreto-test-woo';
export const WEBHOOK_ID_WOO = '7';

/** Deja la guardia de webhooks Woo configurada como en prod: secreto y override de IDs conocidos. */
export function activarGuardiaWoo() {
  process.env.WOO_WEBHOOK_SECRET = SECRETO_WOO;
  process.env.WOO_WEBHOOK_IDS = WEBHOOK_ID_WOO;
}
export function desactivarGuardiaWoo() {
  delete process.env.WOO_WEBHOOK_SECRET;
  delete process.env.WOO_WEBHOOK_IDS;
}

/** POST firmado (HMAC-SHA256 del cuerpo crudo, como WC) a un webhook Woo. Devuelve el request de supertest. */
export function postWoo(request, app, ruta, payload, { topic = null, deliveryId = null, webhookId = WEBHOOK_ID_WOO, firmar = true, secreto = SECRETO_WOO } = {}) {
  const cuerpo = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const porDefecto = ruta.endsWith('/product') ? 'product.updated' : 'order.updated';
  const req = request(app).post(ruta).set('content-type', 'application/json')
    .set('x-wc-webhook-topic', topic ?? porDefecto)
    .set('x-wc-webhook-id', String(webhookId));
  if (deliveryId) req.set('x-wc-webhook-delivery-id', deliveryId);
  if (firmar) req.set('x-wc-webhook-signature', crypto.createHmac('sha256', secreto).update(cuerpo).digest('base64'));
  return req.send(cuerpo);
}
