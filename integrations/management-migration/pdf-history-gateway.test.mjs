import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {allowedTarget, createGateway, prefix} from './gateway.mjs';
import {createPdfHistory} from './pdf-proxy.mjs';

const secret = 'synthetic-history-gateway-key-'.repeat(3);
const id = '11111111-2222-4333-8444-555555555555';
const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const pdf = Buffer.from('%PDF-1.7\nsynthetic history stream\n\x00\xff\n%%EOF');
const cookie = 'connect.sid=synthetic-history-session';
const token = crypto.createHmac('sha256', secret).update('pdf-corrector-worker-v1').digest('hex');
const history = {items: [{id, name: 'Envíos Córdoba_corregido.pdf', day: '2026-10-15'}], total: 1, page: 1, pages: 1, page_size: 20};
const pdfHeaders = (extra = {}) => ({'Content-Type': 'application/pdf', 'X-Fusion-Pdf-Id': id,
  'X-Fusion-Pdf-Total': '16', 'X-Fusion-Pdf-Pages': '3,8',
  'X-Fusion-Pdf-Name': encodeURIComponent('Envíos Córdoba_corregido.pdf'), ...extra});

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  return server.address().port;
}

async function fixture(t, workerHandle) {
  const state = {status: 200, body: {ok: true, user: 'qa', is_admin: true}};
  const calls = [];
  const worker = http.createServer((req, res) => {
    calls.push({url: req.url, method: req.method, headers: req.headers});
    return workerHandle(req, res);
  });
  const workerPort = await listen(t, worker);
  const auth = http.createServer((req, res) => {res.writeHead(state.status); res.end(JSON.stringify(state.body));});
  const authPort = await listen(t, auth);
  const gateway = createGateway({secret, upstreamHost: '127.0.0.1', upstreamPort: 1, authPort,
    pdfHistoryHandle: createPdfHistory(secret, workerPort),
    pdfHandle: () => assert.fail('History routes must not invoke PDF correction')});
  const gatewayPort = await listen(t, gateway);
  return {state, calls, root: `http://127.0.0.1:${gatewayPort}${prefix}/corregir-etiquetas`};
}

