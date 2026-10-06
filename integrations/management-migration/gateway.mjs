import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createLocalCatalog, catalogRoute, CatalogError } from './local-catalog.mjs';
import { createDirectory, directoryRoute, DirectoryError } from './directory.mjs';
import { createMetrics, metricsRoute, MetricsError } from './metrics.mjs';
import {createAndreani,createAndreaniWorker,csrfToken,csrfValid,AndreaniError} from './andreani.mjs';
import {andreaniView} from './andreani-view.mjs';
import {pdfView} from './pdf-view.mjs';
import {createPdfProxy} from './pdf-proxy.mjs';
import {createPos,PosError} from './pos-vps.mjs';
import {deliveryRoute,createDelivery,DeliveryError,smtpTransport} from './delivery.mjs';
import {salesWebTarget} from './sales-web.mjs';

export const prefix = '/herramientas/gestion-vps';
function posTarget(route,method,local){
 const actions={'GET /fbpos/v2/session':'session','POST /fbpos/v2/pricing':'pricing','POST /fbpos/v2/manual-receipt':'manual-receipt','POST /fbpos/v2/fulfillment':'fulfillment','GET /fbpos/v2/draft':'draft-read','PUT /fbpos/v2/draft':'draft-write','POST /fbpos/v2/reset':'reset','POST /fbpos/v2/prepare':'prepare','POST /fbpos/v2/release':'release','POST /fbpos/v2/customer':'customer'};
 if(actions[method+' '+route])return {kind:'pos',action:actions[method+' '+route],local};
 const order=method==='GET'&&route.match(/^\/fbpos\/v2\/orders\/([1-9]\d{0,9})$/);if(order)return {kind:'pos',action:'order-read',order_id:Number(order[1]),local};
 const match=method==='GET'&&route.match(/^\/fbpos\/v2\/operation\/([a-f0-9-]{36})$/);return match?{kind:'pos',action:'status',operation:match[1],local}:null;
}
const readRoutes = [
  /^\/fbpos\/v2\/(customer-fields|draft|search|customers|quotes|quotes\/\d+|product\/\d+|operation\/[a-zA-Z0-9-]+)$/,
  /^\/fusion-taller\/v1\/(products|customers|bike-profile|jobs|jobs\/\d+|reminders|settings)$/,
  /^\/fusion-arca\/v1\/(config|products|customer-fields|orders\/\d+|invoices|invoices\/\d+|automation|bulk\/orders|bulk\/activity|ml\/config|ml\/activity)$/,
];
const arcaWriteRoutes = [/^\/fusion-arca\/v1\/(connection|customer-lookup|invoices)$/, /^\/fusion-arca\/v1\/invoices\/[1-9]\d*\/(emit|recover|internal|credit-note|credit-note\/emit)$/];
export function allowedTarget(raw, method='GET') {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith(prefix + '/') || /[\\\r\n]/.test(raw)) return null;
  const local = raw.slice(prefix.length);
  if (local.split('?')[0].includes('..')) return null;
  const u = new URL(local, 'http://private.invalid');
  if (u.origin !== 'http://private.invalid' || decodeURIComponent(u.pathname) !== u.pathname || u.pathname.includes('..')) return null;
  if ([...u.searchParams.keys()].some(k => ['_method', '_jsonp', 'callback', 'action'].includes(k))) return null;
  if(!u.search&&['GET','HEAD'].includes(method)&&['/pos-web/','/facturador-web/'].includes(u.pathname))return {kind:'web-sales',module:u.pathname==='/pos-web/'?'pos':'facturador',local};
  const receipt=u.pathname.match(/^\/facturador\/comprobante\/([a-f0-9]{64})$/);
  if(receipt&&!u.search&&['GET','HEAD'].includes(method))return {kind:'delivery-public',token:receipt[1],local};
  if(u.pathname==='/facturador/print'&&[...u.searchParams.keys()].join(',')==='id'&&/^[1-9]\d{0,14}$/.test(u.searchParams.get('id'))&&['GET','HEAD'].includes(method))return {kind:'proxy',local:'/index.php?fusion_vps_print='+u.searchParams.get('id')};
  if(u.pathname==='/corregir-etiquetas/'&&!u.search)return {kind:'pdf-page',local};
  if(u.pathname==='/corregir-etiquetas/api'&&!u.search)return {kind:'pdf-api',local};
  if(['/assets/pdf-corrector.js','/assets/pdf-corrector.css','/assets/pdf-render.mjs','/assets/pdfjs/pdf.min.mjs','/assets/pdfjs/pdf.worker.min.mjs'].includes(u.pathname)&&!u.search)return {kind:'asset',local};
  if(['/assets/andreani.js','/assets/andreani.css'].includes(u.pathname)&&!u.search)return {kind:'asset',local};
  if(u.pathname==='/andreani/'&&[...u.searchParams.keys()].every(k=>['status','from','to','order_id','page'].includes(k)&&u.searchParams.getAll(k).length===1))return {kind:'andreani',local};
  if(u.pathname==='/andreani/api'&&!u.search)return {kind:'andreani-api',local};
  if(u.pathname==='/andreani/download'&&[...u.searchParams.keys()].join(',')==='id')return {kind:'andreani-download',local};
  if (['/assets/management.css', '/assets/catalog-ui.js', '/assets/directory.js', '/assets/directory.css','/assets/metrics.js','/assets/metrics.css','/assets/sales-core.js'].includes(u.pathname)) return { kind: 'asset', local };
  if (u.pathname === '/ventas/' && !u.search) return { kind: 'metrics', local };
  if (u.pathname === '/ventas/api' && [...u.searchParams.keys()].every(k=>['kind','from','to','statuses[]','bike_categories[]','brand','model','page','generation','filter_kind','filter_brands[]','currency','category','country','state','city','search','mode','channel','modelKey','variant','quality','saleState','category[]'].includes(k))) return { kind: 'metrics-api', local };
  if (u.pathname === '/directory/' && !u.search) return { kind: 'directory', local };
  if (u.pathname === '/directory/api' && [...u.searchParams.keys()].every(k=>['kind','q','page','id'].includes(k))) return { kind: 'directory-api', local };
  if (u.pathname.startsWith('/wp-json/')) {
    const route = u.pathname.slice('/wp-json'.length);
    if(!['GET','HEAD'].includes(method)&&u.search)return null;
    if(u.searchParams.has('rest_route'))return null;
    const pos=posTarget(route,method,local);if(pos)return pos;
    const delivery=deliveryRoute(route,method,local);if(delivery)return delivery;
    if (u.searchParams.has('rest_route') || !(method==='POST'?arcaWriteRoutes:readRoutes).some(r => r.test(route))) return null;
    const query = new URLSearchParams(u.searchParams); query.set('rest_route', route);
    return { kind: 'proxy', local: '/index.php?' + query.toString() };
  }
  if (u.pathname === '/') {
    if (!u.search) return { kind: 'home', local };
    if (u.searchParams.has('rest_route')) {
      const route = u.searchParams.get('rest_route');
      if(u.searchParams.getAll('rest_route').length!==1)return null;
      if(!['GET','HEAD'].includes(method)&&[...u.searchParams.keys()].some(k=>k!=='rest_route'))return null;
      const pos=posTarget(route,method,local);if(pos)return pos;
      const delivery=deliveryRoute(route,method,local);if(delivery)return delivery;
      if(method==='POST'&&[...u.searchParams.keys()].some(k=>k!=='rest_route'))return null;
      if (u.searchParams.getAll('rest_route').length !== 1 || !(method==='POST'?arcaWriteRoutes:readRoutes).some(r => r.test(route))) return null;
      return { kind: 'proxy', local };
    }
    const keys = [...u.searchParams.keys()];
    if (keys.every(k => ['fbpos_quote','print'].includes(k)) && u.searchParams.getAll('fbpos_quote').length === 1 && /^[a-zA-Z0-9-]{12,100}$/.test(u.searchParams.get('fbpos_quote')) && (!u.searchParams.has('print') || u.searchParams.get('print') === '1')) return { kind: 'proxy', local };
    if (keys.length === 1 && keys[0] === 'page_id' && /^[1-9]\d{0,14}$/.test(u.searchParams.get('page_id'))) return { kind: 'proxy', local };
    if (['pos', 'taller', 'facturador'].includes(u.searchParams.get('fm_module')) && keys.every(k => ['fm_module', 'view', 'order_id'].includes(k))) return { kind: 'proxy', local };
    return null;
  }
  if (/^\/wp-content\/plugins\/(fusion-bikes-pos-v2|fusion-facturacion-arca|fusion-taller)\/(assets|docs)\/[a-zA-Z0-9_./-]+\.(js|css|png|jpg|jpeg|svg|woff2?|ttf|html)$/.test(u.pathname)
      || /^\/wp-includes\/(css|js|images)\/[a-zA-Z0-9_./-]+\.(js|css|png|gif|svg|woff2?|ttf)$/.test(u.pathname)) return { kind: 'proxy', local };
  return null;
}
export function makeClaim(user, method, uri, secret, time = Math.floor(Date.now() / 1000), body, csrf) {
  const claim = Buffer.from(JSON.stringify({ user, method, uri, time, ...(body!==undefined?{sha256:crypto.createHash('sha256').update(body).digest('hex')}:{}),...(csrf?{csrf}:{}) })).toString('base64');
  return { 'x-fusion-claim': claim, 'x-fusion-signature': crypto.createHmac('sha256', secret).update(claim).digest('hex') };
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
function session(cookie, authPort) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: authPort, path: '/api/auth/me', headers: { cookie }, timeout: 3000 }, res => {
      let body = ''; res.on('data', data => { body += data; if (body.length > 32768) req.destroy(new Error('auth response limit')); });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch { reject(new Error('auth response')); } });
    });
    req.on('timeout', () => req.destroy(new Error('auth timeout'))); req.on('error', reject);
  });
}
const home = readFileSync(new URL('./home.html', import.meta.url), 'utf8');

