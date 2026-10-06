import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createMetrics,lineRows,csvReport,MetricsError} from './metrics.mjs';
const options={states:{AR:{B:'Buenos Aires'}},taxonomies:[{name:'pa_marca'},{name:'pa_modelo'}],categories:[{id:62}],statuses:[{key:'wc-completed'},{key:'wc-refunded'}]};
const product={id:7,exists:true,name:'Padre actual',sku:'P',terms:{pa_marca:['Trek'],pa_modelo:['Ruta'],product_cat:['Hija']},category_ids:[8,62]};
const order={id:1,date:'2026-09-30',currency:'ARS',status:'completed',country:'AR',state:'B',city:'Ciudad',items:[{id:11,product_id:7,variation_id:9,name:'Histórico',quantity:2,amount:70.5}]};
test('Parent taxonomy, inherited category, current variant SKU and historical net money',()=>{
 const r=lineRows(order,new Map([[7,product],[9,{exists:true,sku:'V',variant:'Negro, S'}]]),options,{bikes:[62],brand:'',model:''})[0];
 assert.equal(r.kind,'Bicicletas');assert.equal(r.sku,'V');assert.equal(r.model,'Padre actual');assert.equal(r.amount,70.5);assert.equal(r.state,'Buenos Aires');assert.equal(r.brand,'Trek');
 const m=lineRows(order,new Map([[7,product]]),options,{bikes:[62],brand:'',model:'pa_modelo'})[0];assert.equal(m.modelKey,'m:Trek:Ruta');assert.equal(m.sku,'');
});
test('Deleted parents retain historical name and separate unknown classification',()=>{
 const r=lineRows({...order,items:[{...order.items[0],product_id:0,variation_id:0}]},new Map(),options,{bikes:[62],brand:'',model:''})[0];assert.equal(r.kind,'Sin clasificar');assert.equal(r.model,'Histórico');assert.equal(r.modelKey,'p:11');assert.deepEqual(r.categories,[]);
});
test('CSV applies the displayed filters, keeps currencies separate and blocks spreadsheet formulas',()=>{
 const base={date:'2026-09-01',brand:'Trek',model:'=IMPORT',sku:'FB-1',variant:'Negro',quantity:2,amount:-1.2,currency:'ARS',country:'AR',state:'B',city:'X',categories:['Hija'],kind:'Bicicletas'};
 const q=new URLSearchParams('currency=ARS&filter_kind=Bicicletas&filter_brands[]=Trek&category=Hija&search=FB-1');const csv=csvReport([base,{...base,currency:'USD'},{...base,brand:'Otro'}],q);
 assert.equal(csv.split('\r\n').length,2);assert.ok(csv.includes('"\'=IMPORT"'));assert.ok(csv.includes('"-1.2"'));assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"FB-1"'));
});
test('Local query preserves currencies, returns each Woo mirror once, pins pagination and validates input',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'fusion-metrics-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'metrics.sqlite'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE state(key TEXT,value TEXT);CREATE TABLE facts(id INTEGER,status TEXT,date TEXT,currency TEXT,data TEXT);CREATE TABLE products(id INTEGER,data TEXT)');
 for(const [key,value] of Object.entries({options,generation:'snapshot-a',orders_at:new Date().toISOString(),orders:3,lines:3}))db.prepare('INSERT INTO state VALUES(?,?)').run(key,JSON.stringify(value));
 for(const o of [order,{...order,id:2,currency:'USD',unassigned:true,ml_mirror:true},{...order,id:3,status:'refunded',items:[{...order.items[0],quantity:0,amount:0}]}])db.prepare('INSERT INTO facts VALUES(?,?,?,?,?)').run(o.id,o.status,o.date,o.currency,JSON.stringify(o));
 for(const p of [product,{id:9,exists:true,sku:'V',variant:'S'}])db.prepare('INSERT INTO products VALUES(?,?)').run(p.id,JSON.stringify(p));db.close();
 const read=createMetrics({path:file,statusPath:path.join(dir,'none'),batchSize:1}),q=new URLSearchParams('kind=batch&from=2026-09-01&to=2026-09-30&statuses[]=wc-completed&statuses[]=wc-refunded&bike_categories[]=62');
 const a=read(q).data;assert.equal(a.total,3);assert.equal(a.pages,3);assert.equal(a.rows[0].order,1);q.set('page','2');assert.throws(()=>read(q),e=>e.status===409);q.set('generation',a.snapshot.generation);const b=read(q).data;assert.equal(b.rows[0].currency,'USD');assert.equal(b.unassigned,1);q.set('generation','old');assert.throws(()=>read(q),e=>e.status===409);
 q.delete('generation');q.set('page','1');q.set('from','2026-02-30');assert.throws(()=>read(q),e=>e.status===400);q.set('from','2026-09-01');q.set('statuses[]',"wc-completed' OR 1=1");assert.throws(()=>read(q),e=>e.status===400);
 q.set('statuses[]','wc-completed');q.append('page','1');assert.throws(()=>read(q),e=>e.status===400);
});
