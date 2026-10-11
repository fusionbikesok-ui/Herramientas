import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDirectory,directoryRoute,DirectoryError} from './directory.mjs';
import {createGateway,prefix} from './gateway.mjs';
import http from 'node:http';

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'fusion-directory-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'index.sqlite'),statusPath=join(dir,'status.json'),db=new DatabaseSync(path);
 db.exec('CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE customers(id INTEGER PRIMARY KEY,search TEXT,data TEXT);CREATE TABLE guests(order_id INTEGER PRIMARY KEY,search TEXT,data TEXT);CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER,search TEXT,created_at TEXT,data TEXT)');
 db.prepare('INSERT INTO state VALUES(?,?)').run('completed_at',JSON.stringify(new Date().toISOString()));
 const c={id:4,key:'woo:customer:4',name:'José <script>',email:'jose@example.invalid',document:'12345678',billing:{first_name:'José',email:'jose@example.invalid'},marketing_consent:'unknown'};
 db.prepare('INSERT INTO customers VALUES(?,?,?)').run(4,'jose <script> jose@example.invalid 12345678 541112345678',JSON.stringify(c));
 for(const id of [10,11]) db.prepare('INSERT INTO guests VALUES(?,?,?)').run(id,'ana',JSON.stringify({id:0,key:'woo:order:'+id,kind:'guest_order'}));
 db.prepare('INSERT INTO orders VALUES(?,?,?,?,?)').run(22,4,'fb-70394 22 jose', '2024-01-01',JSON.stringify({id:22,total:'10.13',currency:'USD',is_ml_mirror:true,ml_order_id:'555',items:[{sku:'FB-70394'}]}));db.close();
 writeFileSync(statusPath,JSON.stringify({state:'error'}));return {read:createDirectory({path,statusPath}),path,statusPath,dir};
}
test('Routes intercept only intended reads',()=>{
 assert.equal(directoryRoute('/index.php?rest_route=/fbpos/v2/customers&q=Ana').kind,'pos');
 assert.equal(directoryRoute('/index.php?rest_route=/fusion-taller/v1/customers').kind,'taller');
 assert.equal(directoryRoute('/index.php?rest_route=/fusion-arca/v1/customer-lookup'),null);
});
test('Local search handles accents, conjunction, documents and SQL wildcards literally',t=>{
 const {read}=fixture(t);
 assert.equal(read({kind:'customers',q:'JOSÉ 12345678'}).rows[0].id,4);
 assert.equal(read({kind:'customers',q:'541112345678'}).total,1);
 assert.equal(read({kind:'customers',q:'12.345.678'}).total,1);
 assert.equal(read({kind:'customers',q:'%_'}).total,0);
 assert.throws(()=>read({kind:'customers',page:'-1',q:'ana'}),DirectoryError);
 assert.throws(()=>read({kind:'customers',q:'x'.repeat(161)}),DirectoryError);
});
test('Guests are preserved separately; native plugin adapters return Woo customer IDs only',t=>{
 const {read}=fixture(t),guests=read({kind:'customers',q:'Ana'}).rows;
 assert.equal(guests.length,2);assert.notEqual(guests[0].key,guests[1].key);
 assert.equal(read({kind:'pos',q:'Ana'}).length,0);
 const pos=read({kind:'pos',q:'José'});assert.equal(pos[0].id,4);assert.equal(pos[0]._local_directory.read_only,true);
 assert.equal(pos[0].billing.billing_first_name,'José');assert.equal(pos[0].document_type,'DNI');
 assert.equal(read({kind:'taller',q:'José'}).rows[0].id,4);
});
test('Historical orders preserve amounts, source mirror and stale snapshot status on sync failure',t=>{
 const {read}=fixture(t),result=read({kind:'orders',q:'FB-70394'});
 assert.equal(result.rows[0].total,'10.13');assert.equal(result.rows[0].currency,'USD');assert.equal(result.rows[0].is_ml_mirror,true);
 assert.equal(result.status.sync.state,'error');assert.equal(read({kind:'order',id:'22'}).order.id,22);
 assert.equal(read({kind:'orders',q:'#22'}).rows[0].id,22);
 assert.equal(read({kind:'customer-orders',id:'4'}).rows[0].id,22);
 assert.equal(read({kind:'customer-orders',id:'5'}).rows.length,0);
 assert.throws(()=>read({kind:'order',id:'23'}),e=>e.status===404);
});
test('Missing initial snapshot fails explicitly; readers reopen after atomic publication',t=>{
 const {read,path}=fixture(t);renameSync(path,path+'.old');
 assert.throws(()=>read({kind:'status'}),DirectoryError);renameSync(path+'.old',path);
 assert.equal(read({kind:'status'}).counts.customers,1);
});
test('Current admin authorization protects customer and order data; no upstream calls or writes',async t=>{
 const {read}=fixture(t);let status=401,is_admin=false,reads=0;
 const auth=http.createServer((req,res)=>{res.writeHead(status);res.end(JSON.stringify({ok:status===200,is_admin,user:'test'}));});
 await new Promise(r=>auth.listen(0,'127.0.0.1',r));
 const gw=createGateway({secret:'x'.repeat(64),authPort:auth.address().port,upstreamHost:'127.0.0.1',upstreamPort:1,directoryRead:r=>{reads++;return read(r);}});
 await new Promise(r=>gw.listen(0,'127.0.0.1',r));t.after(()=>{auth.close();gw.close();});
 const url='http://127.0.0.1:'+gw.address().port+prefix;
 assert.equal((await fetch(url+'/directory/api?kind=customers&q=Jose')).status,401);
 status=200;assert.equal((await fetch(url+'/directory/api?kind=customers&q=Jose')).status,403);assert.equal(reads,0);
 is_admin=true;const data=await fetch(url+'/directory/api?kind=customers&q=Jose');assert.equal(data.status,200);assert.equal(data.headers.get('x-fusion-directory-source'),'vps-local');assert.equal((await data.json()).rows.length,1);
 assert.equal((await fetch(url+'/wp-json/fbpos/v2/customers?q=Jose')).status,200);
 assert.equal((await fetch(url+'/directory/api',{method:'POST'})).status,423);
 status=401;assert.equal((await fetch(url+'/directory/api?kind=orders&q=22')).status,401);assert.equal(reads,2);
});
