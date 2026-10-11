import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {createGateway, allowedTarget, prefix} from './gateway.mjs';
import {csrfToken} from './andreani.mjs';
import {createPdfProxy} from './pdf-proxy.mjs';

const secret = 'synthetic-pdf-test-key-'.repeat(4);
const origin = 'https://herramientas.fusionbikes.com.ar';
const cookie = 'connect.sid=synthetic-test-session';
const pdfBytes = Buffer.from('%PDF-1.7\nsynthetic HTTP test payload');
const defaultRule = {
  before: {weight: '9000', width: '20', height: '30', length: '40'},
  after: {weight: '15000', width: '25', height: '70', length: '150'},
};
const ruleJson = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
const headers = {
  cookie, origin, 'content-type': 'application/pdf',
  'x-fusion-csrf': csrfToken(secret, 'qa', cookie),
};

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  return server.address().port;
}

async function gatewayFixture(t, pdfHandle) {
  const state = {status: 200, body: {ok: true, user: 'qa', is_admin: true}};
  const auth = http.createServer((req, res) => {
    assert.equal(req.url, '/api/auth/me');
    res.writeHead(state.status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(state.body));
  });
  const authPort = await listen(t, auth);
  const gateway = createGateway({secret, origin, upstreamHost: '127.0.0.1', upstreamPort: 1, authPort, pdfHandle});
  const port = await listen(t, gateway);
  return {state, root: `http://127.0.0.1:${port}${prefix}`};
}

function rawPost(url, requestHeaders, body = pdfBytes) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {method: 'POST', headers: requestHeaders, agent: false}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    // write() without Content-Length exercises the streaming size guard.
    if (body) req.write(body);
    req.end();
  });
}

test('PDF routes are exact and cannot be repurposed with query parameters', () => {
  for (const [path, kind] of [['/corregir-etiquetas/', 'pdf-page'], ['/corregir-etiquetas/api', 'pdf-api'], ['/assets/pdf-corrector.js', 'asset'], ['/assets/pdf-corrector.css', 'asset']]) {
    assert.equal(allowedTarget(prefix + path)?.kind, kind);
    assert.equal(allowedTarget(prefix + path + '?action=anything'), null);
  }
  for (const path of ['/corregir-etiquetas/file.pdf', '/corregir-etiquetas/api?url=https://example.invalid', '/corregir-etiquetas/api/../worker', '/corregir-etiquetas/%61pi']) {
    assert.equal(allowedTarget(prefix + path), null);
  }
});

test('Gateway requires current administrator session, exact origin and session-bound CSRF', async t => {
  let called = 0;
  const {state, root} = await gatewayFixture(t, async (req, res) => {
    called++;
    for await (const _ of req) { /* consume the accepted upload */ }
    res.writeHead(200, {'Content-Type': 'application/pdf'});
    res.end(pdfBytes);
  });
  const upload = (h = headers) => fetch(root + '/corregir-etiquetas/api', {method: 'POST', headers: h, body: pdfBytes});
  state.status = 401;
  state.body.ok = false;
  assert.equal((await upload()).status, 401);
  assert.equal((await fetch(root + '/corregir-etiquetas/')).status, 401);
  state.status = 200;
  state.body.ok = true;
  state.body.is_admin = false;
  assert.equal((await upload()).status, 403);
  state.body.is_admin = true;
  for (const patch of [
    {origin: 'https://evil.invalid'}, {origin: ''}, {'x-fusion-csrf': ''},
    {'x-fusion-csrf': 'forged'}, {cookie: 'connect.sid=different'},
    {'x-fusion-csrf': csrfToken(secret, 'different-user', cookie)},
    {'x-fusion-csrf': csrfToken(secret, 'qa', cookie, 1)},
  ]) assert.equal((await upload({...headers, ...patch})).status, 403);
  assert.equal(called, 0);
  assert.equal((await fetch(root + '/corregir-etiquetas/api', {headers})).status, 405);
  assert.equal((await fetch(root + '/corregir-etiquetas/api', {method: 'PUT', headers})).status, 423);
  const result = await upload();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(called, 1);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), pdfBytes);
});

