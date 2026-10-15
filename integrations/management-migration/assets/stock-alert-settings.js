(()=>{'use strict';
const $=id=>document.getElementById(id),panel=$('fs-alerts'),form=$('fs-alert-form');
if(!panel||!form)return;
let saved=null,csrf='',busy=false,loaded=false;
const endpoint='/herramientas/gestion-vps/ventas/stock/alertas';
function message(text,error=false){$('fs-alert-message').textContent=text;$('fs-alert-message').classList.toggle('fs-alert-error',error);}
function block(value){busy=value;$('fs-alert-fields').disabled=value;$('fs-alert-save').disabled=value;$('fs-alert-reload').disabled=value;}
function render(data){
 saved=data.settings;csrf=data.csrf;loaded=true;
 $('fs-alert-enabled').checked=saved.enabled;$('fs-alert-time').value=saved.time;
 for(let i=0;i<2;i++){const r=saved.recipients[i];$('fs-alert-name-'+i).value=r.name;$('fs-alert-phone-'+i).value='+'+r.phone;$('fs-alert-active-'+i).checked=r.enabled;}
 const active=saved.recipients.filter(r=>r.enabled);
 $('fs-alert-summary').textContent=!saved.enabled?'Desactivadas':!active.length?'Sin destinatarios activos':'Activadas · '+saved.time+' · '+active.map(r=>r.name).join(' y ');
 $('fs-alert-summary').classList.toggle('is-on',saved.enabled&&active.length>0);
 const delivery=data.delivery;
 $('fs-alert-provider').textContent=delivery?.reason==='template_not_approved'?'Última verificación: Meta todavía está revisando la plantilla del aviso. El envío requiere su aprobación.':delivery?.state==='number_disconnected'?'El emisor está desconectado. Revisá la conexión de WhatsApp antes del próximo envío.':['blocked','delivery_problem'].includes(delivery?.state)?'La última revisión del envío encontró un problema. Consultá al administrador.':'';
 $('fs-alert-provider').hidden=!$('fs-alert-provider').textContent;
 $('fs-alert-updated').textContent=saved.updated_at?'Último cambio: '+new Date(saved.updated_at).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour12:false})+(saved.updated_by?' · '+saved.updated_by:''):'';
}
async function request(method,body){
 const response=await fetch(endpoint,{method,credentials:'same-origin',headers:method==='POST'?{'Content-Type':'application/json','X-Fusion-CSRF':csrf}:{},...(body?{body:JSON.stringify(body)}:{})});
 let data;try{data=await response.json();}catch{throw Error('No se pudo leer la respuesta. Recargá la configuración antes de volver a guardar.');}
 if(!response.ok)throw Error(data.message||data.error||'No se pudo completar la operación.');
 return data;
}
async function load(){
 if(busy)return;block(true);message('Cargando configuración…');
 try{render(await request('GET'));message('Los cambios se aplican al próximo envío programado.');}
 catch(e){message(e.message,true);$('fs-alert-summary').textContent='No disponible';}
 finally{block(false);if(!loaded){$('fs-alert-fields').disabled=true;$('fs-alert-save').disabled=true;}}
}
form.addEventListener('submit',async e=>{
 e.preventDefault();if(busy||!saved||!form.reportValidity())return;
 const input={revision:saved.revision,enabled:$('fs-alert-enabled').checked,time:$('fs-alert-time').value,recipients:saved.recipients.map((r,i)=>({id:r.id,name:$('fs-alert-name-'+i).value,phone:$('fs-alert-phone-'+i).value,enabled:$('fs-alert-active-'+i).checked}))};
 block(true);message('Guardando cambios…');
 try{render(await request('POST',input));message('Configuración guardada. No se envió ningún mensaje al guardar.');}
 catch(e){message(e.message,true);}
 finally{block(false);}
});
$('fs-alert-reload').addEventListener('click',load);
panel.addEventListener('toggle',()=>{if(panel.open&&!busy)load();});
load();
})();