export function createGateway({ secret, upstreamHost, upstreamPort = 80, authPort = 3001, catalogRead, directoryRead, metricsRead, andreaniHandle, pdfHandle, posHandle, deliveryHandle, posEnabled=process.env.FUSION_POS_VPS_ENABLED==='1', salesLocation=process.env.FUSION_SALES_LOCATION||'vps', origin='https://herramientas.fusionbikes.com.ar' }) {
  if (!secret || secret.length < 64) throw new Error('Missing signing key');
  const catalog = createLocalCatalog({ port: authPort, ...(catalogRead ? { read: catalogRead } : {}) });
  const directory = directoryRead || createDirectory();
  const metrics = metricsRead || createMetrics();
  const andreani=andreaniHandle||createAndreani({worker:createAndreaniWorker({secret,host:upstreamHost,port:upstreamPort})});
  const pdf=pdfHandle||createPdfProxy(secret);
  const pos=posHandle||createPos({catalog});
  const delivery=deliveryHandle||createDelivery({origin,send:smtpTransport().send,read:(kind,id,user)=>new Promise((resolve,reject)=>{
    const uri=kind==='pdf'?'/index.php?fusion_vps_print='+id:'/index.php?rest_route=/fusion-arca/v1/invoices/'+id;
    const request=http.get({hostname:upstreamHost,port:upstreamPort,path:uri,headers:{host:'herramientas.fusionbikes.com.ar',...makeClaim(user,'GET',uri,secret,undefined,Buffer.alloc(0))},timeout:60000},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>(kind==='pdf'?8*1024*1024:1024*1024))request.destroy(new Error('limit'));else chunks.push(chunk);});
      response.on('error',reject);
      response.on('end',()=>{if(response.statusCode!==200)return reject(new DeliveryError('No se pudo recuperar el comprobante.',502));try{const body=Buffer.concat(chunks);resolve(kind==='pdf'?body:JSON.parse(body));}catch{reject(new DeliveryError('No se pudo recuperar el comprobante.',502));}});
    });request.on('timeout',()=>request.destroy(new Error('timeout')));request.on('error',()=>reject(new DeliveryError('No se pudo preparar el comprobante. No se envió ningún correo.',502)));
  })});
  const assets = new Map([
    ['/assets/pdf-render.mjs',['pdf-render.mjs','text/javascript']],
    ['/assets/pdfjs/pdf.min.mjs',['pdfjs/pdf.min.mjs','text/javascript']],
    ['/assets/pdfjs/pdf.worker.min.mjs',['pdfjs/pdf.worker.min.mjs','text/javascript']],
    ['/assets/pdf-corrector.js',['pdf-corrector.js','text/javascript']],
    ['/assets/pdf-corrector.css',['pdf-corrector.css','text/css']],
    ['/assets/management.css', ['management.css', 'text/css']],
    ['/assets/catalog-ui.js', ['catalog-ui.js', 'text/javascript']],
    ['/assets/directory.js', ['directory.js', 'text/javascript']],
    ['/assets/directory.css', ['directory.css', 'text/css']],
    ['/assets/metrics.js', ['metrics.js', 'text/javascript']],
    ['/assets/sales-core.js', ['sales-core.js', 'text/javascript']],
    ['/assets/metrics.css', ['metrics.css', 'text/css']],
    ['/assets/andreani.js', ['andreani.js', 'text/javascript']],
    ['/assets/andreani.css', ['andreani.css', 'text/css']],
    ['/wp-content/plugins/fusion-bikes-pos-v2/assets/pos.js', ['pos.js', 'text/javascript']],
    ['/wp-content/plugins/fusion-taller/assets/app.js', ['taller.js', 'text/javascript']],
    ['/wp-content/plugins/fusion-facturacion-arca/assets/admin.js', ['facturador.js', 'text/javascript']],
  ]);
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; form-action 'self'; base-uri 'self'");
    let target; try { target = allowedTarget(req.url,req.method); } catch { target = null; }
    const arcaPost=req.method==='POST'&&target?.kind==='proxy'&&arcaWriteRoutes.some(r=>r.test(new URL(target.local,'http://private.invalid').searchParams.get('rest_route')||''));
    const posWrite=target?.kind==='pos'&&!['GET','HEAD'].includes(req.method)&&posEnabled;
    const deliveryPost=target?.kind==='delivery'&&req.method==='POST';
    if (!['GET', 'HEAD'].includes(req.method)&&!posWrite&&!deliveryPost&&!(req.method==='POST'&&([prefix+'/andreani/api',prefix+'/corregir-etiquetas/api'].includes(req.url)||arcaPost))) return json(res, 423, { error: 'Operación no habilitada.', message: 'Esta operación todavía no está habilitada en el VPS.' });
    if (!target) return json(res, 404, { error: 'Ruta no disponible.' });
    if(target.kind==='delivery-public'){
      try{const file=await delivery('public',{token:target.token});res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="'+file.filename+'"','Content-Length':file.pdf.length});return res.end(req.method==='HEAD'?'':file.pdf);}
      catch(e){return json(res,e instanceof DeliveryError?e.status:503,{message:e instanceof DeliveryError?e.message:'El comprobante no está disponible.'});}
    }
    try {
      const auth = await session(req.headers.cookie || '', authPort);
      if (auth.status !== 200 || auth.body.ok !== true) return json(res, 401, { error: 'Ingresá en Herramientas para acceder.' });
      if (auth.body.is_admin !== true || typeof auth.body.user !== 'string') return json(res, 403, { error: 'La validación requiere un administrador de Herramientas.' });
      const web=(salesLocation==='web'||target.kind==='web-sales')?salesWebTarget(target,req.method):null;
      if(web){
        if(web.status===302){res.writeHead(302,{Location:web.url});return res.end();}
        return json(res,423,{code:'sales_in_web',message:'El POS y el facturador funcionan en la web. Abrí el acceso de Herramientas para continuar.',url:web.url});
      }
      if(target.kind==='delivery'){
        if(target.action==='session')return json(res,200,{csrf:csrfToken(secret,auth.body.user,req.headers.cookie||'')});
        let input={};
        if(deliveryPost){
          if(req.headers.origin!==origin||!csrfValid(req.headers['x-fusion-csrf'],secret,auth.body.user,req.headers.cookie||''))return json(res,403,{code:'delivery_csrf',message:'Renová la sesión del facturador para enviar el comprobante.'});
          if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{message:'Formato no admitido.'});
          const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)return json(res,413,{message:'La solicitud supera el tamaño permitido.'});chunks.push(chunk);}
          try{input=JSON.parse(Buffer.concat(chunks));if(!input||typeof input!=='object'||Array.isArray(input))throw Error();}catch{return json(res,400,{message:'Datos inválidos.'});}
        }
        try{return json(res,200,await delivery(target.action,{...input,id:target.id},auth.body.user));}
        catch(e){return json(res,e instanceof DeliveryError?e.status:503,{code:e instanceof DeliveryError?e.code:'delivery_unavailable',message:e instanceof DeliveryError?e.message:'No se pudo consultar el envío. Actualizá su estado antes de reintentar.',data:e instanceof DeliveryError?e.data:{}});}
      }
      if(target.kind==='pos'){
        if(!posEnabled)return json(res,423,{message:'El POS está en preparación.'});
        if(target.action==='session')return json(res,200,{csrf:csrfToken(secret,auth.body.user,req.headers.cookie||'')});
        let input={operation:target.operation,order_id:target.order_id};
        if(posWrite){
          if(req.headers.origin!==origin||!csrfValid(req.headers['x-fusion-csrf'],secret,auth.body.user,req.headers.cookie||''))return json(res,403,{code:'pos_csrf',message:'Recargá el POS para renovar la sesión.'});
          if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{message:'Formato no admitido.'});
          const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)return json(res,413,{message:'La venta supera el tamaño permitido.'});chunks.push(chunk);}
          try{input=JSON.parse(Buffer.concat(chunks));if(!input||typeof input!=='object'||Array.isArray(input))throw Error();}catch{return json(res,400,{message:'Datos inválidos.'});}
        }
        try{return json(res,200,await pos(target.action,input,auth.body.user,req.headers.cookie||''));}
        catch(e){return json(res,e instanceof PosError?e.status:503,{code:e instanceof PosError?e.code:'pos_unavailable',message:e instanceof PosError?e.message:'No se pudo recuperar el POS. Conservá la preparación y volvé a intentar.'});}
      }
      let arcaBody;
      if(arcaPost){
        if(req.headers.origin!==origin||!csrfValid(req.headers['x-fusion-csrf'],secret,auth.body.user,req.headers.cookie||''))return json(res,403,{message:'Recargá el facturador para renovar la sesión.'});
        if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{message:'Formato no admitido.'});
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>262144)return json(res,413,{message:'El comprobante supera el tamaño permitido.'});chunks.push(chunk);}
        arcaBody=Buffer.concat(chunks);try{const data=JSON.parse(arcaBody);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();}catch{return json(res,400,{message:'Datos inválidos.'});}
      }
      if(target.kind==='pdf-page'){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        return res.end(req.method==='HEAD'?'':pdfView(csrfToken(secret,auth.body.user,req.headers.cookie||'')));
      }
      if(target.kind==='pdf-api'){
        if(req.method!=='POST')return json(res,405,{message:'Subí el PDF desde el corrector de etiquetas.'});
        if(req.headers.origin!==origin||!csrfValid(req.headers['x-fusion-csrf'],secret,auth.body.user,req.headers.cookie||''))return json(res,403,{message:'Recargá la página para renovar la sesión.'});
        return await pdf(req,res);
      }
      if(target.kind.startsWith('andreani')){
        try{
          const q=new URL(target.local,'http://private.invalid').searchParams;
          if(target.kind==='andreani-api'){
            if(req.method!=='POST')return json(res,405,{success:false,message:'Usá la preparación de envíos.'});
            if(req.headers.origin!==origin||!csrfValid(req.headers['x-fusion-csrf'],secret,auth.body.user,req.headers.cookie||''))return json(res,403,{success:false,message:'Recargá el panel para renovar la sesión de revisión.'});
            if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{success:false,message:'Formato no admitido.'});
            const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>262144)throw new AndreaniError('La solicitud supera el tamaño permitido.',413);chunks.push(chunk);}
            let input;try{input=JSON.parse(Buffer.concat(chunks));}catch{throw new AndreaniError('Datos inválidos.');}
            if(!input||Array.isArray(input)||!['order','phone','search','save','settings','export'].includes(input.action))throw new AndreaniError('Acción no disponible.',404);
            return json(res,200,{success:true,data:await andreani(input.action,input,auth.body.user)});
          }
          if(target.kind==='andreani-download'){
            const data=await andreani('download',{id:q.get('id')},auth.body.user);res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="'+data.filename+'"'});return res.end(req.method==='HEAD'?'':data.file);
          }
          const data=await andreani('list',Object.fromEntries(q),auth.body.user);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(req.method==='HEAD'?'':andreaniView(data,q,csrfToken(secret,auth.body.user,req.headers.cookie||'')));
        }catch(e){return json(res,e instanceof AndreaniError?e.status:503,{success:false,message:e instanceof AndreaniError?e.message:'No se pudo abrir la preparación de envíos.'});}
      }
      if (target.kind === 'home') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(req.method === 'HEAD' ? '' : home); }
      if (target.kind === 'directory') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(req.method === 'HEAD' ? '' : readFileSync(new URL('./directory.html', import.meta.url))); }
      if (target.kind === 'metrics') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(req.method === 'HEAD' ? '' : readFileSync(new URL('./metrics.html', import.meta.url))); }
      const asset = assets.get(new URL(target.local, 'http://private.invalid').pathname);
      if (asset) {
        const content = readFileSync(new URL('./assets/' + asset[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' });
        return res.end(req.method === 'HEAD' ? '' : content);
      }
      const localMetrics = metricsRoute(target.local);
      if (localMetrics) {
        try { const data=metrics(localMetrics);res.setHeader('X-Fusion-Metrics-Source','vps-local');if(typeof data.csv==='string'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="fusion-ventas-detalle.csv"'});return res.end(req.method==='HEAD'?'':data.csv);}return json(res,200,req.method==='HEAD'?null:data); }
        catch(error) { return json(res,error instanceof MetricsError?error.status:503,{success:false,data:error instanceof MetricsError?error.message:'No se pudo consultar la copia local de ventas.'}); }
      }
      const localDirectory = directoryRoute(target.local);
      if (localDirectory) {
        try { const data=directory(localDirectory);res.setHeader('X-Fusion-Directory-Source','vps-local');return json(res,200,req.method==='HEAD'?null:data); }
        catch(error) { return json(res,error instanceof DirectoryError?error.status:503,{code:'local_directory_unavailable',message:error instanceof DirectoryError?error.message:'No se pudo consultar el directorio local.'}); }
      }
      const localCatalog = catalogRoute(target.local);
      if (localCatalog) {
        try {
          const data = await catalog(localCatalog, req.headers.cookie || '');
          if(localCatalog.module==='facturador')for(const p of data.rows){p.vat='21';p.requires_serial=/^\s*(?:bicicletas?|bici|bikes?|e-bikes?)\b/iu.test(p.name);p.price=p._local.reference_price;p.usd_price=null;p.commercial_rate=0;}
          res.setHeader('X-Fusion-Catalog-Source', 'vps-local');
          res.setHeader('X-Fusion-Catalog-Cache-Seconds', '5');
          return json(res, 200, req.method === 'HEAD' ? null : data);
        } catch (error) {
          return json(res, error instanceof CatalogError ? error.status : 503,
            { code: 'local_catalog_unavailable', message: error instanceof CatalogError ? error.message : 'No se pudo consultar el catálogo local.' });
        }
      }
      const headers = { host: 'herramientas.fusionbikes.com.ar', ...makeClaim(auth.body.user, req.method, target.local, secret,undefined,arcaBody||Buffer.alloc(0),csrfToken(secret,auth.body.user,req.headers.cookie||'')) };
      if(arcaPost){headers['content-type']='application/json';headers['content-length']=arcaBody.length;}
      if (req.headers.accept) headers.accept = req.headers.accept;
      const proxy = http.request({ hostname: upstreamHost, port: upstreamPort, path: target.local, method: req.method, headers, timeout: arcaPost?150000:60000 }, upstream => {
        // Never forward WordPress cookies or redirects to another origin.
        for (const [key, value] of Object.entries(upstream.headers)) {
          if (['content-type', 'content-length', 'content-encoding','content-disposition'].includes(key)) res.setHeader(key, value);
          if (key === 'location' && value.startsWith('https://herramientas.fusionbikes.com.ar' + prefix + '/')) res.setHeader(key, value);
        }
        res.statusCode = upstream.statusCode; upstream.pipe(res);
      });
      proxy.on('timeout', () => proxy.destroy(new Error('upstream timeout')));
      proxy.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'El módulo no está disponible. Volvé a intentar.' }); else res.destroy(); });
      proxy.end(arcaBody);
    } catch { json(res, 503, { error: 'No se pudo verificar la sesión de Herramientas.' }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createGateway({ secret: process.env.FUSION_MANAGEMENT_SIGNING_KEY, upstreamHost: process.env.FUSION_MANAGEMENT_UPSTREAM })
    .listen(8212, '127.0.0.1', () => console.log('Fusion management validation gateway listening on loopback'));
}
