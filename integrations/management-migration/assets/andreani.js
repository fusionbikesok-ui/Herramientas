/* Fusion Bikes — Andreani VPS. Current administrator session and CSRF required. */
(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dialog = $('#fbam-dialog'), editor = $('#fbam-editor');
  if (!dialog) return;
  let current = null, dirty = false, saving = false, timer, sequence = 0;
  async function api(action, data = {}) {
    const body = JSON.stringify({action,...data});
    const response = await fetch(FBAM.url, {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-Fusion-CSRF':FBAM.csrf}, body});
    let json;
    try { json = await response.json(); } catch (_) { throw new Error('No se pudo leer la respuesta. Recargá la página para renovar la sesión.'); }
    if (!response.ok || !json.success) throw new Error(json.message || json.data?.message || 'No se pudo completar la operación.');
    return json.data;
  }
  function selections() {
    const selected = $$('.fbam-pick:checked');
    $('#fbam-selected').textContent = selected.length;
    $('#fbam-download').disabled = !selected.length;
  }
  $$('.fbam-pick').forEach(c => c.addEventListener('change', selections));
  $('#fbam-all').addEventListener('change', e => {
    $$('.fbam-pick').filter(c => !c.closest('tr').hidden).forEach(c => { c.checked = e.target.checked; });
    selections();
  });
  $('#fbam-method').addEventListener('input', e => {
    const q = e.target.value.toLocaleLowerCase();
    $$('tr[data-id]').forEach(row => {
      row.hidden = !row.dataset.method.toLocaleLowerCase().includes(q);
      if (row.hidden) $('.fbam-pick', row).checked = false;
    });
    $('#fbam-all').checked = false; selections();
  });
  function close() {
    if (saving) return;
    if (dirty && !window.confirm('Hay cambios sin guardar. ¿Cerrar la revisión?')) return;
    sequence++; clearTimeout(timer); dialog.close(); current = null; dirty = false;
  }
  $('#fbam-close').addEventListener('click', close);
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  const field = (key, label, value, type = 'text', extra = '') => `<label>${label}<input name="${key}" type="${type}" value="${escape(value)}" ${extra}></label>`;
  function parcel(p, i) {
    return `<div class="fbam-parcel" data-parcel><div class="fbam-parcel-head"><b>Bulto ${i+1}</b><button type="button" class="button-link-delete" data-remove>Quitar</button></div><div class="fbam-grid"><label class="span2">Tipo de paquete<select name="profile"><option value="auto" ${p.profile_mode==='auto'?'selected':''}>Automático según los productos</option><option value="bike" ${p.profile_mode!=='auto'&&p.profile==='bike'?'selected':''}>Bicicletas · 30 × 20 × 40 cm · 9.000 g</option><option value="other" ${p.profile_mode!=='auto'&&p.profile==='other'?'selected':''}>Resto · 12 × 25 × 30 cm · 1.000 g</option><option value="manual" ${p.profile_mode!=='auto'&&(!p.profile||p.profile==='manual')?'selected':''}>Personalizado / paquete guardado</option></select></label><label class="span2">Paquete guardado<select name="saved"><option value="">Ingresar peso y medidas</option>${FBAM.packages.map(v => `<option value="${escape(v)}" ${p.saved===v?'selected':''}>${escape(v)}</option>`).join('')}</select></label>${field('value','Valor declarado fijo ($ ARS)',FBAM.declaredValue,'text','readonly')}${field('weight','Peso embalado (gramos)',p.weight,'text','inputmode="decimal"')}${field('height','Alto (cm)',p.height,'text','inputmode="decimal"')}${field('width','Ancho (cm)',p.width,'text','inputmode="decimal"')}${field('depth','Profundidad (cm)',p.depth,'text','inputmode="decimal"')}</div></div>`;
  }
  function draftFromForm() {
    const f = $('#fbam-review-form');
    const d = {};
    ['service','first_name','last_name','dni','email','phone_code','phone_number','street','number','floor','apartment','destination','branch','observations'].forEach(k => { d[k] = f.elements[k]?.value || ''; });
    d.reviewed = f.elements.reviewed.checked;
    d.packages = $$('[data-parcel]',f).map(p => Object.fromEntries(['profile','saved','value','weight','height','width','depth'].map(k => [k, $(`[name="${k}"]`,p).value])));
    d.packages.forEach(p=>{p.profile_mode=p.profile==='auto'?'auto':'fixed';if(p.profile_mode==='auto')p.profile=current.auto_package.profile;});
    return d;
  }
  function packageState() {
    $$('[data-parcel]',editor).forEach((p,i) => {
      $('.fbam-parcel-head b',p).textContent = `Bulto ${i+1}`;
      $('[data-remove]',p).hidden = $$('[data-parcel]',editor).length===1;
      const saved = $('[name="saved"]',p).value;
      ['weight','height','width','depth'].forEach(k => { $(`[name="${k}"]`,p).disabled=!!saved; });
    });
    const total = $$('[data-parcel] [name="value"]',editor).reduce((n,x) => n + (Number(x.value.replace(',','.')) || 0),0);
    $('#fbam-parcel-total').textContent = `Valor declarado total: $ ${total.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})} ARS`;
  }
  function serviceState() {
    const branch = $('[name="service"]',editor).value==='branch';
    $('#fbam-home-fields').hidden = branch;
    $('#fbam-branch-fields').hidden = !branch;
  }
  function problems(errors) {
    const box = $('#fbam-problems');
    box.className = errors.length ? 'fbam-problems' : 'fbam-success';
    box.innerHTML = errors.length ? `<b>Falta completar</b><ul>${errors.map(e=>`<li>${escape(e)}</li>`).join('')}</ul>` : 'Datos listos para exportar.';
  }
  function render(order) {
    const d=order.draft;
    $('#fbam-dialog-title').textContent=`Revisar pedido #${order.number}`;
    editor.innerHTML = `<div class="fbam-origin">${order.source_changed?'<p class="fbam-problems">El pedido cambió en la tienda. Volvé a revisar todos los datos antes de guardar.</p>':''}<b>${escape(order.products.join(' · '))}</b><p>${escape(order.address_original)}</p><p>Celular del pedido: <strong>${escape(order.phone_original || 'Sin cargar')}</strong> · Envío: ${escape(order.method || 'Sin método')}</p></div>
      <form id="fbam-review-form"><div class="fbam-section"><h3>Destinatario</h3><div class="fbam-grid">${field('first_name','Nombre *',d.first_name)}${field('last_name','Apellido *',d.last_name)}${field('dni','DNI *',d.dni,'text','inputmode="numeric"')}${field('email','Email *',d.email,'email')}${field('phone_code','Código de área * (sin 0)',d.phone_code,'text','inputmode="numeric"')}${field('phone_number','Celular * (sin 15)',d.phone_number,'text','inputmode="numeric"')}</div><p class="description">El teléfono se separa automáticamente cuando tiene un código de área reconocible. Revisá los datos si quedan vacíos.</p><button type="button" class="button" id="fbam-split-phone">Separar celular del pedido</button><p id="fbam-phone-status" role="status">${order.phone_detected?.code ? 'Detectado: '+escape(order.phone_detected.code)+' + '+escape(order.phone_detected.number) : 'No se pudo separar automáticamente el teléfono original.'}</p></div>
      <div class="fbam-section"><h3>Entrega</h3><label>Servicio<select name="service"><option value="home" ${d.service==='home'?'selected':''}>A domicilio</option><option value="branch" ${d.service==='branch'?'selected':''}>A sucursal</option><option value="today" ${d.service==='today'?'selected':''}>Llega hoy</option></select></label><div id="fbam-home-fields"><div class="fbam-grid">${field('street','Calle *',d.street)}${field('number','Número *',d.number)}${field('floor','Piso',d.floor)}${field('apartment','Departamento',d.apartment)}</div><label>Provincia / localidad / CP *<input name="destination" value="${escape(d.destination)}" list="fbam-destination-options" autocomplete="off" data-search="destination" placeholder="Buscá, por ejemplo: CORDOBA 5000"></label><datalist id="fbam-destination-options"></datalist><small class="fbam-search-help">Escribí al menos 2 caracteres y elegí un destino de la lista.</small>${field('observations','Observaciones',d.observations)}<p class="description">La dirección se separa en calle y número; el barrio y otros complementos se conservan en observaciones. Si pegás una dirección completa, dejá Número vacío y guardá para separarla. Revisá los casos que queden pendientes.</p></div><div id="fbam-branch-fields"><label>Sucursal *<input name="branch" value="${escape(d.branch)}" list="fbam-branch-options" autocomplete="off" data-search="branch" placeholder="Buscá por nombre de sucursal"></label><datalist id="fbam-branch-options"></datalist></div><p class="description">“Llega hoy” usa las localidades habilitadas en tu plantilla. Confirmá disponibilidad y horario en Andreani.</p></div>
      <div class="fbam-section"><h3>Bultos</h3><p>${order.auto_package?.profile==='bike'?'Se detectaron bicicletas: 30 × 20 × 40 cm y 9.000 g.':order.auto_package?.profile==='other'?'Sin bicicletas: 12 × 25 × 30 cm y 1.000 g, también en pedidos con varios productos.':'Elegí el tipo de paquete. Revisá las categorías de bicicletas en los ajustes si no se detectan.'} Orden: alto × ancho × profundidad. Podés cambiar cada bulto.</p><div id="fbam-parcels">${d.packages.map(parcel).join('')}</div><button type="button" class="button" id="fbam-add">+ Agregar bulto</button><b id="fbam-parcel-total"></b><p class="description">Cada bulto genera una fila de envío independiente con valor declarado fijo de $30.000 ARS, cualquiera sea el importe o la moneda del pedido.</p></div>
      <label class="fbam-check"><input type="checkbox" name="reviewed" ${d.reviewed?'checked':''}> Revisé destinatario, servicio, bultos y valores declarados.</label><div id="fbam-problems" role="status" aria-live="polite"></div><div class="fbam-modal-actions"><span id="fbam-save-status" role="status"></span><button type="submit" class="button button-primary" id="fbam-save">Guardar revisión</button></div></form>`;
    packageState(); serviceState(); problems(order.errors);
    const form=$('#fbam-review-form');
    form.addEventListener('input', e => {
      dirty=true;
      if(e.target.name!=='reviewed') form.elements.reviewed.checked=false;
      if(['weight','height','width','depth'].includes(e.target.name)) $('[name="profile"]',e.target.closest('[data-parcel]')).value='manual';
      if(e.target.name==='value') packageState();
    });
    form.addEventListener('change', e => {
      dirty=true; if(e.target.name!=='reviewed') form.elements.reviewed.checked=false;
      if(e.target.name==='profile') {
        const p=e.target.closest('[data-parcel]'), values=e.target.value==='auto'?current.auto_package:FBAM.profiles[e.target.value];
        if(values) ['saved','weight','height','width','depth'].forEach(k=>{ $(`[name="${k}"]`,p).value=values[k]; });
      }
      if(e.target.name==='saved') $('[name="profile"]',e.target.closest('[data-parcel]')).value='manual';
      packageState();
      if(e.target.name==='service'){ serviceState(); sequence++; clearTimeout(timer); $('#fbam-destination-options').replaceChildren(); }
    });
    $('#fbam-split-phone').addEventListener('click', async e=>{
      const button=e.currentTarget, orderId=current.id; button.disabled=true;
      try {
        const phone=await api('phone',{phone:current.phone_original});
        if(!dialog.open || current?.id!==orderId) return;
        form.elements.phone_code.value=phone.code; form.elements.phone_number.value=phone.number;
        form.elements.reviewed.checked=false; dirty=true;
        $('#fbam-phone-status').textContent=`Separado: ${phone.code} + ${phone.number}`;
      } catch(err) { if(dialog.open && current?.id===orderId) $('#fbam-phone-status').textContent=err.message; }
      finally {button.disabled=false;}
    });
    form.addEventListener('click', e => {
      const remove=e.target.closest('[data-remove]');
      if(remove && $$('[data-parcel]').length>1) { remove.closest('[data-parcel]').remove(); dirty=true; form.elements.reviewed.checked=false; packageState(); }
    });
    $('#fbam-add').addEventListener('click', () => {
      const count=$$('[data-parcel]').length;
      if(count>=20) return window.alert('Máximo 20 bultos por pedido.');
      $('#fbam-parcels').insertAdjacentHTML('beforeend',parcel({...current.auto_package,value:FBAM.declaredValue},count));
      dirty=true; form.elements.reviewed.checked=false; packageState();
    });
    $$('[data-search]',form).forEach(input => input.addEventListener('input', () => {
      clearTimeout(timer); const ticket=++sequence;
      const kind=input.dataset.search==='branch'?'branches':(form.elements.service.value==='today'?'today':'destinations');
      timer=setTimeout(async () => {
        try {
          const values=await api('search',{kind,q:input.value});
          if(ticket!==sequence || !dialog.open) return;
          const list=document.getElementById(input.getAttribute('list'));
          list.replaceChildren(...values.map(v=>{const option=document.createElement('option');option.value=v;return option;}));
        } catch(e) { if(ticket===sequence) $('#fbam-save-status').textContent=e.message; }
      },250);
    }));
    form.addEventListener('submit',async e=>{
      e.preventDefault(); if(saving) return; saving=true; $('#fbam-save').disabled=true;
      $('#fbam-save-status').textContent='Guardando…';
      try {
        const updated=await api('save',{id:current.id,revision:current.revision,draft:draftFromForm()});
        current=updated; dirty=false;
        // Show normalized address and recovered parcels exactly as saved.
        // Automatic changes clear the confirmation and must remain visible.
        render(updated);
        const row=$(`tr[data-id="${updated.id}"]`), ready=$('.fbam-ready',row);
        row.dataset.ready=updated.errors.length?'0':'1';
        ready.textContent=updated.errors.length?'Revisar datos':'Listo para exportar';
        ready.className=`fbam-ready fbam-tag ${updated.errors.length?'warn':'ok'}`;
        $('#fbam-save-status').textContent=updated.errors.length?'Borrador guardado. Completá los datos indicados.':'Revisión guardada. Ya podés cerrar y exportar.';
      } catch(e) { $('#fbam-save-status').textContent=e.message; }
      finally { saving=false; $('#fbam-save').disabled=false; }
    });
  }
  $$('.fbam-review').forEach(button=>button.addEventListener('click',async()=>{
    current=null; dirty=false; editor.textContent='Cargando pedido…'; dialog.showModal();
    const ticket=++sequence;
    try { const data=await api('order',{id:button.dataset.id}); if(ticket!==sequence || !dialog.open) return; current=data;render(data); }
    catch(e){if(ticket===sequence) editor.textContent=e.message;}
  }));
  $('#fbam-export').addEventListener('submit',async e=>{
    e.preventDefault();
    const selected=$$('.fbam-pick:checked').map(x=>x.closest('tr'));
    if(selected.some(r=>r.dataset.ready!=='1')) return window.alert('Revisá y guardá todos los pedidos seleccionados antes de exportar.');
    if(selected.some(r=>r.dataset.exported==='1') && !$('[name="allow_repeat"]').checked) return window.alert('Hay pedidos ya exportados. Habilitá “Permitir reexportar” si necesitás generar nuevamente el archivo.');
    const button=$('#fbam-download'); button.disabled=true; button.textContent='Generando Excel…';
    try {
      const result=await api('export',{ids:selected.map(r=>Number(r.dataset.id)),allow_repeat:$('[name="allow_repeat"]').checked});
      const box=$('#fbam-export-status');box.hidden=false;box.replaceChildren();
      const a=document.createElement('a');a.href=result.url;a.download=result.filename;a.className='button';a.textContent='Descargar '+result.filename;
      box.append('Archivo generado. ',a);a.click();
      selected.forEach(r=>{r.dataset.exported='1';$('.fbam-export-date',r).textContent='Exportado en esta sesión';$('.fbam-pick',r).checked=false;});
      $('#fbam-all').checked=false; selections();
    } catch(err) { window.alert(err.message); }
    finally {button.textContent='Descargar Excel Andreani';selections();}
  });
  $('#fbam-settings-form').addEventListener('submit',async e=>{
    e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;
    try{await api('settings',{bike_categories:[...e.currentTarget.elements.bike_categories.selectedOptions].map(o=>Number(o.value))});$('#fbam-settings-status').textContent=' Perfiles guardados. Se aplican al abrir pedidos sin preparación previa.';}
    catch(err){$('#fbam-settings-status').textContent=err.message;}finally{button.disabled=false;}
  });
})();
