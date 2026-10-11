(()=>{'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:2}).format(Number(n)||0);
const usd=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(n)||0);
const text=v=>{const t=document.createElement('textarea');t.innerHTML=String(v??'');return t.value;};
const plain=v=>{const d=document.createElement('div');d.innerHTML=String(v??'');return (d.textContent||'').trim();};
function confirmAction(message){
 return new Promise(resolve=>{
  const previous=document.activeElement,cover=document.createElement('div');cover.className='fbpos-modal';
  cover.innerHTML='<section class="fbpos-modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-action-title"><h2 id="confirm-action-title">Confirmar acción</h2><p></p><div class="modal-actions"><button class="fbpos-btn" data-cancel>Cancelar</button><button class="fbpos-btn primary" data-confirm>Continuar</button></div></section>';
  cover.querySelector('p').textContent=message;const cancel=cover.querySelector('[data-cancel]'),accept=cover.querySelector('[data-confirm]');
  const done=value=>{cover.remove();previous?.focus();resolve(value);};cancel.onclick=()=>done(false);accept.onclick=()=>done(true);
  cover.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();done(false);}if(e.key==='Tab'){e.preventDefault();(document.activeElement===cancel?accept:cancel).focus();}};
  ($('#fbpos-app')||document.body).appendChild(cover);cancel.focus();
 });
}
let requestSequence=0;
async function api(path,options={}){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),25000);
 try{
  const endpoint=FBPOS.rest+path+((options.method||'GET')==='GET'?(path.includes('?')?'&':'?')+'_pos_fresh='+Date.now()+'-'+(++requestSequence):'');
  let r;try{r=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal,headers:{'Content-Type':'application/json','X-WP-Nonce':FBPOS.nonce,'X-Fusion-CSRF':document.querySelector('meta[name="fusion-csrf"]')?.content||'',...options.headers}});}catch(e){throw new Error(e.name==='AbortError'?'El servidor tardó demasiado. Actualizá el estado antes de reintentar; la venta permanece guardada.':'No se pudo conectar. La venta permanece en el tablero.');}
  let body;try{body=await r.json();}catch(e){throw new Error('El servidor no respondió correctamente. La venta permanece guardada para reintentar.');}
  if(r.status===403&&body.code==='pos_csrf'&&!options.__csrfRetry){
   const session=await api('/session');document.querySelector('meta[name="fusion-csrf"]').content=session.csrf;
   return api(path,{...options,__csrfRetry:true});
  }
  if(!r.ok){let msg=plain(body.message)||'No se pudo completar la solicitud.';if(/database connection|base de datos/i.test(msg))msg='La base de datos no respondió. La venta permanece guardada para reintentar.';const e=new Error(msg);e.code=body.code;e.status=r.status;e.data=body.data||{};e.fields=e.data.fields||{};throw e;}return body;
 }finally{clearTimeout(timeout);}
}
const state={quote_id:0,dirty:false,receipt:{kind:'card',first:'',second:'',ref1:'',ref2:''},combine:false,cart:new Map(),customer:null,plan:'cash',note:'',operation:'',payment_url:'',status_url:'',phase:'editing',version:0,ready:false,conflict:false,order:null,preparing:false};
let orderActionBusy=false;
let editRevision=0,quotesPage=1,quoteRequest=null,quoteSaving=false;
let saveTimer,saveChain=Promise.resolve(),searchTimer,searchVersion=0,scanQueue=Promise.resolve(),stock=false,pollTimer,formId=0,fieldSchema=[],lastFocus=null;
const productTitle=p=>{const name=String(p.name||''),suffix=p.variation?' — '+p.variation:'';return suffix&&name.endsWith(suffix)?name.slice(0,-suffix.length):name;};
const items=()=>[...state.cart.values()].map(p=>({id:p.id,qty:p.qty,serials:Array.from({length:p.qty},(_,i)=>p.serials?.[i]||'')}));
const subtotal=()=>[...state.cart.values()].reduce((n,p)=>n+p.price*p.qty,0);
const locked=()=>!state.ready||state.phase!=='editing'||state.preparing||state.conflict;
function message(msg){$('#board-message').hidden=!msg;$('#board-message').textContent=msg;}
function saleSnapshot(){const c=state.customer||{};return {quote_id:state.quote_id,items:items(),customer:{id:c.id||0,name:c.name||'',document:c.document||'',email:c.email||'',phone:c.phone||'',consumerFinal:!!c.consumerFinal,billing:c.billing||{}},plan:state.plan,gateway:$('#gateway').value,combine:false,receipt:state.receipt,note:state.note,operation:state.operation,payment_url:state.payment_url,status_url:state.status_url,phase:state.phase};}
function localCheckpoint(){try{sessionStorage.setItem('fbpos-v3-'+FBPOS.operator,JSON.stringify({version:state.version,dirty:state.dirty,sale:saleSnapshot()}));}catch(e){}}
function scheduleSave(){if(!state.ready)return;state.dirty=true;editRevision++;localCheckpoint();clearTimeout(saveTimer);$('#save-status').textContent='Guardando…';$('#save-status').dataset.saved='false';saveTimer=setTimeout(()=>saveDraft().catch(()=>{}),500);}
async function putDraft(snapshot,version){return api('/draft',{method:'PUT',body:JSON.stringify({version,sale:snapshot})});}
function saveDraft(){clearTimeout(saveTimer);saveChain=saveChain.catch(()=>{}).then(async()=>{
 const snapshot=JSON.parse(JSON.stringify(saleSnapshot())),revision=editRevision;let r;
 try{r=await putDraft(snapshot,state.version);}
 catch(e){if(e.code==='draft_conflict'){state.conflict=true;render();}throw e;}
 state.version=r.version;state.conflict=false;state.dirty=revision!==editRevision;localCheckpoint();$('#save-status').textContent=state.dirty?'Guardando…':'Guardado';$('#save-status').dataset.saved=String(!state.dirty);
}).catch(e=>{state.dirty=true;localCheckpoint();$('#save-status').textContent='Cambios sin guardar';$('#save-status').dataset.saved='false';message(e.message+' Si otra pestaña cambió la venta, recargá este tablero.');throw e;});return saveChain;}
let pricingKey='',pricingQuote=null,pricingError='',pricingBusy=false,pricingTimer,pricingSequence=0,preferredPlan='cash';
const cartPricingKey=()=>JSON.stringify(items().map(({id,qty})=>({id,qty})).sort((a,b)=>a.id-b.id));
const pricingReady=()=>!!pricingQuote&&pricingKey===cartPricingKey()&&!pricingBusy&&!pricingError;
function options(){
 return pricingReady()?pricingQuote.plans.map(p=>({...p,detail:p.count>1?p.count+' × '+money(p.total/p.count):money(p.total)})):[{key:'cash',label:'Contado de referencia',total:subtotal(),detail:money(subtotal()),plan:'',gateway:'bacs'}];
}
function ensurePricing(force=false){
 const key=cartPricingKey();if(!force&&key===pricingKey)return;
 preferredPlan=state.plan;pricingKey=key;pricingQuote=null;pricingError='';clearTimeout(pricingTimer);const sequence=++pricingSequence;
 if(!state.cart.size){pricingBusy=false;return;}pricingBusy=true;
 pricingTimer=setTimeout(async()=>{
  try{const quote=await api('/pricing',{method:'POST',body:JSON.stringify({items:JSON.parse(key)})});if(sequence!==pricingSequence)return;
   pricingQuote=quote;pricingBusy=false;state.plan=quote.plans.some(p=>p.key===preferredPlan)?preferredPlan:quote.plans[0].key;
   for(const row of quote.products||[]){const product=state.cart.get(row.id);if(product)product.price=row.unit;}
   render();if(state.phase==='editing')scheduleSave();
  }catch(e){if(sequence!==pricingSequence)return;pricingBusy=false;pricingError=e.message;render();}
 },250);
}
const isManualGateway=id=>['bacs','cheque','cod','fusion_custom_payment'].includes(String(id||''));
const thumbnail=p=>`<img class="pos-product-image" src="${esc(p.image||FBPOS.imagePlaceholder||'')}" data-fallbacks="${esc(JSON.stringify(p.image_fallbacks||[]))}" alt="" loading="eager" decoding="async">`;
document.addEventListener('error',e=>{const img=e.target;if(!img.matches?.('img.pos-product-image'))return;let alternatives=[];try{alternatives=JSON.parse(img.dataset.fallbacks||'[]');}catch(_){}const next=alternatives.shift();img.dataset.fallbacks=JSON.stringify(alternatives);if(next){img.src=next;return;}img.hidden=true;const placeholder=document.createElement('span');placeholder.className='pos-image-missing';placeholder.textContent='Sin imagen';img.replaceWith(placeholder);},true);
let addQueue=Promise.resolve(),liveGeneration=0,lastCatalog=[],catalogAt=0;
function requestAdd(p){const generation=liveGeneration;$('#search-status').textContent='Verificando stock…';addQueue=addQueue.catch(()=>{}).then(async()=>{if(locked()||generation!==liveGeneration)return;try{const fresh=await api('/product/'+encodeURIComponent(p.id));if(locked()||generation!==liveGeneration)return;lastCatalog=lastCatalog.map(row=>row.id===fresh.id?fresh:row);if(lastCatalog.length)showProducts(lastCatalog);addProduct(fresh);}catch(e){if(generation===liveGeneration)$('#search-status').textContent=e.message;}});return addQueue;}
function render(){ensurePricing();const rows=[...state.cart.values()],lock=locked();
 $('#cart').innerHTML=rows.length?rows.map(p=>`<div class="cart-row">${thumbnail(p)}<div><strong>${esc(productTitle(p))}</strong>${p.variation?`<small>${esc(p.variation)}</small>`:''}<small>${esc(p.sku||'')}${p.stock_status!=='instock'?' · Sin stock':''}</small></div><div class="qty"><button data-action="dec" data-id="${p.id}" ${lock?'disabled':''} aria-label="Restar unidad">−</button><b>${p.qty}</b><button data-action="inc" data-id="${p.id}" ${lock?'disabled':''} aria-label="Sumar unidad">+</button></div><strong>${money(p.price*p.qty)}</strong><button class="close" data-action="remove" data-id="${p.id}" ${lock?'disabled':''} aria-label="Quitar producto">×</button>${(p.requires_serial||p.show_serials||(p.serials||[]).some(Boolean))?`<div class="frame-serials"><strong>Número de serie del cuadro</strong><small>Una serie por bicicleta. Se guarda en el pedido y pasa a la factura.</small><div>${Array.from({length:p.qty},(_,i)=>`<label>Unidad ${i+1}<input data-serial-product="${p.id}" data-serial-unit="${i}" maxlength="120" autocomplete="off" value="${esc(p.serials?.[i]||'')}" placeholder="Escribí o escaneá la serie" ${lock?'disabled':''}></label>`).join('')}</div></div>`:`<button type="button" class="fbpos-link serial-toggle" data-action="serial" data-id="${p.id}" ${lock?'disabled':''}>Agregar número de cuadro / serie</button>`}</div>`).join(''):'<div class="empty">Buscá un producto o escaneá su código para comenzar.</div>';
 const units=rows.reduce((n,p)=>n+p.qty,0);$('#cart-count').textContent=units+(units===1?' unidad':' unidades');$('#cash-total').textContent=money(subtotal());$('#sale-lock').hidden=!lock;
 const c=state.customer;$('#sale-lock').textContent='Cliente: '+(c?.name||'Sin seleccionar')+' · '+(state.order?'Pedido #'+state.order.number+' · '+state.order.status:'Cobro en preparación')+'. El total definitivo figura en el panel de pago.';$('#customer-summary').innerHTML=c?`<strong>${esc(c.name)}</strong><span>${c.consumerFinal?'Cliente ocasional':esc(c.document||c.email||'Cliente seleccionado')}</span>`:'Seleccioná a quién corresponde la venta.';
 $('#clear-customer').hidden=!c;$('#clear-customer').disabled=lock;$('#edit-customer').hidden=!c||!!c.consumerFinal;$('#edit-customer').disabled=lock;
 for(const id of ['consumer-final','find-customer','new-customer','sale-plan','gateway','sale-note','product-search','stock-toggle','refresh-catalog'])$('#'+id).disabled=lock;
 $('#quote-button').disabled=true;$('#prepare-payment').disabled=!rows.length||!c||lock||!state.ready||!pricingReady();
 $('#prepare-payment').hidden=state.phase!=='editing';$('#show-payment').hidden=state.phase==='editing';
 $('#sale-phase').textContent=state.phase==='editing'?'En preparación':state.order?.status||'Cobro en curso';
 $('#sale-note').value=state.note;const opts=options();if(!opts.some(o=>o.key===state.plan))state.plan='cash';$('#sale-plan').innerHTML=opts.map(o=>`<option value="${o.key}">${esc(o.label)}</option>`).join('');$('#sale-plan').value=state.plan;
 const selected=opts.find(o=>o.key===state.plan);$('#sale-plan').disabled=lock;$('#gateway').disabled=lock;$('#plan-preview').hidden=false;$('#plan-preview').innerHTML=`<strong>${esc(selected.detail)}</strong><span>Importe según la opción elegida</span>`;
 chooseGateway();
 $('#quote-origin').hidden=!state.quote_id;$('#quote-origin').textContent='Venta preparada desde el presupuesto #'+state.quote_id;
 if(state.order)renderOrder();
 renderGuided();
}
function addProduct(p){if(locked())return;const qty=(state.cart.get(p.id)?.qty||0)+1;const localReady=!!p._local?.pos_checkout_ready;if(qty>999||(!p.selectable&&!localReady)||p.stock_status!=='instock'||(p.sold_individually&&qty>1)||(p.stock!==null&&qty>Number(p.stock))){$('#search-status').textContent='No se puede agregar: revisá stock o variante.';return;}state.cart.set(p.id,{...p,selectable:true,price:Number(p.price??p._local?.reference_price),serials:state.cart.get(p.id)?.serials||p.serials||[],qty});render();scheduleSave();$('#search-status').textContent='Agregado desde el catálogo local: '+p.name;}
$('#cart').onclick=e=>{const b=e.target.closest('[data-action]');if(!b||locked())return;const p=state.cart.get(+b.dataset.id);if(!p)return;if(b.dataset.action==='serial'){p.show_serials=true;render();$('#cart [data-serial-product="'+p.id+'"]')?.focus();return;}if(b.dataset.action==='inc'){requestAdd(p);return;}if(b.dataset.action==='remove')state.cart.delete(p.id);else {p.qty=Math.max(1,p.qty-1);p.serials=(p.serials||[]).slice(0,p.qty);}render();scheduleSave();};
$('#cart').addEventListener('input',e=>{const el=e.target.closest('[data-serial-product]');if(!el||locked())return;const p=state.cart.get(Number(el.dataset.serialProduct));if(!p)return;p.serials=p.serials||[];p.serials[Number(el.dataset.serialUnit)]=el.value;scheduleSave();});
$('#cart').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[data-serial-product]')){e.preventDefault();const inputs=$$('[data-serial-product]');inputs[inputs.indexOf(e.target)+1]?.focus();}});
function showProducts(rows){
 if(!Array.isArray(rows))throw new Error('Respuesta de búsqueda no válida.');
 lastCatalog=rows;
 $('#product-results').innerHTML=rows.length?rows.map(p=>`<button class="product-card" data-product="${p.id}" ${(!p.selectable&&!p._local?.pos_checkout_ready)||p.stock_status!=='instock'||locked()?'disabled':''}>${thumbnail(p)}<span><strong>${esc(productTitle(p))}</strong><small>${esc(p.variation||'')}${p.variation?' · ':''}${esc(p.sku||'Sin SKU')}</small><small class="stock-indicator ${p.stock_status==='instock'?'in-stock':''}"><i aria-hidden="true"></i>${p.stock_status!=='instock'?'Sin stock':'Stock '+Number(p.stock)}</small><b>${p.price==null?'Precio no disponible':money(p.price)}</b></span><span class="add-product">${p._local?.pos_checkout_ready?'Agregar':'Agregar'} <svg class="pos-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg></span></button>`).join(''):'<div class="empty">No se encontraron productos.</div>';
 $('#product-results').onclick=e=>{const b=e.target.closest('[data-product]');if(b)requestAdd(rows.find(p=>p.id===+b.dataset.product));};
};
const searchPath=q=>'/search?include_out_of_stock='+(stock?'1':'0')+'&q='+encodeURIComponent(q);
function typedSearch(){clearTimeout(searchTimer);const version=++searchVersion,q=$('#product-search').value.trim();if(q.length<2){$('#product-results').innerHTML='';lastCatalog=[];$('#search-status').textContent='Escribí al menos dos letras.';return;}$('#search-status').textContent='Buscando…';searchTimer=setTimeout(async()=>{try{const r=await api(searchPath(q));if(version!==searchVersion)return;catalogAt=Date.now();showProducts(r);$('#search-status').textContent=r.length+(r.length===1?' resultado':' resultados');}catch(e){if(version===searchVersion)$('#search-status').textContent=e.message;}},300);}
$('#refresh-catalog').onclick=()=>{if(!locked())typedSearch();};
function refreshVisibleCatalog(){if(document.visibilityState==='hidden'||locked()||Date.now()-catalogAt<15000||$('#product-search').value.trim().length<2)return;catalogAt=Date.now();typedSearch();}
window.addEventListener('focus',refreshVisibleCatalog);window.addEventListener('pageshow',refreshVisibleCatalog);document.addEventListener('visibilitychange',refreshVisibleCatalog);
$('#product-search').oninput=typedSearch;$('#stock-toggle').onclick=()=>{stock=!stock;$('#stock-toggle').setAttribute('aria-pressed',String(stock));$('#stock-toggle').setAttribute('aria-checked',String(!stock));typedSearch();};
$('#product-search').onkeydown=e=>{if(e.key!=='Enter'||locked())return;e.preventDefault();clearTimeout(searchTimer);const version=++searchVersion,q=e.target.value.trim();if(!q)return;e.target.value='';scanQueue=scanQueue.then(async()=>{if(locked())return;try{const r=await api('/search?exact=1&q='+encodeURIComponent(q));if(r.length===1&&r[0].exact)addProduct(r[0]);else{const matches=r.length?r:await api(searchPath(q));if(version!==searchVersion)return;$('#product-search').value=q;showProducts(matches);$('#search-status').textContent=matches.length+' resultados · elegí un producto';}}catch(err){$('#search-status').textContent=err.message;}});};
$('#sale-note').oninput=e=>{state.note=e.target.value;scheduleSave();};
function chooseGateway(){const selected=options().find(o=>o.key===state.plan)||options()[0];$('#gateway').innerHTML=`<option value="${esc(selected.gateway)}">${selected.plan?'Tarjeta · Mercado Pago':'Contado / transferencia'}</option>`;gatewayNotice();}
const externalReceipt=()=>['fbpos_posnet','fbpos_combined'].includes($('#gateway').value);
function receiptData(){const r=state.receipt,total=options().find(o=>o.key===state.plan).total;
 const parts=[{gateway:'card',amount:$('#gateway').value==='fbpos_posnet'?total:Number(r.first),reference:r.ref1}];
 if($('#gateway').value==='fbpos_combined')parts.push({gateway:r.kind,amount:Number(r.second),rate:r.kind==='usd'?Number(FBPOS.usdRate):1,reference:r.ref2});
 return parts;
}
function receiptBalance(){
 const parts=receiptData(),total=options().find(o=>o.key===state.plan).total;
 const paid=parts.reduce((n,p)=>n+Math.round(p.amount*(p.gateway==='usd'?p.rate:1)*100)/100,0);
 const valid=parts.every(p=>Number.isFinite(p.amount)&&p.amount>0)&&Math.abs(Math.round(total*100)-Math.round(paid*100))===0;
 $('#receipt-balance').textContent=`Total: ${money(total)} · Registrado: ${money(paid)} · Diferencia: ${money(total-paid)}`;
 return valid;
}
function drawReceipt(){const external=externalReceipt(),mixed=$('#gateway').value==='fbpos_combined',r=state.receipt;
 $('#external-receipt').hidden=!external;$('#receipt-combination').hidden=!mixed;$('#receipt-second-box').hidden=!mixed;
 for(const [id,key] of [['receipt-kind','kind'],['receipt-first','first'],['receipt-second','second'],['receipt-ref1','ref1'],['receipt-ref2','ref2']]){$('#'+id).value=r[key];$('#'+id).disabled=locked();}
 if(!mixed){$('#receipt-first').value=options().find(o=>o.key===state.plan).total;$('#receipt-first').disabled=true;}
 $('#receipt-second-label').textContent=r.kind==='usd'?'Dólares recibidos (USD)':'Importe cobrado con el segundo medio (ARS)';
 $('#receipt-rate').textContent=r.kind==='usd'?`Cotización: ${money(FBPOS.usdRate)} por USD. Se guarda el importe en dólares y su equivalente en pesos.`:'';
 if(external)receiptBalance();$('#prepare-payment').textContent=external?'Registrar cobros de la venta':'Continuar al cobro';
}
function gatewayNotice(){$('#gateway-note').textContent='El checkout abrirá con este plan seleccionado. Allí confirmás envío y datos de pago.';}
$('#gateway').onchange=()=>{gatewayNotice();scheduleSave();};
for(const [id,key] of [['receipt-kind','kind'],['receipt-first','first'],['receipt-second','second'],['receipt-ref1','ref1'],['receipt-ref2','ref2']])$('#'+id).addEventListener(id==='receipt-kind'?'change':'input',e=>{state.receipt[key]=e.target.value;if(key==='kind'){state.receipt.second='';drawReceipt();}else receiptBalance();scheduleSave();});
function openModal(id){lastFocus=document.activeElement;$('#'+id).hidden=false;setTimeout(()=>$('#'+id).querySelector('input,button')?.focus(),0);}
function closeModal(id){$('#'+id).hidden=true;lastFocus?.focus();if(id==='review-modal')renderGuided();}
$('#close-customer').onclick=$('#cancel-customer').onclick=()=>closeModal('customer-modal');$('#close-quote').onclick=()=>closeModal('quote-modal');
for(const modal of $$('.fbpos-modal'))modal.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal(modal.id);return;}if(e.key!=='Tab')return;const list=[...modal.querySelectorAll('button,input,select,textarea,a[href]')].filter(el=>!el.disabled&&!el.closest('[hidden]'));const first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}});

