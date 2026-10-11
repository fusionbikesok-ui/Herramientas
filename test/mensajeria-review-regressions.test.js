// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { createCommerce } from '../lib/mensajeriaCommerce.js';
import { createInvoiceSource } from '../lib/mensajeriaInvoiceSource.js';
import { mensajeriaRouter } from '../routes/mensajeria.js';
import { savedReply } from '../public/mensajeria/message-actions.js';
import { savedAttachment } from '../public/mensajeria/app.js';

const contract = JSON.parse(readFileSync(new URL('./fixtures/mensajeria-web-contract.json', import.meta.url), 'utf8'));

describe('Regresión del contrato compartido entre WordPress y el lector de facturas', () => {
  it('consume la misma respuesta que valida MessagingRead, con número fiscal e identidad de PDF', async () => {
    const fetcher = vi.fn(async url => new Response(JSON.stringify(String(url).endsWith('/pdf') ? contract.pdf : contract.order)));
    const read = createInvoiceSource({ env: { WOO_URL: 'https://fusionbikes.com.ar', WOO_CK: 'fixture-key', WOO_CS: 'fixture-secret' }, fetchImpl: fetcher });
    const order = await read({ orderId: 101, phone: '+5493517000001' });
    expect(order.invoices).toEqual([{ id: 201, label: 'Factura B 00015-00000001', date: '2026-10-07', total: '100.00' }]);
    const pdf = await read({ orderId: 101, invoiceId: order.invoices[0].id, phone: '+5493517000001' });
    expect(pdf).toEqual({ name: 'Factura-fixture.pdf', mime: 'application/pdf', data_base64: contract.pdf.data_base64 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('no acepta la antigua respuesta con identidad de PDF solamente anidada', async () => {
    const legacy = { ...contract.pdf }; delete legacy.order_id; delete legacy.invoice_id;
    const read = createInvoiceSource({ env: { WOO_URL: 'https://fusionbikes.com.ar', WOO_CK: 'fixture-key', WOO_CS: 'fixture-secret' }, fetchImpl: async () => new Response(JSON.stringify(legacy)) });
    await expect(read({ orderId: 101, invoiceId: 201, phone: '+5493517000001' })).rejects.toHaveProperty('code', 'invoice_identity_mismatch');
  });
});

describe('Regresión de factura preparada después de recargar la bandeja', () => {
  // These are the actual private production serializers. Execute them in a tiny
  // storage harness, without duplicating their implementation or booting the UI.
  const app = readFileSync(new URL('../public/mensajeria/app.js', import.meta.url), 'utf8');
  const serializers = app.slice(app.indexOf('  function persist() {'), app.indexOf('  async function api('));
  function storageHarness(state, storage) {
    return runInNewContext(`${serializers}\n({persist,restore})`, {
      state, savedAttachment, savedReply, text: value => value == null ? '' : String(value),
      sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) },
    });
  }

  it('el recorrido persistir → página nueva → restaurar conserva PDF y texto del mismo chat', () => {
    const storage = new Map(), key = 'whatsapp:line:5493517000001';
    const state = { storageKey: 'mensajeria-drafts-v1:herramientas:1', drafts: new Map([[key, {
      reply: 'Te compartimos el comprobante del pedido #101.', note: 'Nota privada', file: null,
      uploaded: { media_id: 'pdf-fixture-201', name: 'Factura-fixture.pdf', mime: 'application/pdf', data_base64: 'never-persist-document-bytes' },
    }]]), operations: new Map() };
    storageHarness(state, storage).persist();
    const fresh = { storageKey: state.storageKey, drafts: new Map(), operations: new Map() };
    storageHarness(fresh, storage).restore();
    expect(fresh.drafts.get(key)).toEqual({ reply: 'Te compartimos el comprobante del pedido #101.', note: 'Nota privada', file: null, replyTo: null, uploaded: { media_id: 'pdf-fixture-201', name: 'Factura-fixture.pdf', mime: 'application/pdf' } });
    expect(storage.get(state.storageKey)).not.toContain('never-persist-document-bytes');
    expect(fresh.drafts.has('whatsapp:another-line:5493517000001')).toBe(false);
    const anotherActor = { storageKey: 'mensajeria-drafts-v1:herramientas:2', drafts: new Map(), operations: new Map() };
    storageHarness(anotherActor, storage).restore();
    expect(anotherActor.drafts.size).toBe(0);
  });
});

describe('Persistencia de respuesta puntual',()=>{
 it('conserva cita y descarta una referencia malformada',()=>{
  const source=readFileSync(new URL('../public/mensajeria/app.js',import.meta.url),'utf8');
  const serializers=source.slice(source.indexOf('  function persist() {'),source.indexOf('  async function api('));
  const storage=new Map(),key='whatsapp:fixture:customer',quote={id:'123',version:'a'.repeat(64),author:'Cliente',text:'Consulta'};
  const state={storageKey:'fixture',drafts:new Map([[key,{reply:'Respuesta',note:'',replyTo:quote}]]),operations:new Map()};
  const harness=runInNewContext(`${serializers}\n({persist,restore})`,{state,savedReply,savedAttachment,text:v=>String(v||''),sessionStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)}});
  harness.persist();state.drafts=new Map();harness.restore();expect(state.drafts.get(key).replyTo).toEqual(quote);
  state.drafts.get(key).replyTo={...quote,id:'no'};harness.persist();state.drafts=new Map();harness.restore();expect(state.drafts.get(key).replyTo).toBeNull();
 });
});

