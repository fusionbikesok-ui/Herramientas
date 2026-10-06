import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {createDelivery,DeliveryError} from './delivery.mjs';
import {createGateway,allowedTarget,prefix} from './gateway.mjs';
const pdf=Buffer.from('%PDF-1.7\nTest-only PDF bytes');
const invoice={id:42,number:71,status:'authorized',environment:'production',payload:{type:6,point:15,currency:'ARS',totals:{gross:5000},issuer:{company:'Fusion Bikes'},customer:{name:'Cliente <prueba>'}}};
function fixture(t,extra={}){const dir=mkdtempSync(path.join(tmpdir(),'delivery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let time=1800000000000;const sent=[];const statePath=path.join(dir,'delivery.sqlite');const handle=createDelivery({statePath,read:async kind=>kind==='pdf'?pdf:invoice,send:async mail=>{sent.push(mail);return {accepted:[mail.to],messageId:'mock-only'};},now:()=>time,...extra});return {handle,sent,statePath,tick:n=>{time+=n;}};}
const request=(more={})=>({id:42,email:'cliente@example.test',idempotency_key:crypto.randomUUID(),...more});
test('Email attaches the final PDF once; same request is replayed without SMTP; cool down applies',async t=>{
 const f=fixture(t),input=request();const result=await f.handle('email',input,'admin');assert.equal(result.state,'accepted');assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].attachments[0].content,pdf);assert.match(f.sent[0].subject,/00015-00000071/);assert.match(f.sent[0].html,/&lt;prueba&gt;/);assert.doesNotMatch(f.sent[0].html,/<prueba>/);
 assert.equal((await f.handle('email',input,'admin')).id,result.id);assert.equal(f.sent.length,1);
 await assert.rejects(f.handle('email',request(),'admin'),e=>e.code==='delivery_recent');
 await assert.rejects(f.handle('email',request(),'other-admin'),e=>e.code==='delivery_recent');
 await assert.rejects(f.handle('email',input,'other-admin'),e=>e.code==='delivery_conflict');
 assert.equal((await f.handle('delivery',{id:42},'admin')).items[0].state,'accepted');
});
test('Unknown SMTP outcomes never automatically retry and require an explicit reviewed retry',async t=>{
 let calls=0;const f=fixture(t,{send:async()=>{calls++;throw Error('mock uncertain transport');}}),input=request();
 assert.equal((await f.handle('email',input,'admin')).state,'unknown');assert.equal((await f.handle('email',input,'admin')).state,'unknown');assert.equal(calls,1);
 await assert.rejects(f.handle('email',request(),'admin'),e=>e.code==='delivery_uncertain');
 await f.handle('email',request({retry_after:input.idempotency_key}),'admin');assert.equal(calls,2);
});
test('Concurrent requests cannot create duplicate SMTP sends',async t=>{
 let release,entered;const pending=new Promise(r=>release=r),inside=new Promise(r=>entered=r);let calls=0;
 const f=fixture(t,{send:async mail=>{calls++;entered();await pending;return {accepted:[mail.to]};}});
 const first=f.handle('email',request(),'admin');await inside;
 await assert.rejects(f.handle('email',request(),'admin'),e=>e.code==='delivery_busy');release();await first;assert.equal(calls,1);
});
test('Parallel PDF preparation serializes before SMTP acceptance boundary',async t=>{
 const f=fixture(t);const results=await Promise.allSettled([f.handle('email',request(),'admin'),f.handle('email',request(),'admin')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.sent.length,1);
});
test('Private, unguessable links retrieve exactly one PDF and expire after seven days',async t=>{
 const f=fixture(t);const share=await f.handle('share',{id:42,phone:'+54 9 351 5555555'},'admin');assert.equal(f.sent.length,0);assert.match(share.whatsapp_url,/^https:\/\/wa\.me\/5493515555555\?text=/);
 const token=share.url.split('/').at(-1);assert.deepEqual((await f.handle('public',{token})).pdf,pdf);
 const db=new DatabaseSync(f.statePath);assert.notEqual(db.prepare('SELECT hash FROM links').get().hash,token);db.close();
 await assert.rejects(f.handle('public',{token:'f'.repeat(64)}),e=>e.status===404);f.tick(7*86400000);await assert.rejects(f.handle('public',{token}),e=>e.status===404);
});
test('Drafts, invalid PDFs, malformed recipients and missing identity cannot send',async t=>{
 const draft=fixture(t,{read:async()=>({...invoice,status:'draft'})});await assert.rejects(draft.handle('email',request(),'admin'),e=>e.code==='delivery_not_final');assert.equal(draft.sent.length,0);
 const broken=fixture(t,{read:async kind=>kind==='pdf'?Buffer.from('<html>not a PDF</html>'):invoice});await assert.rejects(broken.handle('email',request(),'admin'),e=>e.code==='delivery_pdf');assert.equal(broken.sent.length,0);
 const f=fixture(t);for(const email of ['a@example.test\r\nBcc: x@example.test','a@example.test,b@example.test','invalid'])await assert.rejects(f.handle('email',request({email}),'admin'));await assert.rejects(f.handle('email',request(),''));assert.equal(f.sent.length,0);
});
test('Abandoned sending records become uncertain, preserving duplicate protection across restarts',async t=>{
 const f=fixture(t);await f.handle('email',request(),'admin');const db=new DatabaseSync(f.statePath);db.exec("UPDATE emails SET state='sending'");db.close();f.tick(120001);assert.equal((await f.handle('delivery',{id:42},'admin')).items[0].state,'unknown');await assert.rejects(f.handle('email',request(),'admin'),e=>e.code==='delivery_uncertain');
});
test('Internal and homologation messages are labeled without implying fiscal authorization',async t=>{
 for(const record of [{...invoice,status:'internal',payload:{...invoice.payload,internal_number:'X-001'}},{...invoice,environment:'homologation'}]){const f=fixture(t,{read:async kind=>kind==='pdf'?pdf:record});await f.handle('email',request(),'admin');assert.match(f.sent[0].text,/SIN VALIDEZ FISCAL/);}
});
test('Gateway restricts delivery to authenticated admins with origin and CSRF; only token PDF is public',async t=>{
 let authState={ok:false},calls=[];const auth=http.createServer((req,res)=>res.end(JSON.stringify(authState)));await new Promise(r=>auth.listen(0,'127.0.0.1',r));
 const secret='b'.repeat(64),origin='https://herramientas.fusionbikes.com.ar';
 const gateway=createGateway({secret,upstreamHost:'127.0.0.1',upstreamPort:1,authPort:auth.address().port,deliveryHandle:async(action,input,user)=>{calls.push({action,input,user});if(action==='public'){if(input.token!=='a'.repeat(64))throw new DeliveryError('Not found',404);return {pdf,filename:'test.pdf'};}return {state:'accepted'};}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(()=>{auth.close();gateway.close();});const base='http://127.0.0.1:'+gateway.address().port+prefix;
 const publicPath='/facturador/comprobante/'+'a'.repeat(64);const result=await fetch(base+publicPath);assert.equal(result.status,200);assert.equal(result.headers.get('referrer-policy'),'no-referrer');assert.equal(result.headers.get('content-type'),'application/pdf');assert.equal(await result.text(),pdf.toString());assert.equal((await fetch(base+publicPath,{method:'HEAD'})).status,200);
 assert.equal((await fetch(base+publicPath+'?id=1')).status,404);assert.equal((await fetch(base+'/facturador/comprobante/'+'f'.repeat(64))).status,404);
 const endpoint=base+'/wp-json/fusion-arca/v1/invoices/42/email';const post={method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({...request(),id:999})};assert.equal((await fetch(endpoint,post)).status,401);
 authState={ok:true,is_admin:false,user:'admin'};assert.equal((await fetch(endpoint,post)).status,403);authState.is_admin=true;
 assert.equal((await fetch(endpoint,post)).status,403);const csrf=(await(await fetch(base+'/wp-json/fusion-arca/v1/delivery-session')).json()).csrf;post.headers['x-fusion-csrf']=csrf;
 assert.equal((await fetch(endpoint,{...post,headers:{...post.headers,origin:'https://attacker.invalid'}})).status,403);assert.equal((await fetch(endpoint,post)).status,200);assert.equal(calls.at(-1).input.id,42);assert.equal(calls.at(-1).user,'admin');
 for(const route of ['/wp-json/fusion-arca/v1/invoices/42/whatsapp','/wp-json/fusion-arca/v1/whatsapp/check'])assert.equal((await fetch(base+route,post)).status,423);
 assert.equal(allowedTarget(prefix+'/wp-json/fusion-arca/v1/invoices/42/email?rest_route=/wp/v2/users','POST'),null);
 assert.equal(allowedTarget(prefix+'/?rest_route=/fusion-arca/v1/invoices/42/email&rest_route=/wp/v2/users','POST'),null);
});
