import test from 'node:test';
import assert from 'node:assert/strict';
import {stockRows,createStockReport} from './stock-report.mjs';
import {mergeSales} from './commercial.mjs';
import {allowedTarget,createGateway} from './gateway.mjs';
import http from 'node:http';
const now=Date.parse('2026-10-15T01:00:00Z'),opts={days:90,cover:15,now};
const product=(id,extra={})=>({id_woo:id,tipo:'simple',stock:10,nombre:'Producto '+id,sku:'SKU-'+id,marca:'Venzo',actualizado_en:'2026-10-14T12:00:00Z',categorias_json:'["Bicicletas"]',...extra});
const sale=(id,quantity,extra={})=>({catalog_id:id,product:id,sku:'SKU-'+id,quantity,channel:'web',saleState:'valid',date:'2026-10-14',order:'woo:1',...extra});
test('coverage uses ninety calendar days, net sales and per-variant inventory',()=>{
 const report=stockRows([product(1,{stock:5}),product(2,{stock:100}),product(3,{stock:0})],[sale(1,50),sale(1,-5,{saleState:'partial'}),sale(2,2)],opts);
 assert.equal(report.rows[0].daily,.5);assert.equal(report.rows[0].coverage_days,10);assert.equal(report.rows[0].alert,'critical');assert.equal(report.rows[1].alert,'healthy');assert.equal(report.rows[2].alert,'no_sales');assert.equal(report.rows[2].coverage_days,null);
});
test('zero and negative quantities remain explicit; missing stock is never coerced to zero',()=>{
 const rows=stockRows([product(1,{stock:0}),product(2,{stock:-2}),product(3,{stock:null})],[sale(1,10),sale(3,10)],opts).rows;
 assert.equal(rows[0].alert,'missing');assert.equal(rows[0].coverage_days,0);assert.equal(rows[1].alert,'negative');assert.equal(rows[2].alert,'review');assert.equal(rows[2].stock,null);assert.equal(rows[2].coverage_days,null);
});
test('pending, cancelled, refunded, unresolved ML and unknown units do not inflate demand',()=>{
 const sales=['pending','cancelled','refunded','review'].map(s=>sale(1,100,{saleState:s}));sales.push(sale(1,100,{channel:'ml_pending'}),sale(1,null),sale(1,2,{channel:'ml',saleState:'partial'}));
 const result=stockRows([product(1)],sales,opts);assert.equal(result.rows[0].units,2);assert.equal(result.quality.excluded_lines,6);
});
test('parent stock is not duplicated across sizes and non-countable products are excluded',()=>{
 const p=product(10,{tipo:'variable',stock:3}),m=product(11,{tipo:'variation',id_padre:10,stock:0}),s=product(12,{tipo:'variation',id_padre:10,stock:0});
 const result=stockRows([p,m,s,product(13,{no_contable:1})],[sale(11,5),sale(12,10)],opts);assert.equal(result.rows.length,2);assert.ok(result.rows.every(r=>r.issue==='shared'&&r.coverage_days===null));assert.equal(result.quality.shared_stock,2);
});
test('identity uses exact catalog id, falls back only to unique compatible SKU, never title',()=>{
 const result=stockRows([product(1),product(2,{sku:'dup'}),product(3,{sku:'dup'})],[sale(1,2,{sku:'old-sku'}),sale(null,5,{sku:'SKU-1',product:1}),sale(null,50,{sku:'SKU-1',product:999}),sale(null,100,{sku:'dup',product:null}),sale(null,20,{sku:'missing',model:'Producto 1',product:null})],opts);
 assert.equal(result.rows[0].units,7);assert.equal(result.quality.unmatched_lines,3);assert.equal(result.rows[1].issue,'duplicate');
});
test('same model sizes keep their own sales and availability',()=>{
 const catalog=[product(9,{tipo:'variable',stock:0}),product(1,{tipo:'variation',id_padre:9,stock:1,atributos_json:'[{"name":"Talle","option":"M"}]'}),product(2,{tipo:'variation',id_padre:9,stock:10})];
 const result=stockRows(catalog,[sale(1,30),sale(2,1)],opts);assert.equal(result.rows[0].coverage_days,3);assert.equal(result.rows[1].coverage_days,900);assert.match(result.rows[0].variant,/M/);
});
test('commercial reconciliation preserves variation identity and excludes the Woo ML copy',()=>{
 const products=new Map([[9,{id:9,exists:true,name:'Raptor',category_ids:[62],terms:{pa_marca:['Venzo']}}],[1,{id:1,exists:true,parent_id:9,sku:'SKU-1',name:'Raptor M',variant:'M'}]]);
 const woo=[{id:10,ml_mirror:true,ml_order_id:'ML1',date:'2026-10-14',status:'completed',items:[{product_id:9,variation_id:1,sku:'SKU-1',quantity:2}]}];
 const ml=[{id:'ML1',date:'2026-10-14',saleState:'valid',items:[{sku:'SKU-1',quantity:2}]}];
 const result=mergeSales(woo,ml,products,{statuses:[{key:'wc-completed',default:true}]},[62]);assert.equal(result.rows.length,1);assert.equal(result.rows[0].catalog_id,1);assert.equal(result.counts.mirrors_replaced,1);
 assert.equal(stockRows([product(1,{tipo:'variation',id_padre:9})],result.rows,opts).rows[0].units,2);
});
const meta={generation:'g1',orders_at:'2026-10-14T23:00:00Z',web_from:'2020-01-01',windows:[{from:'2026-01-01',to:'2026-12-31'}]};
test('report defaults to 90 days in Argentina, pins sales pages and reads catalog once',async()=>{
 const queries=[];let reads=0;const read=createStockReport({now:()=>now,readCatalog:async()=>{reads++;return[product(1)];},readSales:q=>{queries.push(new URLSearchParams(q));return{data:{rows:[sale(1,1)],pages:2,snapshot:meta}};}});
 const a=(await read(new URLSearchParams('mode=stock'),'cookie')).data;
 assert.deepEqual(a.period,{from:'2026-07-17',to:'2026-10-14',days:90,cover:15});assert.equal(a.rows[0].units,2);assert.equal(queries[1].get('generation'),'g1');assert.equal(a.snapshot.ml_complete,true);
 await read(new URLSearchParams('mode=stock&days=30'),'cookie');assert.equal(reads,1);
});
test('invalid inputs and unavailable stock fail explicitly instead of producing an empty report',async()=>{
 let calls=0;const read=createStockReport({now:()=>now,readCatalog:async()=>[],readSales:()=>{calls++;return{data:{rows:[],pages:1,snapshot:meta}};}});
 for(const q of ['mode=stock&days=0','mode=stock&days=31','mode=stock&cover=0','mode=stock&cover=91','mode=stock&cover=2.5','mode=stock&days=30&days=90','mode=stock&path=/etc/passwd'])await assert.rejects(()=>read(new URLSearchParams(q)),e=>e.status===400);
 assert.equal(calls,0);await assert.rejects(()=>read(new URLSearchParams('mode=stock')),e=>e.status===503);
});
test('a gap in ML history is reported as partial; missing rows do not become zero-demand proof',async()=>{
 const read=createStockReport({now:()=>now,readCatalog:async()=>[product(1)],readSales:()=>({data:{rows:[],pages:1,snapshot:{...meta,windows:[{from:'2026-07-17',to:'2026-08-01'},{from:'2026-08-03',to:'2026-10-14'}]}}})});
 const data=(await read(new URLSearchParams('mode=stock'))).data;assert.equal(data.snapshot.ml_complete,false);assert.equal(data.rows[0].coverage_days,null);
});
test('stock routes stay inside existing authenticated report gateway',async t=>{
 assert.equal(allowedTarget('/herramientas/gestion-vps/ventas/stock/').kind,'stock-page');assert.equal(allowedTarget('/herramientas/gestion-vps/ventas/api?mode=stock&days=90&cover=15').kind,'metrics-api');assert.equal(allowedTarget('/herramientas/gestion-vps/ventas/api?mode=stock&path=x'),null);
 let isAdmin=false,called=0;const auth=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,is_admin:isAdmin,user:'qa'}));});await new Promise(r=>auth.listen(0,'127.0.0.1',r));t.after(()=>auth.close());
 const server=createGateway({secret:'x'.repeat(64),upstreamHost:'127.0.0.1',authPort:auth.address().port,metricsRead:async()=>{called++;return{success:true,data:{rows:[]}};},andreaniHandle:()=>{},posHandle:()=>{},deliveryHandle:()=>{},pdfHandle:()=>{}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 let res=await fetch(base+'/herramientas/gestion-vps/ventas/api?mode=stock&days=90&cover=15');assert.equal(res.status,403);assert.equal(called,0);
 isAdmin=true;res=await fetch(base+'/herramientas/gestion-vps/ventas/api?mode=stock&days=90&cover=15');assert.equal(res.status,200);assert.equal((await res.json()).success,true);assert.equal(called,1);
 res=await fetch(base+'/herramientas/gestion-vps/ventas/api?mode=stock',{method:'POST'});assert.equal(res.status,423);
});

test('services never become zero-stock or synthetic-stock replenishment alerts; workshop merchandise remains countable',()=>{
 const catalog=[product(19688,{stock:0,categorias_json:'["SERVICES","Taller"]'}),product(2,{stock:999924,categorias_json:'["Servicios"]'}),product(3,{stock:0,categorias_json:'["Taller","Repuestos"]'})];
 const r=stockRows(catalog,[sale(19688,12),sale(2,15),sale(3,3)],opts);
 for(const id of [19688,2]){const row=r.rows.find(x=>x.id===id);assert.equal(row.stock,null);assert.equal(row.alert,'service');assert.equal(row.coverage_days,null);assert.ok(row.units>0);}
 assert.equal(r.rows.find(x=>x.id===3).alert,'missing');assert.equal(r.rows.find(x=>x.id===3).stock,0);assert.equal(r.quality.services,2);
});
