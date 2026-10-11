import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {mensajeriaRouter} from '../routes/mensajeria.js';
import {createInvoiceSource} from '../lib/mensajeriaInvoiceSource.js';

describe('Compartir: autorización, destinatario y preparación sin envío',()=>{
 let db,app,fetcher,commerce,invoiceSource,productSource,thread,role;
 const key='whatsapp:111:5493511234567';
 beforeEach(()=>{
  role='write';thread={key,channel:'whatsapp',owner_id:'herramientas:1',phone:'5493511234567',status:'open',can_send:true,capabilities:{media:true}};
  db=new Database(':memory:');db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,is_admin INTEGER,activo INTEGER);CREATE TABLE user_permisos(user_id INTEGER,herramienta TEXT,nivel TEXT);INSERT INTO users VALUES(1,'QA',0,1);`);
  const order={id:41,number:'41',tracking:[{number:'360000000000000',carrier:'Andreani',url:'https://www.andreani.com/envio/360000000000000'}]};
  commerce={products:vi.fn(()=>({ok:true,products:[]})),product:vi.fn(()=>({id:8,name:'Bicicleta QA',sku:'FB-8',variation:'Negro / S',price:1000,url:'https://fusionbikes.com.ar/?p=7'})),orders:vi.fn(()=>({orders:[order]})),orderForPhone:vi.fn((phone,id)=>{if(phone!=='+'+thread.phone||Number(id)!==41)throw Object.assign(new Error('No coincide'),{status:404,code:'order_not_found'});return order;})};
  invoiceSource=vi.fn(async({invoiceId})=>invoiceId===undefined?{invoices:[{id:88,label:'Factura B 15-1'}]}:{name:'Factura-41.pdf',mime:'application/pdf',data_base64:Buffer.from('%PDF-1.4\nTest only PDF').toString('base64')});
  productSource={quote:vi.fn(async()=>({cash:1000,installments:[{count:6,amount:200}],free_shipping:true})),photo:vi.fn(async()=>null)};
  fetcher=vi.fn(async(url,opts)=>{const b=JSON.parse(opts.body);return new Response(JSON.stringify(b.op==='thread'?{ok:true,thread}:{ok:true,media_id:'qa-pdf',mime:'application/pdf',name:'Factura-41.pdf'}));});
  app=express();app.use(session({secret:'test-only-session-secret',resave:false,saveUninitialized:true}));app.use((req,res,next)=>{req.user={id:1,username:'QA',permisos:[{herramienta:'mensajeria',nivel:role}]};next();});
  app.use('/api',mensajeriaRouter(db,{env:{INBOX_PROXY_SECRET:'test-only-proxy-secret-long-enough',INBOX_PUBLIC_ORIGIN:'https://qa.test'},fetchImpl:fetcher,commerce,invoiceSource,productSource}));
 });
 afterEach(()=>db.close());
 async function client(){const agent=request.agent(app),r=await agent.get('/api/bootstrap');return{agent,csrf:r.body.csrf};}
 const post=(a,b)=>a.agent.post('/api/commerce/prepare').set('origin','https://qa.test').set('x-csrf-token',a.csrf).send({key,request_id:crypto.randomUUID(),...b});
 it('búsqueda de productos es local y no consulta el bot o la web',async()=>{
  const a=await client();expect((await a.agent.get('/api/products?q=FB-8')).status).toBe(200);expect(commerce.products).toHaveBeenCalledWith('FB-8','all');expect(fetcher).not.toHaveBeenCalled();expect(invoiceSource).not.toHaveBeenCalled();
 });
 it('no toma teléfono ni actor proporcionados por el navegador',async()=>{
  const a=await client();expect((await a.agent.get('/api/commerce/orders').query({key,phone:'evil',actor:'supervisor'})).status).toBe(200);expect(commerce.orders).toHaveBeenCalledWith('+'+thread.phone);
 });
 it('lector o agente ajeno no consultan pedidos ni preparan facturas',async()=>{
  const a=await client();role='read';expect((await a.agent.get('/api/commerce/orders').query({key})).status).toBe(403);expect((await a.agent.get('/api/products?q=bici')).status).toBe(403);role='write';thread.owner_id='herramientas:2';expect((await a.agent.get('/api/commerce/orders').query({key})).status).toBe(403);expect(commerce.orders).not.toHaveBeenCalled();expect(invoiceSource).not.toHaveBeenCalled();
 });
 it('conserva CSRF y agrega la única factura sin pedir confirmaciones extra',async()=>{
  const a=await client();expect((await a.agent.post('/api/commerce/prepare').send({})).status).toBe(403);const direct=await post(a,{kind:'invoice',order_id:41});expect(direct.status).toBe(200);expect(direct.body.media.media_id).toBe('qa-pdf');expect(invoiceSource).toHaveBeenCalledTimes(2);
 });
 it('rechaza pedido ajeno y comprobante con id inválido antes de la web',async()=>{
  const a=await client();expect((await post(a,{kind:'invoice',order_id:999,confirm_identity:true})).status).toBe(404);expect((await post(a,{kind:'invoice',order_id:41,invoice_id:'1/../../8',confirm_identity:true})).status).toBe(400);expect(invoiceSource).not.toHaveBeenCalled();
 });
 it('prepara producto y tracking sin enviar ni emitir',async()=>{
  const a=await client();const p=await post(a,{kind:'product',product_id:8});expect(p.status).toBe(200);expect(p.body.text).toContain('Contado / transferencia');expect(p.body.text).toContain('?p=7');const t=await post(a,{kind:'tracking',order_id:41,tracking_index:0});expect(t.body.text).toContain('/envio/360000000000000');expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body).op).toBe('thread');expect(invoiceSource).not.toHaveBeenCalled();
 });
 it('lista comprobantes y carga PDF privado sin crear command/send',async()=>{
  invoiceSource.mockImplementation(async({invoiceId})=>invoiceId===undefined?{invoices:[{id:88,label:'Factura B 15-1'},{id:89,label:'Nota crédito B 15-2'}]}:{name:'Factura-41.pdf',mime:'application/pdf',data_base64:Buffer.from('%PDF-1.4 test').toString('base64')});const a=await client(),base={kind:'invoice',order_id:41};const l=await post(a,base);expect(l.body.selection_required).toBe(true);expect(l.body.invoices[0].id).toBe(88);const p=await post(a,{...base,invoice_id:88,phone:'other'});expect(p.body.media.media_id).toBe('qa-pdf');expect(invoiceSource).toHaveBeenLastCalledWith({orderId:41,invoiceId:88,phone:thread.phone});const ops=fetcher.mock.calls.map(c=>JSON.parse(c[1].body).op);expect(ops).not.toContain('command');expect(ops.filter(x=>x==='upload')).toHaveLength(1);
 });
 it('revalida propiedad y contacto después de descargar; no sube PDF si cambió',async()=>{
  const a=await client();invoiceSource.mockImplementation(async()=>{thread.owner_id='herramientas:2';return{data_base64:'cGRm',mime:'application/pdf',name:'f.pdf'};});expect((await post(a,{kind:'invoice',order_id:41,invoice_id:88,confirm_identity:true})).status).toBe(403);expect(fetcher.mock.calls.map(c=>JSON.parse(c[1].body).op)).not.toContain('upload');
 });
 it('producto adjunta foto privada y revalida al responsable sin enviar',async()=>{
  const a=await client();productSource.photo.mockResolvedValue({name:'Producto.jpg',mime:'image/jpeg',data_base64:'anBlZw=='});
  const response=await post(a,{kind:'product',product_id:8});expect(response.status).toBe(200);
  const ops=fetcher.mock.calls.map(c=>JSON.parse(c[1].body));expect(ops.filter(x=>x.op==='thread')).toHaveLength(2);expect(ops.find(x=>x.op==='upload').mime).toBe('image/jpeg');expect(ops.some(x=>x.op==='command')).toBe(false);
 });
 it('no sube foto cuando cambia responsable durante la consulta de cuotas',async()=>{
  const a=await client();productSource.photo.mockImplementation(async()=>{thread.owner_id='herramientas:2';return {name:'P.jpg',mime:'image/jpeg',data_base64:'anBlZw=='};});
  expect((await post(a,{kind:'product',product_id:8})).status).toBe(403);expect(fetcher.mock.calls.map(c=>JSON.parse(c[1].body).op)).not.toContain('upload');
 });
 it('producto web conserva ficha de texto sin intentar subir imágenes',async()=>{
  const a=await client();thread.channel='web';thread.capabilities.media=false;
  expect((await post(a,{kind:'product',product_id:8})).status).toBe(200);expect(productSource.photo).not.toHaveBeenCalled();
 });
 it('valida y propaga el filtro de stock sin consultar servicios externos',async()=>{
  const a=await client();expect((await a.agent.get('/api/products?q=bici&stock=instock')).status).toBe(200);expect(commerce.products).toHaveBeenCalledWith('bici','instock');expect((await a.agent.get('/api/products?q=bici&stock=evil')).status).toBe(400);expect(fetcher).not.toHaveBeenCalled();
 });
 it('ventana cerrada, chat cerrado y chat web no descargan PDF',async()=>{
  const a=await client();for(const fields of [{can_send:false,send_blocked_reason:'window_closed'},{status:'closed'},{channel:'web'}]){Object.assign(thread,{can_send:true,status:'open',channel:'whatsapp'},fields);expect((await post(a,{kind:'invoice',order_id:41,invoice_id:88,confirm_identity:true})).status).toBe(409);}expect(invoiceSource).not.toHaveBeenCalled();
 });
});

describe('Lectura de factura web acotada',()=>{
 const env={WOO_URL:'https://fusionbikes.com.ar',WOO_CK:'test-key',WOO_CS:'test-secret'};
 const pdf=Buffer.from('%PDF-1.4\nDocumento sintético de prueba');
 const body={ok:true,order_id:41,invoice_id:88,data_base64:pdf.toString('base64'),sha256:crypto.createHash('sha256').update(pdf).digest('hex'),filename:'Factura-41.pdf'};
 it('solo GET al origen fijo; teléfono en header y sin emisión, credenciales en URL o redirects',async()=>{
  const f=vi.fn(async()=>new Response(JSON.stringify(body))),read=createInvoiceSource({env,fetchImpl:f});expect((await read({orderId:41,invoiceId:88,phone:'5493511234567'})).mime).toBe('application/pdf');const [url,options]=f.mock.calls[0];expect(String(url)).toBe('https://fusionbikes.com.ar/wp-json/wc/v3/fusion-herramientas/messaging-orders/41/invoices/88/pdf');expect(options.method).toBe('GET');expect(options.redirect).toBe('error');expect(options.headers['X-Fusion-Contact-Phone']).toBe('+5493511234567');
 });
 it('valida relación pedido/comprobante, firma PDF y hash',async()=>{
  for(const change of [{order_id:42},{invoice_id:89},{sha256:'0'.repeat(64)},{data_base64:Buffer.from('<html>bad</html>').toString('base64')}]){const read=createInvoiceSource({env,fetchImpl:async()=>new Response(JSON.stringify({...body,...change}))});await expect(read({orderId:41,invoiceId:88,phone:'+5493511234567'})).rejects.toHaveProperty('status');}
 });
 it('rechaza configuración de otro origen antes de comunicar credenciales',async()=>{
  const f=vi.fn();for(const WOO_URL of ['http://fusionbikes.com.ar','https://evil.test','https://fusionbikes.com.ar:999','https://x@fusionbikes.com.ar'])await expect(createInvoiceSource({env:{...env,WOO_URL},fetchImpl:f})({orderId:41,phone:'+5493511234567'})).rejects.toHaveProperty('code','invoice_source_unavailable');expect(f).not.toHaveBeenCalled();
 });
 it('no propaga errores de origen ni información privada',async()=>{
  const read=createInvoiceSource({env,fetchImpl:async()=>new Response(JSON.stringify({message:'private traceback test-secret'}),{status:500})});await expect(read({orderId:41,phone:'+5493511234567'})).rejects.toThrow('No se pudo consultar');
 });
});
