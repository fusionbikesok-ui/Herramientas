import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

export class DeliveryError extends Error {constructor(message,status=400,code='delivery_error',data={}){super(message);Object.assign(this,{status,code,data});}}
const fail=(m,s=400,c,d)=>{throw new DeliveryError(m,s,c,d);};
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function deliveryRoute(route,method,local){
 if(route==='/fusion-arca/v1/delivery-session'&&method==='GET')return {kind:'delivery',action:'session',local};
 const m=route.match(/^\/fusion-arca\/v1\/invoices\/([1-9]\d{0,11})\/(email|share|delivery)$/);
 return m&&((method==='POST'&&m[2]!=='delivery')||(method==='GET'&&m[2]==='delivery'))?{kind:'delivery',action:m[2],id:Number(m[1]),local}:null;
}
export function smtpTransport(configPath='/etc/fusion-management-delivery-mail.json'){
 let transport,from;
 function configured(){
  if(transport)return transport;
  let c;try{c=JSON.parse(readFileSync(configPath,'utf8'));}catch{fail('El correo del VPS necesita configuración.',503,'delivery_mail_config');}
  if(!c.host||!c.user||!c.pass||!c.from||![465,587,2525].includes(Number(c.port)))fail('La configuración de correo no está completa.',503,'delivery_mail_config');
  const nodemailer=createRequire(import.meta.url)('/opt/fusionbikes/herramientas/node_modules/nodemailer');
  from=c.from;transport=nodemailer.createTransport({host:c.host,port:Number(c.port),secure:Number(c.port)===465,requireTLS:Number(c.port)!==465,auth:{user:c.user,pass:c.pass},tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:60000,logger:false,debug:false});return transport;
 }
 return {verify:()=>configured().verify(),send:async mail=>{const t=configured();return t.sendMail({...mail,from});}};
}
export function createDelivery({statePath=path.join(process.env.STATE_DIRECTORY||'/var/lib/fusion-management-validation','delivery.sqlite'),read,send,now=()=>Date.now(),origin='https://herramientas.fusionbikes.com.ar'}={}){
 function db(){const d=new DatabaseSync(statePath);try{chmodSync(statePath,0o600);}catch{}d.exec('PRAGMA busy_timeout=3000;PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS links(hash TEXT PRIMARY KEY,invoice INTEGER NOT NULL,expires INTEGER NOT NULL,pdf BLOB NOT NULL,filename TEXT NOT NULL);CREATE TABLE IF NOT EXISTS emails(id TEXT PRIMARY KEY,user TEXT NOT NULL,invoice INTEGER NOT NULL,recipient TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,message_id TEXT);CREATE INDEX IF NOT EXISTS emails_lookup ON emails(user,invoice,recipient,created);');return d;}
 function status(row){const state=row.state==='sending'&&now()-row.updated>120000?'unknown':row.state;return {id:row.id,recipient:row.recipient,state,created_at:new Date(row.created).toISOString(),message:state==='accepted'?'El servidor de correo aceptó el mensaje con el PDF adjunto. La aceptación todavía no confirma la entrega.':state==='sending'?'El envío está en curso. Actualizá su estado antes de reintentar.':'No se pudo confirmar el resultado del envío. Revisá la casilla de correo antes de reenviar para evitar duplicados.'};}
 async function document(id,user){const row=await read('invoice',id,user);if(Number(row.id)!==id||!['authorized','internal'].includes(row.status)||!row.payload)fail('Primero finalizá el comprobante para compartirlo.',409,'delivery_not_final');return row;}
 async function share(d,row,user){
  const pdf=await read('pdf',row.id,user);if(!Buffer.isBuffer(pdf)||pdf.length<10||pdf.length>8*1024*1024||pdf.subarray(0,5).toString()!=='%PDF-')fail('No se pudo preparar un PDF válido. No se envió el comprobante.',502,'delivery_pdf');
  const token=crypto.randomBytes(32).toString('hex'),expires=now()+7*86400000,filename='Fusion-Bikes-Comprobante-'+row.id+'.pdf';
  d.prepare('DELETE FROM links WHERE expires<=?').run(now());
  d.prepare('INSERT INTO links VALUES(?,?,?,?,?)').run(sha(token),row.id,expires,pdf,filename);
  return {url:origin+'/herramientas/gestion-vps/facturador/comprobante/'+token,pdf,filename};
 }
 function description(row){const p=row.payload;const number=p.internal_number||String(p.point).padStart(5,'0')+'-'+String(row.number).padStart(8,'0');const kind=row.status==='internal'?'Comprobante sin CAE':([3,8].includes(Number(p.type))?'Nota de crédito ':'Factura ')+([1,3].includes(Number(p.type))?'A':'B');return {label:kind+' '+number,total:String(p.currency||'ARS')+' '+Number(p.totals?.gross||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}),warning:row.environment!=='production'?'HOMOLOGACIÓN · SIN VALIDEZ FISCAL':row.status==='internal'?'COMPROBANTE SIN CAE · SIN VALIDEZ FISCAL':''};}
 return async(action,input={},user)=>{
  const d=db();try{
   if(action==='public'){
    if(!/^[a-f0-9]{64}$/.test(input.token||''))fail('El enlace no está disponible o venció.',404);
    const row=d.prepare('SELECT pdf,filename FROM links WHERE hash=? AND expires>?').get(sha(input.token),now());if(!row)fail('El enlace no está disponible o venció.',404);
    return {pdf:Buffer.from(row.pdf),filename:row.filename};
   }
   const id=input.id;if(!user||!Number.isSafeInteger(id)||id<1)fail('Comprobante inválido.');
   if(action==='delivery')return {items:d.prepare('SELECT * FROM emails WHERE invoice=? ORDER BY created DESC,rowid DESC LIMIT 8').all(id).map(status)};
   if(action==='share'){
    const phone=String(input.phone??'').replace(/\D/g,'');if(phone&&!/^[1-9]\d{10,14}$/.test(phone))fail('Ingresá el teléfono con código de país. Ejemplo: 5493515214819.');
    const row=await document(id,user),file=await share(d,row,user),info=description(row);
    const message=[info.warning,row.payload.issuer?.company||'Fusion Bikes',info.label,info.total,'Ver / descargar el PDF (enlace válido por 7 días):',file.url].filter(Boolean).join('\n');
    return {url:file.url,whatsapp_url:'https://wa.me/'+phone+'?text='+encodeURIComponent(message),message:'Revisá el destinatario y pulsá Enviar en WhatsApp. El enlace al PDF vence en 7 días.',expires_days:7};
   }
   if(action!=='email')fail('Acción no disponible.',404);
   const recipient=String(input.email??'').trim().toLowerCase();if(recipient.length>254||!/^[-+.!#$%&'*\/=?^_`{|}~a-z0-9]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(recipient)||/[\r\n]/.test(recipient))fail('Ingresá un correo válido para el destinatario.',400,'delivery_email');
   const key=input.idempotency_key;if(!uuid.test(key||''))fail('Falta identificar el envío.',400,'delivery_key');
   let row=d.prepare('SELECT * FROM emails WHERE id=?').get(key);
   if(row){if(row.user!==user||row.invoice!==id||row.recipient!==recipient)fail('Ese envío pertenece a otra solicitud.',409,'delivery_conflict');return status(row);}
   const previous=d.prepare('SELECT * FROM emails WHERE invoice=? AND recipient=? ORDER BY created DESC,rowid DESC LIMIT 1').get(id,recipient);
   if(previous){const previousState=status(previous).state;if(previousState==='sending')fail('El envío anterior sigue en curso.',409,'delivery_busy');if(previousState==='unknown'&&input.retry_after!==previous.id)fail('El envío anterior tiene un resultado incierto. Revisá la casilla antes de reenviar.',409,'delivery_uncertain',{previous:previous.id});if(previousState==='accepted'&&now()-previous.created<60000)fail('El comprobante fue enviado hace unos segundos. Esperá un minuto antes de reenviarlo.',409,'delivery_recent');}
   const invoice=await document(id,user),file=await share(d,invoice,user),info=description(invoice);
   // Serialize the acceptance boundary across concurrent requests, including different UUIDs.
   d.exec('BEGIN IMMEDIATE');try{
    const concurrent=d.prepare('SELECT * FROM emails WHERE invoice=? AND recipient=? ORDER BY created DESC,rowid DESC LIMIT 1').get(id,recipient);
    if(concurrent?.id!==previous?.id)fail('Otra solicitud procesó este envío. Actualizá el estado.',409,'delivery_busy');
    d.prepare('INSERT INTO emails(id,user,invoice,recipient,state,created,updated) VALUES(?,?,?,?,?,?,?)').run(key,user,id,recipient,'sending',now(),now());d.exec('COMMIT');
   }catch(e){d.exec('ROLLBACK');throw e;}
   const subject=(info.warning?'['+info.warning+'] ':'')+info.label+' · Fusion Bikes';
   const text=[info.warning,'Hola '+(invoice.payload.customer?.name||''), 'Te enviamos '+info.label+'.','Total: '+info.total,'Adjuntamos el PDF del comprobante. El archivo adjunto no vence.','Ver en línea (7 días): '+file.url,'Gracias por elegir Fusion Bikes.'].filter(Boolean).join('\n\n');
   const html='<div style="font:16px/1.6 Arial,sans-serif;max-width:600px;color:#172b28"><h2>Fusion Bikes</h2>'+text.split('\n\n').map(line=>'<p>'+escape(line)+'</p>').join('')+'</div>';
   try{const result=await send({to:recipient,subject,text,html,attachments:[{filename:file.filename,content:file.pdf,contentType:'application/pdf'}]});if(!result?.accepted?.some(a=>String(a).toLowerCase()===recipient))throw Error('not accepted');d.prepare('UPDATE emails SET state=?,updated=?,message_id=? WHERE id=?').run('accepted',now(),String(result.messageId||'').slice(0,250),key);}
   catch{d.prepare('UPDATE emails SET state=?,updated=? WHERE id=?').run('unknown',now(),key);}
   row=d.prepare('SELECT * FROM emails WHERE id=?').get(key);return status(row);
  }finally{d.close();}
 };
}