test('Authenticated page includes eight editable rule inputs, view, print, download and an embedded preview', async t => {
  const {root} = await gatewayFixture(t, () => assert.fail('Rendering the page must not invoke the worker'));
  const page = await fetch(root + '/corregir-etiquetas/', {headers: {cookie}});
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /name="fusion-csrf" content="[^"\s]+"/);
  for (const id of ['pdf-open', 'pdf-print', 'pdf-download', 'pdf-preview']) assert.ok(html.includes(`id="${id}"`), id);
  for (const side of ['before', 'after']) {
    for (const field of ['weight', 'width', 'height', 'length']) {
      const id = `${side}-${field}`;
      const matches = [...html.matchAll(/<input\b[^>]*>/g)].filter(([input]) => input.includes(`id="${id}"`));
      assert.equal(matches.length, 1, `Exactly one ${id} input is required`);
      const input = matches[0][0];
      assert.match(input, /form="pdf-form"/);
      assert.ok(input.includes(`value="${defaultRule[side][field]}"`), `${id} default value`);
      assert.doesNotMatch(input, /\b(?:disabled|readonly)(?:\s|=|>)/);
    }
  }
  const head = await fetch(root + '/corregir-etiquetas/', {method: 'HEAD', headers: {cookie}});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('Proxy rejects wrong MIME, invalid signature and declared or streamed oversized uploads before the worker', async t => {
  let workerCalls = 0;
  const worker = http.createServer((req, res) => {workerCalls++; res.end();});
  const port = await listen(t, worker);
  const {root} = await gatewayFixture(t, createPdfProxy(secret, port));
  const url = root + '/corregir-etiquetas/api';
  assert.equal((await rawPost(url, {...headers, 'content-type': 'text/plain'})).status, 415);
  assert.equal((await rawPost(url, headers, Buffer.from('no'))).status, 400);
  assert.equal((await rawPost(url, headers, Buffer.from('<html>'))).status, 400);
  assert.equal((await rawPost(url, {...headers, 'content-length': String(10 * 1024 * 1024 + 1)}, null)).status, 413);
  const large = Buffer.alloc(10 * 1024 * 1024 + 1, 32);
  pdfBytes.copy(large);
  assert.equal((await rawPost(url, headers, large)).status, 413);
  assert.equal(workerCalls, 0);
});

test('Proxy sends only internal authorization and returns validated correction metadata', async t => {
  let received;
  const worker = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks)};
    res.writeHead(200, {'X-Fusion-Pdf-Total': '16', 'X-Fusion-Pdf-Pages': '3,8'});
    res.end(pdfBytes);
  });
  const port = await listen(t, worker);
  const {root} = await gatewayFixture(t, createPdfProxy(secret, port));
  const result = await rawPost(root + '/corregir-etiquetas/api', headers);
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'application/pdf');
  assert.equal(result.headers['x-fusion-pdf-total'], '16');
  assert.equal(result.headers['x-fusion-pdf-pages'], '3,8');
  assert.match(result.headers['content-disposition'], /attachment; filename="etiquetas_corregidas\.pdf"/);
  assert.deepEqual(result.body, pdfBytes);
  assert.equal(received.url, '/correct');
  assert.equal(received.method, 'POST');
  assert.deepEqual(received.body, pdfBytes);
  assert.equal(received.headers.cookie, undefined);
  assert.equal(received.headers.origin, undefined);
  assert.equal(received.headers['x-fusion-csrf'], undefined);
  assert.equal(received.headers.authorization, 'Bearer ' + crypto.createHmac('sha256', secret).update('pdf-corrector-worker-v1').digest('hex'));
});

test('Proxy propagates rule errors and rejects malformed worker success metadata', async t => {
  let mode = 'rule-error';
  const worker = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    if (mode === 'rule-error') {
      res.writeHead(422, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({message: 'No hay etiquetas con la combinación.'}));
    } else {
      res.writeHead(200, mode === 'invalid-total' ? {'X-Fusion-Pdf-Total': '301', 'X-Fusion-Pdf-Pages': '1'} : {'X-Fusion-Pdf-Total': '1'});
      res.end(pdfBytes);
    }
  });
  const port = await listen(t, worker);
  const {root} = await gatewayFixture(t, createPdfProxy(secret, port));
  const url = root + '/corregir-etiquetas/api';
  const ruleError = await rawPost(url, headers);
  assert.equal(ruleError.status, 422);
  assert.match(JSON.parse(ruleError.body).message, /No hay etiquetas/);
  for (mode of ['invalid-total', 'missing-pages']) {
    const result = await rawPost(url, headers);
    assert.equal(result.status, 503);
    assert.ok(!result.body.subarray(0, 5).equals(Buffer.from('%PDF-')));
  }
});

test('Proxy accepts one active job, rejects concurrency, then releases its slot', async t => {
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;});
  let hold = true;
  const worker = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    if (hold) {
      hold = false;
      entered();
      await new Promise(resolve => {release = resolve;});
    }
    res.writeHead(200, {'X-Fusion-Pdf-Total': '1', 'X-Fusion-Pdf-Pages': '1'});
    res.end(pdfBytes);
  });
  const port = await listen(t, worker);
  const {root} = await gatewayFixture(t, createPdfProxy(secret, port));
  const url = root + '/corregir-etiquetas/api';
  const first = rawPost(url, headers);
  await started;
  try {
    assert.equal((await rawPost(url, headers)).status, 429);
  } finally {release();}
  assert.equal((await first).status, 200);
  assert.equal((await rawPost(url, headers)).status, 200);
});

