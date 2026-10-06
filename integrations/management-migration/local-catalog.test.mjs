import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {queryCatalog,catalogRoute,createLocalCatalog,readLocalCatalog,readLocalCash,catalogImage} from './local-catalog.mjs';
import {createGateway,prefix} from './gateway.mjs';

const rows=[
 {id_woo:1,nombre:'Pedal SHIMANO M520',sku:'FB-1',gtin:'689228060470',tipo:'simple',stock:13,precio:172500,actualizado_en:'2026-10-04T20:00:00Z'},
 {id_woo:2,nombre:'Bicicleta Álamos',sku:'BIKE',gtin:'1234567890123',tipo:'variable',stock:99},
 {id_woo:3,nombre:'Bicicleta Álamos — Rojo M',sku:'BIKE-M',tipo:'variation',id_padre:2,stock:2,precio:null,atributos_json:'[{"name":"Talle","option":"M"}]'},
 {id_woo:4,nombre:'Bicicleta Álamos — Azul L',sku:'BIKE-L',tipo:'variation',id_padre:2,stock:0},
 {id_woo:5,nombre:'Pedal sin cantidad',sku:'NO-STOCK',tipo:'simple',stock:null},
 {id_woo:6,nombre:'Pedal con diferencia',sku:'NEG',tipo:'simple',stock:-2},
];
const target=(route,query='')=>catalogRoute('/index.php?rest_route='+encodeURIComponent(route)+'&'+query);

test('Local search preserves stock, excludes parents and never invents commercial prices',()=>{
 const result=queryCatalog(rows,target('/fbpos/v2/search','q=shimano%20m520'));
 assert.equal(result.length,1);assert.equal(result[0].stock,13);assert.equal(result[0].price,null);assert.equal(result[0].selectable,false);
 assert.equal(result[0]._local.reference_price,null);assert.equal(result[0]._local.updated_at,'2026-10-04T20:00:00Z');assert.equal(result[0].stock_status,'unverified');
 const exact=queryCatalog(rows,target('/fbpos/v2/search','q=689228060470&exact=1'));assert.equal(exact[0].id,1);assert.equal(exact[0].exact,true);
 const children=queryCatalog(rows,target('/fbpos/v2/search','q=1234567890123&exact=1'));assert.deepEqual(children.map(p=>p.id),[4,3]);assert.ok(children.every(p=>p.exact===false));
 assert.deepEqual(queryCatalog(rows,target('/fbpos/v2/search','q=alamos')).map(p=>p.id),[3]);
 const unknown=queryCatalog(rows,target('/fbpos/v2/product/5'));assert.equal(unknown.stock,null);assert.equal(unknown.in_stock,null);
 const zero=queryCatalog(rows,target('/fbpos/v2/product/4'));assert.equal(zero.stock,0);assert.equal(zero.stock_status,'unverified');
 assert.throws(()=>queryCatalog(rows,target('/fbpos/v2/product/2')),/no figura/);
});
test('Filters, paging, accents, literal special characters and invalid inputs remain bounded',()=>{
 const large=Array.from({length:45},(_,i)=>({id_woo:100+i,nombre:'Cámara '+String(i).padStart(2,'0'),sku:'CAM-'+i,tipo:'simple',stock:1}));
 const result=queryCatalog(large,target('/fusion-arca/v1/products','q=camara&page=2&stock=instock'));
 assert.equal(result.rows.length,20);assert.equal(result.page,2);assert.equal(result.has_more,true);assert.equal(result.rows[0].id,120);
 assert.equal(queryCatalog(rows,target('/fusion-taller/v1/products','q=pedal')).rows.length,3);
 assert.equal(queryCatalog(rows,target('/fusion-arca/v1/products','q=pedal&stock=outofstock')).rows[0].stock,-2);
 assert.deepEqual(queryCatalog(rows,target('/fbpos/v2/search',"q=%25%27%20OR%201%3D1")),[]);
 for(const query of ['q=x&q=y','q='+ 'x'.repeat(101),'page=-1','page=100000','stock=invalid','q=%00'])assert.throws(()=>queryCatalog(rows,target('/fbpos/v2/search',query)));
 assert.equal(catalogRoute('/index.php?rest_route=/fbpos/v2/prepare'),null);
});
test('Cache coalesces local reads, expires after 5 seconds and fails instead of serving stale stock',async()=>{
 let time=0,calls=0,fail=false;
 const catalog=createLocalCatalog({port:1,now:()=>time,readCash:async()=>115000,read:async()=>{calls++;if(fail)throw new Error('offline');return rows;}});
 const q=target('/fbpos/v2/search','q=shimano');
 await Promise.all([catalog(q,'a'),catalog(q,'a')]);assert.equal(calls,1);
 time=4999;await catalog(q,'a');assert.equal(calls,1);
 time=5000;fail=true;await assert.rejects(catalog(q,'a'));assert.equal(calls,2);
 fail=false;await catalog(q,'a');assert.equal(calls,3);
});
test('HTTP flow reads only the existing VPS catalogue and checks authorization even on cache hits',async t=>{
 let authorized=true,admin=true,reads=0;
 const local=http.createServer((req,res)=>{
   assert.equal(req.headers.cookie,'connect.sid=fixture');res.setHeader('Content-Type','application/json');
   if(req.url==='/api/auth/me'){res.statusCode=authorized?200:401;res.end(JSON.stringify({ok:authorized,user:'fixture',is_admin:admin}));return;}
   if(req.url==='/api/consulta-precios/buscar?q=FB-1'){res.end(JSON.stringify({ok:true,found:true,producto:{id_woo:1,sku:'FB-1',precio:115000}}));return;}
   assert.equal(req.url,'/api/woo/catalogo');assert.equal(req.method,'GET');reads++;res.end(JSON.stringify({ok:true,data:rows}));
 });
 await new Promise(r=>local.listen(0,'127.0.0.1',r));
 const gateway=createGateway({secret:'x'.repeat(64),authPort:local.address().port,upstreamHost:'127.0.0.1',upstreamPort:1});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 t.after(()=>{local.close();gateway.close();});
 const base='http://127.0.0.1:'+gateway.address().port+prefix;
 const headers={cookie:'connect.sid=fixture'};
 let response=await fetch(base+'/wp-json/fbpos/v2/search?q=FB-1',{headers});assert.equal(response.status,200);const product=(await response.json())[0];assert.equal(product.stock,13);assert.equal(product._local.reference_price,115000);assert.equal(response.headers.get('X-Fusion-Catalog-Source'),'vps-local');assert.equal(reads,1);
 response=await fetch(base+'/wp-json/fbpos/v2/product/1',{headers});assert.equal(response.status,200);assert.equal(reads,1);
 authorized=false;assert.equal((await fetch(base+'/wp-json/fbpos/v2/search?q=FB-1',{headers})).status,401);assert.equal(reads,1);
 authorized=true;admin=false;assert.equal((await fetch(base+'/wp-json/fbpos/v2/search?q=FB-1',{headers})).status,403);assert.equal(reads,1);
 admin=true;assert.equal((await fetch(base+'/wp-json/fbpos/v2/search?q=FB-1',{headers,method:'POST'})).status,423);
});
test('Local HTTP failures do not masquerade as an empty catalogue',async t=>{
 const local=http.createServer((req,res)=>{res.writeHead(500);res.end('{"ok":false}');});await new Promise(r=>local.listen(0,'127.0.0.1',r));t.after(()=>local.close());
 await assert.rejects(readLocalCatalog('',local.address().port),/catálogo/);
});
test('Catalogue renderer escapes names and preserves unknown quantities and cash labels',()=>{
 const context={window:{},document:{addEventListener(){}},Intl,Date,URL};
 vm.runInNewContext(readFileSync(new URL('./assets/catalog-ui.js',import.meta.url),'utf8'),context);
 const p=queryCatalog(rows,target('/fbpos/v2/product/5'));p.name='<img src=x onerror=alert(1)>';
 const html=context.window.FusionLocalCatalog.render([p]);
 assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));assert.ok(html.includes('Sin dato de stock'));assert.ok(html.includes('Contado / Transferencia'));assert.ok(html.includes('sin fecha disponible'));
 p.image='https://fusionbikes.com.ar/wp-content/uploads/2026/bike.webp';assert.ok(context.window.FusionLocalCatalog.render([p]).includes('<img src="https://fusionbikes.com.ar/'));
 p.image='https://evil.example/tracker.png';assert.ok(!context.window.FusionLocalCatalog.render([p]).includes('<img'));
});

