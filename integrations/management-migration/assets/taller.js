/* Fusion Taller: no remote scripts, no customer data in localStorage. */
(() => {
  'use strict';
  const root = document.getElementById('fusion-taller-app');
  if (!root) return;
  const C = window.FusionTaller;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = cents => new Intl.NumberFormat('es-AR', {style:'currency',currency:'ARS',maximumFractionDigits:2}).format((Number(cents)||0)/100);
  const states = {received:'Recibida',diagnosis:'En diagnóstico',approval:'Esperando aprobación',repair:'En reparación',parts:'Esperando repuestos',quality:'Control final',ready:'Lista para retirar',delivered:'Entregada',cancelled:'Cancelada'};
  const bikeTypes = {mtb:'MTB / montaña',road:'Ruta',gravel:'Gravel',urban:'Urbana / paseo',kids:'Infantil / juvenil',bmx:'BMX',folding:'Plegable',other:'Otra'};
  let profileSeq=0, profileTimer;
  const lookups={customers:0,products:0}, lookupTimers={};
  let customerRows=[],productRows=[];
  const inspectionFields={brakes:'Frenos',transmission:'Transmisión',wheels:'Ruedas y cubiertas',steering:'Dirección',frame:'Cuadro y horquilla',suspension:'Suspensiones',electrical:'Sistema eléctrico, si corresponde'};
  const qualityFields={work:'Trabajos acordados completados',brakes:'Frenos verificados',assembly:'Montaje y ajustes verificados',test:'Prueba funcional realizada',clean:'Bicicleta y accesorios revisados para entrega'};
  const reminders = {pending:'Programado',cancelled:'Cancelado',accepted:'Aceptado por Meta',uncertain:'Resultado incierto',sending:'Envío iniciado',failed:'No enviado',expired:'Vencido'};
  const state = {tab:'jobs',page:1,q:'',status:'',bike:'',customer:0,editStage:'reception',settings:{},job:null,dirty:false};
  let requestNumber = 0;
  async function api(path, method='GET', data) {
    const r = await fetch(C.api+path, {method,credentials:'same-origin',headers:{'X-WP-Nonce':C.nonce,'Content-Type':'application/json'}, ...(data!==undefined ? {body:JSON.stringify(data)} : {})});
    let out; try { out=await r.json(); } catch { throw new Error('El servidor no respondió en el formato esperado. Revisá la sesión y la conexión.'); }
    if (!r.ok) throw new Error(out.message || 'No se pudo completar la operación.');
    return out;
  }
  const badge = (key, labels=states) => `<span class="ft-badge ft-${esc(key)}">${esc(labels[key]||key)}</span>`;
  function shell() {
    root.innerHTML = `<div class="ft-app"><aside class="ft-side"><div class="ft-brand">FUSION<span>TALLER</span></div><p>Servicio técnico<br>de bicicletas</p><nav><button data-tab="jobs">Órdenes de servicio</button><button data-tab="reminders">Recordatorios</button>${C.can_config?'<button data-tab="settings">Configuración</button>':''}</nav><a href="${esc(C.hub)}">Volver al panel Fusion</a><small>Taller conectado · ${esc(C.version)}</small></aside><main class="ft-main"><header><div><span class="ft-eyebrow">FUSION BIKES</span><h1 id="ft-title">Órdenes de servicio</h1></div><button class="ft-button" data-action="new">+ Nueva orden</button></header><div id="ft-global-error" class="ft-error" role="alert" hidden></div><div id="ft-content" aria-live="polite"></div></main></div><dialog class="ft-dialog" id="ft-dialog"></dialog>`;
  }
  function error(e, box=root.querySelector('#ft-global-error')) { box.textContent=e.message||String(e); box.hidden=false; box.scrollIntoView({block:'nearest'}); }
  async function load() {
    const serial=++requestNumber;
    root.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active', b.dataset.tab===state.tab));
    root.querySelector('#ft-title').textContent={jobs:state.bike?'Historial de la bicicleta':state.customer?'Historial del cliente':'Órdenes de servicio',reminders:'Recordatorios por WhatsApp',settings:'Configuración del taller'}[state.tab];
    root.querySelector('#ft-global-error').hidden=true;
    const panel=root.querySelector('#ft-content'); panel.innerHTML='<p class="ft-loading">Cargando…</p>';
    try {
      if (state.tab==='settings') { state.settings=await api('settings'); if(serial===requestNumber) configView(panel); return; }
      if (state.tab==='reminders') { const data=await api('reminders?page='+state.page); if(serial===requestNumber) reminderView(panel,data); return; }
      const data=await api('jobs?'+new URLSearchParams({page:state.page,q:state.q,status:state.status,bike:state.bike,customer:state.customer}));
      if (serial!==requestNumber) return;
      const counts=Object.fromEntries(data.counts.map(r=>[r.status,Number(r.total)]));
      panel.innerHTML=`<div class="ft-metrics"><article><span>En taller</span><b>${Object.keys(states).filter(k=>!['delivered','cancelled'].includes(k)).reduce((a,k)=>a+(counts[k]||0),0)}</b></article><article><span>Esperando aprobación</span><b>${counts.approval||0}</b></article><article><span>En reparación</span><b>${counts.repair||0}</b></article><article><span>Listas para retirar</span><b>${counts.ready||0}</b></article></div><form id="ft-search" class="ft-toolbar"><input name="q" aria-label="Buscar" placeholder="Cliente, teléfono, bicicleta, cuadro u orden" value="${esc(state.q)}"><select name="status" aria-label="Estado"><option value="">Todos los estados</option>${Object.entries(states).map(([k,v])=>`<option value="${k}" ${state.status===k?'selected':''}>${v}</option>`).join('')}</select><button class="ft-button ft-secondary">Buscar</button>${state.bike||state.customer?'<button type="button" data-action="all" class="ft-link">Ver todas</button>':''}</form><div class="ft-table-wrap"><table><thead><tr><th>Orden / ingreso</th><th>Cliente y bicicleta</th><th>Estado / responsable</th><th>Entrega prevista</th><th>Presupuesto / saldo</th><th></th></tr></thead><tbody>${data.rows.map(j=>`<tr><td><strong>#${esc(j.id)}</strong><small>${esc(j.data.received)}</small></td><td><strong>${esc(j.client)}</strong><small>${esc(j.bike_label)}${j.serial?' · '+esc(j.serial):''}</small>${j.data.bike_type?`<span class="ft-bike-type">${esc(bikeTypes[j.data.bike_type]||'Otra')}</span>`:''}</td><td>${badge(j.status)}${j.data.priority==='urgent'?'<span class="ft-urgent">Prioridad alta</span>':''}<small>${esc(j.data.technician||'Sin asignar')}</small></td><td>${esc(j.data.deadline||'—')}${j.data.deadline&&j.data.deadline<C.today&&!['delivered','cancelled'].includes(j.status)?'<small class="ft-urgent">Entrega demorada</small>':''}</td><td>${money(j.data.total)}<small>Saldo ${money(j.data.total-j.data.paid)}</small></td><td><button class="ft-link" data-open="${esc(j.id)}">Abrir →</button></td></tr>`).join('')||'<tr><td colspan="6" class="ft-empty">Todavía no hay órdenes para esta búsqueda. Registrá el ingreso de una bicicleta para empezar.</td></tr>'}</tbody></table></div>${pagination(data)}`;
    } catch (e) { panel.innerHTML=''; error(e); }
  }
  function pagination(d) { return `<div class="ft-pagination"><button class="ft-link" data-page="${d.page-1}" ${d.page<=1?'disabled':''}>← Anterior</button><span>Página ${d.page}</span><button class="ft-link" data-page="${d.page+1}" ${!d.more?'disabled':''}>Siguiente →</button></div>`; }
  function reminderView(panel,d) {
    panel.innerHTML=`<div class="ft-note">${state.settings.enabled?'Automatización habilitada.':'Los envíos automáticos están apagados.'} Cada entrega puede programar un recordatorio. Un nuevo ingreso cancela el aviso del service anterior. Horario: ${esc(state.settings.hour)} a ${esc(state.settings.end_hour)} h · ${esc(state.settings.timezone)}.</div><div class="ft-table-wrap"><table><thead><tr><th>Fecha prevista</th><th>Cliente / bicicleta</th><th>WhatsApp</th><th>Estado y detalle</th><th></th></tr></thead><tbody>${d.rows.map(r=>`<tr><td>${esc(r.due_local)}<small>Orden #${esc(r.job_id)}</small></td><td><strong>${esc(r.client)}</strong><small>${esc(r.bike_label)}</small></td><td>+${esc(r.phone)}</td><td>${badge(r.state,reminders)}<small>${esc(r.error)}</small>${r.message_id?`<details><summary>ID del mensaje</summary><small>${esc(r.message_id)}</small></details>`:''}</td><td><button data-open="${esc(r.job_id)}" class="ft-link">Orden</button>${r.state==='pending'?`<button data-reminder="cancel" data-id="${esc(r.job_id)}" class="ft-link">Cancelar aviso</button>`:''}${r.state==='failed'?`<button data-reminder="retry" data-id="${esc(r.job_id)}" class="ft-link">Reintentar</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5" class="ft-empty">Los avisos aparecerán cuando entregues una bicicleta con recordatorio habilitado.</td></tr>'}</tbody></table></div>${pagination(d)}<p class="ft-muted">“Aceptado por Meta” confirma recepción por la API. Esta versión no confirma entrega ni lectura. Los resultados inciertos quedan bloqueados para evitar duplicados.</p>`;
  }
  function input(label,name,value='',type='text',attrs='') { return `<label class="ft-field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`; }
  function area(label,name,value='') { return `<label class="ft-field ft-wide"><span>${label}</span><textarea name="${name}" rows="3" maxlength="5000">${esc(value)}</textarea></label>`; }
  function configView(panel) {
    const s=state.settings;
    panel.innerHTML=`<form id="ft-config"><div class="ft-error" id="ft-config-error" role="alert" hidden></div><section class="ft-card"><h2>Cuándo recordar el próximo service</h2><p>El plazo se cuenta desde la entrega. Estos valores se proponen para las nuevas órdenes; cada orden conserva su propio plazo.</p><div class="ft-grid">${input('Plazo predeterminado','count',s.count,'number','min="1" max="3650" required')}<label class="ft-field"><span>Unidad</span><select name="unit"><option value="days" ${s.unit==='days'?'selected':''}>Días</option><option value="months" ${s.unit==='months'?'selected':''}>Meses</option></select></label>${input('Enviar a partir de (hora)','hour',s.hour,'number','min="0" max="23" required')}${input('Hasta antes de (hora)','end_hour',s.end_hour,'number','min="1" max="24" required')}</div><label class="ft-check"><input type="checkbox" name="weekdays" ${s.weekdays?'checked':''}> Enviar solo de lunes a viernes</label><p class="ft-muted">Zona horaria: ${esc(s.timezone)}. El primer proceso dentro del horario envía los avisos vencidos. Si pasaron más de 14 días, se marca el aviso para revisión.</p></section><section class="ft-card"><h2>WhatsApp</h2><div class="ft-grid"><label class="ft-field"><span>Conexión</span><select name="source"><option value="meta" ${s.source==='meta'?'selected':''}>Usar Meta for WooCommerce</option><option value="direct" ${s.source==='direct'?'selected':''}>Cloud API · conexión propia</option></select></label>${input('Plantilla aprobada','template',s.template,'text','required pattern="[a-z0-9_]+"')}${input('Idioma exacto en Meta','language',s.language,'text','required')}</div><details ${s.source==='direct'?'open':''}><summary>Credenciales de conexión propia</summary><p>Solo se usan si elegís conexión propia.</p><div class="ft-grid">${input('ID del número de WhatsApp','phone_id',s.phone_id||'')}${input('ID de cuenta WABA','waba_id',s.waba_id||'')}${input(s.has_token?'Token guardado · vacío lo conserva':'Token de servidor','token','','password','autocomplete="new-password"')}</div></details><div class="ft-note"><strong>Plantilla sugerida: fusion_recordatorio_service</strong><p>Sin encabezado ni botones. Variables con nombre: <code>{{cliente}}</code>, <code>{{bicicleta}}</code>, <code>{{fecha}}</code>. También admite variables numéricas 1, 2 y 3 en ese orden.</p><p>Hola {{cliente}}, en Fusion Bikes registramos el próximo mantenimiento de tu bicicleta {{bicicleta}} para el {{fecha}}. Si querés coordinar el service, respondé a este mensaje. Si preferís no recibir más recordatorios, avisános por acá.</p></div><div class="ft-connection">${s.ready?'✓ Conexión y plantilla comprobadas':'Pendiente de comprobar conexión y plantilla'}${s.checked?.number?' · '+esc(s.checked.number):''}</div><label class="ft-check"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> Habilitar envíos automáticos de recordatorios</label><p class="ft-muted">Primero guardá con los envíos apagados; luego comprobá la conexión. La comprobación no manda mensajes.</p><div class="ft-toolbar"><button class="ft-button" type="submit">Guardar configuración</button><button class="ft-button ft-secondary" type="button" data-action="check">Comprobar conexión y plantilla</button></div><div id="ft-config-ok" class="ft-note" hidden></div></section><section class="ft-card"><h2>Ejecución y acceso</h2><p>Proceso horario: ${s.cron_scheduled?'programado':'sin programar; guardá la configuración'}. Última ejecución: ${esc(s.last_cron||'todavía no registrada')}.</p><p>Para ejecutar aunque no haya visitas, configurá una tarea del hosting que ejecute WordPress Cron cada 5 minutos. El plugin revisa los avisos una vez por hora.</p><p>Acceso fuera del administrador: agregá <code>[fusion_taller]</code> a una página privada para operadores y excluila de la caché. El usuario debe tener el rol <strong>Operador de Fusion Taller</strong>, Administrador o Gestor de tienda.</p></section></form>`;
  }
  const uuid = () => window.crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(16)+'-'+Math.random().toString(16).slice(2)+'-'+Math.random().toString(16).slice(2);
  function blank(previous) {
    const d=previous?.data||{};
    return {id:0,revision:0,request_key:uuid(),bike_key:previous?.bike_key||'',client:previous?.client||'',phone:previous?.phone||'',serial:previous?.serial||'',status:'received',data:{customer_id:d.customer_id||0,customer_document:d.customer_document||'',brand:d.brand||'',model:d.model||'',colour:d.colour||'',size:d.size||'',bike_type:d.bike_type||'',email:d.email||'',received:C.today,deadline:'',delivered:'',items:[],paid:0,budget:'draft',allow_reminder:!!d.allow_reminder,interval_count:state.settings.count||90,interval_unit:state.settings.unit||'days'}};
  }
  function line(i={}) {
    const linked=!!i.product_id;
    return `<tr><td><input type="hidden" data-item="line_id" value="${esc(i.line_id||uuid())}"><input type="hidden" data-item="product_id" value="${esc(i.product_id||0)}"><select data-item="type" aria-label="Tipo"><option value="labor" ${i.type!=='part'?'selected':''}>Servicio</option><option value="part" ${i.type==='part'?'selected':''}>Repuesto</option></select></td><td><input data-item="name" value="${esc(i.name||'')}" ${linked?'readonly':''} placeholder="Concepto adicional" maxlength="${linked?1000:190}" aria-label="Descripción">${linked?`<small>Catálogo #${esc(i.product_id)} · SKU ${esc(i.sku||'sin SKU')}</small>`:'<small>Concepto manual</small>'}</td><td><input data-item="qty" type="number" value="${esc(i.qty??1)}" min="0.001" max="9999" step="0.001" aria-label="Cantidad"></td><td><input data-item="price" type="number" value="${esc((i.cents||0)/100)}" ${linked?'readonly':''} min="0" max="1000000000" step="0.01" aria-label="Precio unitario">${linked?'<small>Precio fijado al agregar</small>':''}</td><td><button type="button" data-action="remove-line" class="ft-link" aria-label="Quitar renglón">×</button></td></tr>`;
  }
  function setStage(stage) {
    state.editStage=stage;
    root.querySelectorAll('[data-stage]').forEach(b=>{const active=b.dataset.stage===stage;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});
    root.querySelectorAll('.ft-stage').forEach(p=>p.hidden=p.dataset.panel!==stage);
  }
  function invalidateLookups(){Object.keys(lookups).forEach(k=>{lookups[k]++;clearTimeout(lookupTimers[k]);});}
  function editor(j) {
    state.job=j; state.dirty=false; clearTimeout(profileTimer); profileSeq++; state.profileManual=!!j.data.bike_type;invalidateLookups();customerRows=[];productRows=[];
    const d=j.data,dlg=root.querySelector('#ft-dialog'),linked=!!d.customer_id;
    dlg.innerHTML=`<form id="ft-job" novalidate>
      <div class="ft-modal-head"><div><span class="ft-eyebrow">FUSION BIKES / ORDEN DE SERVICIO</span><h2>${j.id?'Orden #'+esc(j.id):'Nuevo ingreso'}</h2><small>${j.id?esc(j.bike_label)+' · '+esc(j.client):'Recepción y seguimiento del trabajo'}</small></div><button class="ft-close" type="button" data-action="close" aria-label="Cerrar">×</button></div>
      <div class="ft-stage-nav" role="tablist" aria-label="Etapas de la orden">${Object.entries({reception:'1 · Recepción',diagnosis:'2 · Inspección',budget:'3 · Presupuesto',delivery:'4 · Finalización'}).map(([k,v])=>`<button type="button" role="tab" aria-controls="ft-stage-${k}" data-stage="${k}">${v}</button>`).join('')}</div>
      <div class="ft-modal-body"><div class="ft-order-status"><label class="ft-field"><span>Estado de la orden</span><select name="status">${Object.entries(states).map(([k,v])=>`<option value="${k}" ${j.status===k?'selected':''}>${v}</option>`).join('')}</select></label>${input('Técnico responsable','technician',d.technician,'text','maxlength="100"')}<label class="ft-field"><span>Prioridad</span><select name="priority"><option value="normal">Normal</option><option value="urgent" ${d.priority==='urgent'?'selected':''}>Alta</option></select></label></div>
      <div class="ft-stage" id="ft-stage-reception" data-panel="reception" role="tabpanel">
        <section><h3>Cliente de la web / POS</h3><input type="hidden" name="customer_id" value="${esc(d.customer_id||0)}"><div class="ft-lookup"><label class="ft-field"><span>Buscar cliente existente</span><input data-lookup="customers" placeholder="Nombre, teléfono, DNI, CUIT o correo" autocomplete="off" maxlength="100"></label><button type="button" class="ft-button ft-secondary" data-action="new-customer">Nuevo cliente</button></div><div id="ft-customers-results" class="ft-lookup-results" aria-live="polite"></div><p id="ft-customer-link" class="ft-muted">${linked?'Ficha compartida #'+esc(d.customer_id)+'. Para corregir sus datos, editá el cliente en el POS y volvé a seleccionarlo.':j.id?'Orden anterior sin vincular. Podés buscar su ficha compartida.':'Buscá al cliente antes de crear una ficha nueva.'}</p>
        <div class="ft-grid">${input('Nombre y apellido *','client',j.client,'text',`required maxlength="190" ${linked?'readonly':''}`)}${input('DNI / CUIT','customer_document',d.customer_document,'text',`maxlength="20" ${linked?'readonly':''}`)}${input('WhatsApp','phone',j.phone,'tel',`placeholder="3512642305 o +5493512642305" maxlength="30" ${linked?'readonly':''}`)}${input('Correo','email',d.email,'email',linked?'readonly':'')}</div><button type="button" class="ft-button ft-secondary" data-action="create-customer" ${linked?'hidden':''}>Crear cliente en la base compartida</button></section>
        <section><h3>Bicicleta</h3><div class="ft-grid">${input('Marca *','brand',d.brand,'text','required maxlength="70"')}${input('Modelo *','model',d.model,'text','required maxlength="100"')}<label class="ft-field"><span>Tipo de bicicleta</span><select name="bike_type"><option value="">Sin clasificar</option>${Object.entries(bikeTypes).map(([k,v])=>`<option value="${k}" ${d.bike_type===k?'selected':''}>${v}</option>`).join('')}</select></label>${input('Número de cuadro','serial',j.serial,'text','maxlength="100"')}${input('Talle','size',d.size,'text','maxlength="50"')}${input('Color','colour',d.colour,'text','maxlength="70"')}</div><div class="ft-bike-profile"><div id="ft-bike-visual"></div><div><p id="ft-bike-hint" aria-live="polite"></p><button type="button" class="ft-link" data-action="detect-type">Sugerir según marca y modelo</button><label class="ft-check"><input type="checkbox" name="remember_model_type"> Recordar este tipo para esta marca y modelo</label></div></div></section>
        <section><h3>Recepción</h3><div class="ft-grid">${input('Fecha de ingreso','received',d.received,'date','required')}${input('Entrega prevista','deadline',d.deadline,'date')}${area('Problema informado por el cliente','issue',d.issue)}${area('Estado al ingresar y accesorios que deja','accessories',d.accessories)}</div></section>
      </div>
      <div class="ft-stage" id="ft-stage-diagnosis" data-panel="diagnosis" role="tabpanel"><section><h3>Inspección de recepción</h3><p class="ft-muted">Registrá lo revisado y detallá los hallazgos en el diagnóstico.</p><div class="ft-inspection">${Object.entries(inspectionFields).map(([k,label])=>`<label class="ft-field"><span>${label}</span><select name="inspection_${k}">${Object.entries({pending:'Sin revisar',ok:'Correcto',attention:'Requiere atención',na:'No aplica'}).map(([v,l])=>`<option value="${v}" ${(d.inspection?.[k]||'pending')===v?'selected':''}>${l}</option>`).join('')}</select></label>`).join('')}</div></section><section>${area('Diagnóstico y tareas propuestas','diagnosis',d.diagnosis)}</section></div>
      <div class="ft-stage" id="ft-stage-budget" data-panel="budget" role="tabpanel"><section><h3>Servicios y repuestos del catálogo</h3><div class="ft-catalog-search"><label class="ft-field"><span>Agregar como</span><select id="ft-catalog-kind"><option value="labor">Servicio</option><option value="part">Repuesto</option></select></label><label class="ft-field"><span>Buscar en el catálogo local</span><input data-lookup="products" placeholder="Nombre, SKU o código de barras" autocomplete="off" maxlength="100"></label></div><div id="ft-products-results" class="ft-lookup-results" aria-live="polite"></div><p class="ft-muted">Consulta del catálogo sincronizado en el VPS. Cantidad registrada y precio web de referencia; agregar productos y guardar cambios aún no está habilitado.</p><div class="ft-table-wrap"><table class="ft-items"><thead><tr><th>Tipo</th><th>Servicio / repuesto</th><th>Cant.</th><th>Unitario ARS</th><th></th></tr></thead><tbody id="ft-lines">${(d.items||[]).map(line).join('')}</tbody></table></div><button type="button" class="ft-link" data-action="add-line">+ Concepto adicional manual</button><div class="ft-total" id="ft-total"></div></section>
        <section><h3>Aprobación del presupuesto</h3><div class="ft-grid"><label class="ft-field"><span>Estado del presupuesto</span><select name="budget">${Object.entries({draft:'Borrador',pending:'Pendiente de aprobación',approved:'Aprobado',rejected:'Rechazado'}).map(([k,v])=>`<option value="${k}" ${d.budget===k?'selected':''}>${v}</option>`).join('')}</select></label>${input('Aprobación: medio, fecha y persona','approval_note',d.approval_note,'text','placeholder="Ej.: WhatsApp, 29/09, Juan Pérez" maxlength="300"')}${input('Cobro / seña registrado (ARS)','paid',(d.paid||0)/100,'number','min="0" max="1000000000" step="0.01"')}</div><label class="ft-check"><input type="checkbox" name="reapprove_budget"> El cliente aprobó nuevamente este presupuesto modificado</label>${d.approved_at?`<p class="ft-muted">Aprobación registrada por ${esc(d.approved_by)} · ${esc(d.approved_at)}</p>`:''}<p class="ft-muted">El registro de cobro no procesa pagos ni emite facturas.</p></section>
      </div>
      <div class="ft-stage" id="ft-stage-delivery" data-panel="delivery" role="tabpanel"><section><h3>Trabajo realizado</h3>${area('Detalle de tareas y observaciones de entrega','work',d.work)}</section><section><h3>Control final</h3><div class="ft-quality">${Object.entries(qualityFields).map(([k,label])=>`<label class="ft-check"><input type="checkbox" name="quality_${k}" ${d.quality?.[k]?'checked':''}> ${label}</label>`).join('')}</div><div class="ft-grid">${input('Control final realizado por','quality_by',d.quality_by,'text','maxlength="100"')}${input('Fecha de entrega efectiva','delivered',d.delivered||C.today,'date','required')}</div><p class="ft-muted">Completá estos controles antes de marcar Lista para retirar o Entregada. La fecha efectiva se registra al entregar.</p></section>
        <section class="ft-reminder-box"><h3>Próximo service por WhatsApp</h3><label class="ft-check"><input type="checkbox" name="allow_reminder" ${d.allow_reminder?'checked':''}> El cliente solicitó recibir el recordatorio de mantenimiento</label><div class="ft-grid">${input('Recordar después de la entrega','interval_count',d.interval_count||90,'number','min="1" max="3650" required')}<label class="ft-field"><span>Unidad</span><select name="interval_unit"><option value="days" ${d.interval_unit==='days'?'selected':''}>Días</option><option value="months" ${d.interval_unit==='months'?'selected':''}>Meses</option></select></label></div><p>Se programa una vez al marcar la bicicleta como Entregada.</p>${j.reminder?`<p>${badge(j.reminder.state,reminders)} · ${esc(j.reminder.due_local||j.reminder.due_at)}</p>`:''}</section>
      </div>
      ${j.id?`<section class="ft-documents"><h3>Constancias y seguimiento</h3><p class="ft-muted">Generá las constancias desde la orden guardada para imprimir, guardar como PDF o compartir por WhatsApp.</p><div class="ft-toolbar"><button type="button" class="ft-button ft-secondary" data-document="received">Hoja de recepción</button><button type="button" class="ft-button ft-secondary" data-document="finished" ${['ready','delivered'].includes(j.status)?'':'disabled'}>Hoja de finalización</button><button type="button" class="ft-link" data-action="print">Imprimir presupuesto</button></div><div id="ft-document-result" aria-live="polite"></div><div class="ft-toolbar"><button type="button" class="ft-link" data-action="history">Historial de la bicicleta</button>${d.customer_id?'<button type="button" class="ft-link" data-action="customer-history">Historial del cliente</button>':''}<button type="button" class="ft-link" data-action="repeat">Nuevo ingreso de esta bicicleta</button></div><details><summary>Últimos cambios</summary>${(d.audit||[]).slice(-10).reverse().map(a=>`<p>${esc(a.at)} UTC · ${esc(a.name)} · ${esc(a.text)}</p>`).join('')}</details></section>`:''}
      </div><footer><div id="ft-job-error" class="ft-error" role="alert" hidden></div><span>Guardá antes de emitir una constancia.</span><button class="ft-button" type="submit">Guardar orden</button></footer></form>`;
    if(!dlg.open) dlg.showModal();totals();showBikeType();setStage(state.editStage);
    if(!d.bike_type)lookupBikeType();
  }
  function selectCustomer(c){
    lookups.customers++;clearTimeout(lookupTimers.customers);
    const values={customer_id:c.id,client:c.name,phone:c.phone,email:c.email,customer_document:c.document};
    for(const [k,v] of Object.entries(values)){const field=root.querySelector(`[name="${k}"]`);field.value=v||'';if(k!=='customer_id')field.readOnly=!!c.id;}
    root.querySelector('[data-action=create-customer]').hidden=!!c.id;
    root.querySelector('#ft-customer-link').textContent=c.id?`Ficha compartida #${c.id}. Los cambios de esta orden no sobrescriben la ficha del POS.`:'Completá nombre y documento o correo para crear la ficha compartida.';
    root.querySelector('#ft-customers-results').innerHTML='';state.dirty=true;
  }
  async function lookup(kind){
    const field=root.querySelector(`[data-lookup="${kind}"]`),box=root.querySelector(`#ft-${kind}-results`);if(!field||!box)return;
    const q=field.value.trim(),seq=++lookups[kind];if(q.length<2){box.innerHTML='';return;}
    box.textContent='Buscando…';
    try {
      const data=await api(kind+'?q='+encodeURIComponent(q));if(seq!==lookups[kind]||!field.isConnected)return;
      if(kind==='customers'){
        customerRows=data.rows;
        box.innerHTML=data.rows.map((c,i)=>`<button type="button" class="ft-result" data-customer="${i}"><strong>${esc(c.name)}</strong><span>${esc(c.document||'Sin documento')} · ${esc(c.phone||c.email||'Sin contacto')} · #${esc(c.id)}</span></button>`).join('')||'<p>Sin coincidencias. Podés crear un cliente nuevo.</p>';
      } else {
        productRows=data.rows;
        if(data.local_catalog){box.innerHTML=FusionLocalCatalog.render(data.rows);return;}
        box.innerHTML=data.rows.map((p,i)=>`<button type="button" class="ft-result ft-product-result" data-product="${i}">${p.image?`<img src="${esc(p.image)}" alt="" loading="lazy">`:''}<span><strong>${esc(p.name)}</strong><small>SKU ${esc(p.sku||'sin SKU')} · #${esc(p.id)} · ${p.in_stock?(p.stock_quantity===null?'Disponible':'Stock: '+esc(p.stock_quantity)):'Sin stock / pendiente de reposición'}</small></span><b>${money(p.cents)}</b></button>`).join('')||'<p>Sin coincidencias. Buscá por nombre o SKU de un producto con precio y variante definida.</p>';
        if(data.rows.length>=30)box.insertAdjacentHTML('beforeend','<p>Hasta 30 resultados. Afiná la búsqueda para ver otros productos.</p>');
      }
    }catch(e){if(seq===lookups[kind])box.textContent=e.message;}
  }

  function bikeSvg(type) {
    const r=type==='kids'?18:type==='bmx'||type==='folding'?20:27;
    const cx=type==='kids'?48:40, fx=type==='kids'?127:145, cy=70;
    const road=type==='road'||type==='gravel';
    let frame=`M${cx} ${cy} L72 31 L91 ${cy} Z M72 31 L131 28 L91 ${cy} M131 28 L${fx} ${cy} M72 31 L67 21 M58 21 L79 21`;
    if(type==='urban') frame=`M${cx} ${cy} L69 35 L87 ${cy} L131 25 M69 35 Q101 80 131 25 L${fx} ${cy} M69 35 L65 19 M57 19 L75 19 M125 25 L119 13 L110 13`;
    if(type==='folding') frame=`M${cx} ${cy} L78 50 L${fx} ${cy} M78 50 L125 49 L${fx} ${cy} M78 50 L76 21 M64 21 L84 21 M131 49 L128 12 L116 12`;
    if(type==='kids')frame=`M48 70 L73 43 L88 70 Z M73 43 L117 41 L88 70 M117 41 L127 70 M73 43 L70 29 M62 29 L78 29 M115 41 L108 27 L100 27`;
    if(type==='bmx')frame=`M40 70 L70 42 L89 70 Z M70 42 L128 38 L89 70 M128 38 L145 70 M70 42 L66 28 M58 28 L76 28 M125 38 L119 16 L106 16`;
    const bar=road?'M128 28 L130 17 L148 17 Q160 17 158 27 Q157 34 147 31':(!['kids','bmx','folding','urban'].includes(type)?'M128 28 L125 16 L137 16':'');
    return `<svg viewBox="0 0 190 108" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="${cx}" cy="${cy}" r="${r}" stroke-width="${type==='mtb'||type==='gravel'?4:2.5}"/><circle cx="${fx}" cy="${cy}" r="${r}" stroke-width="${type==='mtb'||type==='gravel'?4:2.5}"/><path d="${frame} ${bar}" stroke-width="3"/><circle cx="${type==='kids'?88:91}" cy="70" r="5" stroke-width="2"/>${type==='folding'?'<circle cx="101" cy="50" r="4" stroke-width="3"/>':''}</g></svg>`;
  }
  function showBikeType(hint) {
    const select=root.querySelector('[name=bike_type]'), visual=root.querySelector('#ft-bike-visual');if(!select||!visual)return;
    const type=select.value;
    visual.innerHTML=bikeSvg(type)+`<strong>${esc(bikeTypes[type]||'Sin clasificar')}</strong><small>Ilustración del tipo</small>`;
    root.querySelector('#ft-bike-hint').textContent=hint || (type?'Tipo guardado en esta ficha. Podés cambiarlo si la bicicleta fue modificada.':'Completá marca y modelo para sugerir el tipo, o elegilo manualmente.');
  }
  async function lookupBikeType() {
    const dlg=root.querySelector('#ft-dialog');if(!dlg.open)return;
    const brand=root.querySelector('[name=brand]').value.trim(),model=root.querySelector('[name=model]').value.trim();
    const n=++profileSeq;
    if(brand.length<2||model.length<2){showBikeType('Completá marca y modelo o elegí el tipo manualmente.');return;}
    try {
      const data=await api('bike-profile?'+new URLSearchParams({brand,model}));
      if(n!==profileSeq||!dlg.open||state.profileManual)return;
      const select=root.querySelector('[name=bike_type]');
      if(data.type && bikeTypes[data.type]) {
        if(select.value!==data.type){select.value=data.type;state.dirty=true;}
        showBikeType(data.source==='workshop'?'Sugerido por una asociación guardada en tu taller. Podés corregirlo.':'Sugerido por la referencia inicial de marca/modelo. Revisá que corresponda a esta bicicleta.');
      } else showBikeType('Modelo sin asociación conocida. Elegí el tipo y marcá “Recordar” si querés reutilizarlo.');
    } catch(e) {if(n===profileSeq&&dlg.open)showBikeType('No se pudo buscar la sugerencia. Podés elegir el tipo manualmente.');}
  }

  function readLines() { return [...root.querySelectorAll('#ft-lines tr')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-item]')].map(i=>[i.dataset.item,i.value]))); }
  function totals() {
    const lines=readLines();
    const labor=lines.filter(i=>i.type==='labor').reduce((a,i)=>a+Math.round(Math.round((Number(i.price)||0)*100)*(Number(i.qty)||0)),0);
    const parts=lines.filter(i=>i.type==='part').reduce((a,i)=>a+Math.round(Math.round((Number(i.price)||0)*100)*(Number(i.qty)||0)),0);
    const t=lines.reduce((sum,i)=>sum+Math.round((Number(i.qty)||0)*Math.round((Number(i.price)||0)*100)),0);
    const paid=Math.round((Number(root.querySelector('[name=paid]')?.value)||0)*100);
    const box=root.querySelector('#ft-total'); if(box) box.innerHTML=`<span>Servicios <b>${money(labor)}</b></span><span>Repuestos <b>${money(parts)}</b></span><span>Total <b>${money(t)}</b></span><span>Saldo <b>${money(t-paid)}</b></span>`;
  }
  function close() { if(state.saving)return false; if(state.dirty && !confirm('Hay cambios sin guardar. ¿Querés descartarlos?')) return false; clearTimeout(profileTimer);profileSeq++;invalidateLookups();root.querySelector('#ft-dialog').close();state.dirty=false;return true; }
  function printJob() {
    if(state.dirty) throw new Error('Guardá los cambios antes de imprimir.');
    const j=state.job,d=j.data,w=window.open('','_blank'); if(!w) throw new Error('Permití abrir una ventana para imprimir la ficha.');
    w.document.write(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Fusion Taller · Orden ${esc(j.id)}</title><style>body{font:14px Arial,sans-serif;max-width:850px;margin:35px auto;color:#172523}h1{font-size:25px}h2{font-size:17px;margin-top:28px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px 6px;border-bottom:1px solid #ddd}p{white-space:pre-wrap;line-height:1.5}.head{display:flex;justify-content:space-between}.foot{margin-top:50px;color:#555}@media print{button{display:none}}</style><body><div class="head"><h1>FUSION BIKES · TALLER</h1><h2>Orden #${esc(j.id)}</h2></div><p>Cliente: ${esc(j.client)}<br>WhatsApp: ${esc(j.phone)}<br>Bicicleta: ${esc(j.bike_label)}<br>Tipo: ${esc(bikeTypes[d.bike_type]||'Sin clasificar')}<br>Cuadro: ${esc(j.serial||'No informado')}<br>Ingreso: ${esc(d.received)} · Entrega prevista: ${esc(d.deadline||'A coordinar')}</p><h2>Motivo de ingreso</h2><p>${esc(d.issue||'—')}</p><h2>Estado y accesorios recibidos</h2><p>${esc(d.accessories||'—')}</p><h2>Diagnóstico y presupuesto</h2><p>${esc(d.diagnosis||'—')}</p><table><thead><tr><th>Descripción</th><th>Cantidad</th><th>Unitario</th><th>Importe</th></tr></thead><tbody>${d.items.map(i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.qty)}</td><td>${money(i.cents)}</td><td>${money(Math.round(i.cents*i.qty))}</td></tr>`).join('')}</tbody></table><p><strong>Total: ${money(d.total)} · Registrado como cobrado: ${money(d.paid)} · Saldo: ${money(d.total-d.paid)}</strong></p><p>Aprobación: ${esc(d.approval_note||'Pendiente')}</p><h2>Trabajos realizados</h2><p>${esc(d.work||'—')}</p><p class="foot">Firma / aclaración al retirar: ___________________________________<br><br>Ficha de taller / presupuesto. No es una factura fiscal.<br>fusionbikes.com.ar</p><button onclick="window.print()">Imprimir / guardar PDF</button></body></html>`); w.document.close();
  }
  root.addEventListener('input',e=>{ if(e.target.closest('#ft-job')) {
    if(e.target.dataset.lookup){const k=e.target.dataset.lookup;lookups[k]++;clearTimeout(lookupTimers[k]);lookupTimers[k]=setTimeout(()=>lookup(k),350);return;}
    state.dirty=true;totals();
    if(['brand','model'].includes(e.target.name)) {
      clearTimeout(profileTimer);profileSeq++;state.profileManual=false;
      root.querySelector('[name=bike_type]').value='';root.querySelector('[name=remember_model_type]').checked=false;
      showBikeType('Buscando una coincidencia de marca y modelo…');profileTimer=setTimeout(lookupBikeType,500);
    }
  } });
  root.addEventListener('change',e=>{ if(e.target.closest('#ft-job')) {
    state.dirty=true;
    if(e.target.name==='bike_type') {clearTimeout(profileTimer);profileSeq++;state.profileManual=true;showBikeType('Selección manual. Podés recordarla para próximos ingresos de este modelo.');}
  } });
  root.addEventListener('submit',async e=>{
    e.preventDefault(); const form=e.target,submit=form.querySelector('[type=submit]');
    if(form.id==='ft-search') { const f=new FormData(form);state.q=f.get('q');state.status=f.get('status');state.page=1;await load();return; }
    if(form.id==='ft-job'&&!form.checkValidity()){const invalid=form.querySelector(':invalid');const stage=invalid?.closest('.ft-stage');if(stage)setStage(stage.dataset.panel);form.reportValidity();return;}
    if(submit)submit.disabled=true;
    const box=form.querySelector('.ft-error'); if(box)box.hidden=true;
    try {
      const values=Object.fromEntries(new FormData(form));
      if(form.id==='ft-job') {
        const payload={...values,id:state.job.id,revision:state.job.revision,request_key:state.job.request_key,bike_key:state.job.bike_key,items:readLines(),inspection:Object.fromEntries(Object.keys(inspectionFields).map(k=>[k,values['inspection_'+k]||'pending'])),quality:Object.fromEntries(Object.keys(qualityFields).map(k=>[k,!!values['quality_'+k]])),reapprove_budget:!!values.reapprove_budget,allow_reminder:!!values.allow_reminder,remember_model_type:!!values.remember_model_type};
        state.saving=true;form.setAttribute('aria-busy','true');form.querySelector('.ft-modal-body').inert=true;form.querySelector('.ft-close').disabled=true;
        const saved=await api('jobs','POST',payload);state.dirty=false;root.querySelector('#ft-dialog').close();await load();editor(saved);
        const msg=document.createElement('p');msg.className='ft-success';msg.textContent='Orden guardada.';root.querySelector('.ft-modal-head').after(msg);
      } else if(form.id==='ft-config') {
        state.settings=await api('settings','POST',{...values,enabled:!!values.enabled,weekdays:!!values.weekdays});configView(root.querySelector('#ft-content')); const ok=root.querySelector('#ft-config-ok');ok.textContent='Configuración guardada.';ok.hidden=false;
      }
    } catch(err){ error(err,box||undefined); }
    finally{state.saving=false;if(form.isConnected){form.removeAttribute('aria-busy');const body=form.querySelector('.ft-modal-body');if(body)body.inert=false;const closeButton=form.querySelector('.ft-close');if(closeButton)closeButton.disabled=false;}if(submit)submit.disabled=false;}
  });
  root.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    try {
      if(b.dataset.stage){setStage(b.dataset.stage);return;}
      if(b.dataset.customer!==undefined){selectCustomer(customerRows[Number(b.dataset.customer)]);return;}
      if(b.dataset.product!==undefined){
        const p=productRows[Number(b.dataset.product)];
        root.querySelector('#ft-lines').insertAdjacentHTML('beforeend',line({...p,product_id:p.id,type:root.querySelector('#ft-catalog-kind').value}));
        state.dirty=true;totals();b.textContent='Agregado al presupuesto';b.disabled=true;return;
      }
      if(b.dataset.document){
        if(state.dirty)throw new Error('Guardá la orden antes de generar una constancia.');
        const job=state.job,box=root.querySelector('#ft-document-result');b.disabled=true;
        const doc=await api('jobs/'+job.id+'/document','POST',{kind:b.dataset.document,revision:job.revision});
        if(state.job!==job||!box.isConnected)return;
        box.innerHTML=`<div class="ft-note"><strong>${esc(doc.title)}</strong><div class="ft-toolbar"><a class="ft-button ft-secondary" href="${esc(doc.url)}" target="_blank" rel="noopener noreferrer">Abrir / imprimir / PDF</a>${doc.whatsapp_url?`<a class="ft-button" href="${esc(doc.whatsapp_url)}" target="_blank" rel="noopener noreferrer">Enviar por WhatsApp</a>`:'<span>Completá el WhatsApp en la ficha del cliente para compartir.</span>'}</div><small>WhatsApp abre el mensaje para revisarlo y enviarlo. El enlace permite ver esta copia hasta el ${esc(doc.expires)}.</small></div>`;return;
      }
      if(b.dataset.tab) {state.tab=b.dataset.tab;state.page=1;await load();return;}
      if(b.dataset.page){state.page=Number(b.dataset.page);await load();return;}
      if(b.dataset.open){b.disabled=true;state.editStage='reception';editor(await api('jobs/'+b.dataset.open));return;}
      if(b.dataset.reminder){if(!confirm(b.dataset.reminder==='cancel'?'¿Cancelar este recordatorio?':'¿Reintentar este envío en el próximo horario habilitado?'))return;b.disabled=true;await api('reminders/'+b.dataset.id,'POST',{action:b.dataset.reminder});await load();return;}
      switch(b.dataset.action){
        case 'new':state.editStage='reception';editor(blank());break;
        case 'new-customer':selectCustomer({id:0,name:'',phone:'',email:'',document:''});setStage('reception');break;
        case 'create-customer':{b.disabled=true;const form=root.querySelector('#ft-job'),v=Object.fromEntries(new FormData(form));const c=await api('customers','POST',{name:v.client,document:v.customer_document,phone:v.phone,email:v.email});if(form.isConnected)selectCustomer(c);break;}
        case 'close':close();break;
        case 'add-line':root.querySelector('#ft-lines').insertAdjacentHTML('beforeend',line());state.dirty=true;break;
        case 'remove-line':b.closest('tr').remove();state.dirty=true;totals();break;
        case 'all':state.customer=0;state.bike='';state.page=1;await load();break;
        case 'history':{const bike=state.job.bike_key;if(close()){state.customer=0;state.bike=bike;state.q='';state.status='';state.page=1;state.tab='jobs';await load();}break;}
        case 'customer-history':{const id=state.job.data.customer_id;if(close()){state.customer=id;state.bike='';state.q='';state.status='';state.page=1;state.tab='jobs';await load();}break;}
        case 'repeat':{const old=state.job;if(close()){state.editStage='reception';editor(blank(old));}break;}
        case 'print':printJob();break;
        case 'detect-type':state.profileManual=false;await lookupBikeType();break;
        case 'check':b.disabled=true;state.settings=await api('check','POST',{});configView(root.querySelector('#ft-content'));break;
      }
    }catch(err){error(err,root.querySelector('#ft-dialog').open?root.querySelector('#ft-job-error'):root.querySelector('#ft-config-error')||undefined);}
    finally{if(!b.dataset.product)b.disabled=false;}
  });
  shell();
  root.querySelector('#ft-dialog').addEventListener('cancel',e=>{e.preventDefault();close();});
  window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
  api('settings').then(s=>{state.settings=s;return load();}).catch(error);
})();