test('Proxy forwards a normalized manual rule and accepts single-field edits and allowed extremes', async t => {
  const received = [];
  const worker = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({rule: req.headers['x-fusion-pdf-rule'], body: Buffer.concat(chunks)});
    res.writeHead(200, {'X-Fusion-Pdf-Total': '1', 'X-Fusion-Pdf-Pages': '1'});
    res.end(pdfBytes);
  });
  const port = await listen(t, worker);
  const {root} = await gatewayFixture(t, createPdfProxy(secret, port));
  const url = root + '/corregir-etiquetas/api';
  const custom = {
    before: {weight: '12345', width: '12', height: '34', length: '56'},
    after: {weight: '67890', width: '65', height: '43', length: '21'},
  };
  const validRules = [custom,
    ...['weight', 'width', 'height', 'length'].map(field => ({before: {...defaultRule.before}, after: {...defaultRule.before, [field]: '1'}})),
    {before: {weight: '1', width: '1', height: '1', length: '1'},
     after: {weight: '999999', width: '9999', height: '9999', length: '9999'}},
  ];
  for (const rule of validRules) {
    const result = await rawPost(url, {...headers, 'x-fusion-pdf-rule': '  ' + ruleJson(rule).replaceAll(':', ': ') + '  '});
    assert.equal(result.status, 200);
    const passed = received.at(-1);
    assert.deepEqual(JSON.parse(passed.rule), rule);
    assert.equal(passed.rule, JSON.stringify(JSON.parse(passed.rule)), 'The worker receives compact canonical JSON');
    assert.deepEqual(passed.body, pdfBytes);
  }
  assert.equal(received.length, validRules.length);
  // A following request without a rule must never inherit an earlier manual rule.
  assert.equal((await rawPost(url, headers)).status, 200);
  const last = received.at(-1).rule;
  if (last !== undefined) assert.deepEqual(JSON.parse(last), defaultRule);
});

test('Proxy rejects invalid manual rule schemas and field values before contacting the worker', async t => {
  let workerCalls = 0;
  const worker = http.createServer(async (req, res) => {
    workerCalls++;
    for await (const _ of req) { /* consume if a regression lets this through */ }
    res.writeHead(200, {'X-Fusion-Pdf-Total': '1', 'X-Fusion-Pdf-Pages': '1'});
    res.end(pdfBytes);
  });
  const port = await listen(t, worker);
  const {root} = await gatewayFixture(t, createPdfProxy(secret, port));
  const url = root + '/corregir-etiquetas/api';
  const invalidRules = [null, {}, [], true, false, 1, 'default',
    {before: defaultRule.before}, {after: defaultRule.after},
    {...defaultRule, extra: 'rejected'}, {before: defaultRule.before, after: defaultRule.before}];
  for (const side of ['before', 'after']) {
    for (const wrong of [null, {}, [], '9000', true, 9]) invalidRules.push({...structuredClone(defaultRule), [side]: wrong});
    invalidRules.push({...structuredClone(defaultRule), [side]: {...defaultRule[side], extra: '1'}});
    for (const field of ['weight', 'width', 'height', 'length']) {
      const missing = structuredClone(defaultRule);
      delete missing[side][field];
      invalidRules.push(missing);
      for (const bad of ['', null, true, false, 1, 1.2, [], {}, '0', '-1', '+1', '1.5', '1,5', '1e2', ' 1', '1 ', '1\n', '١', '１', '1 Gr', '1'.repeat(field === 'weight' ? 7 : 5)]) {
        const rule = structuredClone(defaultRule);
        rule[side][field] = bad;
        invalidRules.push(rule);
      }
    }
  }
  for (const rule of invalidRules) {
    const result = await rawPost(url, {...headers, 'x-fusion-pdf-rule': ruleJson(rule)});
    assert.equal(result.status, 400, `Invalid rule must be rejected: ${ruleJson(rule)}`);
    assert.ok(JSON.parse(result.body).message);
  }
  // Keep padding inside JSON: HTTP parsers trim header outer whitespace before validation.
  for (const raw of ['', '{', '[' + ' '.repeat(1024) + ']', ruleJson(defaultRule).slice(0, -1) + ' '.repeat(1024) + '}']) {
    const result = await rawPost(url, {...headers, 'x-fusion-pdf-rule': raw});
    assert.equal(result.status, 400, `Malformed or oversized rule, length=${raw.length}`);
  }
  assert.equal(workerCalls, 0);
});

test('An invalid rule does not retain the processing lock and valid edits remain behind CSRF', async t => {
  let workerCalls = 0;
  const worker = http.createServer(async (req, res) => {
    workerCalls++;
    for await (const _ of req) { /* consume */ }
    res.writeHead(200, {'X-Fusion-Pdf-Total': '1', 'X-Fusion-Pdf-Pages': '1'});
    res.end(pdfBytes);
  });
  const port = await listen(t, worker);
  const {root} = await gatewayFixture(t, createPdfProxy(secret, port));
  const url = root + '/corregir-etiquetas/api';
  assert.equal((await rawPost(url, {...headers, 'x-fusion-pdf-rule': '{}'})).status, 400);
  const ruleHeaders = {...headers, 'x-fusion-pdf-rule': ruleJson(defaultRule)};
  assert.equal((await rawPost(url, {...ruleHeaders, 'x-fusion-csrf': 'forged'})).status, 403);
  assert.equal(workerCalls, 0);
  assert.equal((await rawPost(url, ruleHeaders)).status, 200);
  assert.equal(workerCalls, 1);
});
