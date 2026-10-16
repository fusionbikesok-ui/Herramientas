(() => {
  'use strict';
  const $=id=>document.getElementById(id),base='/herramientas/gestion-vps/corregir-etiquetas/';
  const fields=[...document.querySelectorAll('[data-rule-input]')];
  let viewer=null,busy=false,listPage=1,listPages=1,listRequest=0,listController=null,historyItems=[],batchController=null;
  function lock(value){busy=value;for(const el of [...fields,$('pdf-reset-rule'),$('pdf-file'),$('pdf-submit'),$('history-refresh'),$('history-next'),...document.querySelectorAll('[data-history-open],[data-print-today]')])el.disabled=value||el.dataset.empty==='true';}
  function message(text,error=false){$('pdf-status').hidden=false;$('pdf-status').dataset.error=String(error);$('pdf-status').textContent=text;}
  function clearResult(){if(viewer)viewer.destroy();viewer=null;$('pdf-result').hidden=true;$('pdf-download').removeAttribute('href');}
  function readRule(){const rule={};for(const side of ['before','after']){rule[side]={};for(const key of ['weight','width','height','length'])rule[side][key]=$(side+'-'+key).value;}return rule;}
  function resetStatus(){clearResult();$('pdf-status').hidden=true;}
  $('pdf-file').addEventListener('change',resetStatus);
  for(const field of fields)field.addEventListener('input',()=>{field.setCustomValidity('');resetStatus();});
  $('pdf-reset-rule').addEventListener('click',()=>{for(const field of fields){field.value=field.defaultValue;field.setCustomValidity('');}resetStatus();});
  window.addEventListener('pagehide',event=>{batchController?.abort('pagehide');if(!event.persisted&&viewer)viewer.destroy();});

  async function checked(response){
    if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.message||error.error||'No se pudo completar la operación.');}
    return response;
  }
  async function showPdf(response){
    await checked(response);
    if(!/^application\/pdf(?:;|$)/i.test(response.headers.get('content-type')||''))throw new Error('La sesión venció. Volvé a ingresar en Herramientas.');
    const id=response.headers.get('x-fusion-pdf-id')||'',total=Number(response.headers.get('x-fusion-pdf-total'));
    const pages=(response.headers.get('x-fusion-pdf-pages')||'').split(',').map(Number);
    if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isInteger(total)||total<1||total>300||!pages.length||pages.some(n=>!Number.isInteger(n)||n<1||n>total))throw new Error('No se pudo verificar el archivo. Actualizá el historial.');
    const name=decodeURIComponent(response.headers.get('x-fusion-pdf-name')||'etiquetas_corregidas.pdf'),blob=await response.blob();
    clearResult();$('pdf-download').href=base+'files/'+id+'?download=1';$('pdf-download').download=name;
    $('result-title').textContent=name;
    $('pdf-summary').textContent=`${pages.length} ${pages.length===1?'etiqueta corregida':'etiquetas corregidas'} de ${total}. ${total-pages.length} sin cambios.`;
    $('pdf-pages').textContent='Guardado en el historial · Páginas corregidas: '+pages.join(', ')+'.';
    $('pdf-result').hidden=false;$('pdf-print').disabled=true;message('Preparando la vista previa…');
    try{const module=await import('/herramientas/gestion-vps/assets/pdf-render.mjs');viewer=await module.createViewer(blob,pages[0],message);$('pdf-print').disabled=false;$('pdf-status').hidden=true;}
    catch{message('El PDF está guardado. No se pudo cargar la vista previa: podés descargarlo e imprimirlo desde tu visor.',true);}
    $('result-title').focus();$('pdf-result').scrollIntoView({behavior:'smooth',block:'start'});
  }
  async function printCurrent(){
    if(!viewer)return;const button=$('pdf-print');button.disabled=true;button.textContent='Preparando…';
    try{await viewer.print();}catch(error){message(error.message||'No se pudo imprimir. Descargá el PDF e imprimilo desde tu visor.',true);}
    finally{button.disabled=false;button.textContent='Imprimir';}
  }
  $('pdf-open').addEventListener('click',()=>{$('pdf-preview').scrollIntoView({behavior:'smooth',block:'start'});$('pdf-canvas').focus();});
  $('pdf-print').addEventListener('click',async()=>{if(busy||!viewer)return;lock(true);try{await printCurrent();}finally{lock(false);}});
  $('pdf-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;clearResult();const file=$('pdf-file').files[0];
    if(!file)return message('Elegí un archivo PDF.',true);
    if(!/\.pdf$/i.test(file.name))return message('Elegí un archivo con extensión .pdf.',true);
    if(file.size>10*1024*1024)return message('El PDF supera los 10 MB. Dividilo en archivos más pequeños.',true);
    for(const field of fields)if(!/^[0-9]+$/.test(field.value)||Number(field.value)===0){field.setCustomValidity('Ingresá un número entero mayor que cero.');field.reportValidity();return;}
    const rule=readRule();if(Object.keys(rule.before).every(key=>rule.before[key]===rule.after[key]))return message('Cambiá al menos un valor de salida: entrada y salida son iguales.',true);
    lock(true);$('pdf-submit').textContent='Corrigiendo y guardando…';message('Revisando las etiquetas y guardando el resultado.');
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),55000);
    try{
      const response=await fetch(base+'api',{method:'POST',credentials:'same-origin',signal:controller.signal,headers:{'Content-Type':'application/pdf','X-Fusion-CSRF':document.querySelector('meta[name="fusion-csrf"]').content,'X-Fusion-Pdf-Rule':JSON.stringify(rule),'X-Fusion-Pdf-Filename':encodeURIComponent(file.name.slice(0,160))},body:file});
      await showPdf(response);await loadHistory(1);
    }catch(error){message(error.name==='AbortError'?'La respuesta tardó demasiado. Actualizá el historial antes de volver a corregir; el archivo puede haberse guardado.':error.message,true);}
    finally{clearTimeout(timeout);lock(false);$('pdf-submit').textContent='Corregir y guardar';}
  });

  function element(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
  function dayLabel(day){const [y,m,d]=day.split('-');return `${d}/${m}/${y}`;}
  function argentinaToday(){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');}
  function renderHistory(data){
    const list=$('history-list'),openDays=new Set([...list.querySelectorAll('details[open]')].map(group=>group.dataset.day));
    if(data.page===1)historyItems=[];
    const seen=new Set(historyItems.map(item=>item.id));for(const item of data.items)if(!seen.has(item.id)){historyItems.push(item);seen.add(item.id);}
    historyItems.sort((a,b)=>b.day.localeCompare(a.day)||b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
    list.replaceChildren();const today=argentinaToday(),groups=new Map([[today,[]]]);
    for(const item of historyItems){if(!groups.has(item.day))groups.set(item.day,[]);groups.get(item.day).push(item);}
    for(const [day,items] of groups){
      const isToday=day===today,group=element('details',undefined,'pdf-history-day'+(isToday?' pdf-history-today':''));group.dataset.day=day;group.open=isToday||openDays.has(day);
      const summary=element('summary'),heading=element('span',undefined,'pdf-day-label');heading.append(element('strong',isToday?'HOY':dayLabel(day)));
      if(isToday)heading.append(element('span',dayLabel(day),'pdf-note'));
      summary.append(heading,element('span',`${items.length} ${items.length===1?'archivo':'archivos'}`,'pdf-day-count'));group.append(summary);
      const content=element('div',undefined,'pdf-day-files');group.append(content);list.append(group);
      if(isToday){
        const toolbar=element('div',undefined,'pdf-today-toolbar'),button=element('button','Imprimir todos los de HOY','ui-btn ui-btn--primary');
        button.type='button';button.dataset.printToday='true';button.dataset.empty=String(!items.length);button.disabled=busy||!items.length;
        button.addEventListener('click',printToday);toolbar.append(button);
        const cancel=element('button','Cancelar preparación','ui-btn');cancel.type='button';cancel.id='print-today-cancel';cancel.hidden=!batchController;cancel.addEventListener('click',()=>batchController?.abort('user'));toolbar.append(cancel);
        const status=element('p','', 'pdf-note');status.id='print-today-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');toolbar.append(status);content.append(toolbar);
      }
      if(!items.length)content.append(element('p','Todavía no corregiste archivos hoy. Los que guardes aparecerán acá.','pdf-note pdf-day-empty'));
      for(const item of items){
      const row=element('article',undefined,'pdf-history-row'),details=element('div',undefined,'pdf-history-details');
      details.append(element('h4',item.name));
      const time=new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(item.created_at));
      details.append(element('p',`${time} · ${item.total} ${item.total===1?'página':'páginas'} · ${item.changed} ${item.changed===1?'corregida':'corregidas'} · ${Math.max(1,Math.round(item.size/1024))} KB`,'pdf-note'));
      const actions=element('div',undefined,'pdf-history-actions');
      for(const [label,print] of [['Ver',false],['Imprimir',true]]){const button=element('button',label,'ui-btn');button.type='button';button.dataset.historyOpen=item.id;button.disabled=busy;button.setAttribute('aria-label',label+' '+item.name);button.addEventListener('click',()=>openHistory(item.id,print));actions.append(button);}
      const download=element('a','Descargar','ui-btn');download.href=base+'files/'+item.id+'?download=1';download.download=item.name;download.setAttribute('aria-label','Descargar '+item.name);actions.append(download);
      row.append(details,actions);content.append(row);
      }
    }
    listPage=data.page;listPages=data.pages;$('history-pagination').hidden=listPage>=listPages||historyItems.length>=data.total;$('history-next').disabled=busy;
    $('history-status').textContent='';
  }
  async function loadHistory(page=1){
    const sequence=++listRequest;if(listController)listController.abort();listController=new AbortController();const controller=listController;
    const query=new URLSearchParams({page:String(page)});
    $('history-status').textContent='Cargando archivos…';$('history-next').disabled=true;const timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const read=async params=>(await checked(await fetch(base+'history?'+params,{credentials:'same-origin',signal:controller.signal}))).json();
      const data=await read(query);
      // Complete the boundary day so a page of 20 records cannot split its files.
      if(data.page<data.pages&&data.items.length){
        const day=data.items[data.items.length-1].day;let dayPage=1,dayPages=1;
        do{const complete=await read(new URLSearchParams({from:day,to:day,page:String(dayPage)}));data.items.push(...complete.items);dayPages=complete.pages;dayPage++;}while(dayPage<=dayPages);
      }
      if(sequence!==listRequest)return;renderHistory(data);
    }
    catch(error){if(sequence!==listRequest)return;$('history-status').textContent=error.name==='AbortError'?'La consulta tardó demasiado. Usá Actualizar para volver a intentar.':error.message;$('history-next').disabled=false;}
    finally{clearTimeout(timeout);}
  }
  async function openHistory(id,print){
    if(busy)return;lock(true);clearResult();message('Abriendo archivo guardado…');
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),25000);
    try{await showPdf(await fetch(base+'files/'+id,{credentials:'same-origin',signal:controller.signal}));if(print)await printCurrent();}
    catch(error){message(error.name==='AbortError'?'El archivo tardó demasiado en abrirse. Volvé a intentar.':error.message,true);}
    finally{clearTimeout(timeout);lock(false);}
  }
  async function printToday(){
    if(busy)return;lock(true);
    const day=argentinaToday(),status=(text,error=false)=>{const target=$('print-today-status');if(target){target.textContent=text;target.dataset.error=String(error);}};
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);batchController=controller;
    $('print-today-cancel').hidden=false;$('print-today-cancel').textContent='Cancelar preparación';
    try{
      status('Reuniendo los archivos de hoy…');
      const items=[],seen=new Set();let page=1,pages=1;
      do{
        const query=new URLSearchParams({from:day,to:day,page:String(page)});
        const response=await checked(await fetch(base+'history?'+query,{credentials:'same-origin',signal:controller.signal}));const data=await response.json();
        for(const item of data.items){if(item.day!==day||!/^[a-f0-9-]{36}$/.test(item.id))throw new Error('No se pudo verificar la lista de hoy. Actualizá el historial.');if(!seen.has(item.id)){seen.add(item.id);items.push(item);}}
        pages=data.pages;page++;
      }while(page<=pages);
      clearTimeout(timeout);
      if(!items.length)throw new Error('Todavía no hay archivos de hoy para imprimir.');
      const module=await import('/herramientas/gestion-vps/assets/pdf-render.mjs');
      await module.printBatch(items.map(item=>({name:item.name,load:async()=>{
        const downloadController=new AbortController(),downloadTimeout=setTimeout(()=>downloadController.abort(),25000);
        const cancel=()=>downloadController.abort();controller.signal.addEventListener('abort',cancel,{once:true});
        try{
          controller.signal.throwIfAborted();
          const response=await checked(await fetch(base+'files/'+item.id,{credentials:'same-origin',signal:downloadController.signal}));
          if(!/^application\/pdf(?:;|$)/i.test(response.headers.get('content-type')||'')||response.headers.get('x-fusion-pdf-id')!==item.id)throw new Error('No se pudo verificar '+item.name+'. No se imprimió el grupo.');
          return await response.blob();
        }finally{clearTimeout(downloadTimeout);controller.signal.removeEventListener('abort',cancel);}
      }})),status,{signal:controller.signal,onDialog:()=>{const button=$('print-today-cancel');if(button)button.textContent='Volver al panel';}});
      status('Se cerró el diálogo de impresión. Podés volver a imprimir el grupo cuando lo necesites.');
    }catch(error){status(controller.signal.reason==='user'?'Preparación cerrada. Podés volver a imprimir el grupo.':error.name==='AbortError'?'La descarga tardó demasiado. Volvé a intentar; no se imprimió el grupo.':error.message||'No se pudo preparar el grupo. Volvé a intentar.',controller.signal.reason!=='user');}
    finally{clearTimeout(timeout);batchController=null;const cancel=$('print-today-cancel');if(cancel)cancel.hidden=true;lock(false);}
  }
  $('history-refresh').addEventListener('click',()=>loadHistory(1));
  $('history-next').addEventListener('click',()=>loadHistory(Math.min(listPages,listPage+1)));
  loadHistory(1);
})();
