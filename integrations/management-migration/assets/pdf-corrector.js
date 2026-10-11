(() => {
  'use strict';
  const form=document.getElementById('pdf-form'),fileInput=document.getElementById('pdf-file');
  const submit=document.getElementById('pdf-submit'),status=document.getElementById('pdf-status');
  const result=document.getElementById('pdf-result'),preview=document.getElementById('pdf-preview');
  const fields=[...document.querySelectorAll('[data-rule-input]')],reset=document.getElementById('pdf-reset-rule');
  function lockInputs(locked){for(const field of fields)field.disabled=locked;reset.disabled=locked;fileInput.disabled=locked;submit.disabled=locked;}
  function readRule(){const rule={};for(const side of ['before','after']){rule[side]={};for(const key of ['weight','width','height','length'])rule[side][key]=document.getElementById(side+'-'+key).value;}return rule;}
  let objectUrl=null,viewer=null;
  function clearResult(){
    result.hidden=true;if(viewer){viewer.destroy();viewer=null;}
    for(const id of ['pdf-download'])document.getElementById(id).removeAttribute('href');
    if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
  }
  function message(text,error=false){status.hidden=false;status.dataset.error=String(error);status.textContent=text;}
  fileInput.addEventListener('change',()=>{clearResult();status.hidden=true;});
  for(const field of fields)field.addEventListener('input',()=>{field.setCustomValidity('');clearResult();status.hidden=true;});
  reset.addEventListener('click',()=>{for(const field of fields){field.value=field.defaultValue;field.setCustomValidity('');}clearResult();status.hidden=true;});
  window.addEventListener('pagehide',event=>{if(!event.persisted&&objectUrl)URL.revokeObjectURL(objectUrl);});
  form.addEventListener('submit',async event=>{
    event.preventDefault();clearResult();
    const file=fileInput.files[0];
    if(!file)return message('Elegí un archivo PDF.',true);
    if(!/\.pdf$/i.test(file.name))return message('Elegí un archivo con extensión .pdf.',true);
    if(file.size>10*1024*1024)return message('El PDF supera los 10 MB. Dividilo en archivos más pequeños.',true);
    for(const field of fields){if(!/^[0-9]+$/.test(field.value)||Number(field.value)===0){field.setCustomValidity('Ingresá un número entero mayor que cero.');field.reportValidity();return;}}
    const rule=readRule();
    if(Object.keys(rule.before).every(key=>rule.before[key]===rule.after[key]))return message('Cambiá al menos un valor de salida: entrada y salida son iguales.',true);
    lockInputs(true);submit.textContent='Corrigiendo…';
    message('Revisando las etiquetas. Esto puede tardar unos segundos.');
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),45000);
    try{
      const response=await fetch('/herramientas/gestion-vps/corregir-etiquetas/api',{
        method:'POST',credentials:'same-origin',signal:controller.signal,
        headers:{'Content-Type':'application/pdf','X-Fusion-CSRF':document.querySelector('meta[name="fusion-csrf"]').content,'X-Fusion-Pdf-Rule':JSON.stringify(rule)},body:file
      });
      if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.message||error.error||'No se pudo corregir el PDF. Volvé a intentar.');}
      if(!/^application\/pdf(?:;|$)/i.test(response.headers.get('content-type')||''))throw new Error('La sesión venció. Volvé a ingresar en Herramientas.');
      const total=Number(response.headers.get('x-fusion-pdf-total'));
      const pages=(response.headers.get('x-fusion-pdf-pages')||'').split(',').map(Number).filter(n=>Number.isInteger(n)&&n>0);
      if(!Number.isInteger(total)||total<1||!pages.length)throw new Error('No se pudo verificar el resultado. Volvé a intentar.');
      const blob=await response.blob();objectUrl=URL.createObjectURL(blob);
      const originalName=file.name.replace(/\.pdf$/i,'').replace(/[\u0000-\u001f<>:"/\\|?*]/g,'_').slice(0,150);

      const download=document.getElementById('pdf-download');download.href=objectUrl;download.download=originalName+'_corregido.pdf';
      document.getElementById('pdf-summary').textContent=`${pages.length} ${pages.length===1?'etiqueta corregida':'etiquetas corregidas'} de ${total}. ${total-pages.length} sin cambios.`;
      document.getElementById('pdf-pages').textContent='Páginas corregidas: '+pages.join(', ')+'.';
      result.hidden=false;message('Preparando la vista previa…');
      document.getElementById('pdf-print').disabled=true;
      try{const module=await import('/herramientas/gestion-vps/assets/pdf-render.mjs');viewer=await module.createViewer(blob,pages[0],message);status.hidden=true;document.getElementById('pdf-print').disabled=false;}catch{message('El PDF está corregido. No se pudo cargar la vista previa: podés descargarlo e imprimirlo desde tu visor.',true);}
      document.getElementById('result-title').focus();result.scrollIntoView({behavior:'smooth',block:'start'});
    }catch(error){message(error.name==='AbortError'?'La corrección tardó demasiado. Probá con un PDF más pequeño.':error.message,true);}
    finally{clearTimeout(timeout);lockInputs(false);submit.textContent='Corregir etiquetas';}
  });
  document.getElementById('pdf-open').addEventListener('click',()=>{preview.scrollIntoView({behavior:'smooth',block:'start'});document.getElementById('pdf-canvas').focus();});
  document.getElementById('pdf-print').addEventListener('click',async()=>{
    if(!viewer)return;const button=document.getElementById('pdf-print');button.disabled=true;lockInputs(true);button.textContent='Preparando…';
    try{await viewer.print();}catch(error){message(error.message||'No se pudo imprimir. Descargá el PDF e imprimilo desde tu visor.',true);}
    finally{button.disabled=false;lockInputs(false);button.textContent='Imprimir';}
  });
})();
