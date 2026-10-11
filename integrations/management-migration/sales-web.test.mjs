import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {salesWebTarget} from './sales-web.mjs';import {createGateway,prefix,allowedTarget} from './gateway.mjs';
test('Fixed web destinations preserve only supported read parameters',()=>{
 assert.equal(salesWebTarget({kind:'proxy',local:'/?fm_module=pos'}).url,'https://fusionbikes.com.ar/punto-de-venta/');
 assert.equal(salesWebTarget({kind:'proxy',local:'/?fm_module=facturador&view=history&order_id=70706'}).url,'https://fusionbikes.com.ar/wp-admin/admin.php?page=fusion-arca&view=history&order_id=70706');
 assert.equal(salesWebTarget({kind:'proxy',local:'/?fm_module=facturador&view=https://evil.invalid&order_id=1x'}).url,'https://fusionbikes.com.ar/wp-admin/admin.php?page=fusion-arca');
 for(const local of ['/ventas/','/andreani/','/corregir-etiquetas/','/?fm_module=taller','/index.php?fusion_vps_print=173'])assert.equal(salesWebTarget({kind:'proxy',local}),null);
 assert.equal(allowedTarget(prefix+'/pos-web/','POST'),null);
});
test('Web mode redirects authenticated operators and blocks stale fiscal/POS calls before any backend',async t=>{
 let admin=false,upstreamCalls=0,metricsCalls=0;
 const auth=http.createServer((req,res)=>res.end(JSON.stringify({ok:true,user:'test',is_admin:admin})));
 const upstream=http.createServer((req,res)=>{upstreamCalls++;res.end('{}');});
 for(const s of [auth,upstream])await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const gateway=createGateway({secret:'s'.repeat(64),upstreamHost:'127.0.0.1',upstreamPort:upstream.address().port,authPort:auth.address().port,salesLocation:'web',posEnabled:true,metricsRead:()=>{metricsCalls++;return {ok:true};}});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>{for(const s of [auth,upstream,gateway])s.close();});
 const root='http://127.0.0.1:'+gateway.address().port+prefix;
 assert.equal((await fetch(root+'/pos-web/',{redirect:'manual'})).status,403);admin=true;
 for(const path of ['/pos-web/','/?fm_module=pos','/facturador-web/','/?fm_module=facturador&view=history']){
  const r=await fetch(root+path,{redirect:'manual'});assert.equal(r.status,302);assert.ok(r.headers.get('location').startsWith('https://fusionbikes.com.ar/'));
 }
 for(const [path,method] of [['/wp-json/fusion-arca/v1/orders/70706','GET'],['/?rest_route=/fusion-arca/v1/invoices/173/emit','POST'],['/wp-json/fbpos/v2/prepare','POST'],['/wp-json/fbpos/v2/draft','PUT']])assert.equal((await fetch(root+path,{method})).status,423);
 assert.equal(upstreamCalls,0);
 assert.equal((await fetch(root+'/ventas/api?kind=options')).status,200);assert.equal(metricsCalls,1);
 assert.equal((await fetch(root+'/?fm_module=taller')).status,200);assert.equal(upstreamCalls,1);
});
