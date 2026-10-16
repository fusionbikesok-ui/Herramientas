import {getDocument,GlobalWorkerOptions} from './pdfjs/pdf.min.mjs';
GlobalWorkerOptions.workerSrc='/herramientas/gestion-vps/assets/pdfjs/pdf.worker.min.mjs';

// One print document for the complete daily group; individual viewing stays independent.
export async function printBatch(files,onStatus,{signal,onDialog=()=>{}}={}){
  const tasks=[],plan=[],urls=[];let frame=null,bytes=0;
  const check=()=>{if(signal?.aborted)throw new DOMException('Preparación cancelada.','AbortError');};
  const abort=()=>{for(const task of tasks)task.destroy().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{
    for(let index=0;index<files.length;index++){
      check();
      onStatus(`Cargando archivo ${index+1} de ${files.length}…`);
      const blob=await files[index].load();bytes+=blob.size;
      if(bytes>60*1024*1024)throw new Error('El grupo es demasiado grande para imprimirlo junto. Imprimí los archivos por separado.');
      const task=getDocument({data:new Uint8Array(await blob.arrayBuffer()),isEvalSupported:false,stopAtErrors:true});tasks.push(task);
      let doc;try{doc=await task.promise;}catch{check();throw new Error('No se pudo abrir '+files[index].name+'. No se imprimió el grupo.');}
      if(plan.length+doc.numPages>300)throw new Error('El grupo supera las 300 páginas. Imprimí los archivos por separado.');
      for(let n=1;n<=doc.numPages;n++){
        check();
        const page=await doc.getPage(n),normal=page.getViewport({scale:1});
        if(!Number.isFinite(normal.width)||!Number.isFinite(normal.height)||normal.width<=0||normal.height<=0)throw new Error('Una página tiene un tamaño no válido. No se imprimió el grupo.');
        plan.push({doc,page:n,width:normal.width,height:normal.height,name:files[index].name});page.cleanup();
      }
    }
    if(!plan.length)throw new Error('No hay páginas para imprimir.');
    const pixels=scale=>plan.reduce((sum,item)=>{const factor=Math.min(scale,3000/Math.max(item.width,item.height));return sum+Math.ceil(item.width*factor)*Math.ceil(item.height*factor);},0);
    // Keep physical size, prefer 288 dpi and reduce to 200 dpi before the 3000px edge cap.
    let scale=4;
    if(pixels(scale)>64000000){
      let low=200/72,high=4;
      if(pixels(low)>64000000)throw new Error('El grupo es demasiado grande para imprimirlo junto con buena calidad. Imprimí los archivos por separado.');
      for(let n=0;n<20;n++){const middle=(low+high)/2;if(pixels(middle)<=64000000)low=middle;else high=middle;}
      scale=low;
    }
    frame=document.createElement('iframe');frame.title='Todos los archivos de HOY preparados para imprimir';frame.className='pdf-print-frame';document.body.append(frame);
    const paper=frame.contentDocument;paper.open();paper.write('<!doctype html><html><head><title>Etiquetas de HOY</title></head><body></body></html>');paper.close();
    const styles=paper.createElement('style');styles.textContent='html,body{margin:0;padding:0}section{break-after:page;margin:0;padding:0;overflow:hidden}section:last-child{break-after:auto}img{display:block;width:100%;height:100%}';paper.head.append(styles);
    for(let index=0;index<plan.length;index++){
      check();
      const item=plan[index];onStatus(`Preparando ${files.length} archivos: página ${index+1} de ${plan.length}…`);
      const page=await item.doc.getPage(item.page),viewport=page.getViewport({scale:Math.min(scale,3000/Math.max(item.width,item.height))});
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      try{
        await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
        const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!png)throw new Error('No se pudo preparar una página. No se imprimió el grupo.');
        const url=URL.createObjectURL(png);urls.push(url);
        const section=paper.createElement('section'),image=paper.createElement('img'),name='batch'+index;
        const width=item.width*25.4/72,height=item.height*25.4/72;
        styles.textContent+=`@page ${name}{size:${width}mm ${height}mm;margin:0}.${name}{page:${name};width:${width}mm;height:${height}mm}`;
        section.className=name;image.src=url;image.alt=item.name+' · página '+item.page;section.append(image);paper.body.append(section);await image.decode();
      }finally{canvas.width=0;canvas.height=0;page.cleanup();}
    }
    onStatus(`${files.length} ${files.length===1?'archivo':'archivos'} · ${plan.length} páginas listas. Elegí la impresora y tamaño real (100 %).`);
    check();onDialog();
    await new Promise((resolve,reject)=>{
      const win=frame.contentWindow;let started=false,timer,settled=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);win.removeEventListener('beforeprint',before);win.removeEventListener('afterprint',after);signal?.removeEventListener('abort',cancel);error?reject(error):resolve();};
      const before=()=>{started=true;},after=()=>finish(),cancel=()=>finish(new DOMException('Preparación cancelada.','AbortError'));
      win.addEventListener('beforeprint',before,{once:true});win.addEventListener('afterprint',after,{once:true});signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted)return cancel();
      timer=setTimeout(()=>{if(!started)finish(new Error('El navegador no abrió la impresión. Volvé a intentar o imprimí los archivos por separado.'));},1500);
      try{win.focus();win.print();}catch(error){finish(error);}
    });
  }finally{
    signal?.removeEventListener('abort',abort);
    if(frame)frame.remove();for(const url of urls)URL.revokeObjectURL(url);
    await Promise.allSettled(tasks.map(task=>task.destroy()));
  }
}

