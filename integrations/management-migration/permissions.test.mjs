import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { VPS_APPLICATIONS, canUseManagement } from './permissions.mjs';
import { allowedTarget, createGateway, managementHtml, prefix } from './gateway.mjs';
import { csrfToken } from './andreani.mjs';
const secret='x'.repeat(64);
const user=(id)=>({ok:true,user:'qa-operador',is_admin:false,permisos:id?[{herramienta:id,nivel:'read'}]:[]});
const permitted=(id,path,method='GET',location='web')=>canUseManagement(user(id),allowedTarget(prefix+path,method),method,location);

test('cada aplicación del VPS tiene un permiso único y no se concede por defecto',()=>{
  assert.equal(new Set(VPS_APPLICATIONS.map(a=>a.id)).size,VPS_APPLICATIONS.length);
  const routes={ 'gestion-ventas':'/ventas/api?kind=options', 'gestion-stock':'/ventas/api?mode=stock&kind=report', 'gestion-alertas':'/ventas/stock/alertas', 'gestion-clientes':'/directory/api?kind=search', 'gestion-andreani':'/andreani/', 'pdf-etiquetas':'/corregir-etiquetas/', 'gestion-taller':'/?fm_module=taller', 'acceso-pos-web':'/pos-web/', 'acceso-facturador-web':'/facturador-web/' };
  for(const [id,path] of Object.entries(routes)){
    assert.equal(permitted(id,path),true,id);
    assert.equal(permitted(null,path),false,id+' default deny');
    for(const other of Object.keys(routes)){
      if(other===id || id==='gestion-stock'&&other==='gestion-alertas')continue;
      assert.equal(permitted(other,path),false,other+' no puede abrir '+id);
    }
  }
});

test('alias REST, HEAD, rutas desconocidas y parámetros ambiguos no eluden permisos',()=>{
  for(const path of ['/?rest_route=/fusion-taller/v1/jobs','/wp-json/fusion-taller/v1/jobs']){
    assert.equal(permitted('gestion-taller',path,'HEAD'),true);
    assert.equal(permitted('gestion-clientes',path),false);
  }
  for(const path of ['/?page_id=1000000000','/?fbpos_quote=abc123def456ghi789','/?rest_route=/fusion-arca/v1/invoices','/wp-json/fbpos/v2/search'])
    for(const app of VPS_APPLICATIONS) assert.equal(permitted(app.id,path),false,path+' '+app.id);
  for(const path of ['/?fm_module=taller&fm_module=pos','/?fm_module=taller&fm_module[]=pos','/?rest_route=/fusion-taller/v1/jobs&fm_module=pos','/wp-json/fusion-taller/v1/jobs?page_id=1','/?rest_route=/fusion-taller/v1/jobs&rest_route[]=/wp/v2/users','/?rest_route=/fusion-taller/v1/jobs&rest.route=/fusion-arca/v1/invoices','/?rest_route=/fusion-taller/v1/jobs&fm+module=pos','/?rest_route=/fusion-taller/v1/jobs&rest_route%00x=/fusion-arca/v1/invoices','/?rest_route=/fusion-taller/v1/jobs&q=x;fm_module=pos'])
    assert.equal(allowedTarget(prefix+path),null,path);
  assert.equal(permitted('gestion-taller','/?fm_module=taller','POST'),false);
  assert.equal(permitted('gestion-ventas','/ventas/api?mode=commercial&mode=stock'),false);
  assert.equal(permitted('acceso-pos-web','/?fm_module=pos','GET','vps'),false);
  assert.equal(permitted('acceso-facturador-web','/wp-json/fusion-arca/v1/invoices','POST'),false);
});

test('el menú oculta otros módulos y la configuración de alertas',()=>{
  const html='<a href="'+prefix+'/ventas/">Ventas</a><a href="'+prefix+'/directory/">Clientes</a><details id="fs-alerts">Configurar</details><script src="'+prefix+'/assets/stock-alert-settings.js?v=1" defer></script>';
  const result=managementHtml(html,user('gestion-ventas'));
  assert.match(result,/>Ventas</);assert.doesNotMatch(result,/Clientes|Configurar|stock-alert-settings/);
  assert.match(managementHtml(html,{is_admin:true}),/Clientes/);
});

