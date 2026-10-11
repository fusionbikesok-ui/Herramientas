import {getDocument,GlobalWorkerOptions} from './pdfjs/pdf.min.mjs';
GlobalWorkerOptions.workerSrc='/herramientas/gestion-vps/assets/pdfjs/pdf.worker.min.mjs';

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
