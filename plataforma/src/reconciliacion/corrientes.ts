/**
 * E1 T5 — fuente única del mapeo tópico de `missed_feeds` → corriente (spec §2.1), del lado de la
 * plataforma. La plataforma no puede importar nada fuera de `plataforma/` (se empaqueta con
 * `plataforma/` como build context, ver `plataforma/deploy/compose.yml`); `lib/gatewayCanal.js` del
 * legado no existe dentro de la imagen. Esta tabla es una copia deliberada, no una reexportación, de la
 * de `lib/gatewayCanal.js` — `test/gatewayCanal.test.js` (legado, mismo checkout que la plataforma en
 * repo) exige por test que ambas tablas coincidan, para que no diverjan en silencio.
 */
export const TOPIC_A_CORRIENTE = Object.freeze({
  orders_v2: 'orders', shipments: 'shipments', questions: 'questions',
  messages: 'messages', claims: 'claims', items: 'items',
});