$('#consumer-final').onclick=()=>{state.customer={id:0,name:'Consumidor final',consumerFinal:true,billing:{},document:'',phone:'',email:''};render();scheduleSave();};
function openSearch(){if(locked())return;$('#customer-title').textContent='Buscar cliente';$('#customer-search-pane').hidden=false;$('#customer-form').hidden=true;$('#customer-results').innerHTML='';openModal('customer-modal');$('#customer-query').focus();}
$('#find-customer').onclick=openSearch;
async function findCustomer(){const q=$('#customer-query').value.trim();if(q.length<2)return;$('#customer-results').textContent='Buscando…';try{const rows=await api('/customers?q='+encodeURIComponent(q));$('#customer-results').innerHTML=rows.length?rows.map((c,i)=>`<div class="customer-result"><div><strong>${esc(c.name)}</strong><small>${esc(c.document||'Sin documento')} · ${esc(c.phone||c.email||'')}</small></div><button class="fbpos-btn" data-customer="${i}">Seleccionar cliente</button></div>`).join(''):'<p class="empty">No hay coincidencias. Podés crear un cliente nuevo.</p>';$('#customer-results').onclick=async e=>{const b=e.target.closest('[data-customer]');if(!b)return;state.customer={...rows[+b.dataset.customer],consumerFinal:false};closeModal('customer-modal');render();scheduleSave();if(Object.keys(state.customer.field_errors||{}).length)await openCustomerForm(state.customer,{fields:state.customer.field_errors});};}catch(e){$('#customer-results').textContent=e.message;}}
$('#customer-search-button').onclick=findCustomer;$('#customer-query').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();findCustomer();}};
function billingValues(){const result={};for(const f of fieldSchema){const el=$('#field-'+f.key);if(el)result[f.key]=el.type==='checkbox'?(el.checked?'1':''):el.value;}return result;}
async function drawFields(values={}){const r=await api('/customer-fields?country='+encodeURIComponent(values.billing_country||'AR'));fieldSchema=r.fields;
 $('#customer-fields').innerHTML=fieldSchema.map(f=>{const value=values[f.key]??f.default??'',required=f.required?' required':'',id='field-'+f.key;let control;
 if(f.type==='checkbox')control=`<input id="${id}" type="checkbox" ${value==='1'?'checked':''}${required}>`;
 else if(['select','country','radio'].includes(f.type)){control=`<select id="${id}"${required}><option value="">Seleccionar…</option>${Object.entries(f.options).map(([key,label])=>`<option value="${esc(key)}" ${String(value)===key?'selected':''}>${esc(label)}</option>`).join('')}</select>`;}
 else if(f.type==='textarea')control=`<textarea id="${id}"${required}>${esc(value)}</textarea>`;
 else control=`<input id="${id}" type="${['text','email','tel','number','date','hidden'].includes(f.type)?f.type:'text'}" value="${esc(value)}" placeholder="${esc(f.placeholder)}"${required}>`;
 return `<label ${f.hidden?'hidden':''} for="${id}">${esc(f.label)}${f.required?' *':''}${control}<small id="error-${f.key}" class="field-error"></small></label>`;}).join('');
 const country=$('#field-billing_country');if(country)country.onchange=async()=>{const v=billingValues();v.billing_state='';try{await drawFields(v);}catch(e){$('#customer-errors').hidden=false;$('#customer-errors').textContent=e.message;}};
}
async function openCustomerForm(customer=null,problem=null){if(locked())return;formId=customer?.id||0;$('#customer-title').textContent=formId?'Revisar datos del cliente':'Nuevo cliente';$('#customer-search-pane').hidden=true;$('#customer-form').hidden=false;$('#customer-errors').hidden=true;$('#customer-fields').textContent='Cargando campos del checkout…';openModal('customer-modal');$('#save-customer').disabled=true;try{await drawFields(customer?.billing||{});if(problem)showCustomerErrors(problem);}catch(e){$('#customer-errors').hidden=false;$('#customer-errors').textContent=e.message;}finally{$('#save-customer').disabled=false;}}
$('#new-customer').onclick=$('#create-from-search').onclick=()=>openCustomerForm();$('#edit-customer').onclick=()=>openCustomerForm(state.customer);
function showCustomerErrors(err){
 const entries=Object.entries(err.fields||{}),panel=$('#customer-errors');panel.hidden=false;
 panel.innerHTML=`<strong>Completá los datos del cliente para continuar</strong><p>${entries.length?'Este cliente tiene datos faltantes o inválidos. Revisá los campos señalados:':esc(err.message||'Revisá los datos ingresados.')}</p>${entries.length?'<ul>'+entries.map(([key,msg])=>`<li><a href="#field-${esc(key)}">${esc(fieldSchema.find(f=>f.key===key)?.label||key)}: ${esc(msg)}</a></li>`).join('')+'</ul>':''}<p>La venta y los productos siguen guardados. Al terminar, pulsá <b>Guardar y usar cliente</b> y volvé a continuar con el cobro.</p>`;
 for(const [key,msg] of entries){const el=$('#field-'+key),error=$('#error-'+key);if(error)error.textContent=msg;if(el){el.setAttribute('aria-invalid','true');el.setAttribute('aria-describedby','error-'+key);}}
 panel.querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();document.getElementById(a.getAttribute('href').slice(1))?.focus();});
 const first=entries.map(([key])=>$('#field-'+key)).find(el=>el&&!el.closest('[hidden]'));first?.focus();panel.scrollIntoView?.({block:'nearest'});
}
$('#customer-fields').addEventListener('input',e=>{e.target.removeAttribute('aria-invalid');});
$('#customer-form').onsubmit=async e=>{
 e.preventDefault();$('#customer-errors').hidden=true;$$('.field-error').forEach(el=>el.textContent='');$$('#customer-fields [aria-invalid]').forEach(el=>el.removeAttribute('aria-invalid'));
 const fields={};for(const f of fieldSchema){const el=$('#field-'+f.key);if(el&&!f.hidden&&!el.checkValidity())fields[f.key]=el.validity.valueMissing?'Este dato es obligatorio.':'Revisá el formato de este dato.';}
 if(Object.keys(fields).length){showCustomerErrors({fields});return;}
 const b=$('#save-customer');b.disabled=true;
 try{const r=await api('/customer',{method:'POST',body:JSON.stringify({id:formId,billing:billingValues()})});state.customer={...r.customer,consumerFinal:false};closeModal('customer-modal');render();scheduleSave();message('Datos guardados para esta venta. El cliente quedará asociado al pedido al completar el checkout.');}
 catch(err){showCustomerErrors(err);}finally{b.disabled=false;}
};
const checkoutOrigins=new Set([location.origin,'https://fusionbikes.com.ar','https://www.fusionbikes.com.ar']);
function safeURL(value){if(typeof value!=='string'||!value.trim())return null;try{const u=new URL(value,location.href);return checkoutOrigins.has(u.origin)?u.href:null;}catch(e){return null;}}
function displayPanel(url){
 $('#return-editing').hidden=!!state.order;$('#return-editing').disabled=!!state.order;$('#external-payment').hidden=false;$('#external-payment').textContent='Abrir checkout de la tienda';$('#refresh-payment').hidden=false;
 $('#panel-hint').textContent='Abrí el checkout en otra pestaña. Allí se calculan precio final, cuotas, envío y pago. Al volver, el POS consulta el estado del pedido.';
 $('#board').classList.add('payment-active');$('#payment-panel').hidden=false;$('#checkout-frame').hidden=true;$('#checkout-frame').src='about:blank';$('#payment-result').hidden=false;
 const safe=safeURL(url);$('#payment-result').innerHTML=safe?`<p>Preparación guardada.</p><a class="fbpos-btn primary" target="_blank" rel="noopener noreferrer" href="${esc(safe)}">Abrir checkout de la tienda</a>`:'Actualizá el estado para recuperar el enlace.';
 $('#payment-state').textContent='Pendiente de completar en la tienda';startPolling();
}
$('#close-payment').onclick=()=>{$('#board').classList.remove('payment-active');$('#payment-panel').hidden=true;};
$('#show-payment').onclick=()=>{if(state.order){$('#board').classList.add('payment-active');$('#payment-panel').hidden=false;if(state.order.retry_url)displayPanel(state.order.retry_url);else renderOrder();return;}if(state.payment_url){displayPanel(state.payment_url);return;}preparePayment();};
function clearExpiredOperation(){clearTimeout(pollTimer);$('#checkout-frame').src='about:blank';$('#board').classList.remove('payment-active');$('#payment-panel').hidden=true;state.operation='';state.payment_url='';state.status_url='';state.order=null;state.phase='editing';state.preparing=false;$('#order-summary').hidden=true;render();chooseGateway();}
async function recoverExpiredOperation(e){if(e.code!=='operation_missing')throw e;clearExpiredOperation();await saveDraft();$('#save-status').textContent='Venta recuperada';message('La preparación anterior había vencido. Conservamos los productos y el cliente para que puedas continuar.');$('#product-search').focus();}
let statusInFlight=null,pollFailures=0;
function needsPaymentPolling(){return !!state.operation&&!state.order?.paid&&!['cancelled','refunded'].includes(state.order?.state);}
function startPolling(delay=15000){clearTimeout(pollTimer);if(!needsPaymentPolling())return;pollTimer=setTimeout(async()=>{
 if(document.visibilityState==='hidden'||orderActionBusy||state.preparing){startPolling(10000);return;}
 try{await refreshOrder();pollFailures=0;}catch(e){pollFailures++;$('#payment-state').textContent='No se pudo consultar el pago. Reintentando…';}
 if(needsPaymentPolling())startPolling(Math.min(30000,pollFailures?5000*Math.pow(2,pollFailures):15000));
},delay);}
window.addEventListener('focus',()=>{if(needsPaymentPolling())startPolling(300);});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden'&&needsPaymentPolling())startPolling(300);});
$('#checkout-frame').addEventListener('load',()=>{if(needsPaymentPolling())startPolling(300);});
async function refreshOrder(){
 if(!state.operation||orderActionBusy)return;
 if(statusInFlight)return statusInFlight;
 const token=state.operation;
 const task=(async()=>{const r=await api('/operation/'+encodeURIComponent(token)+(state.status_url?'?vps=1':''));if(token!==state.operation||state.preparing)return r;
 if(r.order_id){
  const changed=JSON.stringify(state.order)!==JSON.stringify(r),phaseChanged=state.phase!=='registered';
  state.order=r;state.phase='registered';
  if(changed){render();if(r.paid||['failed','cancelled','refunded'].includes(r.state)){$('#board').classList.add('payment-active');$('#payment-panel').hidden=false;renderOrder();}}
  if(phaseChanged)scheduleSave();
  if(r.paid||['cancelled','refunded'].includes(r.state))clearTimeout(pollTimer);
 }else $('#payment-state').textContent=r.status;
 return r;})();statusInFlight=task;
 try{return await task;}finally{if(statusInFlight===task)statusInFlight=null;}
}
$('#refresh-payment').onclick=()=>refreshOrder().catch(e=>recoverExpiredOperation(e).catch(err=>message(err.message)));
$('#return-editing').onclick=async()=>{if(!state.operation)return;if(!await confirmAction('¿Cerrar esta preparación y volver a editar? Solo se permite si todavía no se creó un pedido.'))return;try{await api('/release',{method:'POST',body:JSON.stringify({operation:state.operation})});clearTimeout(pollTimer);$('#checkout-frame').src='about:blank';$('#payment-panel').hidden=true;$('#board').classList.remove('payment-active');state.operation='';state.payment_url='';state.status_url='';state.order=null;state.phase='editing';render();scheduleSave();}catch(e){message(e.message);}};
$('#external-payment').onclick=()=>{const url=safeURL(state.order?.retry_url||state.payment_url);if(url)window.open(url,'_blank','noopener,noreferrer');else message('No hay un enlace de cobro válido. Actualizá el estado.');};
window.addEventListener('message',e=>{if(!checkoutOrigins.has(e.origin)||e.source!==$('#checkout-frame').contentWindow||e.data?.type!=='fbpos-checkout-state')return;
 const messages={pending:'El pago está pendiente. La venta quedó guardada. Consultá el estado; no vuelvas a cobrar.',paid:'Pago aprobado. Actualizando el pedido para continuar al comprobante.',loading:'Cargando el formulario de cobro…',ready:'Completá los datos y revisá el total del formulario antes de cobrar.',error:'El formulario necesita atención. Usá la acción indicada dentro del panel.',processing:'Procesando el cobro. No vuelvas a confirmar. Estamos consultando el estado.',unavailable:'El formulario no se cargó. Usá Recargar formulario dentro del panel.'};
 if(!messages[e.data.state])return;
 if(!state.order||state.order.needs_payment)$('#payment-state').textContent=messages[e.data.state];
 refreshOrder().catch(()=>{});});
