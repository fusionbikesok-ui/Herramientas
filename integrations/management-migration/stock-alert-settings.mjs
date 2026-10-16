import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class AlertSettingsError extends Error{constructor(message,status=400){super(message);this.status=status;}}
export function normalizePhone(value){
 if(typeof value!=='string'||value.length>30||!/^[+\d ().-]+$/.test(value))throw new AlertSettingsError('Ingresá un WhatsApp válido con código de área, sin 0 ni 15.');
 let number=value.replace(/\D/g,'');
 if(number.length===10)number='549'+number;
 else if(number.length===12&&number.startsWith('54'))number='549'+number.slice(2);
 if(!/^549[1-9]\d{9}$/.test(number))throw new AlertSettingsError('Ingresá un WhatsApp argentino con código de área, sin 0 ni 15.');
 return number;
}
export function validateSettings(value){
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!['revision','enabled','time','recipients'].includes(k)))throw new AlertSettingsError('Configuración inválida.');
 if(!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time||''))throw new AlertSettingsError('Revisá el horario y el estado de los envíos.');
 if(!Array.isArray(value.recipients)||value.recipients.length!==2)throw new AlertSettingsError('Configurá los dos destinatarios.');
 const recipients=value.recipients.map((r,i)=>{
  if(!r||Array.isArray(r)||Object.keys(r).some(k=>!['id','name','phone','enabled'].includes(k))||r.id!=='operator'+(i+1)||typeof r.enabled!=='boolean'||typeof r.name!=='string'||!r.name.trim()||r.name.trim().length>70||/[\x00-\x1f\x7f]/.test(r.name))throw new AlertSettingsError('Revisá el nombre de cada operador.');
  return{id:r.id,name:r.name.trim(),phone:normalizePhone(r.phone),enabled:r.enabled};
 });
 if(recipients[0].phone===recipients[1].phone)throw new AlertSettingsError('Usá un número distinto para cada destinatario.');
 return{revision:value.revision,enabled:value.enabled,time:value.time,recipients};
}

export function createAlertSettings({directory='/var/lib/fusion-management-validation',now=()=>new Date()}={}){
 const file=path.join(directory,'stock-alert-settings.json'),statusFile=path.join(directory,'stock-alert-status.json');
 function read(){
  try{
   const raw=fs.readFileSync(file,'utf8');if(raw.length>8192)throw Error();
   const row=JSON.parse(raw),valid=validateSettings({revision:row.revision,enabled:row.enabled,time:row.time,recipients:row.recipients});
   if(row.schema!==1)throw Error();
   return{schema:1,...valid,updated_at:row.updated_at||null,updated_by:row.updated_by||null};
  }catch{throw new AlertSettingsError('No se pudo leer la configuración. No se cambió ningún envío.',503);}
 }
 function status(){
  try{const text=fs.readFileSync(statusFile,'utf8');if(text.length>16384)return null;const s=JSON.parse(text);
   return{state:typeof s.state==='string'?s.state.slice(0,80):'',reason:typeof s.reason==='string'?s.reason.slice(0,100):'',checked_at:s.checked_at||null};
  }catch{return null;}
 }
 function result(row){return{ok:true,settings:row,sender:'2035',timezone:'America/Argentina/Buenos_Aires',days:90,cover:15,delivery:status()};}
 return(action,input,user)=>{
  if(action==='read')return result(read());
  if(action!=='save')throw new AlertSettingsError('Operación no disponible.',405);
  const valid=validateSettings(input),old=read();
  if(valid.revision!==old.revision)throw new AlertSettingsError('La configuración cambió en otra pestaña. Cerrá y volvé a abrir las alertas para revisar la versión actual.',409);
  const next={schema:1,...valid,revision:old.revision+1,updated_at:now().toISOString(),updated_by:String(user).slice(0,100)};
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  try{
   fs.writeFileSync(tmp,JSON.stringify(next,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
   fs.renameSync(tmp,file);
  }catch{try{fs.unlinkSync(tmp);}catch{}throw new AlertSettingsError('No se pudo guardar. Se conserva la configuración anterior.',503);}
  return result(next);
 };
}