test('Images use the known uploads source and inherit the parent; private/data/javascript URLs are rejected',()=>{
 for(const url of ['http://fusionbikes.com.ar/wp-content/uploads/a.jpg','javascript:alert(1)','data:image/png,abc','https://user:password@fusionbikes.com.ar/wp-content/uploads/a.jpg','https://127.0.0.1/wp-content/uploads/a.jpg','https://fusionbikes.com.ar/wp-content/uploads/a.svg','https://fusionbikes.com.ar/wp-admin/a.png','https://fusionbikes.com.ar/wp-content/uploads/a.jpg?key=x'])assert.equal(catalogImage(url),'');
 const parent={...rows[1],img:'https://fusionbikes.com.ar/wp-content/uploads/2026/bike.webp'};
 assert.equal(queryCatalog([parent,rows[2]],target('/fbpos/v2/product/3')).image,parent.img);
});

test('Cash lookup binds identity and never falls back to the REST list or a stale price',async t=>{
 let value={ok:true,found:true,producto:{id_woo:70394,sku:'FB-70394',precio:4450000}};
 const local=http.createServer((req,res)=>{assert.equal(req.url,'/api/consulta-precios/buscar?q=FB-70394');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});
 await new Promise(r=>local.listen(0,'127.0.0.1',r));t.after(()=>local.close());
 const p={id:70394,sku:'FB-70394'};assert.equal(await readLocalCash(p,'',local.address().port),4450000);
 value.producto.id_woo=1;assert.equal(await readLocalCash(p,'',local.address().port),null);
 value={ok:false};await assert.rejects(readLocalCash(p,'',local.address().port));
 let fail=false,time=0;
 const catalog=createLocalCatalog({now:()=>time,read:async()=>rows,readCash:async()=>{if(fail)throw new Error('unavailable');return 115000;}});
 const q=target('/fbpos/v2/product/1');assert.equal((await catalog(q,''))._local.reference_price,115000);
 time=5000;fail=true;const missing=await catalog(q,'');assert.equal(missing._local.reference_price,null);assert.equal(missing.stock,13);
});
