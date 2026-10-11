(() => {
  'use strict';
  const root = document.getElementById('fusion-arca-app');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = (v, currency = 'ARS') => `${currency === 'USD' ? 'USD' : '$'} ${Number(v || 0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Argentina/Cordoba',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const states = {draft:'Borrador',rejected:'Rechazada',pending:'Pendiente de ARCA',authorized:'Autorizada',internal:'Sin CAE'};
  const vats = ['21','10.5','27','5','2.5','0'];
  let config, doc, tab = 'new', busy = false, searchTimer, requestNumber = 0, results = [], listPage = 1, dirty = false, stockFilter = 'all';
  let historyQuery='', historyRows=[], historyRequest=0, historyStatus='', historyOrigin='', historyPoll;
  let productPage=1,productQuery='',productStock='all',productHasMore=false;
  let settingsDraft=null;
  let connectionResults = {}, billingSchema = {country:'AR',fields:[]}, billingRequest=0;
  const credit = () => [3,8].includes(Number(doc.payload.type));
  const frozen = () => locked() || credit();
  const label = p => ([3,8].includes(Number(p.type))?'Nota de crédito ':'Factura ')+([1,3].includes(Number(p.type))?'A':'B');
  const icon = name => `<svg class="fa-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({invoice:'<path d="M6 3h9l4 4v14H5V3h1zM14 3v5h5M8 12h8M8 16h6"/>',plus:'<path d="M12 5v14M5 12h14"/>',history:'<path d="M4 5v5h5M4 10a8 8 0 1 1 1 8M12 8v5l3 2"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="white"/><circle cx="15" cy="17" r="3" fill="white"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',box:'<path d="m3 7 9-4 9 4v10l-9 4-9-4V7zm0 0 9 4 9-4M12 11v10M8 5l9 4"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',check:'<path d="m5 12 4 4L19 6"/>',mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',print:'<path d="M7 8V3h10v5M7 17H3V9h18v8h-4M7 14h10v7H7z"/>',credit:'<path d="M8 4H4v4M4 4l6 6M11 3h6l4 4v14H7V12M16 3v5h5M11 16h6"/>',save:'<path d="M4 3h13l3 3v15H4V3zm3 0v6h9V3M7 21v-8h10v8"/>',refresh:'<path d="M20 4v6h-6M4 20v-6h6M20 10a8 8 0 0 0-14-5M4 14a8 8 0 0 0 14 5"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>'})[name]||''}</svg>`;
  const isInvoice = r => [1,6].includes(Number(r.type??r.payload?.type))&&(r.authorization??r.payload?.authorization??'arca')!=='internal'&&r.status!=='internal';
  function creditAction(r,editor=false){
    if(!isInvoice(r))return '';
    if(Number(r.credit_note_id)>0)return `<button class="fa-btn secondary ${editor?'':'small'}" data-open="${Number(r.credit_note_id)}">${icon('credit')} Ver nota de crédito</button>`;
    const can=r.can_credit===true||r.can_credit===1;
    return `<button class="fa-btn secondary ${editor?'':'small'}" ${can?`data-credit="${Number(r.id)}"`:'disabled'} title="${esc(r.credit_reason||'Emitir nota de crédito por el total')}">${icon('credit')} Nota de crédito</button>${can?'':`<small class="fa-action-help">${esc(r.credit_reason||'Primero autorizá la factura.')}</small>`}`;
  }
  function clientMissing(){
    const c=doc.payload.customer,missing=[];
    if(!c.document)missing.push({caption:'DNI, CUIT o CUIL',selector:'[data-field="customer.document"]'});
    if(c.billing&&!credit())for(const f of billingSchema.fields)if(f.required&&!f.hidden&&(f.type==='checkbox'?String(c.billing[f.key])!=='1':!String(c.billing[f.key]??'').trim()))missing.push({caption:f.label,selector:`[data-billing="${f.key}"]`});
    if(!c.name)missing.push({caption:'Nombre o razón social',selector:c.billing?'[data-billing="billing_first_name"]':'[data-field="customer.name"]'});
    if(!c.address)missing.push({caption:'Domicilio',selector:c.billing?'[data-billing="billing_address_1"]':'[data-field="customer.address"]'});
    return missing;
  }
  function workflow(){const ready=[doc.payload.lines.length>0,clientMissing().length===0,locked()];return `<div class="fa-workflow" aria-label="Pasos para facturar">${[['products','box','Productos','Agregá o escaneá'],['client','user','Cliente','Completá sus datos'],['summary','invoice','Emitir','Revisá el total']].map(([target,glyph,title,desc],i)=>`<button type="button" data-go="${target}" class="${ready[i]?'done':''}"><span class="fa-step-icon">${icon(ready[i]?'check':glyph)}</span><span><b>${i+1}. ${title}</b><small>${desc}</small></span></button>`).join('')}</div>`;}
  const billingDefaults = () => Object.fromEntries(billingSchema.fields.map(f=>[f.key,f.key==='billing_country'?billingSchema.country:f.default||'']));
  const blank = () => ({id:0,revision:0,status:'draft',environment:config.environment,payload:{authorization:'arca',currency:'ARS',type:6,date:today(),concept:1,
    same_currency:'S',commercial_rate:0,fiscal_rate:0,order_id:0,customer:{name:'',address:'',email:'',phone:'',...(billingSchema.fields.length?{billing:billingDefaults()}:{}),document:'',document_type:96,vat_condition:5},lines:[],notes:'',payment_terms:'Contado',review_confirmed:false}});
  const locked = () => ['authorized','pending','internal'].includes(doc.status);
  const internal = () => doc.payload.authorization === 'internal' || doc.status === 'internal';
  const options = (items, value) => items.map(([id,label])=>`<option value="${esc(id)}" ${String(id)===String(value)?'selected':''}>${esc(label)}</option>`).join('');
  let freshRead=0;
  async function api(path, method='GET', data, renewed=false) {
    if(method!=='GET'&&(/^(?:ml|bulk|whatsapp)\//.test(path)||/^invoices\/\d+\/whatsapp(?:\?|$)/.test(path)))throw new Error('Esta función todavía no está habilitada en el VPS. Podés emitir manualmente y guardar el PDF del comprobante.');
    if(method!=='GET'&&path==='config')throw new Error('La configuración fiscal está disponible sólo para consulta en este corte. Los cambios se administran en el VPS.');
    const csrf=document.querySelector('meta[name="fusion-csrf"]')?.content;
    if(method!=='GET'&&!csrf)throw new Error('La sesión del facturador necesita actualizarse. Recargá la página antes de guardar o emitir.');
    const url = new URL(FusionArca.root, location.href);
    if(url.searchParams.has('rest_route')) {const [p,q]=path.split('?');url.searchParams.set('rest_route',url.searchParams.get('rest_route')+p);if(q)new URLSearchParams(q).forEach((v,k)=>url.searchParams.set(k,v));}
    else {const [p,q]=path.split('?');url.pathname+=p;if(q)new URLSearchParams(q).forEach((v,k)=>url.searchParams.set(k,v));}
    if(method==='GET'&&path.startsWith('ml/'))url.searchParams.set('_fusion_read',Date.now()+'-'+(++freshRead));
    const res = await fetch(url,{method,credentials:'same-origin',cache:'no-store',headers:{'X-WP-Nonce':FusionArca.nonce,'Content-Type':'application/json',...(csrf?{'X-Fusion-CSRF':csrf}:{})},body:data===undefined?undefined:JSON.stringify(data)});
    let body;try{body=await res.json();}catch(e){throw new Error('El servidor devolvió una respuesta inesperada. Si estabas emitiendo, consultá el estado antes de reintentar.');}
    if(!res.ok&&body.code==='delivery_csrf'&&!renewed){const session=await api('delivery-session');document.querySelector('meta[name="fusion-csrf"]').content=session.csrf;return api(path,method,data,true);}
    if(!res.ok){if((path.startsWith('bulk/')||path.startsWith('ml/'))&&body.code==='fusion_bulk_locked'){config.bulk_unlocked=false;bulkSelected.clear();mlSelected.clear();clearTimeout(bulkPoll);clearTimeout(mlPoll);if(tab==='bulk'||tab==='ml')render();}const error=new Error(body.message || 'No se pudo completar la operación.');error.fields=body.data?.fields||{};throw error;}return body;
  }
  let feedbackOrigin=null,feedbackId=0;
  function feedbackContext(el){
    if(!el)return {tab};
    const row=el.closest('[data-ml-row]');if(row)return {tab,selector:`[data-ml-row="${Number(row.dataset.mlRow)}"] .fa-ml-fiscal`};
    if(el.closest('.fa-wa-delivery'))return {tab,selector:'.fa-wa-delivery'};
    const form=el.closest('form');if(form?.id)return {tab,selector:'#'+form.id};
    if(el.id)return {tab,selector:'#'+el.id};
    if(el.dataset.action)return {tab,selector:`[data-action="${el.dataset.action}"]`};
    return {tab,element:el.closest('dialog,.fa-card,.fa-summary')||el};
  }
  function feedbackTarget(context=feedbackOrigin){
    if(context?.tab===tab){const el=context.selector?root.querySelector(context.selector):context.element;if(el?.isConnected)return el;}
    return root.querySelector('dialog[open] form')||root.querySelector(tab==='new'?'#fa-summary':tab==='settings'?'#fa-settings':tab==='ml'?'.fa-ml-sales':tab==='bulk'?'#fa-bulk-activity':'.fa-history-search')||root;
  }
  function clearFieldFeedback(control){
    const id=control.dataset.feedbackId;if(id){document.getElementById(id)?.remove();const desc=(control.getAttribute('aria-describedby')||'').split(/\s+/).filter(x=>x&&x!==id);if(desc.length)control.setAttribute('aria-describedby',desc.join(' '));else control.removeAttribute('aria-describedby');delete control.dataset.feedbackId;}
    control.removeAttribute('aria-invalid');control.closest('label')?.classList.remove('fa-field-missing');
  }
  function inlineFeedback(target,text,bad=false){
    if(!target)return null;
    const control=target.matches('input,select,textarea')?target:null;
    let host=control?(control.closest('label,.fa-field')||control.parentElement):target;
    if(host.tagName==='BUTTON')host=host.closest('.fa-row-actions')||host.parentElement;
    if(host.tagName==='TR')host=host.querySelector('.fa-ml-fiscal')||host.lastElementChild;
    if(control)clearFieldFeedback(control);else Array.from(host.children).filter(x=>x.hasAttribute('data-fa-feedback')).forEach(x=>x.remove());
    const note=document.createElement('div');note.dataset.faFeedback='';note.className='fa-inline-notice '+(bad?'bad':'good');note.textContent=text;note.setAttribute('role',bad?'alert':'status');host.appendChild(note);
    if(control){note.id='fa-field-feedback-'+(++feedbackId);control.dataset.feedbackId=note.id;control.setAttribute('aria-describedby',[control.getAttribute('aria-describedby'),note.id].filter(Boolean).join(' '));if(bad)control.setAttribute('aria-invalid','true');}
    return note;
  }
  function fieldControl(key){
    if(key.startsWith('ml_import.'))return root.querySelector(`#fa-ml-import [name="${key.split('.')[1]}"]`);
    if(key.startsWith('ml_filter.'))return root.querySelector(`#fa-ml-filters [name="${key.split('.')[1]}"]`);
    let m;if((m=/^ml\.(\d+)\.([a-z_]+)$/.exec(key)))return root.querySelector(`[data-ml-customer-sale="${m[1]}"] [data-ml-billing="${m[2]}"]`);
    if((m=/^(settings|whatsapp)\.([a-z_]+)$/.exec(key)))return root.querySelector(`#${m[1]==='settings'?'fa-settings':'fa-whatsapp-settings'} [name="${m[2]}"]`);
    if((m=/^billing\.(billing_[a-z_]+)$/.exec(key)))return root.querySelector(`[data-billing="${m[1]}"]`);
    if((m=/^customer\.([a-z_]+)$/.exec(key)))return root.querySelector(`[data-field="customer.${m[1]}"]`);
    if((m=/^recipient\.(phone|email)$/.exec(key)))return root.querySelector('#fa-recipient-'+m[1]);
    if((m=/^lines\.(\d+)\.serials\.(\d+)$/.exec(key)))return root.querySelector(`[data-serial-line="${m[1]}"][data-serial-index="${m[2]}"]`);
    return null;
  }
  function toast(text,bad=false,context=feedbackOrigin){
    const el=document.getElementById('fa-notice');if(el){el.className='fa-notice '+(bad?'bad':'good');el.textContent=text;el.hidden=false;}
    inlineFeedback(feedbackTarget(context),text,bad);
  }
  function reportError(error,context=feedbackOrigin){
    toast(error.message||String(error),true,context);let first=null;
    for(const [key,message] of Object.entries(error.fields||{})){const control=fieldControl(key);if(control){inlineFeedback(control,String(message),true);if(!first&&!control.disabled)first=control;}}
    if(first){first.focus();first.scrollIntoView({block:'center',behavior:'smooth'});}
  }
  function fieldFailure(message,fields){const error=new Error(message);error.fields=fields;return error;}
  root.addEventListener('click',e=>{if(!busy)feedbackOrigin=feedbackContext(e.target.closest('button')||e.target);},true);
  root.addEventListener('submit',e=>{if(!busy)feedbackOrigin=feedbackContext(e.target);},true);
  root.addEventListener('input',e=>{if(e.target.matches('input,select,textarea'))clearFieldFeedback(e.target);},true);
  root.addEventListener('change',e=>{if(e.target.matches('input,select,textarea')){clearFieldFeedback(e.target);if(!busy)feedbackOrigin=feedbackContext(e.target);}},true);
  let firstNativeInvalid=null;
  root.addEventListener('invalid',e=>{
    const input=e.target;if(!input.matches('input,select,textarea'))return;e.preventDefault();
    const v=input.validity,message=v.valueMissing?'Completá este campo.':v.typeMismatch&&input.type==='email'?'Ingresá un correo electrónico válido.':v.rangeUnderflow?'El valor mínimo es '+input.min+'.':v.rangeOverflow?'El valor máximo es '+input.max+'.':v.badInput?'Ingresá un valor válido.':'Revisá el formato de este dato.';
    inlineFeedback(input,message,true);if(!firstNativeInvalid){firstNativeInvalid=input;setTimeout(()=>{const first=firstNativeInvalid;firstNativeInvalid=null;if(first?.isConnected){first.focus();first.scrollIntoView({block:'center',behavior:'smooth'});}},0);}
  },true);
  async function run(fn) {if(busy)return;const context=feedbackOrigin;busy=true;root.classList.add('is-busy');root.setAttribute('aria-busy','true');root.querySelectorAll('button').forEach(b=>{b.dataset.wasDisabled=b.disabled?'1':'0';b.disabled=true;});
    try{await fn();}catch(e){reportError(e,context);}finally{busy=false;root.classList.remove('is-busy');root.removeAttribute('aria-busy');root.querySelectorAll('button[data-was-disabled]').forEach(b=>{b.disabled=b.dataset.wasDisabled==='1';delete b.dataset.wasDisabled;});}}
  function field(label,name,value,type='text',more='') {return `<label class="fa-field"><span>${label}</span><input type="${type}" data-field="${name}" value="${esc(value)}" ${locked()||(credit()&&!['date','notes'].includes(name))?'disabled':''} ${more}></label>`;}
  const dropdownArrow = '<span class="fa-dropdown-arrow" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg></span>';
  const selectionCaption = labels => labels.length===1?labels[0]:labels.length?`${labels.length} opciones seleccionadas`:'Seleccioná opciones';
  function choices(label,name,value,items,attrs='',multiple=false){
    if(name==='field-currency')return `<fieldset class="fa-field fa-choice-group"><legend>${label}</legend><div class="fa-choices">${items.map(([id,caption])=>`<label class="fa-choice"><input type="radio" name="${esc(name)}" value="${esc(id)}" ${String(id)===String(value)?'checked':''} ${attrs}><span>${esc(caption)}</span></label>`).join('')}</div></fieldset>`;
    if(multiple){const selected=items.filter(([id])=>value.map(String).includes(String(id))).map(([,caption])=>caption);return `<fieldset class="fa-field fa-multi-field"><legend>${label}</legend><details class="fa-multi-select"><summary><span class="fa-multi-value" title="${esc(selected.join(', '))}">${esc(selectionCaption(selected))}</span>${dropdownArrow}</summary><div class="fa-multi-panel"><small>Podés elegir varias opciones.</small>${items.length?items.map(([id,caption])=>`<label><input type="checkbox" name="${esc(name)}" value="${esc(id)}" ${value.map(String).includes(String(id))?'checked':''} ${attrs}><span>${esc(caption)}</span></label>`).join(''):'<small>No hay opciones disponibles.</small>'}</div></details></fieldset>`;}
    const entries=items.some(([id])=>String(id)===String(value))?items:[['','Seleccioná una opción'],...items.filter(([id])=>String(id)!=='')];
    return `<label class="fa-field"><span>${label}</span><span class="fa-select-wrap"><select name="${esc(name)}" ${attrs}>${options(entries,value)}</select>${dropdownArrow}</span></label>`;
  }
  function select(label,name,value,items,more=''){return choices(label,'field-'+name,value,items,`data-field="${name}" ${locked()||(credit()&&!['date','notes'].includes(name))?'disabled':''} ${more}`);}
  function identification(){const c=doc.payload.customer,label=({80:'CUIT',86:'CUIL',96:'DNI'})[c.document_type]||'documento';return `<div class="fa-identification"><h3>Identificación del cliente</h3><p>Primero ingresá su DNI, CUIT o CUIL para consultar el padrón.</p><div class="fa-identification-fields">
    ${select('Tipo de identificación','customer.document_type',c.document_type,[[96,'DNI'],[80,'CUIT'],[86,'CUIL']])}
    ${field('Número de '+label,'customer.document',c.document,'text',`inputmode="numeric" autocomplete="off" maxlength="16" aria-required="true" aria-describedby="fa-identification-help" placeholder="${c.document_type===96?'Ingresá el DNI':'Ingresá los 11 dígitos'}"`)}
    ${!frozen()?'<button class="fa-btn secondary" data-action="lookup-customer">Consultar datos en ARCA</button>':''}</div><small id="fa-identification-help">${c.document_type===96?'DNI: entre 6 y 9 dígitos.':'CUIT/CUIL: 11 dígitos, con o sin guiones.'} También podés completar los datos manualmente.</small>
    ${!locked()&&config.credentials_configured===false?`<div class="fa-lookup-access">Para consultar el padrón falta configurar el certificado y la clave privada de Fusion Bikes en este entorno.${FusionArca.admin?' <button class="fa-btn text" data-tab="settings">Configurar acceso a ARCA</button>':''}</div>`:''}</div>`;}
  function lookupIdentification(){
    const c=doc.payload.customer,el=root.querySelector('[data-field="customer.document"]'),value=String(c.document||''),digits=value.replace(/\D/g,''),type=Number(c.document_type);
    let error='';
    if(![80,86,96].includes(type))error='Elegí DNI, CUIT o CUIL para identificar al cliente.';
    else if(!digits)error='Ingresá la identificación del cliente antes de consultar el padrón.';
    else if(/[^\d\s.\-]/.test(value))error='Usá solo números, espacios, puntos o guiones en la identificación.';
    else if(type===96){if(!/^\d{6,9}$/.test(digits)||Number(digits)===0)error='Ingresá un DNI válido, de 6 a 9 dígitos.';}
    else{
      let valid=/^\d{11}$/.test(digits)&&Number(digits)>0;
      if(valid){const weights=[5,4,3,2,7,6,5,4,3,2];let digit=11-weights.reduce((sum,w,i)=>sum+w*Number(digits[i]),0)%11;if(digit===11)digit=0;if(digit===10)digit=9;valid=digit===Number(digits[10]);}
      if(!valid)error='Ingresá un CUIT/CUIL válido de 11 dígitos. Revisá el número completo.';
    }
    if(error){if(el){el.setAttribute('aria-invalid','true');el.focus();}throw fieldFailure(error,{'customer.document':error});}
    if(el)el.removeAttribute('aria-invalid');
    return {document_type:type,document:digits};
  }
  function header(){return `<header class="fa-header"><div class="fa-brand">${FusionArca.logo?`<img class="fa-brand-logo" src="${esc(FusionArca.logo)}" alt="Fusion Bikes">`:`<div class="fa-mark">${icon('invoice')}</div>`}<div><strong>Facturación</strong><small>FUSION BIKES</small></div></div><div class="fa-head-right"><span class="fa-env ${config.environment==='production'?'production':''}">${config.environment==='production'?(config.production_enabled?'Producción · emisión activa':'Producción · emisión pausada'):'Modo de prueba'}</span><span class="fa-muted">${esc(config.company)}</span></div></header>
    <nav class="fa-tabs" aria-label="Facturación"><button data-tab="new" class="${tab==='new'?'active':''}" ${tab==='new'?'aria-current="page"':''}>${icon('invoice')} Facturar</button><button data-tab="history" class="${tab==='history'?'active':''}" ${tab==='history'?'aria-current="page"':''}>${icon('history')} Comprobantes</button><button data-tab="ml" class="${tab==='ml'?'active':''}">${icon('box')} Mercado Libre</button>${FusionArca.admin?`<button data-tab="settings" class="${tab==='settings'?'active':''}" ${tab==='settings'?'aria-current="page"':''}>${icon('settings')} Configuración</button>`:''}</nav><div id="fa-notice" class="fa-notice" role="status" aria-live="polite" hidden></div>`;}
  function totals(){const groups={};for(const l of doc.payload.lines){const n=Math.round(Number(l.total||0)*100);groups[l.vat]=(groups[l.vat]||0)+n;}let gross=0,net=0;for(const [v,g]of Object.entries(groups)){gross+=g;net+=Math.round(g/(1+Number(v)/100));}return {gross:gross/100,net:net/100,vat:(gross-net)/100};}
  function serialCount(){let count=0,need=0;doc.payload.lines.forEach(l=>{if(l.requires_serial){need+=Number(l.quantity);count+=(l.serials||[]).filter(Boolean).length;}});return {count,need};}
  function summary(){const p=doc.payload,t=totals(),series=serialCount();return `<div class="fa-summary"><div class="fa-card-kicker">3. TOTAL Y EMISIÓN</div><div class="fa-summary-type"><span class="fa-letter">${internal()?'X':[1,3].includes(Number(p.type))?'A':'B'}</span><div><strong>${internal()?'Factura sin CAE':label(p)}</strong><small>${esc(states[doc.status]||doc.status)}${doc.id?' · #'+doc.id:''}</small></div></div>
    <div class="fa-sumrow"><span>Moneda</span><b>${p.currency==='USD'?'Dólares estadounidenses':'Pesos argentinos'}</b></div><div class="fa-sumrow"><span>Neto gravado</span><b>${money(t.net,p.currency)}</b></div><div class="fa-sumrow"><span>IVA incluido</span><b>${money(t.vat,p.currency)}</b></div><div class="fa-grand"><span>Total final</span><strong>${money(t.gross,p.currency)}</strong><small>El IVA ya está incluido en este importe.</small></div>
    ${p.currency==='USD'&&!internal()?`<div class="fa-rate-note">${p.same_currency==='S'?'Cotización fiscal: asignada por ARCA al autorizar.':'Cotización fiscal informada: '+money(p.fiscal_rate)}${doc.status==='authorized'?'<br>Autorizada: '+money(p.fiscal_rate):''}</div>`:''}
    ${series.need?`<div class="fa-serial-count ${series.count<series.need?'incomplete':''}"><span>Series de bicicletas</span><b>${series.count} / ${series.need}</b></div>${series.count<series.need?'<small>Las series vacías salen con una línea para completar a mano.</small>':''}`:''}
    ${doc.status==='authorized'?`<div class="fa-success"><strong>CAE ${esc(p.cae)}</strong><br>Comprobante ${String(p.point).padStart(5,'0')}-${String(doc.number).padStart(8,'0')}<br>Vencimiento CAE: ${esc(p.cae_expires)}</div>`:''}
    ${internal()?`<div class="fa-banner warn">${p.internal_number?'<b>'+esc(p.internal_number)+'</b><br>':''}Sin CAE · sin validez fiscal.<br>Punto de venta 20 · numeración propia.</div>`:''}
    ${!locked()?`<div class="fa-authorization">${credit()?'<p>Nota de crédito total · requiere CAE.</p>':`<fieldset class="fa-choice-group"><legend>Autorizada</legend><div class="fa-choice-options">${[['arca','Sí'],['internal','No']].map(([value,text])=>`<label><input type="radio" name="fusion-authorization" data-field="authorization" value="${value}" ${(p.authorization||'arca')===value?'checked':''}> ${text}</label>`).join('')}</div></fieldset>`}</div><p class="fa-emit-help">${internal()?'Se emite sin CAE con numeración correlativa del punto 20.':config.environment==='production'?'Al pulsar Emitir se solicita la autorización a ARCA.':'La emisión se realiza en el entorno de prueba.'}</p><button class="fa-btn primary" data-action="emit">${icon('check')}${internal()?'Emitir factura sin CAE':config.environment==='production'?'Emitir '+(credit()?'nota de crédito':'factura'):'Emitir '+(credit()?'nota de crédito':'factura')+' de prueba'}</button><button class="fa-btn secondary" data-action="save">${icon('save')} Guardar para después</button>`:''}
    ${doc.status==='pending'?'<p class="fa-warning">La solicitud está guardada y bloqueada. Consultá ARCA para recuperar el resultado.</p><button class="fa-btn primary" data-action="recover">Consultar estado</button><button class="fa-btn secondary" data-action="retry">Reenviar solicitud guardada</button>':''}
    ${doc.id?creditAction(doc,true):''}
    ${['authorized','internal'].includes(doc.status)?delivery():''}
    ${doc.id?`<button class="fa-btn secondary" data-action="print">${icon('print')}${['authorized','internal'].includes(doc.status)?'Imprimir / guardar PDF':'Ver borrador imprimible'}</button>`:''}<button class="fa-btn text" data-action="new">${icon('plus')} Nueva factura</button></div>`;}
  function line(l,i){return `<article class="fa-line" data-index="${i}"><div class="fa-line-top"><div><strong>${esc(l.name)}</strong><small>SKU ${esc(l.sku||'—')}${l.item_id?' · Renglón del pedido #'+l.item_id:''}</small></div>${!frozen()&&!doc.payload.order_id?`<button class="fa-remove" data-remove="${i}" aria-label="Quitar ${esc(l.name)}">×</button>`:''}</div><div class="fa-line-values">
    <label><span>Cantidad</span><input type="number" min="1" max="1000" step="1" data-line="${i}" data-key="quantity" value="${l.quantity}" ${frozen()||doc.payload.order_id?'disabled':''}></label>
    <label class="fa-line-total"><span>Importe final del renglón (${doc.payload.currency})</span><input type="number" min="0" step="0.01" data-line="${i}" data-key="total" value="${Number(l.total).toFixed(2)}" ${frozen()||(doc.payload.order_id&&!doc.payload.usd_review)?'disabled':''}></label>
    ${choices('IVA incluido','line-vat-'+i,l.vat,vats.map(v=>[v,v+'%']),`data-line="${i}" data-key="vat" ${frozen()?'disabled':''}`)}</div>
    <label class="fa-serial-toggle"><input type="checkbox" data-line="${i}" data-key="requires_serial" ${l.requires_serial?'checked':''} ${frozen()||l.detected_bicycle?'disabled':''}> Identificar unidades con número de serie / cuadro</label>
    ${l.requires_serial?`<div class="fa-serial-fields">${Array.from({length:Math.min(1000,Math.max(0,Number(l.quantity)))},(_,n)=>`<label><span>Serie · unidad ${n+1}</span><input type="text" maxlength="120" placeholder="Ej.: WTU123456789" data-serial-line="${i}" data-serial-index="${n}" value="${esc(l.serials[n]||'')}" ${frozen()?'disabled':''}></label>`).join('')}</div>`:''}</article>`;}
  function editor(){const p=doc.payload;return `<div class="fa-title-row"><div><h1>${internal()?(doc.payload.internal_number||'Nueva factura sin CAE'):(doc.id?label(p)+' '+(doc.number?fiscalNumber({...p,number:doc.number}):'#'+doc.id):'Nueva factura')}</h1><p>${p.order_id?'Pedido WooCommerce #'+p.order_id+' · moneda tomada de la venta':'Completá estos tres pasos para emitir tu comprobante.'}</p></div><span class="fa-state ${doc.status}">${esc(states[doc.status])}</span></div>
    ${config.environment==='homologation'?'<div class="fa-banner">Modo de pruebas. Los comprobantes de este entorno no tienen validez fiscal.</div>':''}
    ${doc.status==='authorized'&&doc.source_sync_pending?'<div class="fa-banner warn" role="status"><strong>El comprobante ya fue emitido.</strong> La sincronización con la tienda está pendiente y se reintentará automáticamente. No vuelvas a emitirlo.</div>':''}
    ${doc.order_series_refreshed?'<div class="fa-banner">Se cargaron las series del cuadro de cada bicicleta. Guardá el borrador para actualizar el comprobante.</div>':''}
    ${doc.error?`<div class="fa-banner error">${esc(doc.error)}</div>`:''}
    ${p.usd_review?`<div class="fa-banner warn">${p.legacy_usd?'Este pedido no tiene un importe histórico en USD guardado. Completá los importes en dólares acordados con el cliente.':'El pedido incluye descuentos, envío, cargos o cambios que requieren revisar los importes en USD.'} La moneda sigue siendo USD.</div>`:''}
    ${!locked()?workflow():''}<div class="fa-layout"><div class="fa-main">    <section id="fa-products" class="fa-card fa-products-card"><div class="fa-section-head"><h2><span>1</span> ¿Qué vas a facturar?</h2><small>Precios finales con IVA</small></div>
    <div class="fa-product-options">${select('Moneda de la venta','currency',p.currency,[['ARS','Pesos · ARS'],['USD','Dólares · USD']],p.order_id?'disabled':'')}${!frozen()&&!p.order_id?`${choices('Mostrar productos','fa-stock',stockFilter,[['all','Todos'],['instock','Cantidad positiva'],['outofstock','Cantidad cero o negativa']],'data-stock')}`:''}</div>
    ${!frozen()&&!p.order_id?`<label class="fa-search-label" for="fa-product-search">Agregar productos del catálogo <kbd>F2</kbd></label><div class="fa-search-wrap"><span class="fa-search-icon">${icon('search')}</span><input id="fa-product-search" type="search" autocomplete="off" placeholder="Escaneá un código de barras o buscá por nombre / SKU…" aria-label="Buscar productos"><div id="fa-search-results" aria-live="polite"></div></div><p class="fa-search-help">Usá el lector del POS y presioná Enter. Si el código identifica varias variantes, elegí la correcta.</p>`:''}
    <div id="fa-lines">${p.lines.length?p.lines.map(line).join(''):`<div class="fa-empty"><span>${icon('box')}</span><strong>Tu factura empieza acá</strong><p>Escribí el nombre de un producto o escaneá su código.</p></div>`}</div>
    ${!frozen()&&!p.order_id?`<button class="fa-btn text" data-action="custom">${icon('plus')} Agregar producto o servicio manual</button>`:''}
    </section><section id="fa-client" class="fa-card"><div class="fa-section-head"><h2><span>2</span> ¿A quién le facturás?</h2>${!doc.id?'<div class="fa-import"><input id="fa-order" type="number" min="1" placeholder="N.º de pedido"><button class="fa-btn small" data-action="load-order">Cargar pedido</button></div>':''}</div>
    ${credit()?`<div class="fa-banner">Nota de crédito por el total de <b>Factura ${p.credit_of.type===1?'A':'B'} ${String(p.credit_of.point).padStart(5,'0')}-${String(p.credit_of.number).padStart(8,'0')}</b>. Se conservan cliente, moneda, productos, importes y series. La devolución de dinero y la reposición de stock se gestionan por separado. Verificá que no exista otra nota de crédito emitida fuera de este facturador.</div>`:''}
    ${identification()}
    <div class="fa-fields three">${!p.customer.billing?field('Nombre o razón social','customer.name',p.customer.name):''}${select('Condición de IVA','customer.vat_condition',p.customer.vat_condition,[[5,'Consumidor final'],[1,'Responsable inscripto'],[6,'Monotributista'],[4,'Exento'],[15,'No alcanzado']])}${internal()?'<div class="fa-help">Factura sin CAE X · sin validez fiscal</div>':select('Comprobante','type',p.type,credit()?[[p.type,label(p)]]:[[6,'Factura B'],[1,'Factura A']])}</div>
    ${customerFields()}
    <div class="fa-fields two">${field('Condición de venta','payment_terms',p.payment_terms||'Contado')}</div>
    <div class="fa-fields two">${field('Fecha de emisión','date',p.date,'date')}${select('Concepto','concept',p.concept,[[1,'Productos'],[2,'Servicios'],[3,'Productos y servicios']])}</div>
    ${p.concept!==1?`<div class="fa-fields three">${field('Servicio desde','service_from',p.service_from||p.date,'date')}${field('Servicio hasta','service_to',p.service_to||p.date,'date')}${field('Vencimiento de pago','due_date',p.due_date||p.date,'date')}</div>`:''}
    ${p.currency==='USD'&&!internal()?`<div class="fa-fields two">${select('¿Se cancela íntegramente en USD?','same_currency',p.same_currency,[['S','Sí, se cobra en dólares'],['N','No, se cobra en otra moneda / combinado']])}${p.same_currency==='N'?field('Cotización fiscal (ARS por USD)','fiscal_rate',p.fiscal_rate,'number','min="0.000001" step="0.000001"'):'<div class="fa-help">ARCA asignará la cotización fiscal oficial. Los importes del comprobante se expresan en USD.</div>'}</div>`:''}</section>
${!credit()||p.notes?`<section class="fa-card fa-optional"><h2>Observaciones <small>Opcional</small></h2><textarea data-field="notes" rows="3" placeholder="Información adicional para el cliente." ${locked()?'disabled':''}>${esc(p.notes)}</textarea></section>`:''}
    </div><aside id="fa-summary">${summary()}</aside></div>`;}
  async function loadBilling(country){const seq=++billingRequest;const data=await api('customer-fields?country='+encodeURIComponent(country||'AR'));if(seq===billingRequest)billingSchema={country:data.country||country||'AR',fields:Array.isArray(data.fields)?data.fields:[]};}
  async function ensureBilling(){if(doc.payload.customer.billing)await loadBilling(doc.payload.customer.billing.billing_country||'AR');}
  function syncBilling(){const c=doc.payload.customer,b=c.billing;if(!b)return;const state=billingSchema.fields.find(f=>f.key==='billing_state');c.name=(b.billing_company||'').trim()||[b.billing_first_name,b.billing_last_name].filter(Boolean).join(' ');c.address=[b.billing_address_1,b.billing_address_2,b.billing_city,state?.options?.[b.billing_state]||b.billing_state,b.billing_postcode].filter(Boolean).join(', ');c.email=b.billing_email||'';c.phone=b.billing_phone||'';}
  function customerFields(){const c=doc.payload.customer;
    if(!c.billing)return `<div class="fa-fields two">${field('Correo electrónico','customer.email',c.email,'email')}${field('Teléfono','customer.phone',c.phone||'','tel')}${field('Domicilio del cliente','customer.address',c.address)}</div>${!frozen()?'<button class="fa-btn text" data-action="structured-customer">Completar dirección campo por campo como en el checkout</button>':''}`;
    return `<div class="fa-customer-form"><h3>Datos de facturación</h3><p>Completá los campos marcados con *.</p><div class="fa-fields two">${billingSchema.fields.filter(f=>!f.hidden).map(f=>{
      const value=c.billing[f.key]??f.default??'',attrs=`data-billing="${esc(f.key)}" ${frozen()?'disabled':''} ${f.required?'aria-required="true"':''}`,caption=esc(f.label)+(f.required?' *':'');
      if(f.type==='checkbox')return `<label class="fa-check"><input type="checkbox" ${attrs} ${value==='1'?'checked':''}> ${caption}</label>`;
      if(['select','radio'].includes(f.type))return choices(caption,'billing-'+f.key,value,Object.entries(f.options||{}),attrs);
      const control=f.type==='textarea'?`<textarea ${attrs}>${esc(value)}</textarea>`:`<input type="${esc(f.type)}" ${attrs} placeholder="${esc(f.placeholder)}" value="${esc(value)}">`;
      return `<label class="fa-field"><span>${caption}</span>${control}</label>`;
    }).join('')}</div></div>`;
  }
  function whatsappDelivery(){
    const s=config.whatsapp||{},w=doc.whatsapp||{state:'none',label:'Sin envío por API',can_send:true};
    const eligible=doc.status==='authorized'&&doc.environment==='production'&&s.enabled&&s.ready;
    return `<div class="fa-wa-delivery"><h4>Enviar PDF por WhatsApp</h4><p role="status"><b>${esc(w.label||'Sin envío por API')}</b>${w.phone?' · '+esc(w.phone):''}${w.updated_at?'<br><small>'+esc(w.updated_at)+' UTC</small>':''}</p>${w.error?`<p class="fa-banner warn">${esc(w.error)}</p>`:''}
      ${eligible&&w.can_send!==false?'<button type="button" class="fa-btn primary" data-action="wa-send">Enviar PDF por WhatsApp</button>':''}
      ${!s.enabled||!s.ready?'<p>Activá el envío directo en Configuración → WhatsApp.</p>':doc.environment!=='production'?'<p>El envío directo está disponible para comprobantes de Producción autorizados.</p>':''}
      <button type="button" class="fa-btn secondary" data-action="wa-status">Actualizar estado del envío</button><small>“Aceptada por Meta” todavía no confirma la entrega. Los resultados inciertos quedan detenidos para evitar duplicados.</small></div>`;
  }
  function whatsappSettings(){const s=config.whatsapp||{};return `<form id="fa-whatsapp-settings" class="fa-card"><h2>WhatsApp · factura en PDF</h2><p>Usá tu número de empresa para enviar el comprobante directamente al cliente.</p>
    <div class="fa-banner ${s.ready?'good':'warn'}" role="status">${esc(s.message||'Guardá y comprobá la conexión antes de habilitar los envíos.')}${s.number?' · '+esc(s.number):''}</div>
    <div class="fa-fields two"><label class="fa-field"><span>Conexión</span><select name="source"><option value="meta" ${s.source!=='own'?'selected':''}>Usar Meta for WooCommerce</option><option value="own" ${s.source==='own'?'selected':''}>Cloud API · conexión propia</option></select><small>La conexión existente se usa si Meta concede acceso a Cloud API.</small></label>
    <label class="fa-field"><span>Idioma de la plantilla</span><input name="language" value="${esc(s.language||'es_AR')}"><small>Debe coincidir con el idioma aprobado en Meta.</small></label>
    <label class="fa-field"><span>Nombre de la plantilla</span><input name="template" value="${esc(s.template||'fusion_factura_pdf')}"></label></div>
    <div class="fa-fields two" data-wa-own ${s.source!=='own'?'hidden':''}>
    <label class="fa-field"><span>ID del número de WhatsApp</span><input name="phone_id" inputmode="numeric" value="${esc(s.phone_id||'')}"></label>
    <label class="fa-field"><span>ID de cuenta WhatsApp (WABA)</span><input name="waba_id" inputmode="numeric" value="${esc(s.waba_id||'')}"></label>
    <label class="fa-field"><span>Token de acceso</span><input name="token" type="password" autocomplete="new-password" placeholder="${s.has_token?'Guardado · dejá vacío para conservar':'Pegá el token de la aplicación propia'}"></label></div>
    <details><summary>Plantilla que hay que crear en Meta</summary><p>Nombre: <b>fusion_factura_pdf</b> · Categoría: <b>Utilidad</b> · Encabezado: <b>Documento</b>. Sin botones. Variables numéricas, en este orden:</p><p>Hola {{1}}, te enviamos {{2}} de tu compra en Fusion Bikes. Adjuntamos el comprobante en PDF. Gracias por elegirnos.</p><p>{{1}}: nombre del cliente. {{2}}: tipo y número del comprobante. Subí un PDF de ejemplo con datos ficticios y esperá la aprobación de Meta.</p></details>
    <label class="fa-check"><input name="enabled" type="checkbox" ${s.enabled?'checked':''}> Habilitar el envío directo de comprobantes</label>
    <label class="fa-check"><input name="automatic" type="checkbox" ${s.automatic?'checked':''}> Enviar automáticamente las próximas facturas autorizadas de pedidos con aceptación de WhatsApp</label>
    <p class="fa-help">Al habilitar el automático aparece una casilla opcional en el checkout para recibir la factura. Se aplica a nuevas facturas de Producción; Mercado Libre conserva su entrega dentro de la compra. Las ventas manuales y del POS pueden enviarse desde el comprobante.</p>
    <div class="fa-actions"><button class="fa-btn primary" type="submit">Guardar WhatsApp</button><button class="fa-btn secondary" type="button" data-action="wa-check">Comprobar conexión y plantilla</button></div><p class="fa-help">Primero guardá con los envíos apagados, comprobá la conexión y después habilitá el envío. La comprobación no envía mensajes. Meta puede cobrar por los mensajes según su tarifa.</p>
    <details><summary>Confirmaciones de entrega · conexión con aplicación propia</summary><p>Para ver Entregada o Leída, configurá el webhook de tu aplicación propia. Si tu aplicación ya tiene un webhook, debe reenviar estas notificaciones conservando la firma; no reemplaces el de Meta for WooCommerce.</p>
    <label class="fa-field"><span>App Secret de la aplicación propia</span><input name="app_secret" type="password" autocomplete="new-password" placeholder="${s.has_app_secret?'Guardado · dejá vacío para conservar':'Opcional para confirmar entregas'}"></label>
    <label class="fa-field"><span>Callback URL</span><input readonly value="${esc(s.webhook_url||'')}"></label><label class="fa-field"><span>Token de verificación</span><input readonly value="${esc(s.verify_token||'')}"></label><p>Suscribí tu aplicación al campo messages de la cuenta de WhatsApp. Sin estas notificaciones el envío queda como Aceptada por Meta.</p></details></form>`;}

  const mailHistory=new Map();
  function delivery(){const c=doc.payload.customer||{};return `<section class="fa-delivery"><h3>${icon('mail')} Enviar comprobante</h3><p>Compartí este comprobante con el cliente.</p><label class="fa-field"><span>Correo del destinatario</span><input id="fa-recipient-email" type="email" autocomplete="off" value="${esc(c.email||'')}"></label><button type="button" class="fa-btn primary" data-action="email">${icon('mail')} Enviar por email</button><small>Se adjunta el PDF. Revisarás el destinatario antes de enviarlo.</small><div id="fa-email-status" role="status">${deliveryStatus()}</div><button type="button" class="fa-btn text small" data-action="email-status">${icon('refresh')} Actualizar estado del correo</button><hr><label class="fa-field"><span>WhatsApp del destinatario</span><input id="fa-recipient-phone" type="tel" autocomplete="off" value="${esc(c.phone||'')}" placeholder="5493515214819"><small>Incluí el código de país. Vacío: elegí el contacto en WhatsApp.</small></label><button type="button" class="fa-btn secondary" data-action="whatsapp">Preparar WhatsApp</button><div id="fa-whatsapp-link" role="status"></div><small>Compartís un enlace al PDF válido por 7 días. El envío se confirma en WhatsApp.</small></section>`;}
  function deliveryStatus(){const items=mailHistory.get(doc.id);return !items?'<small>Consultá el estado para ver los últimos envíos.</small>':!items.length?'<small>No hay envíos de correo registrados desde el VPS.</small>':items.slice(0,3).map(item=>`<p class="fa-mail-result ${item.state==='accepted'?'good':'warn'}"><b>${esc(item.recipient)}</b><br>${esc(item.message)}<br><small>${esc(new Date(item.created_at).toLocaleString('es-AR'))}</small></p>`).join('');}
  async function refreshDelivery(){const id=doc.id,result=await api(`invoices/${id}/delivery`);mailHistory.set(id,result.items||[]);if(doc.id===id&&document.getElementById('fa-email-status'))document.getElementById('fa-email-status').innerHTML=deliveryStatus();return result.items||[];}
  function confirmEmail(email,uncertain){return new Promise(resolve=>{const modal=document.createElement('dialog');modal.className='fa-credit-dialog fa-email-dialog';modal.innerHTML=`<form method="dialog"><h2>Enviar comprobante por email</h2><p>Se enviará <b>${esc(internal()?'el comprobante sin CAE':label(doc.payload))}</b> en PDF a:</p><p class="fa-email-recipient">${esc(email)}</p>${doc.environment!=='production'?'<p class="fa-banner warn">Comprobante de homologación · sin validez fiscal.</p>':''}${uncertain?'<p class="fa-banner warn">El envío anterior tiene un resultado incierto. Revisá tu casilla antes de reenviar: el cliente podría recibirlo dos veces.</p>':''}<div class="fa-row-actions"><button class="fa-btn secondary" value="cancel">Cancelar</button><button class="fa-btn primary" value="send">${uncertain?'Ya revisé · reenviar':'Confirmar envío'}</button></div></form>`;modal.addEventListener('click',event=>event.stopPropagation());modal.addEventListener('close',()=>{const accepted=modal.returnValue==='send';modal.remove();resolve(accepted);},{once:true});root.appendChild(modal);modal.showModal();});}
  function catalogPrice(p){
    // El catálogo local separa el contado web de la lista de Mercado Libre.
    // No usar p.price ni convertir a USD cuando el producto proviene del VPS.
    const value=p._local?(doc.payload.currency==='ARS'?p._local.reference_price:null):(doc.payload.currency==='USD'?p.usd_price:p.price);
    return typeof value==='number'&&Number.isFinite(value)&&value>=0&&(doc.payload.currency!=='USD'||value>0)?value:null;
  }
  function catalogIssue(p){
    if(!Number.isSafeInteger(Number(p.id))||Number(p.id)<1)return 'El producto no tiene una identificación válida.';
    if(catalogPrice(p)===null)return doc.payload.currency==='USD'?'El catálogo local no ofrece un precio USD confirmado. Agregá un concepto manual con el importe en dólares acordado.':'Falta el precio al contado en el catálogo local. Actualizá la sincronización o agregá un concepto manual con el importe acordado.';
    if(p._local&&!vats.includes(String(p.vat)))return 'Falta confirmar el IVA de este producto. Actualizá el catálogo antes de agregarlo.';
    return '';
  }
  function addProduct(p){if(!p||frozen()||doc.payload.order_id)return false;const issue=catalogIssue(p);if(issue){toast(issue,true);return false;}
    doc.payload.lines.push({product_id:Number(p.id),item_id:0,name:p.name,sku:p.sku,quantity:1,total:catalogPrice(p),vat:p.vat,requires_serial:p.requires_serial,detected_bicycle:p.requires_serial,serials:[]});changed();results=[];++requestNumber;render();document.getElementById('fa-product-search')?.focus();return true;
  }
  function productResults(){return (results.length?results.map((p,i)=>{
    const issue=catalogIssue(p),price=catalogPrice(p),stock=p._local?`Stock sincronizado: ${typeof p.stock==='number'&&Number.isFinite(p.stock)?p.stock:'sin dato'}`:String(p.stock??'Stock sin dato');
    return `<button type="button" class="fa-result" data-product="${i}" ${issue?`disabled title="${esc(issue)}"`:''}>${p.image?`<img src="${esc(p.image)}" alt="" loading="lazy" decoding="async">`:'<span class="fa-product-placeholder">＋</span>'}<span><strong>${esc(p.name)}</strong><small>${esc(p.sku||'Sin SKU')} · ${esc(stock)}${p.requires_serial?' · Serie requerida':''}</small>${p._local?'<small>Contado / transferencia · IVA incluido · catálogo local</small>':''}${issue?`<small>${esc(issue)}</small>`:''}</span><b>${price===null?'Importe por confirmar':money(price,doc.payload.currency)}</b></button>`;
  }).join(''):'<div class="fa-result-message">No se encontraron productos. Revisá el código y el filtro de stock.</div>')+`<div class="fa-search-footer"><small>${results.length} productos mostrados${productHasMore?' · hay más resultados':''}</small>${productHasMore?'<button type="button" class="fa-btn secondary" data-action="more-products">Cargar más productos</button>':''}</div>`;}
  async function searchProducts(scan,more=false){
    const input=document.getElementById('fa-product-search'),panel=document.getElementById('fa-search-results');if(!input||!panel||frozen())return;
    const q=input.value.trim(),stock=stockFilter,seq=++requestNumber;
    if(more&&(!productHasMore||q!==productQuery||stock!==productStock))return;
    const page=more?productPage+1:1;
    if(!more){results=[];productHasMore=false;productPage=1;}
    if(q.length<2){panel.innerHTML='';return;}
    if(!more)panel.innerHTML='<div class="fa-result-message">Buscando…</div>';
    try{
      const data=await api(`products?q=${encodeURIComponent(q)}&stock=${encodeURIComponent(stock)}&page=${page}`);
      if(seq!==requestNumber||!panel.isConnected||input.value.trim()!==q||stock!==stockFilter)return;
      const rows=Array.isArray(data)?data:data.rows;if(!Array.isArray(rows))throw new Error('No se recibió una búsqueda válida. Volvé a intentar.');
      productHasMore=!Array.isArray(data)&&data.has_more===true;productPage=page;productQuery=q;productStock=stock;
      results=more?[...results,...rows.filter(p=>!results.some(old=>Number(old.id)===Number(p.id)))]:rows;
      if(scan&&!more&&!productHasMore&&rows.length===1&&(rows[0].exact_match||(rows[0]._local&&rows[0].exact))&&addProduct(rows[0]))return;
      panel.innerHTML=productResults();
    }catch(err){if(seq===requestNumber&&panel.isConnected){panel.innerHTML=(more?productResults():'')+`<div class="fa-result-message" role="alert">${esc(err.message)}</div>`;}}
  }
  document.addEventListener('keydown',e=>{if(e.key==='F2'&&!busy){const input=document.getElementById('fa-product-search');if(input){e.preventDefault();input.focus();input.select();}}});
  function automaticSettings(s){const statuses=Object.entries(s.order_statuses||{});return `<section class="fa-auto-settings"><div class="fa-section-head"><h2>${icon('refresh')} Facturación automática por estado</h2><span class="fa-state">Pausada en el VPS</span></div><p>La emisión disponible en el VPS es manual. Las reglas automáticas todavía no están habilitadas.</p><fieldset disabled><legend class="fa-sr-only">Reglas automáticas pendientes de habilitación</legend>
    <label class="fa-check"><input type="checkbox" name="auto_enabled"> Activar facturación automática en ${s.environment==='production'?'Producción':'Homologación'}</label>
    <div class="fa-fields two">${choices('1. Estados que disparan la factura','auto_statuses',s.auto_statuses||[],statuses,'',true)}
    <div>${choices('2. Qué pedidos incluir','auto_scope',s.auto_scope||'checkout',[['checkout','Solo compras realizadas en la web'],['all','Todos, excepto Mercado Libre']])}<small>Solo web excluye pedidos creados desde el administrador, POS e importaciones que conservan su origen. Mercado Libre se excluye en ambas opciones.</small></div></div>
    <label class="fa-check"><input type="checkbox" name="auto_require_paid" ${s.auto_require_paid!==false?'checked':''}> Exigir pago registrado antes de facturar</label>
    <div class="fa-help"><b>3. Revisá los resultados</b><br>Si falta identificación, condición de IVA, una serie o un importe en dólares, el pedido queda para revisión. Las facturas pendientes de ARCA nunca se reenvían automáticamente.</div>
    <p class="fa-auto-footnote">Se aplica a próximos cambios de estado; activar la regla no factura pedidos anteriores. Cambiar de entorno, CUIT o punto de venta pausa la automatización. Esta etapa genera la factura; su envío se realiza desde el comprobante.</p>
    ${s.auto_scheduler_available===false?'<div class="fa-banner warn">La cola de WooCommerce no está disponible. Revisá WooCommerce → Estado → Acciones programadas.</div>':''}
    <button type="button" class="fa-btn secondary" data-action="auto-activity">${icon('history')} Ver actividad automática</button><div id="fa-auto-activity" aria-live="polite"></div></fieldset></section>`;}
  async function automaticActivity(){const el=root.querySelector('#fa-auto-activity');if(!el)return;el.textContent='Cargando actividad…';try{const data=await api('automation');if(!el.isConnected)return;if(!Array.isArray(data.rows))throw new Error('No se recibió una actividad válida.');const labels={queued:'En cola',authorized:'Facturada',review:'Pendiente de emisión',pending:'Pendiente de ARCA',rejected:'Rechazada',existing:'Comprobante existente',skipped:'Omitida'};el.innerHTML=data.rows.length?data.rows.map(r=>`<div class="fa-auto-row"><div><b>Pedido #${Number(r.order_id)}</b><small>${esc(new Date(r.updated_at).toLocaleString('es-AR'))}</small></div><span class="fa-state ${esc(r.status)}">${esc(labels[r.status]||r.status)}</span><p>${esc(r.message)}</p>${Number(r.invoice_id)>0?`<button type="button" class="fa-btn small" data-open="${Number(r.invoice_id)}">Abrir comprobante</button>`:`<button type="button" class="fa-btn small" data-auto-order="${Number(r.order_id)}">Revisar pedido</button>`}</div>`).join(''):'<div class="fa-empty"><strong>Todavía no hay actividad</strong><p>Los resultados aparecerán cuando un pedido entre en los estados elegidos.</p></div>';}catch(e){if(el.isConnected)el.textContent=e.message;throw e;}}
  function settings(){const s={...config};return `<div class="fa-title-row"><div><h1>Configuración</h1><p>Datos fiscales de consulta y conexión directa con ARCA. Los cambios de configuración se administran en el VPS.</p></div></div><form id="fa-settings" class="fa-card"><div class="fa-settings-save"><p data-settings-status role="status">${settingsStatus()}</p></div><fieldset disabled style="border:0;margin:0;padding:0;min-width:0"><legend class="fa-sr-only">Configuración fiscal de sólo lectura</legend><div class="fa-fields two">
    ${[['company','Razón social'],['cuit','CUIT'],['address','Domicilio fiscal'],['phone','Teléfono'],['email','Correo electrónico'],['iibb','Ingresos Brutos'],['start_date','Inicio de actividades'],['point','Punto de venta Web Services']].map(([k,l])=>`<label class="fa-field"><span>${l}</span><input name="${k}" value="${esc(s[k])}" type="${k==='start_date'?'date':k==='point'?'number':'text'}"></label>`).join('')}
    ${choices('Entorno','environment',s.environment,[['homologation','Homologación · pruebas'],['production','Producción · facturas reales']])}
    ${choices('IVA predeterminado','vat',s.vat,vats.map(v=>[v,v+'%']))}
    <label class="fa-field"><span>Medios de pago en dólares (IDs, separados por coma)</span><input name="usd_gateways" value="${esc(s.usd_gateways)}"><small>Tu Master Control utiliza cheque para transferencia en dólares.</small></label>
    <div>${choices('Categorías que requieren número de serie','bicycle_categories',String(s.bicycle_categories).split(','),s.categories.map(t=>[t.id,t.name]),'',true)}<small>Indica qué productos deben llevar número de cuadro en el comprobante. Incluye subcategorías y no limita qué productos podés facturar. Sin selección, detecta bicicleta/bicicletas/bikes.</small></div></div>
    ${automaticSettings(s)}<section class="fa-connection-setup"><h2>Conectar con ARCA</h2><p>Entorno guardado: <b>${config.environment==='production'?'Producción':'Homologación'}</b> · CUIT representado: <b>${esc(config.cuit)}</b></p>
    <div class="fa-connection-status"><b>1. Servidor y certificado</b><p>SOAP: ${s.soap_available?'disponible':'falta habilitar'} · OpenSSL: ${s.openssl_available===false?'falta habilitar':'disponible'} · SimpleXML: ${s.simplexml_available===false?'falta habilitar':'disponible'}</p><p>${esc(s.certificate_status?.message||(s.credentials_configured?'Rutas configuradas. Probá los servicios para validar el acceso.':'Falta configurar el certificado y la clave privada.'))}${s.certificate_status?.expires?' Vence el '+esc(s.certificate_status.expires)+'.':''}</p></div>
    <div class="fa-connection-status"><b>2. Facturación electrónica</b><p>Habilitá Facturación Electrónica (wsfe) para el certificado y el CUIT representado. La prueba consulta puntos de venta. Si Homologación devuelve 602, consulta los últimos comprobantes A y B del punto guardado, sin solicitar CAE.</p></div>
    <div class="fa-connection-status"><b>3. Datos del padrón</b><p>Habilitá también Padrón Alcance 13 (ws_sr_padron_a13). La prueba consulta el nombre del emisor usando el CUIT guardado.</p></div>
    <section class="fa-setup-help"><h3>Pasos para obtener y configurar el certificado</h3><ol><li>Ingresá a ARCA con la cuenta del representante. Para pruebas se usa WSASS; para producción, Administración de Certificados Digitales.</li><li>Generá la clave privada y la solicitud CSR en un equipo seguro. En WSASS, el CUIT del certificado es el de la persona que ingresa; en la autorización, el CUIT representado es ${esc(s.cuit)}.</li><li>Descargá el certificado de ARCA y autorizá los dos servicios para el CUIT representado.</li><li>Guardá certificado y clave fuera de la carpeta pública del hosting. Configurá sus rutas en wp-config.php, siguiendo la guía.</li><li>Guardá la configuración y probá Facturación y Padrón. Elegí un punto de venta Web Services habilitado y guardalo.</li></ol><p>La clave fiscal se ingresa únicamente en ARCA. El plugin no la solicita.</p>${FusionArca.guide?`<a href="${esc(FusionArca.guide)}" target="_blank" rel="noopener">Abrir guía de conexión paso a paso</a>`:'<p>La guía se incluye en docs/CONECTAR-ARCA.html dentro del plugin.</p>'}</section>
    </section>
    ${s.wanderlust_detected?'<div class="fa-banner warn"><b>Wanderlust está activo.</b> Podés probar la conexión y trabajar en homologación. La emisión fiscal en producción seguirá bloqueada hasta completar el cambio de facturador. El POS actual todavía utiliza Wanderlust.</div>':''}
    <label class="fa-check"><input name="production_enabled" type="checkbox" ${s.production_enabled?'checked':''}> Habilitar el botón de emisión real cuando el entorno sea Producción.</label>
    </fieldset><div class="fa-actions"><button type="button" class="fa-btn secondary" data-action="connection">Probar Facturación</button><button type="button" class="fa-btn secondary" data-action="connection-padron">Probar Padrón</button></div><p class="fa-help">Las pruebas usan la configuración vigente y no emiten facturas.</p><div id="fa-connection-results" aria-live="polite">${connectionFeedback()}</div></form><section class="fa-card"><h2>Envíos y otras modalidades</h2><p>Correo, WhatsApp, emisión desde Mercado Libre y facturación masiva todavía no están habilitados en el VPS. El historial de Mercado Libre sigue disponible para consulta.</p></section>`;}
  function settingsStatus(){return settingsDraft?'Cambios sin guardar. Pulsá Guardar configuración para aplicarlos.':`Configuración guardada · ${config.environment==='production'?'Producción':'Homologación'}`;}
  function rememberSettings(){settingsDraft=null;}
  function settingsValues(form){const values={};for(const key of ['company','cuit','address','phone','email','iibb','start_date','point','environment','vat','usd_gateways'])values[key]=form.elements[key].value;values.bicycle_categories=Array.from(form.querySelectorAll('[name="bicycle_categories"]:checked')).map(o=>o.value).join(',');values.production_enabled=form.elements.production_enabled.checked;values.auto_enabled=false;values.auto_require_paid=form.elements.auto_require_paid.checked;values.auto_scope=form.elements.auto_scope.value;values.auto_statuses=Array.from(form.querySelectorAll('[name="auto_statuses"]:checked')).map(el=>el.value);return values;}
  function connectionFeedback(){return Object.entries(connectionResults).map(([service,r])=>`<div class="fa-probe ${r.ok?(r.warning?'warn':'good'):'bad'}"><b>${service==='padron'?'Padrón':'Facturación'} · ${esc(r.environment==='production'?'Producción':'Homologación')} · CUIT ${esc(r.cuit)}</b><p>${esc(r.message)}</p>${r.points?.length?`<table class="fa-table"><thead><tr><th>Punto de venta</th><th>Tipo</th><th>Estado</th></tr></thead><tbody>${r.points.map(p=>`<tr><td>${esc(p.Nro)}</td><td>${esc(p.EmisionTipo||'—')}</td><td>${p.available?'Disponible':p.FchBaja&&String(p.FchBaja).toUpperCase()!=='NULL'?'Baja: '+esc(p.FchBaja):'No disponible'}</td></tr>`).join('')}</tbody></table>`:''}</div>`).join('');}
  const fiscalNumber = r => `${String(r.point||0).padStart(5,'0')}-${String(r.number||0).padStart(8,'0')}`;
  const customerVatLabels={1:'Responsable inscripto',4:'Exento',5:'Consumidor final',6:'Monotributista',7:'No categorizado',8:'Proveedor del exterior',9:'Cliente del exterior',10:'IVA liberado',13:'Monotributista social',15:'IVA no alcanzado',16:'Monotributo trabajador independiente promovido'};
  function customerIdentity(c){if(!c)return '';return `${c.document?`<small>${esc(({80:'CUIT',86:'CUIL',96:'DNI'})[c.document_type]||'Documento')} ${esc(c.document)}</small>`:'<small class="fa-data-missing">Falta identificación fiscal</small>'}<small>${esc(customerVatLabels[c.vat_condition]||'Condición IVA sin cargar')}</small>`;}
  function bulkCustomer(r){const c=r.customer_details;if(!c)return `<div class="fa-bulk-customer"><strong>${esc(r.customer||'Cliente sin completar')}</strong></div><div></div>`;return `<div class="fa-bulk-customer"><strong>${esc(c.name||r.customer||'Cliente sin completar')}</strong>${c.contact_name&&c.contact_name!==c.name?`<small>Contacto: ${esc(c.contact_name)}</small>`:''}${customerIdentity(c)}<small>${r.invoice?.status==='excluded_ml'?'Tipo de factura: consultar en Mercado Libre':[1,6].includes(Number(c.vat_condition))?'Factura A prevista':[4,5].includes(Number(c.vat_condition))?'Factura B prevista':'Tipo de factura por confirmar'}</small></div><div class="fa-bulk-contact">${c.address?`<small><b>Domicilio:</b> ${esc(c.address)}</small>`:'<small class="fa-data-missing">Falta domicilio de facturación</small>'}${c.email?`<small><b>Email:</b> ${esc(c.email)}</small>`:'<small class="fa-muted">Email no cargado</small>'}${c.phone?`<small><b>Tel.:</b> ${esc(c.phone)}</small>`:'<small class="fa-muted">Teléfono no cargado</small>'}</div>`;}
  function historyShell(){return `<div class="fa-title-row"><div><h1>Comprobantes</h1><p>Consultá tus facturas, notas de crédito y borradores.</p></div><button class="fa-btn primary" data-action="new">${icon('plus')} Nueva factura</button></div><section class="fa-card fa-history-card"><div class="fa-history-search"><label class="fa-history-query"><span class="fa-sr-only">Buscar comprobantes</span>${icon('search')}<input id="fa-history-q" value="${esc(historyQuery)}" placeholder="Cliente, número, serie o pedido"></label>${choices('Origen de la venta','fa-history-origin',historyOrigin,[['','Todos los orígenes'],['web','Web'],['ml','Mercado Libre'],['pos','Punto de venta'],['manual','Venta manual'],['unknown','Origen no disponible']],'data-history-origin')}${choices('Estado del comprobante','fa-history-status',historyStatus,[['','Todos'],['authorized','Autorizados'],['draft','Borradores'],['pending','Pendientes de ARCA'],['rejected','Rechazados'],['internal','Sin CAE']],'data-history-status')}<button class="fa-btn small" data-action="search-history">Buscar</button><button class="fa-btn small secondary" data-action="refresh-history" title="Actualizar comprobantes" aria-label="Actualizar comprobantes">${icon('refresh')}</button></div><div id="fa-history-results" aria-live="polite">Cargando comprobantes…</div></section>`;}
  function render(){if(FusionArca.pos)tab='new';clearTimeout(historyPoll);clearTimeout(mlPoll);root.innerHTML=header()+(tab==='new'?editor():tab==='settings'?settings():tab==='bulk'?'<section class="fa-card"><h1>Facturación masiva</h1><p>La emisión por lotes todavía no está habilitada en el VPS. Podés cargar un pedido y emitirlo manualmente desde Facturar.</p><button class="fa-btn primary" data-tab="new">Ir a Facturar</button></section>':tab==='ml'?mlShell():historyShell());if(tab==='ml')loadMl().catch(e=>toast(e.message,true));if(tab==='history')loadHistory().catch(e=>toast(e.message,true));if(FusionArca.pos&&Number(doc.payload.order_id)===Number(FusionArca.order))window.parent.postMessage({type:'fusion-arca-pos-state',order_id:Number(FusionArca.order),status:doc.status},location.origin);}
  function refreshSummary(){const s=document.getElementById('fa-summary');if(s)s.innerHTML=summary();const steps=root.querySelector('.fa-workflow');if(steps)steps.outerHTML=workflow();}
  function changed(){dirty=true;doc.payload.review_confirmed=false;}
  async function save(){if(!doc.payload.lines.length)throw new Error('Agregá al menos un producto.');doc=await api('invoices','POST',{id:doc.id,revision:doc.revision,payload:doc.payload});dirty=false;}
  async function loadOrder(id){id=Number(id);if(!Number.isSafeInteger(id)||id<=0)throw new Error('Ingresá un número de pedido válido.');doc=await api('orders/'+id);await ensureBilling();dirty=!!doc.order_series_refreshed;tab='new';render();}
  function scheduleHistory(){clearTimeout(historyPoll);if(tab!=='history'||listPage!==1)return;historyPoll=setTimeout(()=>{if(tab!=='history'||listPage!==1)return;if(document.hidden||busy||root.querySelector('dialog[open]')||root.querySelector('#fa-history-q')?.value!==historyQuery){scheduleHistory();return;}loadHistory().catch(()=>{});},10000);}
  async function loadHistory(){clearTimeout(historyPoll);
    historyQuery=document.getElementById('fa-history-q')?.value??historyQuery;historyStatus=root.querySelector('[data-history-status]')?.value??historyStatus;historyOrigin=root.querySelector('[data-history-origin]')?.value??historyOrigin;
    const seq=++historyRequest,el=document.getElementById('fa-history-results'),page=listPage;if(!el)return;
    el.setAttribute('aria-busy','true');
    try{
      const data=await api(`invoices?page=${page}&q=${encodeURIComponent(historyQuery)}&status=${encodeURIComponent(historyStatus)}&origin=${encodeURIComponent(historyOrigin)}`);
      if(seq!==historyRequest||el!==document.getElementById('fa-history-results'))return;
      if(!Array.isArray(data.rows))throw new Error('No se recibió un listado válido. Pulsá Volver a intentar.');
      historyRows=data.rows.filter(r=>r&&Number(r.id)>0).map(r=>({...r,id:Number(r.id),credit_note_id:Number(r.credit_note_id||0),can_credit:r.can_credit===true||r.can_credit===1||r.can_credit==='1'}));
      el.innerHTML=historyRows.length?`<div class="fa-history-caption">${historyRows.length} comprobantes · Última actualización primero · ${config.environment==='production'?'Producción':'Modo de prueba'}</div><div class="fa-table-scroll"><table class="fa-table"><thead><tr><th>Comprobante</th><th>Cliente / pedido</th><th>Total</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${historyRows.map(r=>`<tr class="${[3,8].includes(Number(r.type))?'fa-credit-row':''}"><td><div class="fa-document-cell"><span class="fa-document-icon">${icon([3,8].includes(Number(r.type))?'credit':'invoice')}</span><div><strong>${r.authorization==='internal'||r.status==='internal'?'Factura sin CAE':Number(r.type)>0?label(r):'Comprobante'}</strong><span>${esc(r.internal_number||(Number(r.number)>0?fiscalNumber(r):'#'+r.id+' · sin número fiscal'))}</span><small>${esc(r.date||r.created_at)}</small>${r.credit_source?`<small>Sobre ${esc(label(r.credit_source))} ${esc(fiscalNumber(r.credit_source))} <button class="fa-btn text" data-open="${Number(r.credit_of)}">Ver factura</button></small>`:''}</div></div></td><td><strong>${esc(r.customer||'Cliente sin completar')}</strong><small class="fa-origin">${esc(r.origin_label||'Origen no disponible')}${r.ml_order_id?' · Orden ML '+esc(r.ml_order_id):Number(r.source_order_id||r.order_id)>0?' · Pedido #'+Number(r.source_order_id||r.order_id):''}</small>${customerIdentity(r.customer_details)}</td><td class="fa-money-cell">${money(r.total,r.currency)}</td><td><span class="fa-state ${esc(r.status)}">${esc(states[r.status]||r.status)}</span>${r.credit_note_id?`<small>NC ${esc(states[r.credit_note_status]||'asociada')}</small>`:''}</td><td><div class="fa-row-actions"><button class="fa-btn small" data-open="${r.id}">${icon('arrow')} ${['draft','rejected'].includes(r.status)?'Continuar':r.status==='pending'?'Consultar':'Abrir'}</button>${creditAction(r)}</div></td></tr>`).join('')}</tbody></table></div><div class="fa-pagination">${page>1?'<button class="fa-btn small" data-action="prev">Anterior</button>':''}<span>Página ${page}</span>${data.has_more?'<button class="fa-btn small" data-action="next">Siguiente</button>':''}</div>`:`<div class="fa-empty">${icon('history')}<strong>No hay comprobantes para mostrar</strong><p>${historyQuery||historyStatus||historyOrigin?'Probá otra búsqueda o quitá los filtros.':'Tus facturas y notas de crédito aparecerán acá.'}</p>${historyQuery||historyStatus||historyOrigin?'<button class="fa-btn secondary" data-action="clear-history">Quitar filtros</button>':'<button class="fa-btn primary" data-action="new">Crear factura</button>'}</div>`;
    }catch(error){
      if(seq===historyRequest&&el===document.getElementById('fa-history-results')){historyRows=[];el.innerHTML=`<div class="fa-empty fa-history-error" role="alert"><strong>No se pudo cargar el listado</strong><p>${esc(error.message)}</p><button class="fa-btn secondary" data-action="refresh-history">${icon('refresh')} Volver a intentar</button></div>`;throw error;}
    }finally{el.removeAttribute('aria-busy');if(seq===historyRequest)scheduleHistory();}
  }
  async function creditDialog(id){
    // Read the current record; never issue from stale list data.
    const record=await api('invoices/'+Number(id));
    if(record.credit_note_id){doc=await api('invoices/'+Number(record.credit_note_id));await ensureBilling();dirty=!!doc.order_series_refreshed;tab='new';render();return;}
    if(!record.can_credit)throw new Error(record.credit_reason||'Esta factura todavía no permite una nota de crédito.');
    const p=record.payload,source={...record,point:p.point,type:p.type,customer:p.customer.name,date:p.date,currency:p.currency,total:p.totals.gross};
    const modal=document.createElement('dialog');modal.className='fa-credit-dialog';
    modal.innerHTML=`<form method="dialog"><span class="fa-dialog-symbol">${icon('credit')}</span><h2>Emitir nota de crédito</h2><p>Se acreditará el total de esta factura.</p><div class="fa-credit-summary"><strong>${esc(label(source))} ${esc(fiscalNumber(source))}</strong><p>${esc(source.customer)}</p><b>${money(source.total,source.currency)}</b></div><label class="fa-field"><span>Fecha de emisión</span><input name="date" type="date" value="${today()}" min="${esc(source.date)}" max="${today()}" required></label><p class="fa-dialog-context">${record.environment==='production'?'Se solicitará un CAE a ARCA.':'Modo de prueba · sin validez fiscal.'} El reintegro y el stock se gestionan por separado.</p><div class="fa-row-actions"><button type="button" class="fa-btn secondary" data-cancel-credit>Cancelar</button><button type="submit" class="fa-btn primary">${icon('check')} Confirmar nota de crédito</button></div></form>`;
    root.appendChild(modal);modal.showModal();modal.querySelector('[data-cancel-credit]').onclick=()=>modal.close();modal.addEventListener('close',()=>modal.remove());modal.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    modal.querySelector('form').onsubmit=e=>{
      e.preventDefault();const form=e.target;
      run(async()=>{
        let result,error;try{result=await api(`invoices/${source.id}/credit-note/emit`,'POST',{confirm:'EMITIR_NOTA_CREDITO',revision:source.revision,date:form.elements.date.value});}catch(e){error=e;}
        modal.close();historyQuery='';historyStatus='';historyOrigin='';listPage=1;tab='history';
        root.innerHTML=header()+historyShell();
        try{await loadHistory();}catch(listError){if(error)throw error;throw listError;}
        if(error)throw error;
        toast(result.status==='authorized'?'Nota de crédito autorizada. Ya aparece en tus comprobantes.':`La nota de crédito está ${states[result.status]?.toLowerCase()||result.status}. Abrila para revisar su estado.`,result.status!=='authorized');
      });
    };
  }
  let mlFilters={from:'',to:'',shipment:'',state:'',number:''};
  let mlPage=1,mlPoll,mlRequest=0,mlHydrating=0,mlSelected=new Set(),mlProcessing=false,mlNextProcess=0;
  const mlStates={discovered:'Pendiente de consulta',waiting:'Esperando despacho',ready:'Lista para facturar',queued:'En cola',review:'Pendiente de emisión',pending:'Pendiente de ARCA',authorized:'Autorizada · enviando PDF',uploaded:'Adjunta en Mercado Libre',cancelled:'Cancelada',return_pending:'Devolución en curso',return_partial:'Devolución parcial',credit_pending:'Nota de crédito en proceso',credit_ready:'Nota de crédito pendiente',credit_review:'Nota de crédito: atención',credited:'Nota de crédito autorizada'};
  const mlShipping={pending:'Pendiente de preparación',handling:'En preparación',ready_to_ship:'Listo para despachar',shipped:'En camino',delivered:'Entregado',not_delivered:'No entregado',cancelled:'Envío cancelado',returned:'Devuelto',not_assigned:'Sin envío asignado',multiple:'Varios envíos · revisar'};
  const mlSubstatus={dropped_off:'Entregado en punto de despacho',authorized_by_carrier:'Recibido por el transportista',ready_for_dropoff:'Pendiente de entregar en punto de despacho',ready_to_print:'Etiqueta por imprimir',printed:'Etiqueta impresa',invoice_pending:'Factura pendiente',waiting_for_carrier_authorization:'Esperando transportista',manufacturing:'En preparación',in_hub:'En centro de distribución',out_for_delivery:'En reparto',receiver_absent:'Destinatario ausente',delayed:'Demorado',ready_for_pickup:'Listo para retirar',picked_up:'Retirado',shipped:'Despachado'};
  const mlOrderStates={paid:'Pagado',confirmed:'Confirmado',payment_required:'Pendiente de pago',payment_in_process:'Pago en proceso',partially_paid:'Pago parcial',cancelled:'Cancelado',partially_refunded:'Reembolso parcial',pending_cancel:'Cancelación en proceso',invalid:'Inválido'};
  function mlDate(value){const d=new Date(typeof value==='number'?value*1000:value);return !value||!Number.isFinite(d.getTime())?'Fecha pendiente':d.toLocaleString('es-AR',{timeZone:'America/Argentina/Cordoba',day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});}
  function mlCells(r){
    const s=r.summary||{},products=Array.isArray(s.products)?s.products:[],pack=s.pack_id||r.pack_id,shipping=s.shipment_display_status||s.shipment_status;
    const product=p=>`<strong class="fa-ml-product-name" title="${esc(p.title)}">${Number(p.quantity)>0?Number(p.quantity)+' × ':''}${esc(p.title||'Producto sin título')}</strong><small>${esc([p.sku?'SKU '+p.sku:'',p.variation].filter(Boolean).join(' · '))}</small>`;
    const invoice=Number(s.invoice_type)===1?'Factura A':Number(s.invoice_type)===6?'Factura B':'';
    return {
      order:`<strong class="fa-ml-order-number">${esc(r.ml_id)}</strong><small>${esc(mlDate(s.date_created))}</small>${pack?`<small title="Compra / pack de Mercado Libre">Pack ${esc(pack)}</small>`:''}`,
      products:products.length?product(products[0])+(products.length>1?`<details class="fa-ml-more"><summary>+ ${products.length-1} ${products.length===2?'producto':'productos'}</summary>${products.slice(1).map(product).join('')}</details>`:''):`<span class="fa-muted">${s.checked_at||s.error?'Productos no disponibles':'Consultando productos…'}</span>`,
      buyer:`<strong>${esc(s.buyer_name||s.buyer_nickname||'Comprador por consultar')}</strong>${s.customer_local?'<small>Datos fiscales completados en el facturador</small>':''}${s.document?`<small>${esc(s.document_type||'Documento')} ${esc(s.document)}</small>`:''}${s.buyer_nickname&&s.buyer_nickname!==s.buyer_name?`<small>${esc(s.buyer_nickname)}</small>`:''}`,
      shipment:`<span class="fa-ml-shipping ${esc(shipping||'unknown')}">${esc(mlShipping[shipping]||shipping||'Por consultar')}</span>${s.shipment_substatus?`<small>${esc(mlSubstatus[s.shipment_substatus]||s.shipment_substatus)}</small>`:''}${s.destination?`<small>${esc(s.destination)}</small>`:''}${s.tracking?`<small title="Seguimiento">${esc(s.tracking)}</small>`:''}${s.error?`<small class="fa-ml-data-error" title="${esc(s.error)}">${esc(s.error)}</small>`:''}`,
      invoice:`<strong class="${invoice?'':'fa-muted'}">${invoice||'Por confirmar'}</strong><small>${esc(s.vat_label||(invoice?'Según datos fiscales ML':'Faltan datos fiscales'))}</small>`,
      total:`<strong>${s.total!==null&&s.total!==undefined&&['ARS','USD'].includes(s.currency)?money(s.total,s.currency):'—'}</strong><small>${esc([s.currency,mlOrderStates[s.order_status]||s.order_status].filter(Boolean).join(' · '))}</small>`
    };
  }
  function mlInvoiceAction(r){
    if(['uploaded','cancelled','return_pending','return_partial','credit_pending','credit_ready','credit_review','credited'].includes(r.state))return '';
    if(r.state==='queued')return '<button class="fa-btn small" disabled>Procesando…</button>';
    if(r.state==='authorized')return `<span class="fa-muted">${config.environment==='production'?'Envío automático':'Sin envío en homologación'}</span>`;
    if(r.state==='pending')return Number(r.invoice_id)>0?`<button class="fa-btn small" data-open="${Number(r.invoice_id)}">Consultar ARCA</button>`:'<button class="fa-btn small" disabled>Pendiente de ARCA</button>';
    return `<button class="fa-btn primary small" data-ml-review="${Number(r.id)}" title="Iniciar facturación y envío con los datos de Mercado Libre">${Number(r.invoice_id)>0?'Continuar proceso':'Facturar y enviar'}</button>`;
  }
  function mlImportForm(s){
    const h=s.history||{},running=h.state==='running',lastMonth=new Date(today()+'T12:00:00');lastMonth.setDate(1);lastMonth.setMonth(lastMonth.getMonth()-1);
    const initial=lastMonth.getFullYear()+'-'+String(lastMonth.getMonth()+1).padStart(2,'0')+'-01';
    const labels={running:'Importación en curso',completed:'Importación terminada',error:'Importación detenida',cancelled:'Importación detenida'};
    return `<form id="fa-ml-import" class="fa-ml-import" aria-label="Traer ventas anteriores"><strong>Traer ventas anteriores</strong><label class="fa-field"><span>Desde</span><input type="date" name="since" required max="${today()}" value="${esc(h.since||initial)}" ${running?'disabled':''}></label><label class="fa-field"><span>Hasta</span><input type="date" name="until" required max="${today()}" value="${esc(h.until||today())}" ${running?'disabled':''}></label><div class="fa-row-actions"><button type="submit" class="fa-btn primary" ${!s.enabled||running?'disabled':''}>Traer ventas</button>${running?'<button type="button" class="fa-btn secondary" data-action="ml-import-cancel">Detener</button>':''}${['error','cancelled'].includes(h.state)?'<button type="button" class="fa-btn secondary" data-action="ml-import-resume">Continuar importación</button>':''}</div><small>La carga continúa en segundo plano aunque cierres esta pantalla. Conserva los comprobantes existentes. La facturación automática mantiene su fecha inicial: ${esc(s.since||'sin configurar')}. Si está activa, facturará las ventas que cumplan esa regla.</small>${h.state?`<div class="fa-inline-notice ${h.error?'bad':'good'}" role="status"><strong>${esc(labels[h.state]||h.state)}</strong> · ${Number(h.added)||0} ventas nuevas · ${Number(h.consulted)||0} consultas${h.through?' · avance: '+esc(h.through):''}.${h.error?' '+esc(h.error):''}</div>`:''}</form>`;
  }
  function mlFilterForm(){return `<form id="fa-ml-filters" class="fa-ml-filters" aria-label="Filtrar ventas de Mercado Libre"><label class="fa-field fa-ml-number"><span>Número de venta o pack</span><input name="number" type="text" inputmode="numeric" maxlength="21" placeholder="Ej.: 2000018602537252" value="${esc(mlFilters.number)}"><small>Busca entre las ventas del historial copiado.</small></label><label class="fa-field"><span>Fecha de venta · desde</span><input type="date" name="from" value="${esc(mlFilters.from)}"></label><label class="fa-field"><span>Hasta</span><input type="date" name="to" value="${esc(mlFilters.to)}"></label><label class="fa-field"><span>Preparación / envío</span><span class="fa-select-wrap"><select name="shipment">${options([['','Todos los envíos'],...Object.entries(mlShipping)],mlFilters.shipment)}</select>${dropdownArrow}</span></label><label class="fa-field"><span>Facturación</span><span class="fa-select-wrap"><select name="state">${options([['','Todos los estados'],...Object.entries(mlStates)],mlFilters.state)}</select>${dropdownArrow}</span></label><div class="fa-row-actions"><button type="submit" class="fa-btn primary">Buscar / filtrar</button><button type="button" data-action="ml-clear-filters" class="fa-btn secondary">Limpiar</button></div><small>Fecha de la venta en horario de Argentina. Los filtros consultan únicamente el historial conservado en el VPS.</small></form>`;}
  function mlSelectionBar(top=false){return `<div class="fa-bulk-selection fa-ml-selection"><label class="fa-check"><input type="checkbox" data-ml-select-page aria-label="Seleccionar ventas disponibles en esta página"> Seleccionar página</label><strong ${top?'id="fa-ml-selected"':''} data-ml-selected>${mlSelected.size} seleccionados</strong><button class="fa-btn primary" data-action="ml-batch" ${mlSelected.size?'':'disabled'}>${icon('invoice')} Facturar y enviar seleccionadas</button></div>`;}
  function mlSelection(){
    root.querySelectorAll('[data-ml-selected]').forEach(el=>el.textContent=`${mlSelected.size} seleccionados`);
    root.querySelectorAll('[data-action="ml-batch"]').forEach(button=>{button.disabled=busy||!mlSelected.size;if('wasDisabled' in button.dataset)button.dataset.wasDisabled=mlSelected.size?'0':'1';});
    const available=Array.from(root.querySelectorAll('[data-ml-select]:not(:disabled)')),selected=available.filter(el=>el.checked).length;
    root.querySelectorAll('[data-ml-select-page]').forEach(el=>{el.checked=available.length>0&&available.length===selected;el.indeterminate=selected>0&&selected<available.length;el.disabled=!available.length;});
  }
  function mlRow(r){return `<tr class="fa-ml-row" data-ml-row="${Number(r.id)}"><td class="fa-ml-select"><input type="checkbox" data-ml-select="${Number(r.id)}" ${mlSelected.has(Number(r.id))?'checked':''} ${['uploaded','pending','queued','authorized','cancelled','return_pending','return_partial','credit_pending','credit_ready','credit_review','credited'].includes(r.state)?'disabled':''} aria-label="Seleccionar venta ${esc(r.ml_id)}"></td>${Object.entries(mlCells(r)).map(([key,html])=>`<td data-label="${esc(({order:'Venta / fecha',products:'Productos',buyer:'Comprador',shipment:'Envío',invoice:'Factura',total:'Total / pago'})[key])}" class="fa-ml-${key}" data-ml-cell="${key}">${html}</td>`).join('')}<td class="fa-ml-fiscal" data-label="Facturación"><span class="fa-state ${esc(r.state)}">${esc(r.state==='authorized'&&config.environment!=='production'?'Prueba autorizada':mlStates[r.state]||r.state)}</span><small class="fa-ml-message" title="${esc(r.message||'')}">${esc(r.message||'Lista para consultar y facturar')}</small>${r.order_id?`<small>Woo #${Number(r.order_id)}</small>`:''}</td><td class="fa-ml-actions" data-label="Acciones"><div class="fa-row-actions"><button class="fa-btn secondary small" data-ml-customer="${Number(r.id)}">Datos del cliente</button>${!['uploaded','cancelled','return_pending','return_partial','credit_pending','credit_ready','credit_review','credited'].includes(r.state)?`${mlInvoiceAction(r)}<button class="fa-btn secondary small" data-ml-prepare="${Number(r.id)}" title="Productos y series" aria-label="Productos y series de la venta ${esc(r.ml_id)}">${icon('box')}</button>`:''}${Number(r.invoice_id)>0&&r.state!=='pending'?`<button class="fa-btn small" data-open="${Number(r.invoice_id)}" title="Ver comprobante" aria-label="Ver comprobante de la venta ${esc(r.ml_id)}">${icon('invoice')}</button>`:''}${Number(r.summary?.credit_note_id)>0?`<button class="fa-btn small" data-open="${Number(r.summary.credit_note_id)}">Ver nota de crédito</button>`:''}${r.order_url?`<a class="fa-btn small" href="${esc(r.order_url)}" target="_blank" rel="noopener" title="Pedido Woo y números de serie" aria-label="Abrir pedido Woo ${Number(r.order_id)}">${icon('arrow')}</a>`:''}</div><small data-ml-checked>${r.summary?.checked_at?'Datos: '+esc(mlDate(r.summary.checked_at)):''}</small></td></tr>`;}
  async function hydrateMl(rows,request,refresh=false){
    const pending=rows.filter(r=>refresh||r.summary?.refresh_needed),progress=root.querySelector('#fa-ml-progress');if(!pending.length)return;
    mlHydrating=request;
    try{
      for(let i=0;i<pending.length;i+=3){
        if(request!==mlRequest||tab!=='ml'||!config.bulk_unlocked||document.hidden||busy)return;
        if(progress)progress.textContent=`Completando comprador y envío… ${i} de ${pending.length}`;
        const data=await api('ml/summary','POST',{ids:pending.slice(i,i+3).map(r=>Number(r.id)),refresh});
        if(request!==mlRequest||tab!=='ml')return;
        for(const result of data.rows||[]){
          const r=rows.find(x=>Number(x.id)===Number(result.id)),tr=root.querySelector(`[data-ml-row="${Number(result.id)}"]`);if(!r||!tr)continue;
          r.summary=result.summary;for(const [key,html] of Object.entries(mlCells(r)))tr.querySelector(`[data-ml-cell="${key}"]`).innerHTML=html;
          tr.querySelector('[data-ml-checked]').textContent=result.summary.checked_at?'Datos: '+mlDate(result.summary.checked_at):'';
        }
      }
      if(progress)progress.textContent='Datos consultados en Mercado Libre · actualización de detalles cada 5 minutos.';
    }catch(e){if(progress&&request===mlRequest)progress.textContent='No se completaron todos los detalles: '+e.message+' Podés volver a intentar con Actualizar.';}
    finally{if(mlHydrating===request)mlHydrating=0;}
  }
  function mlShell(){return `<div class="fa-title-row"><div><h1>Mercado Libre</h1><p>Historial del Facturador conservado en el VPS.</p></div></div><div class="fa-help"><strong>Conexión pendiente de traslado</strong><p>Las ventas de esta pantalla son la copia del historial. La autorización de Mercado Libre todavía sigue en la tienda: aquí no se buscan ventas nuevas, actualizan envíos ni emiten comprobantes.</p></div><div id="fa-ml-panel" aria-live="polite">Cargando historial…</div>`;}
  async function loadMl(){
    clearTimeout(mlPoll);const el=root.querySelector('#fa-ml-panel');if(!el)return;const request=++mlRequest;
    const data=await api('ml/activity?'+new URLSearchParams({page:mlPage,...mlFilters}));
    if(!el.isConnected||request!==mlRequest)return;
    if(!Array.isArray(data.rows))throw Error('No se pudo leer el historial de Mercado Libre.');
    el.innerHTML=`<section class="fa-card fa-ml-sales"><div class="fa-section-head"><h2>Ventas conservadas · ${Number(data.archive_count)||0}</h2><button class="fa-btn secondary" data-action="ml-refresh">Releer historial local</button></div>${mlFilterForm()}<div class="fm-ml-records">${data.rows.map(r=>{
      const cells=mlCells(r);
      return `<article class="fm-ml-record"><header>${cells.order}<span class="fa-state">${esc(mlStates[r.state]||r.state)}</span></header><div class="fm-ml-grid"><div>${cells.products}</div><div>${cells.total}</div><div><small>Envío registrado</small>${cells.shipment}</div><div><small>Comprador</small>${cells.buyer}</div></div>${Number(r.invoice_id)>0?`<button class="fa-btn secondary small" data-open="${Number(r.invoice_id)}">Ver comprobante</button>`:''}<small class="fm-ml-archive-date">Registro copiado · ${esc(r.updated_at||'sin fecha')}</small></article>`;
    }).join('')||'<p class="fa-empty">No hay ventas en la copia con estos filtros.</p>'}</div><div class="fa-pagination">${mlPage>1?'<button class="fa-btn small" data-action="ml-prev">Anterior</button>':''}<span>Página ${mlPage}</span>${data.has_more?'<button class="fa-btn small" data-action="ml-next">Siguiente</button>':''}</div></section>`;
  }

  async function customerMl(order_id){
    const data=await api('ml/customer','POST',{order_id}),modal=document.createElement('dialog');modal.className='fa-credit-dialog fa-bulk-dialog fa-ml-customer-dialog';
    const labels={name:'Nombre o razón social',document_type:'Tipo de documento',document:'DNI / CUIT / CUIL',vat_condition:'Condición de IVA',street_name:'Calle',street_number:'Número o S/N',city_name:'Localidad',state_name:'Provincia',zip_code:'Código postal',country_id:'País',comment:'Piso / departamento (opcional)'};
    const options={document_type:[['','Seleccioná'],['96','DNI'],['80','CUIT'],['86','CUIL']],vat_condition:[['','Seleccioná'],['1','IVA Responsable Inscripto'],['6','Responsable Monotributo'],['5','Consumidor Final'],['4','IVA Exento']],country_id:[['','Seleccioná'],['AR','Argentina']]};
    const field=(r,key)=>`<label class="fa-field ${!r.fields[key]&&key!=='comment'?'fa-field-missing':''}"><span>${esc(labels[key])}</span>${options[key]?`<span class="fa-select-wrap"><select data-ml-billing="${key}" required>${options[key].map(([v,t])=>`<option value="${v}" ${String(r.fields[key]||'')===v?'selected':''}>${esc(t)}</option>`).join('')}</select>${dropdownArrow}</span>`:`<input data-ml-billing="${key}" value="${esc(r.fields[key]||'')}" maxlength="200" ${key==='document'?'inputmode="numeric"':''} ${key==='comment'?'':'required'}>`}</label>`;
    modal.innerHTML=`<form id="fa-ml-customer-form"><h2>Datos fiscales del cliente</h2><p>Completá los datos reales del comprador. La corrección se guarda para esta compra en el facturador; no cambia el perfil de Mercado Libre. Guardar no emite la factura.</p><div class="fa-notice bad" data-ml-customer-error role="alert" tabindex="-1" hidden></div><div class="fa-bulk-review">${data.rows.map(r=>`<article data-ml-customer-sale="${Number(r.id)}"><h3>Orden ML ${esc(r.ml_id)}</h3>${r.locked?'<p class="fa-notice">Comprobante enviado a ARCA: datos bloqueados. Consultá la factura emitida desde el listado.</p>':r.stale?'<p class="fa-notice bad">Mercado Libre cambió los datos. Se muestran los datos actuales: revisalos y guardá la corrección nuevamente.</p>':r.missing.length?`<p class="fa-notice bad" data-ml-missing>Falta completar: ${r.missing.map(esc).join(', ')}.</p>`:'<p class="fa-help">Datos completos. Podés corregirlos antes de facturar.</p>'}<fieldset ${r.locked?'disabled':''}><legend class="fa-sr-only">Datos de facturación</legend><div class="fa-fields two">${Object.keys(labels).map(key=>field(r,key)).join('')}</div></fieldset></article>`).join('')}</div><div class="fa-row-actions"><button type="button" class="fa-btn secondary" data-ml-customer-cancel>Volver</button>${data.rows.some(r=>!r.locked)?'<button type="submit" class="fa-btn primary">Guardar datos del cliente</button>':''}</div></form>`;
    root.appendChild(modal);modal.showModal();modal.querySelector('[data-ml-customer-cancel]').onclick=()=>modal.close();modal.addEventListener('close',()=>modal.remove());modal.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    modal.addEventListener('input',e=>{const sale=e.target.closest('[data-ml-customer-sale]'),notice=sale?.querySelector('[data-ml-missing]');if(!notice)return;const missing=[...sale.querySelectorAll('[data-ml-billing][required]')].filter(el=>!el.value.trim()).map(el=>labels[el.dataset.mlBilling]);notice.hidden=!missing.length;notice.textContent=missing.length?'Falta completar: '+missing.join(', ')+'.':'';});
    modal.querySelector('form').onsubmit=e=>{e.preventDefault();run(async()=>{
      const error=modal.querySelector('[data-ml-customer-error]');error.hidden=true;
      try{const sales={};for(const row of data.rows){if(row.locked)continue;const fields={};modal.querySelector(`[data-ml-customer-sale="${row.id}"]`).querySelectorAll('[data-ml-billing]').forEach(el=>fields[el.dataset.mlBilling]=el.value.trim());sales[row.id]={fingerprint:row.fingerprint,fields};}
        await api('ml/customer','POST',{order_id,sales});modal.close();await loadMl();toast('Datos fiscales guardados. Pulsá Facturar y enviar para emitir el comprobante.',false,{tab:'ml',selector:`[data-ml-row="${order_id}"] .fa-ml-fiscal`});
      }catch(e){error.textContent=e.message;error.hidden=false;reportError(e,{tab:'ml',element:modal.querySelector('form')});}
    });};
  }
  async function prepareMl(order_id){
    const data=await api('ml/prepare','POST',{order_id}),modal=document.createElement('dialog');modal.className='fa-credit-dialog fa-bulk-dialog';
    modal.innerHTML=`<form id="fa-ml-products-form"><h2>Productos y números de cuadro</h2><p>Vinculá cada publicación con su producto del catálogo. Se conserva el importe vendido en Mercado Libre.</p><div class="fa-bulk-review">${data.rows.map(r=>`<article data-ml-sale="${r.id}"><h3>Orden ${esc(r.ml_id)}</h3><p>${esc(r.customer.name)} · ${esc(r.customer.document)}</p>${r.order_id?`<p>Series del <a href="${esc(r.order_url)}" target="_blank" rel="noopener">pedido Woo #${Number(r.order_id)}</a>. Podés editarlas aquí para esta factura.</p>`:'<p>Ingresá aquí una serie por bicicleta.</p>'}<p>Si dejás una serie vacía, el comprobante mostrará ________________________________ para completarla a mano.</p>${r.locked?'<p><strong>Comprobante enviado a ARCA: datos bloqueados.</strong></p>':''}${r.lines.map((l,n)=>`<fieldset data-ml-line="${esc(l.key)}" ${r.locked?'disabled':''}><legend>${Number(l.quantity)} × ${esc(l.name)} · ${money(l.total,r.currency)}</legend><input type="hidden" data-ml-pid value="${Number(l.product_id)||''}"><p data-ml-product>${l.product_id?'Vinculado al catálogo · '+esc(l.sku||l.name):'Falta vincular un producto'}</p><label class="fa-field"><span>Buscar en catálogo por nombre, SKU o código de barras</span><input type="search" data-ml-search placeholder="Escribí o escaneá el producto" autocomplete="off"></label><div data-ml-results aria-live="polite"></div>${l.requires_serial?Array.from({length:Math.min(Number(l.quantity),1000)},(_,i)=>`<label class="fa-field"><span>Número de cuadro · unidad ${i+1}</span><input data-ml-serial maxlength="120" value="${esc(l.serials?.[i]||'')}" placeholder="Opcional · completar a mano"></label>`).join(''):'<p>Este producto no requiere número de cuadro.</p>'}</fieldset>`).join('')}</article>`).join('')}</div><div class="fa-row-actions"><button type="button" class="fa-btn secondary" data-ml-cancel>Volver</button><button type="submit" class="fa-btn primary">Guardar productos y series</button></div></form>`;
    root.appendChild(modal);modal.showModal();let timer,seq=0;
    modal.querySelector('[data-ml-cancel]').onclick=()=>modal.close();modal.addEventListener('close',()=>{clearTimeout(timer);modal.remove();});modal.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    modal.addEventListener('input',e=>{if(!e.target.matches('[data-ml-search]'))return;const field=e.target.closest('fieldset'),q=e.target.value.trim(),request=++seq;clearTimeout(timer);if(q.length<2){field.querySelector('[data-ml-results]').textContent='Escribí al menos 2 caracteres.';return;}timer=setTimeout(()=>search(field,q,1,request),300);});
    async function search(field,q,page,request){const box=field.querySelector('[data-ml-results]');box.textContent='Buscando…';try{const result=await api('products?q='+encodeURIComponent(q)+'&stock=all&page='+page);if(!modal.isConnected||request!==seq)return;box.replaceChildren();for(const p of result.rows){const button=document.createElement('button');button.type='button';button.className='fa-btn secondary small';button.textContent=p.name+' · '+p.sku;button.onclick=()=>{field.querySelector('[data-ml-pid]').value=p.id;field.querySelector('[data-ml-product]').textContent='Vinculado: '+p.name+' · '+p.sku;box.replaceChildren();if(p.requires_serial&&!field.querySelector('[data-ml-serial]')){const sale=data.rows.find(r=>r.id===Number(field.closest('[data-ml-sale]').dataset.mlSale)),line=sale.lines.find(l=>l.key===field.dataset.mlLine);for(let i=0;i<Math.min(line.quantity,1000);i++){const label=document.createElement('label');label.className='fa-field';label.textContent='Número de cuadro · unidad '+(i+1);const input=document.createElement('input');input.dataset.mlSerial='';input.maxLength=120;input.placeholder='Opcional · completar a mano';label.appendChild(input);field.appendChild(label);}}};box.appendChild(button);}if(!result.rows.length)box.textContent='No se encontraron productos.';if(result.has_more){const more=document.createElement('button');more.type='button';more.className='fa-btn secondary';more.textContent='Ver más resultados';more.onclick=()=>search(field,q,page+1,++seq);box.appendChild(more);}}catch(e){if(request===seq)box.textContent=e.message;}}
    modal.querySelector('form').onsubmit=e=>{e.preventDefault();run(async()=>{const sales={};for(const sale of data.rows){if(sale.locked)continue;const lines={};for(const field of modal.querySelector(`[data-ml-sale="${sale.id}"]`).querySelectorAll('[data-ml-line]'))lines[field.dataset.mlLine]={product_id:Number(field.querySelector('[data-ml-pid]').value),serials:[...field.querySelectorAll('[data-ml-serial]')].map(x=>x.value.trim())};sales[sale.id]={fingerprint:sale.fingerprint,lines};}await api('ml/prepare','POST',{order_id,sales});modal.close();await loadMl();toast('Productos y series guardados. Pulsá Facturar y enviar para continuar.',false,{tab:'ml',selector:`[data-ml-row="${order_id}"] .fa-ml-fiscal`});});};
  }
  function scheduleMl(){clearTimeout(mlPoll);mlPoll=setTimeout(()=>{if(tab!=='ml')return;if(document.hidden||busy||mlHydrating||root.querySelector('dialog[open]')||root.querySelector('.fa-ml-setup[open]')||root.querySelector('#fa-ml-filters')?.contains(document.activeElement)||root.querySelector('#fa-ml-import')?.contains(document.activeElement)||root.querySelector('.fa-ml-more[open]')){scheduleMl();return;}loadMl().catch(e=>{toast(e.message,true);scheduleMl();});},15000);}
  function mlSaleLabel(id){const row=root.querySelector(`[data-ml-row="${Number(id)}"] .fa-ml-order-number`);return row?.textContent?'Orden ML '+row.textContent:'Venta seleccionada';}
  function resumeMl(rows,settings){
    if(!settings.enabled||config.environment!=='production'||mlProcessing||Date.now()<mlNextProcess)return;
    const next=rows.find(r=>['queued','authorized'].includes(r.state));if(!next)return;
    setTimeout(async()=>{
      if(tab!=='ml'||!config.bulk_unlocked||document.hidden||busy||mlProcessing)return;
      mlProcessing=true;mlNextProcess=Date.now()+30000;
      try{await api('ml/process','POST',{order_id:Number(next.id)});if(tab==='ml'&&!busy)await loadMl();}
      catch(e){toast('El proceso continúa en segundo plano. '+e.message,true);}
      finally{mlProcessing=false;}
    },100);
  }
  async function reviewMl(order_id){return reviewMlBatch([order_id]);}
  async function reviewMlBatch(ids){
    if(!ids.length||ids.length>30)throw Error('Seleccioná entre 1 y 30 ventas.');
    const seen=new Set(),failures=[],rowFeedback=new Map();let queued=0;
    for(const [index,order_id] of ids.entries()){
      if(seen.has(Number(order_id)))continue;
      const sale=mlSaleLabel(order_id);toast(`Facturando y enviando compra ${index+1} de ${ids.length}…`);
      try{
        // Validate fiscal source and bind it to a server-signed approval, with no extra dialog.
        const data=await api('ml/review','POST',{order_id});
        data.rows.forEach(p=>seen.add(Number(p.ml.job_id)));
        const result=await api('ml/queue','POST',{order_id,expires:data.expires,token:data.token,confirm:'FACTURAR_ML'});
        queued+=result.queued;data.rows.forEach(p=>mlSelected.delete(Number(p.ml.job_id)));
        // The durable queue remains available if the browser closes or this request times out.
        for(const job of result.jobs||[order_id]){
          try{const progress=await api('ml/process','POST',{order_id:Number(job)});
            if(['review','pending','rejected'].includes(progress.state)){failures.push(`${sale}: ${progress.message}`);rowFeedback.set(Number(job),progress.message);}
          }catch(e){const message=`Solicitud confirmada; pendiente de comprobar el resultado. ${e.message}`;failures.push(`${sale}: ${message}`);rowFeedback.set(Number(job),message);break;}
        }
      }catch(error){failures.push(`${sale}: ${error.message}`);rowFeedback.set(Number(order_id),error.message);}
    }
    await loadMl();
    toast(`${queued} ventas iniciadas.${failures.length?' Atención: '+failures.join(' · '):' La factura y el PDF se completan automáticamente; podés ver el estado en el listado.'}`,failures.length>0);
    for(const [id,message] of rowFeedback)inlineFeedback(root.querySelector(`[data-ml-row="${id}"] .fa-ml-fiscal`),message,true);
  }

  let bulkPage=1,bulkStatus='',bulkOrder='',bulkSelected=new Set(),bulkRequest=0,bulkPoll;
  const bulkLabels={queued:'En cola',processing:'Emisión iniciada',review:'Pendiente de emisión',authorized:'Autorizada',pending:'Pendiente de ARCA',rejected:'Rechazada',draft:'Borrador'};
  function bulkAccess(){return `<div class="fa-title-row"><div><h1>Facturación masiva</h1><p>Acceso reservado a ${esc((config.bulk_users||['Matias','Fabri','Jose']).join(' y '))}.</p></div></div>${config.can_bulk?`<form id="fa-bulk-unlock" class="fa-card fa-bulk-access"><h2>Confirmá tu acceso</h2><p>Usá tu propia cuenta y contraseña de WordPress. El acceso dura 15 minutos en esta sesión.</p><label class="fa-field"><span>Usuario</span><input name="username" autocomplete="username" value="${esc(config.bulk_login||'Matias')}" required></label><label class="fa-field"><span>Contraseña de WordPress</span><input name="password" type="password" autocomplete="current-password" required></label><button type="submit" class="fa-btn primary">Acceder a facturación masiva</button></form>`:'<section class="fa-card"><p>Tu cuenta no tiene permiso para administrar lotes. Ingresá a WordPress con la cuenta autorizada.</p></section>'}`;}
  function bulkShell(){if(!config.can_bulk||!config.bulk_unlocked)return bulkAccess();return `<div class="fa-title-row"><div><h1>Facturación masiva</h1><p>Elegí pedidos, revisá los datos y confirmá la emisión del lote.</p></div><button class="fa-btn secondary" data-action="bulk-lock">Cerrar acceso masivo</button></div><div class="fa-banner">${config.environment==='homologation'?'Modo de prueba · sin validez fiscal.':'Producción · se solicitará CAE para cada pedido confirmado.'} Punto de venta ${Number(config.point)}. Se utiliza la cola de WooCommerce.</div><section class="fa-card"><h2>1. Seleccioná los pedidos</h2><p>Hasta 30 por lote. Las ventas de Mercado Libre se gestionan desde su pestaña, con sus datos fiscales e importes de venta.</p>${choices('Estado del pedido','bulk-status',bulkStatus,[['','Todos'],...Object.entries(config.order_statuses||{})],'data-bulk-status')}<div class="fa-actions"><label class="fa-field"><span>Número de pedido</span><input id="fa-bulk-order" type="number" min="1" value="${esc(bulkOrder)}" placeholder="Todos"></label><button class="fa-btn secondary" data-action="bulk-search">Buscar pedidos</button></div><div id="fa-bulk-orders" aria-live="polite">Cargando pedidos…</div><div class="fa-bulk-selection"><strong id="fa-bulk-count">${bulkSelected.size} seleccionados</strong><button class="fa-btn primary" data-action="bulk-review" ${bulkSelected.size?'':'disabled'}>Revisar lote seleccionado</button></div></section><section class="fa-card"><div class="fa-section-head"><h2>Actividad de facturación masiva</h2><button class="fa-btn secondary" data-action="bulk-refresh">${icon('refresh')} Actualizar</button></div><p>Si una solicitud queda pendiente, abrí el comprobante y consultá su estado antes de reintentar.</p><div id="fa-bulk-activity" aria-live="polite">Cargando actividad…</div></section>`;}
  function bulkSelection(){const count=root.querySelector('#fa-bulk-count'),button=root.querySelector('[data-action="bulk-review"]');if(count)count.textContent=`${bulkSelected.size} seleccionados`;if(button){button.disabled=busy||!bulkSelected.size;if('wasDisabled' in button.dataset)button.dataset.wasDisabled=bulkSelected.size?'0':'1';}}
  async function loadBulk(){const el=root.querySelector('#fa-bulk-orders'),seq=++bulkRequest;if(!el)return;el.textContent='Cargando pedidos…';try{const data=await api(`bulk/orders?page=${bulkPage}&status=${encodeURIComponent(bulkStatus)}&order_id=${encodeURIComponent(bulkOrder)}`);if(!el.isConnected||seq!==bulkRequest)return;if(!Array.isArray(data.rows))throw new Error('No se recibió un listado válido.');
    for(const row of data.rows)if(!row.selectable)bulkSelected.delete(Number(row.order_id));
    el.innerHTML=data.rows.length?`<div class="fa-bulk-rows">${data.rows.map(r=>`<article class="fa-bulk-row"><label class="fa-bulk-pick"><input type="checkbox" data-bulk-order="${Number(r.order_id)}" ${bulkSelected.has(Number(r.order_id))?'checked':''} ${r.selectable?'':'disabled'} aria-label="Seleccionar pedido ${Number(r.order_id)}"><span><strong>Pedido #${Number(r.order_id)}</strong></span></label>${bulkCustomer(r)}<div class="fa-bulk-amount"><b>${money(r.total,r.currency)}</b><small>${esc(r.status)}</small></div><div class="fa-bulk-invoice"><span class="fa-state">${esc(r.invoice.label)}</span>${r.invoice.status==='excluded_ml'?'':`<button class="fa-btn text" data-auto-order="${Number(r.order_id)}">Abrir en facturador</button>`}</div></article>`).join('')}</div><div class="fa-pagination">${bulkPage>1?'<button class="fa-btn small" data-action="bulk-prev">Anterior</button>':''}<span>Página ${bulkPage}</span>${data.has_more?'<button class="fa-btn small" data-action="bulk-next">Siguiente</button>':''}</div>`:'<p>No se encontraron pedidos para estos filtros.</p>';
    bulkSelection();
    }catch(e){if(el.isConnected)el.textContent=e.message;throw e;}}
  function bulkResults(rows){return rows.length?rows.map(r=>`<div class="fa-auto-row"><b>Pedido #${Number(r.order_id)}</b><span class="fa-state ${esc(r.status)}">${esc(bulkLabels[r.status]||r.status)}</span><p>${esc(r.message||'')}</p>${r.invoice_id?`<button class="fa-btn small" data-open="${Number(r.invoice_id)}">Abrir comprobante</button>`:`<button class="fa-btn small" data-auto-order="${Number(r.order_id)}">Revisar pedido</button>`}</div>`).join(''):'<p>Todavía no hay emisiones en lote.</p>';}
  async function loadBulkActivity(){clearTimeout(bulkPoll);const el=root.querySelector('#fa-bulk-activity');if(!el)return;const data=await api('bulk/activity');if(!el.isConnected)return;if(!Array.isArray(data.rows))throw new Error('No se recibió una actividad válida.');el.innerHTML=bulkResults(data.rows);if(data.rows.some(r=>['queued','processing'].includes(r.status)))bulkPoll=setTimeout(()=>{if(tab==='bulk')loadBulkActivity().catch(e=>toast(e.message,true));},10000);}
  async function reviewBulk(){if(!bulkSelected.size)throw new Error('Seleccioná al menos un pedido.');const data=await api('bulk/review','POST',{order_ids:[...bulkSelected]});const ready=data.rows.filter(r=>r.ready),sums={};ready.forEach(r=>sums[r.currency]=(sums[r.currency]||0)+Number(r.total));
    const modal=document.createElement('dialog');modal.className='fa-credit-dialog fa-bulk-dialog';modal.innerHTML=`<form><h2>2. Revisá el lote</h2><p>${data.environment==='production'?'Producción · facturas reales con CAE.':'Homologación · comprobantes de prueba.'} Punto de venta ${Number(data.point)}.</p><div class="fa-bulk-review">${data.rows.map(r=>`<article><strong>Pedido #${Number(r.order_id)}</strong><span class="fa-state ${r.ready?'authorized':'review'}">${r.ready?'Listo':'Revisar'}</span><p>${r.ready?`${esc(r.customer)} · ${label(r)} · <b>${money(r.total,r.currency)}</b>`:esc(r.message)}</p>${r.series?.filter(Boolean).length?`<small>Series: ${r.series.filter(Boolean).map(esc).join(', ')}</small>`:''}</article>`).join('')}</div><p><strong>${ready.length} ${ready.length===1?'pedido listo':'pedidos listos'} para emitir</strong></p>${Object.entries(sums).map(([c,t])=>`<p>Total ${c}: <b>${money(t,c)}</b></p>`).join('')}<p>Los pedidos marcados para revisión quedan fuera de este lote. Los envíos al cliente se realizan desde cada comprobante.</p><div class="fa-row-actions"><button type="button" class="fa-btn secondary" data-bulk-cancel>Volver</button><button class="fa-btn primary" type="submit" ${ready.length?'':'disabled'}>Confirmar emisión de ${ready.length} ${ready.length===1?'factura':'facturas'}${data.environment==='production'?'':' de prueba'}</button></div></form>`;
    root.appendChild(modal);modal.showModal();modal.querySelector('[data-bulk-cancel]').onclick=()=>modal.close();modal.addEventListener('close',()=>modal.remove());modal.addEventListener('cancel',e=>{if(busy)e.preventDefault();});modal.querySelector('form').onsubmit=e=>{e.preventDefault();run(async()=>{let result;try{result=await api('bulk/emit','POST',{confirm:'EMITIR_LOTE',orders:ready.map(({order_id,expires,token})=>({order_id,expires,token}))});}catch(error){modal.close();await loadBulkActivity();throw error;}modal.close();ready.forEach(r=>bulkSelected.delete(r.order_id));bulkSelection();await loadBulk();await loadBulkActivity();toast(`${result.rows.filter(r=>r.status==='queued').length} pedidos agregados a la cola. Revisá el resultado de cada uno.`);const results=document.createElement('div');results.className='fa-bulk-submitted';results.innerHTML='<h3>Resultado de la confirmación</h3>'+bulkResults(result.rows);root.querySelector('#fa-bulk-activity').prepend(results);});};
  }
  root.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||busy)return;
    if(b.dataset.go){document.getElementById('fa-'+b.dataset.go)?.scrollIntoView({behavior:'smooth',block:'start'});return;}
    if(FusionArca.pos&&(b.dataset.tab||b.dataset.open||b.dataset.autoOrder||['new','load-order','credit-note'].includes(b.dataset.action)))return;
    if(b.dataset.tab){rememberSettings();tab=b.dataset.tab;if(tab==='history')listPage=1;render();return;}
    if(b.dataset.product!==undefined){addProduct(results[Number(b.dataset.product)]);return;}
    if(b.dataset.remove!==undefined){doc.payload.lines.splice(Number(b.dataset.remove),1);changed();render();return;}
    if(b.dataset.credit){run(()=>creditDialog(b.dataset.credit));return;}
    if(b.dataset.autoOrder){run(()=>loadOrder(Number(b.dataset.autoOrder)));return;}
    if(b.dataset.mlCustomer){run(()=>customerMl(Number(b.dataset.mlCustomer)));return;}
    if(b.dataset.mlPrepare){run(()=>prepareMl(Number(b.dataset.mlPrepare)));return;}
    if(b.dataset.mlReview){run(()=>reviewMl(Number(b.dataset.mlReview)));return;}
    if(b.dataset.open){run(async()=>{doc=await api('invoices/'+b.dataset.open);await ensureBilling();dirty=!!doc.order_series_refreshed;tab='new';render();});return;}
    const action=b.dataset.action;if(!action)return;
    run(async()=>{
      if(action==='new'){if(dirty&&!confirm('Hay cambios sin guardar. ¿Crear otra factura?'))return;await loadBilling('AR');doc=blank();dirty=false;tab='new';render();}
      if(action==='more-products'){await searchProducts(false,true);}
      if(action==='custom'){if(frozen())return;const name=prompt('Descripción del producto o servicio:');if(!name?.trim())return;doc.payload.lines.push({product_id:0,item_id:0,name:name.trim(),sku:'',quantity:1,total:0,vat:config.vat,requires_serial:false,serials:[]});changed();render();}
      if(action==='load-order'){if(dirty&&!confirm('¿Reemplazar el borrador visible con los datos del pedido?'))return;await loadOrder(Number(document.getElementById('fa-order').value));}
      if(action==='save'){await save();render();toast('Borrador guardado. Todavía no se emitió una factura.');}
      if(action==='structured-customer'){
        await loadBilling('AR');const c=doc.payload.customer;c.billing={...billingDefaults(),billing_first_name:c.name,billing_address_1:c.address,billing_email:c.email,billing_phone:c.phone||''};changed();render();
      }
      if(action==='credit-note'){
        if(doc.credit_note_id)doc=await api('invoices/'+doc.credit_note_id);
        else {if(!confirm('Crear una nota de crédito por el TOTAL de esta factura. Se guardará un borrador para revisar y autorizar. ¿Continuar?'))return;doc=await api(`invoices/${doc.id}/credit-note`,'POST',{});}
        await ensureBilling();dirty=false;render();
      }
      if(action==='email'){
        const input=document.getElementById('fa-recipient-email'),email=input.value.trim().toLowerCase();
        if(!email||!input.checkValidity())throw fieldFailure('Completá un correo válido para el destinatario.',{'recipient.email':'Completá un correo válido.'});
        const items=await refreshDelivery(),previous=items.find(item=>item.recipient===email);
        if(previous?.state==='sending')throw new Error(previous.message);
        if(!await confirmEmail(email,previous?.state==='unknown'))return;
        const request={email,idempotency_key:crypto.randomUUID(),...(previous?.state==='unknown'?{retry_after:previous.id}:{})};
        try{const res=await api(`invoices/${doc.id}/email`,'POST',request);await refreshDelivery();toast(res.message,res.state!=='accepted');}
        catch(error){try{await refreshDelivery();}catch{}throw new Error(error.message+' Consultá el estado antes de reenviar.');}
      }
      if(action==='email-status')await refreshDelivery();
      if(action==='wa-check'){
        config.whatsapp=await api('whatsapp/check','POST',{});render();toast(config.whatsapp.message,!config.whatsapp.ready);
      }
      if(action==='wa-status'){
        doc.whatsapp=await api(`invoices/${doc.id}/whatsapp`);render();
      }
      if(action==='wa-send'){
        const phone=root.querySelector('#fa-recipient-phone').value.trim();
        if(!phone)throw fieldFailure('Completá el teléfono del destinatario.',{'recipient.phone':'Completá el teléfono del destinatario.'});
        try{doc.whatsapp=await api(`invoices/${doc.id}/whatsapp`,'POST',{phone});render();toast(doc.whatsapp.label,['failed','paused','unknown'].includes(doc.whatsapp.state));}
        catch(err){try{doc.whatsapp=await api(`invoices/${doc.id}/whatsapp`);render();}catch(_){}throw err;}
      }
      if(action==='whatsapp'){
        const phone=document.getElementById('fa-recipient-phone').value.trim();
        const res=await api(`invoices/${doc.id}/share`,'POST',{phone});
        document.getElementById('fa-whatsapp-link').innerHTML=`<a class="fa-btn primary" href="${esc(res.whatsapp_url)}" target="_blank" rel="noopener noreferrer">Abrir WhatsApp y enviar</a><small>${esc(res.message)}</small>`;
      }
      if(action==='lookup-customer'){
        const c=doc.payload.customer;
        const identification=lookupIdentification();
        if(config.credentials_configured===false)throw new Error('La identificación está completa. Para consultar ARCA, configurá el certificado y la clave privada de Fusion Bikes y habilitá Padrón Alcance 13. Podés completar el cliente manualmente.');
        const data=await api('customer-lookup','POST',identification);
        if((c.name||c.address)&&!confirm('¿Reemplazar nombre y domicilio con los datos devueltos por ARCA?'))return;
        if(data.name)c.name=data.name;c.address=data.address||'';
        if(c.billing&&data.billing){
          c.billing={...c.billing,...data.billing};
          const normalize=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
          const state=billingSchema.fields.find(f=>f.key==='billing_state');const match=Object.entries(state?.options||{}).find(([id,name])=>normalize(name)===normalize(data.province_name));
          if(match)c.billing.billing_state=match[0];else c.billing.billing_state='';syncBilling();
        }
        changed();render();toast(data.message||'Datos consultados. Revisá la condición de IVA del cliente.');
      }
      if(action==='emit'){
        const missing=clientMissing();if(missing.length){
          const fields={};for(const item of missing){const input=root.querySelector(item.selector),key=input?.dataset.billing?'billing.'+input.dataset.billing:input?.dataset.field;if(key)fields[key]='Completá '+item.caption+'.';}
          throw fieldFailure('Completá los campos marcados para emitir.',fields);
        }
        lookupIdentification();
        const t=totals(),s=serialCount(),seriesErrors={},seenSeries=new Set();
        doc.payload.lines.forEach((line,i)=>{if(!line.requires_serial)return;for(let n=0;n<Number(line.quantity);n++){const value=(line.serials?.[n]||'').trim().toUpperCase(),key=`lines.${i}.serials.${n}`;if(!value||/^[_\s]*$/.test(value))continue;else if(seenSeries.has(value))seriesErrors[key]='Este número de serie está repetido.';else seenSeries.add(value);}});
        if(Object.keys(seriesErrors).length)throw fieldFailure('Revisá las series de las bicicletas.',seriesErrors);
        if(internal()){
          await save();render();
          try{doc=await api(`invoices/${doc.id}/internal`,'POST',{confirm:'GENERAR_INTERNO',revision:doc.revision});render();toast('Comprobante '+doc.payload.internal_number+' generado. Podés imprimirlo o guardar el PDF.');}
          catch(err){try{doc=await api('invoices/'+doc.id);render();}catch(_){}throw err;}
          return;
        }
        if(credit()&&!confirm(`Emitir nota de crédito total por ${money(t.gross,doc.payload.currency)} para ${doc.payload.customer.name}. ¿Confirmás?`))return;
        await save();render();
        try{doc=await api(`invoices/${doc.id}/emit`,'POST',{confirm:'EMITIR',revision:doc.revision});render();toast(doc.status==='authorized'?'Comprobante autorizado.':doc.error||'Revisá el estado del comprobante.',doc.status!=='authorized');}
        catch(err){try{doc=await api('invoices/'+doc.id);render();}catch(_){}throw err;}
      }
      if(action==='recover'||action==='retry'){
        if(action==='retry'&&!confirm('Primero se consultará ARCA. Solo si el número no existe, se reenviará la misma solicitud, con los mismos importes y número. ¿Continuar?'))return;
        doc=await api(`invoices/${doc.id}/recover`,'POST',action==='retry'?{retry:'REENVIAR'}:{});render();toast(doc.status==='authorized'?'Autorización recuperada.':doc.error||'Estado actualizado.',doc.status!=='authorized');
      }
      if(action==='print'){if(dirty)throw new Error('Guardá los cambios antes de imprimir.');window.open(doc.print_url,'_blank','noopener');}
      if(action==='connection'||action==='connection-padron'){
        const service=action==='connection-padron'?'padron':'wsfe';
        try{
          const res=await api('connection','POST',{service});
          let message=res.message+' Certificado vigente hasta '+res.expires+'.';
          if(service==='padron')message+=' Emisor consultado: '+res.name+'.';
          else if(!res.homologation_query_ok)message+=res.point_ready?' El punto de venta configurado está disponible para CAE.':' Conexión correcta, pero falta elegir y guardar un punto de venta disponible para CAE.';
          connectionResults[service]={...res,ok:true,message,environment:config.environment,cuit:config.cuit};
        }catch(e){connectionResults[service]={ok:false,message:e.message,environment:config.environment,cuit:config.cuit};throw e;}
        finally{document.getElementById('fa-connection-results').innerHTML=connectionFeedback();}
      }
      if(action==='ml-connect'){const result=await api('ml/oauth','POST',{action:'connect'});const url=new URL(result.url);if(url.origin!=='https://auth.mercadolibre.com.ar'||url.pathname!=='/authorization')throw Error('URL de autorización inválida.');window.location.assign(url.href);return;}
      if(action==='ml-disconnect'){if(!confirm('Se pausará la facturación automática y se desconectará esta cuenta. Los comprobantes se conservan. ¿Continuar?'))return;await api('ml/oauth','POST',{action:'disconnect',confirm:'DESCONECTAR_ML'});await loadMl();}
      if(action==='ml-batch')await reviewMlBatch([...mlSelected]);
      if(action==='ml-clear-filters'){mlFilters={from:'',to:'',shipment:'',state:'',number:''};mlPage=1;mlSelected.clear();await loadMl();}
      if(action==='ml-import-cancel'||action==='ml-import-resume'){await api('ml/import','POST',{action:action==='ml-import-cancel'?'cancel':'resume'});await loadMl();}
      if(action==='ml-refresh')await loadMl(null,true);
      if(action==='ml-sync'){const data=await api('ml/sync','POST',{});await loadMl();toast(`${data.imported} ventas consultadas.${data.has_more?' Hay más ventas: volvé a buscar para traer la siguiente tanda.':''}`);}
      if(action==='ml-next'||action==='ml-prev'){mlPage+=action==='ml-next'?1:-1;await loadMl();}
      if(action==='bulk-lock'){await api('bulk/lock','POST',{});config.bulk_unlocked=false;bulkSelected.clear();mlSelected.clear();clearTimeout(bulkPoll);clearTimeout(mlPoll);render();}
      if(action==='bulk-search'){bulkOrder=root.querySelector('#fa-bulk-order').value;bulkPage=1;await loadBulk();}
      if(action==='bulk-next'||action==='bulk-prev'){bulkPage+=action==='bulk-next'?1:-1;await loadBulk();}
      if(action==='bulk-refresh')await loadBulkActivity();
      if(action==='bulk-review')await reviewBulk();
      if(action==='auto-activity')await automaticActivity();
      if(action==='search-history'){listPage=1;await loadHistory();}
      if(action==='refresh-history')await loadHistory();
      if(action==='clear-history'){historyQuery='';historyStatus='';historyOrigin='';listPage=1;render();}
      if(action==='next'||action==='prev'){listPage+=action==='next'?1:-1;await loadHistory();}
    });
  });
  root.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='fa-history-q'){e.preventDefault();root.querySelector('[data-action="search-history"]')?.click();return;}if(e.key==='Enter'&&e.target.id==='fa-product-search'){e.preventDefault();clearTimeout(searchTimer);if(!busy&&!frozen())searchProducts(true);return;}if(e.key==='Enter'&&e.target.dataset.field==='customer.document'){e.preventDefault();if(!busy&&!locked())root.querySelector('[data-action="lookup-customer"]')?.click();}});
  root.addEventListener('input',e=>{
    if(busy)return;
    const el=e.target;if(el.closest('#fa-whatsapp-settings'))return;if(el.closest('#fa-settings')){rememberSettings();return;}if(el.type==='radio')return;if(el.id==='fa-product-search'){
      clearTimeout(searchTimer);++requestNumber;results=[];productHasMore=false;const panel=document.getElementById('fa-search-results');if(panel)panel.innerHTML='';searchTimer=setTimeout(()=>searchProducts(false),300);return;
    }
    if(el.dataset.billing){el.removeAttribute('aria-invalid');if(frozen())return;doc.payload.customer.billing[el.dataset.billing]=el.type==='checkbox'?(el.checked?'1':'0'):el.value;syncBilling();changed();refreshSummary();return;}
    if(el.dataset.serialLine!==undefined){const l=doc.payload.lines[Number(el.dataset.serialLine)];l.serials[Number(el.dataset.serialIndex)]=el.value.trim();changed();refreshSummary();return;}
    if(el.dataset.line!==undefined){const l=doc.payload.lines[Number(el.dataset.line)],k=el.dataset.key;if(k==='total'){l.total=Number(el.value);changed();refreshSummary();}return;}
    const key=el.dataset.field;if(!key||el.tagName==='SELECT'||el.type==='checkbox')return;
    if(key==='customer.document')el.removeAttribute('aria-invalid');
    let value=el.type==='number'?Number(el.value):el.value;if(key.startsWith('customer.'))doc.payload.customer[key.split('.')[1]]=value;else doc.payload[key]=value;
    changed();refreshSummary();
  });
  root.addEventListener('change',e=>{
    if(busy)return;
    const el=e.target;
    if(el.closest('#fa-whatsapp-settings')){if(el.name==='source')root.querySelector('[data-wa-own]').hidden=el.value!=='own';return;}
    if(el.closest('#fa-settings'))rememberSettings();
    const multi=el.closest('.fa-multi-select');if(multi&&el.type==='checkbox'){const labels=Array.from(multi.querySelectorAll('input:checked')).map(input=>input.nextElementSibling.textContent),caption=multi.querySelector('.fa-multi-value');caption.textContent=selectionCaption(labels);caption.title=labels.join(', ');return;}
    if(el.hasAttribute('data-ml-select-page')){let limited=false;root.querySelectorAll('[data-ml-select]:not(:disabled)').forEach(box=>{const id=Number(box.dataset.mlSelect);if(el.checked){if(!mlSelected.has(id)&&mlSelected.size>=30){limited=true;return;}mlSelected.add(id);box.checked=true;}else{mlSelected.delete(id);box.checked=false;}});mlSelection();if(limited)toast('El lote admite hasta 30 ventas. Hay selecciones en otras páginas.',true);return;}
    if(el.dataset.mlSelect){const id=Number(el.dataset.mlSelect);if(el.checked){if(mlSelected.size>=30){el.checked=false;toast('Seleccioná hasta 30 pedidos por lote.',true);return;}mlSelected.add(id);}else mlSelected.delete(id);mlSelection();return;}
    if(el.dataset.bulkOrder){const id=Number(el.dataset.bulkOrder);if(el.checked){if(bulkSelected.size>=30){el.checked=false;toast('Seleccioná hasta 30 pedidos por lote.',true);return;}bulkSelected.add(id);}else bulkSelected.delete(id);bulkSelection();return;}
    if(el.hasAttribute('data-bulk-status')){bulkStatus=el.value;bulkPage=1;run(()=>loadBulk());return;}
    if(el.hasAttribute('data-history-origin')){historyOrigin=el.value;listPage=1;run(()=>loadHistory());return;}
    if(el.hasAttribute('data-history-status')){historyStatus=el.value;listPage=1;run(()=>loadHistory());return;}
    if(el.dataset.billing){
      if(frozen())return;doc.payload.customer.billing[el.dataset.billing]=el.type==='checkbox'?(el.checked?'1':'0'):el.value;
      if(el.dataset.billing==='billing_country'){doc.payload.customer.billing.billing_state='';run(async()=>{await loadBilling(el.value);syncBilling();changed();render();});}
      else {syncBilling();changed();refreshSummary();}return;
    }
    if(el.hasAttribute('data-stock')){stockFilter=el.value;results=[];document.getElementById('fa-search-results').innerHTML='';document.getElementById('fa-product-search').dispatchEvent(new Event('input',{bubbles:true}));return;}if(el.dataset.line!==undefined){const l=doc.payload.lines[Number(el.dataset.line)],k=el.dataset.key;
      if(k==='quantity'){const q=Number(el.value);if(!Number.isInteger(q)||q<1||q>1000){el.value=l.quantity;return;}l.total=Math.round(l.total/l.quantity*q*100)/100;l.quantity=q;l.serials=l.serials.slice(0,q);}
      else if(k==='requires_serial')l.requires_serial=el.checked;else if(k==='vat')l.vat=el.value;else return;
      changed();render();return;
    }
    const key=el.dataset.field;if(!key)return;
    if(el.tagName!=='SELECT'&&(el.type!=='radio'||!el.checked))return;
    if(key==='currency'&&doc.payload.lines.length){render();toast('Elegí la moneda antes de agregar productos. Para otra moneda, creá una nueva factura.',true);return;}
    const val=['type','concept','customer.vat_condition','customer.document_type'].includes(key)?Number(el.value):el.value;
    if(key.startsWith('customer.'))doc.payload.customer[key.split('.')[1]]=val;else doc.payload[key]=val;
    if(key==='customer.vat_condition'){doc.payload.type=[1,6].includes(val)?1:6;if(doc.payload.type===1)doc.payload.customer.document_type=80;}
    if(key==='customer.document_type'){doc.payload.type=val===80?1:6;}
    changed();render();
    if(key==='customer.document_type'&&val===80&&!internal())toast('Se seleccionó Factura A. Confirmá la condición de IVA del cliente; tener CUIT no implica ser responsable inscripto.');
  });
  document.addEventListener('click',e=>{root.querySelectorAll('.fa-multi-select[open]').forEach(menu=>{if(!menu.contains(e.target))menu.open=false;});});
  root.addEventListener('keydown',e=>{if(e.key==='Escape'){const menu=e.target.closest('.fa-multi-select[open]');if(menu){e.preventDefault();menu.open=false;menu.querySelector('summary').focus();}}});
  root.addEventListener('focusout',e=>{const menu=e.target.closest('.fa-multi-select');if(menu&&e.relatedTarget&&!menu.contains(e.relatedTarget))menu.open=false;});
  root.addEventListener('submit',e=>{if(e.target.id==='fa-ml-filters'){
      e.preventDefault();const f=e.target;run(async()=>{const next=Object.fromEntries(['from','to','shipment','state','number'].map(k=>[k,f.elements[k].value]));next.number=next.number.trim().replace(/^#/, '');if(next.number&&!/^[1-9]\d{0,19}$/.test(next.number))throw fieldFailure('Revisá el número de venta.',{'ml_filter.number':'Ingresá el número completo de venta o pack.'});if(next.from&&next.to&&next.from>next.to)throw fieldFailure('Revisá el intervalo de fechas.',{'ml_filter.to':'Hasta debe ser igual o posterior a Desde.'});mlFilters=next;mlPage=1;mlSelected.clear();await loadMl();});return;
    }if(e.target.id==='fa-ml-import'){
      e.preventDefault();const f=e.target;run(async()=>{const since=f.elements.since.value,until=f.elements.until.value;if(since>until)throw fieldFailure('Revisá las fechas de importación.',{'ml_import.until':'Hasta debe ser igual o posterior a Desde.'});const result=await api('ml/import','POST',{action:'start',since,until});mlFilters={from:since,to:until,shipment:'',state:'',number:''};mlPage=1;mlSelected.clear();await loadMl();toast(result.error||'Carga iniciada. Las ventas aparecerán a medida que avance la importación.',!!result.error);});return;
    }if(e.target.id==='fa-whatsapp-settings'){
      e.preventDefault();const f=e.target;run(async()=>{const v={};for(const k of ['source','phone_id','waba_id','template','language','token','app_secret'])v[k]=f.elements[k].value.trim();for(const k of ['enabled','automatic'])v[k]=f.elements[k].checked;
      try{config.whatsapp=await api('whatsapp/config','POST',v);render();toast('Configuración de WhatsApp guardada.');}finally{f.elements.token.value='';f.elements.app_secret.value='';}});return;
    }if(e.target.id==='fa-ml-app'){
      e.preventDefault();const f=e.target;run(async()=>{
        ++mlRequest;clearTimeout(mlPoll);const appId=f.elements.app_id.value.trim();
        try{
          const saved=await api('ml/oauth','POST',{action:'save',app_id:appId,secret:f.elements.secret.value});
          if(saved?.app_id!==appId||saved.has_secret!==true||!saved.epoch)throw Error('El servidor no confirmó el guardado de la aplicación. Recargá el panel y verificá los datos antes de conectar.');
          await loadMl(saved);
          toast(saved.connected?'Aplicación guardada. La cuenta continúa conectada.':'Aplicación guardada. Ahora presioná Conectar con Mercado Libre.');
        }finally{f.elements.secret.value='';}
      });return;
    }if(e.target.id==='fa-ml-settings'){e.preventDefault();const f=e.target;run(async()=>{await api('ml/config','POST',{enabled:f.elements.enabled.checked,automatic:f.elements.automatic.checked,since:f.elements.since.value,point:f.elements.point.value});await loadMl();toast('Configuración de Mercado Libre guardada.');});return;}if(e.target.id==='fa-bulk-unlock'){e.preventDefault();const form=e.target;run(async()=>{try{await api('bulk/unlock','POST',{username:form.elements.username.value,password:form.elements.password.value});config.bulk_unlocked=true;render();}finally{form.elements.password.value='';}});return;}if(e.target.id!=='fa-settings')return;e.preventDefault();run(async()=>{
    rememberSettings();const values=settingsValues(e.target);
    config=await api('config','POST',values);settingsDraft=null;connectionResults={};if(!doc.id&&!dirty&&!doc.payload.lines.length)doc=blank();render();toast(values.auto_enabled&&!config.auto_enabled?'Configuración guardada. La automatización quedó pausada por el cambio de entorno, CUIT o punto de venta.':config.auto_enabled?'Configuración guardada. Se facturarán los próximos pedidos que cumplan la regla.':'Configuración guardada.');
  });});
  window.addEventListener('beforeunload',e=>{if(dirty||settingsDraft){e.preventDefault();e.returnValue='';}});
  (async()=>{
    try{
      config=await api('config');await loadBilling('AR');doc=blank();
      if(FusionArca.pos){await loadOrder(Number(FusionArca.order));return;}
      tab=['new','history','bulk','ml','settings'].includes(FusionArca.view)&&(FusionArca.view!=='settings'||FusionArca.admin)?FusionArca.view:'new';render();
    }catch(e){root.innerHTML=`<div class="fa-notice bad" role="alert">${esc(e.message)}${FusionArca.pos?'<p>Cerrá este panel y volvé a abrir la factura del pedido.</p>':''}</div>`;return;}
    const orderId=Number(FusionArca.order);
    if(Number.isSafeInteger(orderId)&&orderId>0)await run(()=>loadOrder(orderId));
  })();
})();
