import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { allowedTarget, makeClaim, createGateway, prefix } from './gateway.mjs';
const secret = 'a'.repeat(64);
test('Only known read routes and assets are accepted', () => {
  for (const suffix of ['/', '/?fm_module=taller', '/?fm_module=facturador&view=history', '/?page_id=1000000000', '/?rest_route=%2Ffusion-taller%2Fv1%2Fjobs&page=1', '/wp-content/plugins/fusion-taller/assets/app.js']) assert.ok(allowedTarget(prefix + suffix), suffix);
  for (const suffix of ['/wp-login.php', '/wp-admin/admin.php', '/?fbpos_prepare=x', '/?rest_route=/wp/v2/users', '/?rest_route=/fusion-arca/v1/invoices/1/emit', '/?rest_route=/fusion-taller/v1/jobs&rest_route=/wp/v2/users', '/wp-content/plugins/fusion-taller/assets/../../fusion-taller.php', '/%2e%2e/wp-config.php', '/wp-content/uploads/private.pdf']) assert.equal(allowedTarget(prefix + suffix), null, suffix);
  for (const suffix of ['/wp-json/fusion-taller/v1/jobs?_method=POST', '/?rest_route=/fusion-taller/v1/jobs&_method=POST', '/wp-json/fusion-taller/v1/jobs?rest_route=/wp/v2/users']) assert.equal(allowedTarget(prefix + suffix), null, suffix);
  assert.equal(allowedTarget(prefix + '/wp-json/fusion-taller/v1/jobs?page=1').local, '/index.php?page=1&rest_route=%2Ffusion-taller%2Fv1%2Fjobs');
  assert.ok(allowedTarget(prefix + '/?fbpos_quote=abc123def456ghi789'));
  assert.equal(allowedTarget(prefix + '/?fbpos_quote=abc123def456ghi789&fbpos_prepare=anything'), null);
});
test('Claim binds identity, exact URL, method and expiry', () => {
  const headers = makeClaim('Matias', 'GET', '/?fm_module=taller', secret, 100);
  assert.deepEqual(JSON.parse(Buffer.from(headers['x-fusion-claim'], 'base64')), { user: 'Matias', method: 'GET', uri: '/?fm_module=taller', time: 100 });
  assert.equal(headers['x-fusion-signature'], crypto.createHmac('sha256', secret).update(headers['x-fusion-claim']).digest('hex'));
});
test('Gateway enforces current session, admin, write lock and header isolation', async t => {
  let authState = { status: 401, data: { ok: false } }; let upstreamCalls = 0;
  const auth = http.createServer((req, res) => { assert.equal(req.url, '/api/auth/me'); res.writeHead(authState.status); res.end(JSON.stringify(authState.data)); });
  const upstream = http.createServer((req, res) => { upstreamCalls++; assert.equal(req.headers.cookie, undefined); assert.notEqual(req.headers['x-fusion-claim'], 'attacker'); assert.ok(req.headers['x-fusion-signature']); res.setHeader('Set-Cookie', 'bad=cookie'); res.end('private content'); });
  for (const server of [auth, upstream]) await new Promise(r => server.listen(0, '127.0.0.1', r));
  const gateway = createGateway({ secret, upstreamHost: '127.0.0.1', upstreamPort: upstream.address().port, authPort: auth.address().port });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  t.after(() => { for (const server of [auth, upstream, gateway]) server.close(); });
  const root = 'http://127.0.0.1:' + gateway.address().port + prefix;
  assert.equal((await fetch(root + '/')).status, 401);
  authState = { status: 200, data: { ok: true, user: 'operador', is_admin: false } };
  assert.equal((await fetch(root + '/')).status, 403);
  authState.data.is_admin = true;
  assert.equal((await fetch(root + '/')).status, 200);
  assert.equal((await fetch(root + '/?rest_route=/fusion-taller/v1/jobs', { method: 'POST', body: '{}' })).status, 423);
  const result = await fetch(root + '/?fm_module=taller', { headers: { cookie: 'connect.sid=test', 'x-fusion-claim': 'attacker', 'x-fusion-signature': 'attacker' } });
  assert.equal(result.status, 200); assert.equal(await result.text(), 'private content'); assert.equal(result.headers.get('set-cookie'), null);
  authState.status = 401;
  assert.equal((await fetch(root + '/?fm_module=taller')).status, 401); assert.equal(upstreamCalls, 1);
});
test('Metrics require current admin session and read exclusively from local adapter',async t=>{
 let isAdmin=false,calls=0;const auth=http.createServer((req,res)=>{res.end(JSON.stringify({ok:true,user:'test',is_admin:isAdmin}));});await new Promise(r=>auth.listen(0,'127.0.0.1',r));
 const gateway=createGateway({secret,upstreamHost:'127.0.0.1',upstreamPort:1,authPort:auth.address().port,metricsRead:()=>{calls++;return {success:true,data:{rows:[]}};}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>{auth.close();gateway.close();});
 const url='http://127.0.0.1:'+gateway.address().port+prefix+'/ventas/api?kind=options';assert.equal((await fetch(url)).status,403);assert.equal(calls,0);isAdmin=true;const r=await fetch(url);assert.equal(r.status,200);assert.equal(r.headers.get('x-fusion-metrics-source'),'vps-local');assert.equal(calls,1);assert.equal((await fetch(url,{method:'POST'})).status,423);
 assert.equal(allowedTarget(prefix+'/ventas/api?kind=options&callback=x'),null);
});
