import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, prefix, allowedTarget } from './gateway.mjs';

test('POS VPS prepare returns signed store checkout', async (t) => {
  const auth = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, user: 'qa', is_admin: true })));
  await new Promise(resolve => auth.listen(0, '127.0.0.1', resolve));
  const gateway = createGateway({ secret: 'a'.repeat(64), posBridgeKey: 'b'.repeat(64), posEnabled: true, storeOrigin: 'https://fusionbikes.com.ar', upstreamHost: '127.0.0.1', upstreamPort: 1, authPort: auth.address().port });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => { gateway.close(); auth.close(); });
  assert.equal(allowedTarget(prefix + '/wp-json/fbpos/v2/prepare', 'POST').kind, 'pos-prepare');
  const operation = '11111111-1111-4111-8111-111111111111';
  const response = await fetch('http://127.0.0.1:' + gateway.address().port + prefix + '/wp-json/fbpos/v2/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, items: [{ id: 70394, qty: 1 }], gateway: 'woo-mercado-pago-basic', customer_name: 'QA' }) });
  assert.equal(response.status, 200);
  const data = await response.json(); const url = new URL(data.payment_url);
  assert.equal(url.origin, 'https://fusionbikes.com.ar'); assert.equal(url.searchParams.get('fbpos_checkout'), operation); assert.ok(url.searchParams.get('fbpos_vps_data')); assert.equal(url.searchParams.get('fbpos_source'), 'pos-vps');
});
