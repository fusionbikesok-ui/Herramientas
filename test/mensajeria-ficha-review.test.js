import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {mensajeriaRouter} from '../routes/mensajeria.js';
import {createProductSource} from '../lib/mensajeriaProductSource.js';

describe('Revisión independiente: factura única respeta el contexto después de descargar', () => {
  const key = 'whatsapp:111:5493511234567';
  let db, app, thread, invoiceSource, fetcher, commerce;
  beforeEach(() => {
    thread = {key, number_id: '111', channel: 'whatsapp', owner_id: 'herramientas:1', phone: '5493511234567', status: 'open', can_send: true, capabilities: {media: true}};
    db = new Database(':memory:');
    db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, is_admin INTEGER, activo INTEGER); CREATE TABLE user_permisos(user_id INTEGER, herramienta TEXT, nivel TEXT); INSERT INTO users VALUES(1, \'QA\', 0, 1);');
    commerce = {orderForPhone: vi.fn(() => ({id: 41, number: '41'}))};
    invoiceSource = vi.fn(async ({invoiceId}) => invoiceId === undefined ? {invoices: [{id: 88, label: 'Factura B 15-1'}]} : {name: 'Factura.pdf', mime: 'application/pdf', data_base64: 'JVBERi0xLjQK'});
    fetcher = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      return new Response(JSON.stringify(body.op === 'thread' ? {ok: true, thread} : {ok: true, media_id: 'qa-private', name: 'Factura.pdf', mime: 'application/pdf'}));
    });
    app = express();
    app.use(session({secret: 'test-only-independent-review-session', resave: false, saveUninitialized: true}));
    app.use((req, _res, next) => {req.user = {id: 1, username: 'QA', permisos: [{herramienta: 'mensajeria', nivel: 'write'}]}; next();});
    app.use('/api', mensajeriaRouter(db, {env: {INBOX_PROXY_SECRET: 'test-only-independent-review-proxy-secret', INBOX_PUBLIC_ORIGIN: 'https://qa.test'}, fetchImpl: fetcher, commerce, invoiceSource, productSource: {}}));
  });
  afterEach(() => db.close());
  async function prepare() {
    const agent = request.agent(app);
    const {body} = await agent.get('/api/bootstrap');
    return agent.post('/api/commerce/prepare').set('origin', 'https://qa.test').set('x-csrf-token', body.csrf).send({key, kind: 'invoice', order_id: 41, request_id: crypto.randomUUID()});
  }
  const operations = () => fetcher.mock.calls.map(([, options]) => JSON.parse(options.body).op);

  it('no adjunta ni envía si vence la ventana durante la descarga automática del único PDF', async () => {
    invoiceSource.mockImplementation(async ({invoiceId}) => {
      if (invoiceId === undefined) return {invoices: [{id: 88}]};
      thread.can_send = false; thread.send_blocked_reason = 'window_closed';
      return {name: 'Factura.pdf', mime: 'application/pdf', data_base64: 'JVBERi0xLjQK'};
    });
    const response = await prepare();
    expect(response.status).toBe(409); expect(response.body.code).toBe('window_closed');
    expect(invoiceSource).toHaveBeenCalledTimes(2);
    expect(operations()).toEqual(['thread', 'thread']);
  });

  it('no entrega el PDF al cambiar el teléfono aunque siga siendo el mismo agente', async () => {
    invoiceSource.mockImplementation(async ({invoiceId}) => {
      if (invoiceId === undefined) return {invoices: [{id: 88}]};
      thread.phone = '5493519999999';
      return {name: 'Factura.pdf', mime: 'application/pdf', data_base64: 'JVBERi0xLjQK'};
    });
    const response = await prepare();
    expect(response.status).toBe(409); expect(response.body.code).toBe('contact_changed');
    expect(operations()).not.toContain('upload'); expect(operations()).not.toContain('command');
    expect(invoiceSource.mock.calls.map(([value]) => value.phone)).toEqual(['5493511234567', '5493511234567']);
  });

  it('rechaza una relación pedido/teléfono que desapareció del catálogo durante la lectura remota', async () => {
    commerce.orderForPhone.mockImplementationOnce(() => ({id: 41, number: '41'})).mockImplementation(() => {throw Object.assign(new Error('No coincide'), {status: 404, code: 'order_not_found'});});
    const response = await prepare();
    expect(response.status).toBe(404); expect(response.body.code).toBe('order_not_found');
    expect(invoiceSource).toHaveBeenCalledTimes(2); expect(operations()).not.toContain('upload');
  });

  it('un pedido sin comprobantes no intenta descargar ni adjuntar un archivo inventado', async () => {
    invoiceSource.mockResolvedValue({invoices: []});
    const response = await prepare();
    expect(response.status).toBe(200); expect(response.body.selection_required).toBe(true); expect(response.body.invoices).toEqual([]);
    expect(invoiceSource).toHaveBeenCalledTimes(1); expect(operations()).toEqual(['thread', 'thread']);
  });
});

describe('Revisión independiente: límites de lecturas del catálogo comercial', () => {
  const env = {WOO_URL: 'https://fusionbikes.com.ar', WOO_CK: 'fixture-only-key', WOO_CS: 'fixture-only-secret'};
  const product = id => ({id, sku: `FB-${id}`});
  const payload = id => ({schema: 1, currency: 'ARS', items: [{id, sku: `FB-${id}`, name: 'Producto', state: 'ok', source: 'master_control_pricing_engine', quantity: 1, base_amount: '6000.00', free_shipping: false, plans: [6, 9, 12, 18, 24].map(plan => ({plan: String(plan), installment_amount: '1000.00'}))}]});

  it('coalescencia por producto no consume cupos extra y recupera el cupo tras fallos de red', async () => {
    const pending = [];
    const fetchImpl = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    const source = createProductSource({env, fetchImpl});
    const tasks = Array.from({length: 8}, (_, index) => source.quote(product(index + 1)));
    const same = source.quote(product(1));
    const results = Promise.allSettled([...tasks, same]);
    await expect(source.quote(product(9))).rejects.toHaveProperty('code', 'quote_busy');
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    for (const resolve of pending) resolve(new Response('{}', {status: 503}));
    expect((await results).every(item => item.status === 'rejected')).toBe(true);
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify(payload(9))));
    expect((await source.quote(product(9))).cash).toBe(6000);
  });

  it('limita respuestas sin Content-Length y permite reintentar luego del exceso', async () => {
    const oversized = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(128 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();}});
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(oversized)).mockImplementation(async () => new Response(JSON.stringify(payload(1))));
    const source = createProductSource({env, fetchImpl});
    await expect(source.quote(product(1))).rejects.toHaveProperty('code', 'product_quote_unavailable');
    expect((await source.quote(product(1))).cash).toBe(6000);
  });

  it('dos descargas de foto en curso limitan la tercera y liberan el cupo al fallar', async () => {
    const pending = [];
    const fetchImpl = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    const source = createProductSource({env, fetchImpl});
    const p = {...product(1), image: 'https://fusionbikes.com.ar/wp-content/uploads/2026/10/foto.jpg'};
    const first = source.photo(p), second = source.photo(p);
    const results = Promise.allSettled([first, second]);
    await expect(source.photo(p)).rejects.toHaveProperty('code', 'image_busy');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const resolve of pending) resolve(new Response('', {status: 503}));
    await results;
    fetchImpl.mockImplementation(async () => new Response('', {status: 503}));
    await expect(source.photo(p)).rejects.toHaveProperty('code', 'product_image_unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