function request(url, {method = 'GET', headers = {}, onChunk} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {method, agent: false, headers: {cookie, ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => {chunks.push(chunk); onChunk?.(chunk);});
      res.on('aborted', () => reject(new Error('Response was interrupted')));
      res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.setTimeout(4000, () => req.destroy(new Error('Local test request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function normalWorker(req, res) {
  if (req.url.startsWith('/history')) {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(history));
  }
  res.writeHead(200, pdfHeaders());
  res.end(req.method === 'HEAD' ? undefined : pdf);
}

test('History and file routes allow only exact read paths and unambiguous query keys', () => {
  for (const method of ['GET', 'HEAD']) {
    assert.equal(allowedTarget(prefix + '/corregir-etiquetas/history', method)?.kind, 'pdf-history');
    assert.equal(allowedTarget(prefix + '/corregir-etiquetas/history?q=envios&from=2026-10-14&to=2026-10-15&page=2', method)?.kind, 'pdf-history');
    for (const suffix of ['', '?download=1']) {
      const target = allowedTarget(prefix + '/corregir-etiquetas/files/' + id + suffix, method);
      assert.equal(target?.kind, 'pdf-file');
      assert.equal(target.id, id);
      assert.equal(target.download, Boolean(suffix));
    }
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal(allowedTarget(prefix + '/corregir-etiquetas/history', method), null);
    assert.equal(allowedTarget(prefix + '/corregir-etiquetas/files/' + id, method), null);
  }
  for (const suffix of ['/history/', '/history?q=one&q=two', '/history?from=a&from=b',
    '/history?unknown=1', '/history?download=1', '/history?callback=x', '/history?page=1&page=2',
    '/files/' + id + '?download=0', '/files/' + id + '?download=1&download=1',
    '/files/' + id + '?download=1&q=x', '/files/' + id + '/', '/files/' + id + '.pdf',
    '/files/../history.sqlite3', '/files/%31' + id.slice(1), '/files/not-a-uuid',
    '/files/11111111-2222-1333-8444-555555555555']) {
    assert.equal(allowedTarget(prefix + '/corregir-etiquetas' + suffix), null, suffix);
  }
});

test('GET and HEAD history and files require a current administrator session', async t => {
  const {root, state, calls} = await fixture(t, normalWorker);
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/history', '/files/' + id]) {
      state.status = 401;
      state.body.ok = false;
      assert.equal((await request(root + path, {method})).status, 401);
      state.status = 200;
      state.body.ok = true;
      state.body.is_admin = false;
      assert.equal((await request(root + path, {method})).status, 403);
    }
  }
  assert.equal(calls.length, 0);
  state.body.is_admin = true;
  for (const method of ['GET', 'HEAD']) for (const path of ['/history', '/files/' + id]) {
    const result = await request(root + path, {method});
    assert.equal(result.status, 200);
    assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    if (method === 'HEAD') assert.equal(result.body.length, 0);
  }
  assert.equal(calls.length, 4);
  for (const method of ['POST', 'DELETE']) for (const path of ['/history', '/files/' + id]) {
    assert.equal((await request(root + path, {method})).status, 423);
  }
  assert.equal(calls.length, 4);
});

test('History GET and HEAD preserve filter queries and forward only private worker authorization', async t => {
  const {root, calls} = await fixture(t, normalWorker);
  const query = '?q=C%C3%B3rdoba+%25_&from=2026-10-14&to=2026-10-15&page=2';
  const forged = {authorization: 'Bearer forged', 'x-fusion-pdf-user': 'forged', origin: 'https://untrusted.invalid'};
  const result = await request(root + '/history' + query, {headers: forged});
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(result.body), history);
  const head = await request(root + '/history' + query, {method: 'HEAD', headers: forged});
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'HEAD']);
  for (const call of calls) {
    assert.equal(call.url, '/history' + query);
    assert.equal(call.headers.authorization, 'Bearer ' + token);
    for (const field of ['cookie', 'origin', 'x-fusion-pdf-user', 'x-fusion-csrf']) assert.equal(call.headers[field], undefined);
  }
});

test('Invalid query structure is blocked before the worker and semantic filter errors retain status 400', async t => {
  const {root, calls} = await fixture(t, (req, res) => {
    res.writeHead(400, {'Content-Type': 'application/json'});
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({message: 'Filtros no válidos.'}));
  });
  for (const query of ['?q=a&q=b', '?page=1&page=2', '?from=a&from=b', '?unknown=1', '?callback=x']) {
    assert.equal((await request(root + '/history' + query)).status, 404);
  }
  assert.equal(calls.length, 0);
  for (const query of ['?from=2026-02-30', '?page=0', '?from=2026-10-16&to=2026-10-15']) {
    const result = await request(root + '/history' + query);
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.body), {message: 'Filtros no válidos.'});
  }
  const head = await request(root + '/history?page=0', {method: 'HEAD'});
  assert.equal(head.status, 400);
  assert.equal(head.body.length, 0);
});