export async function createViewer(blob, firstPage, onStatus){
  const loading=getDocument({data:new Uint8Array(await blob.arrayBuffer()),isEvalSupported:false,stopAtErrors:true});
  const doc=await loading.promise;
  const canvas=document.getElementById('pdf-canvas'),select=document.getElementById('pdf-page-select');
  const previous=document.getElementById('pdf-previous'),next=document.getElementById('pdf-next');
  select.replaceChildren();
  for(let n=1;n<=doc.numPages;n++){const option=document.createElement('option');option.value=n;option.textContent=`Página ${n} de ${doc.numPages}`;select.append(option);}
  let current=firstPage,rendering=null,printFrame=null,printUrls=[],disposed=false;
  async function show(n){
    if(disposed)return;
    n=Math.max(1,Math.min(doc.numPages,Number(n)||1));current=n;select.value=n;
    previous.disabled=true;next.disabled=true;select.disabled=true;
    try{
      if(rendering){rendering.cancel();await rendering.promise.catch(()=>{});}
      const page=await doc.getPage(n),normal=page.getViewport({scale:1});
      const scale=Math.min(3,1800/Math.max(normal.width,normal.height));
      const viewport=page.getViewport({scale});canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      canvas.style.width=Math.min(normal.width*2,550)+'px';
      rendering=page.render({canvasContext:canvas.getContext('2d'),viewport});await rendering.promise;
      canvas.setAttribute('aria-label',`Vista previa de la página ${n} de ${doc.numPages}`);
    }finally{rendering=null;previous.disabled=n<=1;next.disabled=n>=doc.numPages;select.disabled=false;}
  }
  previous.onclick=()=>show(current-1).catch(()=>onStatus('No se pudo mostrar esta página. Podés descargar el PDF.',true));
  next.onclick=()=>show(current+1).catch(()=>onStatus('No se pudo mostrar esta página. Podés descargar el PDF.',true));
  select.onchange=()=>show(select.value).catch(()=>onStatus('No se pudo mostrar esta página. Podés descargar el PDF.',true));
  function clearPrint(){if(printFrame)printFrame.remove();printFrame=null;for(const url of printUrls)URL.revokeObjectURL(url);printUrls=[];}
  async function print(){
    let pixels=0;
    for(let n=1;n<=doc.numPages;n++){
      const page=await doc.getPage(n),normal=page.getViewport({scale:1});
      const scale=Math.min(4,3000/Math.max(normal.width,normal.height));
      pixels+=Math.ceil(normal.width*scale)*Math.ceil(normal.height*scale);
      if(pixels>64000000)throw new Error('Este PDF es muy grande para imprimirlo desde el navegador. Descargá el PDF y usá la opción de impresión de tu visor.');
    }
    clearPrint();printFrame=document.createElement('iframe');printFrame.title='Documento preparado para imprimir';printFrame.className='pdf-print-frame';document.body.append(printFrame);
    const paper=printFrame.contentDocument;paper.open();paper.write('<!doctype html><html><head><title>Etiquetas corregidas</title></head><body></body></html>');paper.close();
    printFrame.contentWindow.addEventListener('afterprint',()=>setTimeout(clearPrint,0),{once:true});
    const styles=paper.createElement('style');styles.textContent='html,body{margin:0;padding:0}section{break-after:page;margin:0;padding:0;overflow:hidden}section:last-child{break-after:auto}img{display:block;width:100%;height:100%}';paper.head.append(styles);
    for(let n=1;n<=doc.numPages;n++){
      if(disposed)throw new Error('Elegí nuevamente el archivo para imprimir.');
      onStatus(`Preparando impresión: página ${n} de ${doc.numPages}…`);
      const page=await doc.getPage(n),normal=page.getViewport({scale:1});
      const viewport=page.getViewport({scale:Math.min(4,3000/Math.max(normal.width,normal.height))});
      const printCanvas=document.createElement('canvas');printCanvas.width=Math.ceil(viewport.width);printCanvas.height=Math.ceil(viewport.height);
      await page.render({canvasContext:printCanvas.getContext('2d'),viewport}).promise;
      const png=await new Promise(resolve=>printCanvas.toBlob(resolve,'image/png'));if(!png)throw new Error('No se pudo preparar la impresión. Descargá el PDF e imprimilo desde tu visor.');
      const url=URL.createObjectURL(png);printUrls.push(url);
      const section=paper.createElement('section'),image=paper.createElement('img');
      const width=normal.width*25.4/72,height=normal.height*25.4/72;
      styles.textContent+=`@page label${n}{size:${width}mm ${height}mm;margin:0}.label${n}{page:label${n};width:${width}mm;height:${height}mm}`;
      section.className='label'+n;image.src=url;image.alt='Etiqueta '+n;section.append(image);paper.body.append(section);await image.decode();
      printCanvas.width=0;printCanvas.height=0;page.cleanup();
    }
    onStatus('Documento listo. Elegí la impresora y usá tamaño real (100 %).');
    printFrame.contentWindow.focus();printFrame.contentWindow.print();
  }
  await show(firstPage);
  return {show,print,destroy(){disposed=true;if(rendering)rendering.cancel();clearPrint();loading.destroy();}};
}