async function preparePayment(){if(state.preparing||!state.customer||!state.cart.size||state.conflict||!pricingReady())return;if(externalReceipt()&&!receiptBalance()){$('#review-error').hidden=false;$('#review-error').textContent='Los importes deben ser positivos y sumar el total de la venta.';message('Los importes deben ser positivos y sumar exactamente el total del paso 2.');return;}closeModal('review-modal');state.preparing=true;message('');const oldPhase=state.phase;if(!state.operation)state.operation=crypto.randomUUID();state.phase='payment';render();
 try{await saveDraft();const selected=options().find(o=>o.key===state.plan),c=state.customer;const result=await api('/prepare',{method:'POST',body:JSON.stringify({quote_id:state.quote_id,operation:state.operation,combine:false,price_key:state.plan,expected_total:options().find(o=>o.key===state.plan).total,mixed_payments:externalReceipt()?receiptData():[],items:items(),gateway:$('#gateway').value,plan:selected.plan,label:selected.label,factor:1,expected_usd_total:state.plan==='usd'?Math.round([...state.cart.values()].reduce((n,p)=>n+p.price*p.qty/p.dollar,0)):undefined,customer_id:c.id||0,consumer_final:!!c.consumerFinal,customer_name:c.name,customer_email:c.email||'',customer_phone:c.phone||'',customer_document:c.document||'',billing:c.billing||{},note:state.note})});
  if(result.order_id){state.order=result;state.phase='registered';state.payment_url='';try{await saveDraft();}catch(e){message('El pedido #'+result.number+' quedó registrado, pero el borrador no pudo sincronizarse. No repitas el cobro; usá Actualizar estado.');}$('#board').classList.add('payment-active');$('#payment-panel').hidden=false;$('#checkout-frame').hidden=true;$('#payment-result').hidden=false;render();renderOrder();}
  else{state.payment_url=result.payment_url;state.status_url=result.status_url||'vps';await saveDraft();$('#show-payment').textContent='Volver al panel de cobro';displayPanel(state.payment_url);}}
 catch(e){message(e.message);if(e.code==='pricing_changed')ensurePricing(true);if(e.status&&e.status<500&&!['prepare_busy','draft_conflict'].includes(e.code)){state.operation='';state.phase='editing';state.preparing=false;scheduleSave();if(Object.keys(e.fields||{}).length)await openCustomerForm(state.customer,e);}else{message(e.message+' Usá Reintentar preparación: conserva el mismo identificador.');$('#show-payment').textContent='Reintentar preparación';}}
 finally{state.preparing=false;render();}
}
$('#prepare-payment').onclick=preparePayment;
async function finishPaidSale(o){
 if(!o?.paid||!o.fulfillment)return;
 const done=await resetSale(true);
 if(!done)return;
 message('Pedido #'+o.number+' guardado. '+(o.has_cae||o.invoice_url?(o.invoice_environment==='homologation'?'Comprobante de prueba emitido (sin validez fiscal). ':'Factura emitida. '):'Sin emitir factura desde el POS. ')+'Ya podés iniciar una nueva venta.');
 const url=o.invoice_url||o.edit_url;
 if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';link.className='fbpos-btn';link.textContent=o.invoice_url?'Ver / imprimir factura':'Ver pedido';$('#board-message').append(link);}
}
let managedOrder=null;
function orderHTML(o){
 const edit=safeURL(o.edit_url),retry=safeURL(o.retry_url);
 return `<span class="status-badge ${o.paid?'paid':''}">${esc(o.status)}</span><h3>Pedido #${esc(o.number)}</h3><strong class="order-total">${esc(o.total)}</strong><p>${esc(o.message||'')}</p><div class="order-actions">
 ${o.manual_allowed?'<button class="fbpos-btn primary" data-order-action="manual-receipt">Confirmar dinero recibido</button>':''}
 ${o.paid&&!o.fulfillment?'<button class="fbpos-btn" data-order-action="pickup">Retirado en Fusion</button><button class="fbpos-btn" data-order-action="shipping">Listo para enviar por Andreani</button>':''}
 ${o.can_invoice&&!o.has_cae?'<button class="fbpos-btn primary" data-order-action="invoice">Facturar en el VPS</button>':''}
 ${o.has_cae?'<span>Este pedido ya tiene un comprobante. Consultalo en el facturador.</span>':''}
 <button class="fbpos-btn" data-order-action="refresh">Actualizar estado</button>
 ${retry?`<a class="fbpos-btn" target="_blank" rel="noopener noreferrer" href="${esc(retry)}">Continuar pago</a>`:''}${edit?`<a class="fbpos-btn" target="_blank" rel="noopener" href="${esc(edit)}">Ver pedido en la tienda</a>`:''}</div>`;
}
function renderOrder(){
 const o=state.order;if(!o)return;
 $('#order-summary').hidden=false;$('#return-editing').hidden=true;$('#external-payment').hidden=!o.retry_url;$('#refresh-payment').hidden=false;$('#payment-state').textContent=o.status;
 $('#order-summary').innerHTML=orderHTML(o);$('#checkout-frame').hidden=true;$('#payment-result').hidden=false;$('#payment-result').innerHTML=orderHTML(o);$('#panel-hint').textContent=o.message||'';
}
async function updateManagedOrder(id){
 const o=await api('/orders/'+id);if(state.order?.order_id===o.order_id){state.order=o;renderOrder();}
 if(managedOrder?.order_id===o.order_id){managedOrder=o;$('#pos-order-detail').innerHTML=orderHTML(o);}return o;
}
document.addEventListener('click',async e=>{
 const button=e.target.closest('[data-order-action]');if(!button||orderActionBusy)return;
 const o=button.closest('#pos-order-manager')?managedOrder:state.order;if(!o)return;
 const action=button.dataset.orderAction;
 if(action==='invoice'){openInvoicePanel(o);return;}
 if(action==='manual-receipt'&&!await confirmAction('Pedido #'+o.number+' · '+o.total+'. ¿Confirmás que recibiste este importe? Esta acción registra el cobro, no realiza un cargo.'))return;
 if(['pickup','shipping'].includes(action)&&!await confirmAction('Pedido #'+o.number+': ¿registrar '+(action==='pickup'?'entrega en tienda':'listo para enviar por Andreani')+'?'))return;
 orderActionBusy=true;button.disabled=true;
 try{if(action==='manual-receipt')await api('/manual-receipt',{method:'POST',body:JSON.stringify({operation:o.operation||state.operation,confirmed:true})});
  else if(['pickup','shipping'].includes(action))await api('/fulfillment',{method:'POST',body:JSON.stringify({operation:o.operation||state.operation,mode:action})});
  await updateManagedOrder(o.order_id);
 }catch(err){const target=button.closest('#pos-order-manager')?$('#pos-order-error'):$('#board-message');target.hidden=false;target.textContent=err.message;}
 finally{orderActionBusy=false;button.disabled=false;}
});
function openInvoicePanel(order){
 const url=location.pathname+'?fm_module=facturador&view=pos&order_id='+encodeURIComponent(order.order_id);if(!url)throw new Error('No se pudo abrir Fusion ARCA. Actualizá ambos plugins.');
 $('#invoice-panel-title').textContent='Facturar pedido #'+order.number;$('#invoice-frame').src=url;openModal('invoice-modal');
}
async function closeInvoicePanel(){
 closeModal('invoice-modal');$('#invoice-frame').src='about:blank';
 try{if(managedOrder)await updateManagedOrder(managedOrder.order_id);const order=await refreshOrder();if(order?.paid&&order.has_cae)await finishPaidSale(order);}
 catch(e){message(e.message+' La venta sigue registrada. Usá Actualizar estado.');}
}
$('#close-invoice-panel').onclick=closeInvoicePanel;
$('#invoice-modal').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopImmediatePropagation();closeInvoicePanel();}},true);
window.addEventListener('message',e=>{
 if(e.origin!==location.origin||e.source!==$('#invoice-frame').contentWindow||e.data?.type!=='fusion-arca-pos-state'||Number(e.data.order_id)!==Number(state.order?.order_id))return;
 // A frame message is only a refresh hint. Never trust a posted CAE or URL.
 if(['authorized','pending','internal'].includes(e.data.status))refreshOrder().catch(err=>message(err.message));
});
async function resetSale(completed=false){
 if(!state.ready||state.preparing||(orderActionBusy&&completed!==true))return false;
 if(completed===true&&!state.order?.paid)return false;
 if(completed!==true&&!await confirmAction('¿Limpiar cliente, productos, observaciones y opciones de esta venta? Los pedidos, pagos y facturas ya registrados se conservan. Un pago externo iniciado puede seguir en curso: revisalo en Administración.'))return;
 clearTimeout(saveTimer);state.preparing=true;render();
 try{
  await saveChain.catch(()=>{});
  const r=await api('/reset',{method:'POST',body:JSON.stringify({version:state.version})});
  clearTimeout(pollTimer);clearTimeout(searchTimer);searchVersion++;liveGeneration++;lastCatalog=[];
  $('#checkout-frame').src='about:blank';$('#board').classList.remove('payment-active');$('#payment-panel').hidden=true;
  state.quote_id=0;state.dirty=false;state.cart.clear();state.customer=null;state.plan='cash';state.combine=false;state.receipt={kind:'card',first:'',second:'',ref1:'',ref2:''};state.note='';state.operation='';state.payment_url='';state.status_url='';state.phase='editing';state.order=null;state.version=r.version;state.conflict=false;
  $('#order-summary').hidden=true;$('#product-search').value='';$('#product-results').innerHTML='';$('#customer-query').value='';$('#customer-results').innerHTML='';$('#customer-fields').innerHTML='';fieldSchema=[];formId=0;
  $$('.fbpos-modal').forEach(el=>el.hidden=true);stock=false;$('#stock-toggle').setAttribute('aria-pressed','false');$('#stock-toggle').setAttribute('aria-checked','true');$('#search-status').textContent='Escribí al menos dos letras.';
  sessionStorage.removeItem('fbpos-v3-'+FBPOS.operator);chooseGateway();localCheckpoint();$('#save-status').textContent='Tablero limpio';$('#save-status').dataset.saved='true';message('');return true;
 }catch(e){message(e.message);return false;}
 finally{state.preparing=false;render();$('#product-search').focus();}
}
$('#new-sale').onclick=$('#clear-sale').onclick=resetSale;
$('#clear-customer').onclick=async()=>{if(locked())return;state.customer=null;render();try{await saveDraft();}catch(e){message(e.message);}};
function showQuote(q){$('#quote-content').innerHTML=`<p>${esc(q.number)}</p><div class="order-actions"><a class="fbpos-btn" href="${esc(safeURL(q.url))}" target="_blank" rel="noopener">Abrir / imprimir</a><a class="fbpos-btn" href="${esc(q.whatsapp)}" target="_blank" rel="noopener">Compartir por WhatsApp</a></div><iframe class="quote-preview" title="Vista del presupuesto" src="${esc(safeURL(q.url))}"></iframe>`;openModal('quote-modal');}
$('#quote-button').onclick=async()=>{return;
 if(locked()||quoteSaving)return;quoteSaving=true;render();const c=state.customer||{name:'Consumidor final',consumerFinal:true};
 const payload={items:items(),customer_name:c.name,customer_id:c.id||0,consumer_final:!!c.consumerFinal,billing:c.billing||{},customer_document:c.document||'',customer_phone:c.phone||'',customer_email:c.email||'',note:state.note,price_key:state.plan,gateway:$('#gateway').value};
 const fingerprint=JSON.stringify(payload);if(!quoteRequest||quoteRequest.fingerprint!==fingerprint)quoteRequest={fingerprint,id:crypto.randomUUID()};
 try{const r=await api('/quote',{method:'POST',body:JSON.stringify({...payload,request_id:quoteRequest.id})});quoteRequest=null;showQuote(r);message('Presupuesto guardado. Podés encontrarlo en Presupuestos guardados.');}catch(e){message(e.message);}finally{quoteSaving=false;render();}
};
async function listQuotes(page=1){quotesPage=page;$('#quotes-list').textContent='Cargando presupuestos…';try{
 const r=await api('/quotes?page='+page+'&q='+encodeURIComponent($('#quotes-query').value.trim()));
 $('#quotes-list').innerHTML=r.quotes.length?r.quotes.map(q=>`<article class="saved-quote"><strong>${esc(q.number)} · ${esc(q.customer)}</strong><p>${esc(q.created)} · Contado ${money(q.subtotal)} · Válido hasta ${esc(q.valid_until)}</p><div class="order-actions"><button class="fbpos-btn" data-view-quote="${q.id}">Ver presupuesto</button>${q.order_id?`<a class="fbpos-btn" target="_blank" rel="noopener" href="${esc(safeURL(q.order_url))}">Ver pedido #${q.order_id}</a>`:`<button class="fbpos-btn" data-load-quote="${q.id}" disabled>Convertir en venta</button>`}</div></article>`).join(''):'No hay presupuestos para esta búsqueda.';
 $('#quotes-page').textContent=page+' / '+Math.max(1,r.pages);$('#quotes-prev').disabled=page<=1;$('#quotes-next').disabled=page>=r.pages;
 $('#quotes-list').onclick=e=>{const view=e.target.closest('[data-view-quote]');if(view){showQuote(r.quotes.find(q=>q.id===Number(view.dataset.viewQuote)));return;}const load=e.target.closest('[data-load-quote]');if(load)loadQuote(Number(load.dataset.loadQuote));};
 }catch(e){$('#quotes-list').textContent=e.message;}}
async function loadQuote(id){
 if(locked())return;
 if(state.cart.size&&!await confirmAction('¿Reemplazar la venta en preparación por este presupuesto? Los pedidos registrados se conservan.'))return;
 state.preparing=true;clearTimeout(saveTimer);render();
 try{await saveChain;const q=await api('/quotes/'+id);if(q.converted){message('El presupuesto ya corresponde al pedido #'+q.order_id+'.');await listQuotes(quotesPage);return;}
 if(!q.products.length)throw new Error('El presupuesto no tiene productos disponibles para cargar.');
 state.cart=new Map(q.products.map(p=>[p.id,p]));state.customer=q.customer;state.plan=q.plan||'cash';state.note=q.note||'';state.quote_id=q.id;state.operation='';state.payment_url='';state.status_url='';state.order=null;state.phase='editing';state.receipt={kind:'card',first:'',second:'',ref1:'',ref2:''};state.dirty=true;editRevision++;
 $('#order-summary').hidden=true;$('#checkout-frame').src='about:blank';$('#payment-panel').hidden=true;$('#board').classList.remove('payment-active');render();if([...$('#gateway').options].some(o=>o.value===q.gateway))$('#gateway').value=q.gateway;
 await saveDraft();closeModal('quotes-modal');message('Presupuesto '+q.number+' cargado con precios actuales. Revisá el total y el cliente antes de cobrar.'+(q.issues.length?' '+q.issues.join('. '):''));
 }catch(e){message(e.message);}finally{state.preparing=false;render();}
}
$('#saved-quotes').onclick=()=>{openModal('quotes-modal');listQuotes();};$('#close-quotes').onclick=()=>closeModal('quotes-modal');$('#quotes-search').onclick=()=>listQuotes();$('#quotes-query').onkeydown=e=>{if(e.key==='Enter')listQuotes();};$('#quotes-prev').onclick=()=>listQuotes(quotesPage-1);$('#quotes-next').onclick=()=>listQuotes(quotesPage+1);
window.addEventListener('beforeunload',e=>{localCheckpoint();if($('#save-status').textContent==='Guardando…'||$('#save-status').textContent==='Cambios sin guardar'){e.preventDefault();e.returnValue='';}});
async function boot(){try{const r=await api('/draft');state.version=r.version||0;const sale=r.sale||{};state.quote_id=Number(sale.quote_id)||0;state.cart=new Map((r.products||[]).map(p=>[p.id,p]));state.customer=sale.customer?.name?sale.customer:null;state.plan=sale.plan||'cash';state.combine=false;state.receipt={kind:'card',first:'',second:'',ref1:'',ref2:'',...(sale.receipt||{})};state.note=sale.note||'';state.operation=sale.operation||'';state.payment_url=sale.payment_url||'';state.status_url='vps';state.phase=state.operation?(sale.phase||'payment'):'editing';
 let local=null;try{local=JSON.parse(sessionStorage.getItem('fbpos-v3-'+FBPOS.operator)||'null');}catch(e){}
 if(local?.dirty&&local.sale){
  if(Number(local.version)!==state.version||state.operation||local.sale.operation){message('Hay un respaldo local anterior. Se recuperó la versión guardada del servidor para conservar el estado del pedido.');}
  else{message('Esta pestaña conserva cambios sin guardar.');const recover=document.createElement('button');recover.className='fbpos-btn';recover.textContent='Recuperar cambios de esta pestaña';recover.onclick=async()=>{recover.disabled=true;try{const latest=await api('/draft');if(Number(latest.version)!==Number(local.version)||latest.sale?.operation)throw new Error('La venta cambió en otra pestaña. Recargá para ver la versión actual.');const saved=await putDraft(local.sale,Number(local.version));state.version=saved.version;state.dirty=false;sessionStorage.removeItem('fbpos-v3-'+FBPOS.operator);location.reload();}catch(e){recover.disabled=false;message(e.message);}};$('#board-message').append(recover);}
 }
 $('#gateway').innerHTML=(FBPOS.gateways||[]).map(g=>`<option value="${esc(g.id)}">${esc(g.title)}</option>`).join('');state.ready=true;render();chooseGateway();if(sale.gateway&&[...$('#gateway').options].some(o=>o.value===sale.gateway)){$('#gateway').value=sale.gateway;gatewayNotice();}$('#save-status').textContent=state.cart.size?'Venta recuperada':'Listo';$('#save-status').dataset.saved='true';if(state.operation){try{const status=await refreshOrder();if(!status.order_id&&!state.status_url&&!sale.combine&&isManualGateway(sale.gateway)){await api('/release',{method:'POST',body:JSON.stringify({operation:state.operation})});clearExpiredOperation();await saveDraft();message('Recuperamos la venta manual anterior. Podés volver a iniciar el cobro sin perder productos ni cliente.');}else if(state.order){$('#board').classList.add('payment-active');$('#payment-panel').hidden=false;if(state.order.retry_url)displayPanel(state.order.retry_url);else renderOrder();}else if(state.payment_url)displayPanel(state.payment_url);else{$('#show-payment').textContent='Reintentar preparación';}}catch(e){await recoverExpiredOperation(e);}}else $('#product-search').focus();
 }catch(e){message(e.message);$('#save-status').textContent='No se pudo recuperar la venta';}}

function renderGuided(){
 const selected=options().find(o=>o.key===state.plan),mode=state.plan==='cash'?'cash':state.plan==='usd'?'usd':'installments',lock=locked();
 for(const b of $$('[data-price-mode]')){const m=b.dataset.priceMode;b.setAttribute('aria-pressed',String(m===mode));b.disabled=lock||!options().some(o=>m==='installments'?!!o.plan:o.key===m);}
 $('#sale-plan').hidden=mode!=='installments';$('#installments-label').hidden=mode!=='installments';
 $('#plan-preview').hidden=true;$('#commercial-note').hidden=false;
 $('#commercial-note').textContent=pricingBusy?'Verificando opciones de pago…':pricingError||(!state.cart.size?'Agregá productos para ver las cuotas.':'Precios verificados con Master Control. No incluyen el envío.');
 $('#refresh-plans').hidden=!state.cart.size;$('#refresh-plans').disabled=lock||pricingBusy;
 $('#pos-plan-cards').innerHTML=pricingReady()?options().map(p=>`<button type="button" class="pos-plan-card" data-select-plan="${esc(p.key)}" aria-pressed="${p.key===state.plan}" ${lock?'disabled':''}><strong>${esc(p.label)}</strong><span>${esc(p.detail)}</span><small>Total ${money(p.total)}</small></button>`).join(''):'';

 // Keep a single canonical selector so existing saved plans and pricing stay intact.
 for(const o of $('#sale-plan').options)o.hidden=!options().find(p=>p.key===o.value)?.plan;
 $('#final-total').textContent=state.plan==='usd'?selected.detail:money(selected.total);
 $('#final-total-detail').textContent=selected.plan?selected.detail:state.plan==='usd'?'Equivalente: '+money(selected.total):'';
 $('#review-payment').disabled=$('#prepare-payment').disabled;$('#review-payment').hidden=state.phase!=='editing';
 $('#review-requirement').textContent=!state.ready?'Recuperando la venta…':state.conflict?'Recargá el tablero para recuperar la versión guardada.':state.phase!=='editing'?'Venta registrada o en proceso. Consultá el panel de cobro.':!state.cart.size?'Agregá un producto para comenzar.':!state.customer?'Elegí un cliente o Consumidor final para continuar.':pricingBusy?'Verificando las cuotas…':pricingError?'Actualizá las opciones para continuar.':'Revisá la preparación y abrí el checkout de la tienda.';
 const step=state.order?.paid?3:state.phase!=='editing'||!$('#review-modal').hidden?2:1;
 for(const el of $$('[data-stage]')){if(Number(el.dataset.stage)===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');}
}
for(const b of $$('[data-price-mode]'))b.onclick=()=>{if(locked())return;const m=b.dataset.priceMode;const next=options().find(o=>m==='installments'?!!o.plan:o.key===m);if(!next)return;if(m==='installments'&&options().find(o=>o.key===state.plan)?.plan)return;state.plan=next.key;render();scheduleSave();};
$('#review-payment').onclick=()=>{
 if(locked()||!state.cart.size||!state.customer)return;
 const selected=options().find(o=>o.key===state.plan);
 $('#review-summary').innerHTML=`<p><small>CLIENTE</small><strong>${esc(state.customer.name)}</strong></p><p><small>PRECIO</small><strong>${esc(selected.label)}</strong></p><p><small>MEDIO DE COBRO</small><strong>${esc($('#gateway').selectedOptions[0]?.textContent)}</strong></p><p class="review-total"><span>Total de productos</span><strong>${esc(state.plan==='usd'?selected.detail:money(selected.total))}</strong></p>`;
 $('#review-help').textContent=externalReceipt()?'Registrá los cobros externos. Luego deberás confirmar el dinero recibido. No se realiza un cargo desde este formulario.':isManualGateway($('#gateway').value)?'Se creará el pedido pendiente de cobro. Confirmá el dinero recibido antes de facturar.':'Se preparará un enlace al checkout de la tienda. Allí revisás el total final y completás el pedido.';
 $('#review-error').hidden=true;drawReceipt();openModal('review-modal');renderGuided();
};
$('#close-review').onclick=$('#back-review').onclick=()=>{closeModal('review-modal');renderGuided();};

const planCards=document.createElement('div');planCards.id='pos-plan-cards';planCards.className='pos-plan-cards';$('#commercial-note').after(planCards);
const refreshPlans=document.createElement('button');refreshPlans.id='refresh-plans';refreshPlans.type='button';refreshPlans.className='fbpos-link';refreshPlans.textContent='Actualizar opciones';refreshPlans.onclick=()=>{ensurePricing(true);render();};planCards.after(refreshPlans);
planCards.onclick=e=>{const button=e.target.closest('[data-select-plan]');if(!button||locked())return;state.plan=button.dataset.selectPlan;render();scheduleSave();};
const manageButton=document.createElement('button');manageButton.className='fbpos-btn';manageButton.type='button';manageButton.textContent='Buscar pedido / facturar';$('#new-sale').before(manageButton);
const manager=document.createElement('div');manager.id='pos-order-manager';manager.className='fbpos-modal';manager.hidden=true;
manager.innerHTML='<section class="fbpos-modal-card" role="dialog" aria-modal="true" aria-labelledby="pos-order-title"><h2 id="pos-order-title">Cobro y factura de un pedido</h2><p>Buscá un pedido creado desde tu POS VPS.</p><form id="pos-order-find"><label>Número de pedido<input id="pos-order-number" type="number" min="1" required></label><button class="fbpos-btn primary" type="submit">Buscar pedido</button></form><p id="pos-order-error" role="status" hidden></p><div id="pos-order-detail"></div><div class="modal-actions"><button class="fbpos-btn" id="pos-order-close" type="button">Volver al POS</button></div></section>';
$('#fbpos-app').append(manager);manageButton.onclick=()=>{openModal('pos-order-manager');$('#pos-order-number').focus();};$('#pos-order-close').onclick=()=>{closeModal('pos-order-manager');managedOrder=null;};
$('#pos-order-find').onsubmit=async e=>{e.preventDefault();$('#pos-order-error').hidden=true;$('#pos-order-detail').textContent='Consultando pedido…';try{managedOrder=await api('/orders/'+encodeURIComponent($('#pos-order-number').value));$('#pos-order-detail').innerHTML=orderHTML(managedOrder);}catch(err){managedOrder=null;$('#pos-order-detail').textContent='';$('#pos-order-error').hidden=false;$('#pos-order-error').textContent=err.message;}};
$('#final-total-label').textContent='Total de productos';$('#quote-button').title='Presupuestos nuevos: disponibles todavía en la tienda.';$('#new-customer').textContent='Cargar datos del cliente';$$('[data-price-mode]').forEach(b=>{if(b.dataset.priceMode==='usd')b.hidden=true;});document.querySelector('.price-section .section-caption').textContent='Compará el total y el valor de cada cuota antes de cobrar.';
boot().then(()=>{if(needsPaymentPolling())startPolling();});
})();