describe('Regresión de coincidencia de dígitos nacionales entre países', () => {
  it('BFF + índice local aíslan AR/US y reciben el teléfono internacional de Cloud sin +', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'messaging-review-country-'));
    const directoryPath = join(folder, 'directory.sqlite');
    const db = new Database(':memory:');
    let source;
    try {
      const timestamp = new Date().toISOString();
      db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,is_admin INTEGER,activo INTEGER);
        CREATE TABLE user_permisos(user_id INTEGER,herramienta TEXT,nivel TEXT);
        CREATE TABLE preparaciones(id INTEGER PRIMARY KEY,canal TEXT,wc_order_id INTEGER,tracking TEXT,woo_paso1_incierto INTEGER,woo_paso2_pendiente INTEGER);
        INSERT INTO users VALUES(1,'Fixture',0,1);
        INSERT INTO preparaciones VALUES(1,'web',101,'360000000101',0,0),(2,'web',102,'360000000102',0,0),(3,'web',103,'360000000103',0,0);`);
      source = new Database(directoryPath);
      source.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,data TEXT); CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT);');
      for (const [key, value] of Object.entries({ orders_at: timestamp, orders_complete: true })) source.prepare('INSERT INTO state VALUES(?,?)').run(key, JSON.stringify(value));
      for (const [id, country, phone] of [[101, 'AR', '3515214819'], [102, 'US', '3515214819'], [103, 'US', '+13515214819']]) {
        source.prepare('INSERT INTO orders VALUES(?,?)').run(id, JSON.stringify({ id, number: String(id), billing: { country, phone, first_name: 'Fixture ' + country }, created_at: timestamp, items: [], total: '1.00', currency: country === 'AR' ? 'ARS' : 'USD' }));
      }
      source.close(); source = null;
      const commerce = createCommerce(db, { directoryPath });
      let customer = '5493515214819';
      const key = 'whatsapp:fixture-line:fixture-contact';
      const backend = vi.fn(async (url, options) => {
        expect(JSON.parse(options.body).op).toBe('thread');
        return new Response(JSON.stringify({ ok: true, thread: { key, channel: 'whatsapp', phone: customer, owner_id: 'herramientas:1', status: 'open', can_send: true } }));
      });
      const app = express();
      app.use(session({ secret: 'fixture-session-secret', resave: false, saveUninitialized: true }));
      app.use((req, res, next) => { req.user = { id: 1, username: 'Fixture', permisos: [{ herramienta: 'mensajeria', nivel: 'write' }] }; next(); });
      app.use('/api', mensajeriaRouter(db, { env: { INBOX_PROXY_SECRET: 'fixture-only-proxy-secret-long-enough' }, commerce, fetchImpl: backend, invoiceSource: vi.fn() }));
      const ar = await request(app).get('/api/commerce/orders').query({ key, phone: '+13515214819' });
      expect(ar.status).toBe(200);
      expect(ar.body.orders.map(order => order.id)).toEqual([101]);
      expect(ar.body.orders[0].tracking.map(item => item.number)).toEqual(['360000000101']);
      expect(() => commerce.orderForPhone('+5493515214819', 102)).toThrow('No hay un pedido');
      customer = '13515214819';
      const us = await request(app).get('/api/commerce/orders').query({ key });
      expect(us.status).toBe(200);
      expect(us.body.orders.map(order => order.id)).toEqual([103]);
      expect(us.body.orders[0].tracking.map(item => item.number)).toEqual(['360000000103']);
      expect(() => commerce.orderForPhone('+13515214819', 101)).toThrow('No hay un pedido');
    } finally { source?.close(); db.close(); rmSync(folder, { recursive: true, force: true }); }
  });
});
