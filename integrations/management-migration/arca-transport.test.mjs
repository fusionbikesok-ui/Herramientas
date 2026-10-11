import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import crypto from 'node:crypto';
import {allowedTarget,makeClaim,createGateway,prefix} from './gateway.mjs';
import {csrfToken} from './andreani.mjs';
const secret='s'.repeat(64),cookie='connect.sid=synthetic',user='test';
test('Manual fiscal routes remain private; delivery is handled separately without opening settings or ML',()=>{
 for(const path of ['connection','customer-lookup','invoices','invoices/3/emit','invoices/3/recover','invoices/3/credit-note/emit'])assert.ok(allowedTarget(prefix+'/wp-json/fusion-arca/v1/'+path,'POST'),path);
 for(const path of ['config','ml/process','bulk/emit','invoices/3/whatsapp'])assert.equal(allowedTarget(prefix+'/wp-json/fusion-arca/v1/'+path,'POST'),null,path);
 for(const action of ['email','share'])assert.equal(allowedTarget(prefix+'/wp-json/fusion-arca/v1/invoices/3/'+action,'POST').kind,'delivery');
 assert.equal(allowedTarget(prefix+'/wp-json/fusion-arca/v1/invoices/3/emit','GET'),null);
 assert.equal(allowedTarget(prefix+'/facturador/print?id=1&id=2'),null);
 assert.equal(allowedTarget(prefix+'/wp-json/fusion-arca/v1/invoices/3/recover?retry=REENVIAR','POST'),null);
 assert.equal(allowedTarget(prefix+'/?rest_route=/fusion-arca/v1/invoices/3/emit&id=4','POST'),null);
});
test('Signed body changes when payload changes',()=>{
 const a=makeClaim(user,'POST','/index.php?rest_route=test',secret,1,Buffer.from('{"a":1}'));
 const b=makeClaim(user,'POST','/index.php?rest_route=test',secret,1,Buffer.from('{"a":2}'));
 assert.notEqual(a['x-fusion-signature'],b['x-fusion-signature']);assert.equal(JSON.parse(Buffer.from(a['x-fusion-claim'],'base64')).sha256,crypto.createHash('sha256').update('{"a":1}').digest('hex'));
});
test('Authenticated POST validates CSRF, exact Origin, shape and size before forwarding body',async t=>{
 let admin=true,count=0;const auth=http.createServer((req,res)=>res.end(JSON.stringify({ok:true,user,is_admin:admin})));
 const upstream=http.createServer(async(req,res)=>{count++;let body='';for await(const chunk of req)body+=chunk;const claim=JSON.parse(Buffer.from(req.headers['x-fusion-claim'],'base64'));assert.equal(claim.sha256,crypto.createHash('sha256').update(body).digest('hex'));assert.equal(claim.method,'POST');assert.equal(req.headers.cookie,undefined);res.setHeader('Content-Type','application/json');res.end(body);});
 for(const s of [auth,upstream])await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const gateway=createGateway({secret,authPort:auth.address().port,upstreamHost:'127.0.0.1',upstreamPort:upstream.address().port});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>{auth.close();upstream.close();gateway.close();});
 const url='http://127.0.0.1:'+gateway.address().port+prefix+'/wp-json/fusion-arca/v1/invoices';const headers={cookie,origin:'https://herramientas.fusionbikes.com.ar','content-type':'application/json','x-fusion-csrf':csrfToken(secret,user,cookie)};
 const send=(body,patch={})=>fetch(url,{method:'POST',headers:{...headers,...patch},body});
 assert.equal((await send('{}',{origin:'https://evil.invalid'})).status,403);
 assert.equal((await send('{}',{'x-fusion-csrf':'f'.repeat(64)})).status,403);
 assert.equal((await send('{}',{cookie:'connect.sid=different'})).status,403);
 assert.equal((await send('{}',{'content-type':'text/plain'})).status,415);
 assert.equal((await send('[]')).status,400);assert.equal((await send('{')).status,400);
 assert.equal((await send(JSON.stringify({x:'a'.repeat(262144)}))).status,413);
 admin=false;assert.equal((await send('{}')).status,403);admin=true;assert.equal(count,0);
 const r=await send('{"payload":{"order_id":9}}');assert.equal(r.status,200);assert.deepEqual(await r.json(),{payload:{order_id:9}});assert.equal(count,1);
});