test('HTTP real: permiso vigente, revocación, independencia y validación CSRF',async t=>{
  let current=user('gestion-ventas'),authStatus=200,metricsCalls=0,settingsCalls=0;
  const auth=http.createServer((req,res)=>{assert.equal(req.url,'/api/auth/me');res.writeHead(authStatus);res.end(JSON.stringify(current));});
  await new Promise(r=>auth.listen(0,'127.0.0.1',r));
  const gateway=createGateway({secret,upstreamHost:'127.0.0.1',upstreamPort:1,authPort:auth.address().port,salesLocation:'web',metricsRead:()=>{metricsCalls++;return {success:true,data:{rows:[]}};},alertSettingsHandle:()=>{settingsCalls++;return {ok:true};}});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  t.after(()=>{gateway.closeAllConnections();auth.closeAllConnections();gateway.close();auth.close();});
  const root='http://127.0.0.1:'+gateway.address().port+prefix;
  assert.equal((await fetch(root+'/ventas/api?kind=options')).status,200);
  assert.equal((await fetch(root+'/directory/')).status,403);
  assert.equal((await fetch(root+'/ventas/api?mode=stock')).status,403);
  current=user();assert.equal((await fetch(root+'/ventas/api?kind=options')).status,403);assert.equal(metricsCalls,1);
  current=user('gestion-stock');assert.equal((await fetch(root+'/ventas/api?mode=stock')).status,200);
  assert.equal((await fetch(root+'/ventas/stock/alertas')).status,403);
  const stockHtml=await(await fetch(root+'/ventas/stock/')).text();assert.doesNotMatch(stockHtml,/id="fs-alerts"|stock-alert-settings\.js/);
  current=user('gestion-alertas');assert.equal((await fetch(root+'/ventas/stock/alertas')).status,200);
  const action=root+'/ventas/stock/alertas';
  assert.equal((await fetch(action,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal(settingsCalls,1);
  assert.equal((await fetch(action,{method:'POST',headers:{'content-type':'application/json',origin:'https://herramientas.fusionbikes.com.ar','x-fusion-csrf':csrfToken(secret,current.user,'')},body:'{}'})).status,200);
  current=user('acceso-pos-web');const external=await fetch(root+'/pos-web/',{redirect:'manual'});assert.equal(external.status,302);assert.equal(external.headers.get('location'),'https://fusionbikes.com.ar/punto-de-venta/');
  assert.equal((await fetch(root+'/wp-json/fbpos/v2/search?q=a')).status,403);
  authStatus=401;assert.equal((await fetch(root+'/pos-web/',{redirect:'manual'})).status,401);
});

test('HTTP real: taller autoriza proxy firmado; permisos falsificados y módulos vecinos no pasan',async t=>{
  let current=user('gestion-taller'),upstreamCalls=0;
  const auth=http.createServer((req,res)=>res.end(JSON.stringify(current)));
  const upstream=http.createServer((req,res)=>{upstreamCalls++;assert.equal(req.headers.cookie,undefined);const claim=JSON.parse(Buffer.from(req.headers['x-fusion-claim'],'base64'));assert.equal(claim.user,current.user);assert.equal(claim.uri,req.url);res.end('taller');});
  for(const server of [auth,upstream])await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const gateway=createGateway({secret,upstreamHost:'127.0.0.1',upstreamPort:upstream.address().port,authPort:auth.address().port});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const s of [gateway,auth,upstream]){s.closeAllConnections();s.close();}});
  const root='http://127.0.0.1:'+gateway.address().port+prefix;
  assert.equal((await fetch(root+'/?fm_module=taller')).status,200);
  assert.equal((await fetch(root+'/wp-json/fusion-taller/v1/jobs')).status,200);
  assert.equal((await fetch(root+'/?rest_route=/fusion-arca/v1/config')).status,403);
  current=user();assert.equal((await fetch(root+'/?fm_module=taller',{headers:{'x-fusion-claim':'admin','x-fusion-signature':'fake'}})).status,403);
  assert.equal(upstreamCalls,2);
});