test('Saved PDF bytes stream before the worker finishes; HEAD has no body and download uses UTF-8 filename', async t => {
  let release, firstData;
  const held = new Promise(resolve => {release = resolve;});
  const firstChunk = new Promise(resolve => {firstData = resolve;});
  t.after(() => release());
  let hold = true;
  const {root, calls} = await fixture(t, async (req, res) => {
    res.writeHead(200, pdfHeaders({'Content-Length': String(pdf.length)}));
    if (req.method === 'HEAD') return res.end();
    res.write(pdf.subarray(0, 10));
    if (hold) {hold = false; await held;}
    res.end(pdf.subarray(10));
  });
  const pending = request(root + '/files/' + id, {onChunk: firstData});
  await firstChunk;
  release();
  const result = await pending;
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, pdf);
  assert.equal(result.headers['x-fusion-pdf-id'], id);
  assert.equal(result.headers['x-fusion-pdf-total'], '16');
  assert.equal(result.headers['x-fusion-pdf-pages'], '3,8');
  const encoded = encodeURIComponent('Envíos Córdoba_corregido.pdf');
  assert.equal(result.headers['content-disposition'], `inline; filename="etiquetas_corregidas.pdf"; filename*=UTF-8''${encoded}`);
  const download = await request(root + '/files/' + id + '?download=1');
  assert.deepEqual(download.body, pdf);
  assert.equal(download.headers['content-disposition'], `attachment; filename="etiquetas_corregidas.pdf"; filename*=UTF-8''${encoded}`);
  const head = await request(root + '/files/' + id + '?download=1', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['x-fusion-pdf-id'], id);
  assert.equal(head.headers['content-disposition'], download.headers['content-disposition']);
  assert.deepEqual(calls.map(call => [call.method, call.url]), [['GET', '/files/' + id], ['GET', '/files/' + id], ['HEAD', '/files/' + id]]);
});

test('A file response with mismatched ID or malformed metadata is rejected before PDF bytes are exposed', async t => {
  let extra = {};
  const {root} = await fixture(t, (req, res) => {res.writeHead(200, pdfHeaders(extra)); res.end(req.method === 'HEAD' ? undefined : pdf);});
  for (extra of [
    {'X-Fusion-Pdf-Id': otherId}, {'X-Fusion-Pdf-Id': ''}, {'X-Fusion-Pdf-Id': 'not-a-uuid'},
    {'X-Fusion-Pdf-Total': '301'}, {'X-Fusion-Pdf-Total': '1.5'},
    {'X-Fusion-Pdf-Pages': ''}, {'X-Fusion-Pdf-Pages': '0'}, {'X-Fusion-Pdf-Pages': '17'},
    {'X-Fusion-Pdf-Name': '%ZZ'}, {'X-Fusion-Pdf-Name': 'x'.repeat(2001)},
  ]) {
    const result = await request(root + '/files/' + id);
    assert.equal(result.status, 503, JSON.stringify(extra));
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.ok(JSON.parse(result.body).message);
    assert.ok(!result.body.includes(pdf));
    assert.equal(result.headers['x-fusion-pdf-id'], undefined);
  }
  const head = await request(root + '/files/' + id, {method: 'HEAD'});
  assert.equal(head.status, 503);
  assert.equal(head.body.length, 0);
});

test('Worker filenames cannot inject headers or path separators into the public disposition', async t => {
  const unsafeName = '../folder/Env\r\níos "Córdoba\'s".pdf';
  const safeName = '.._folder_Env__íos _Córdoba\'s_.pdf';
  const {root} = await fixture(t, (req, res) => {
    res.writeHead(200, pdfHeaders({'X-Fusion-Pdf-Name': encodeURIComponent(unsafeName)}));
    res.end(pdf);
  });
  const result = await request(root + '/files/' + id + '?download=1');
  assert.equal(result.status, 200);
  assert.equal(decodeURIComponent(result.headers['x-fusion-pdf-name']), safeName);
  assert.equal(result.headers['content-disposition'], `attachment; filename="etiquetas_corregidas.pdf"; filename*=UTF-8''${encodeURIComponent(safeName).replace(/'/g, '%27')}`);
  assert.doesNotMatch(result.headers['content-disposition'], /[\r\n]/);
});

test('Worker not-found and busy responses pass through without pretending to return a PDF', async t => {
  let status = 404;
  const {root} = await fixture(t, (req, res) => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({message: status === 404 ? 'Archivo no encontrado.' : 'Hay otro PDF en proceso.'}));
  });
  for (status of [404, 429, 503]) {
    const result = await request(root + '/files/' + id);
    assert.equal(result.status, status);
    assert.match(result.headers['content-type'], /^application\/json/);
    assert.ok(JSON.parse(result.body).message);
    assert.equal(result.headers['content-disposition'], undefined);
  }
});
