import http from 'node:http';
import crypto from 'node:crypto';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function setPdfHeaders(res,headers,download=true){
  const total=Number(headers['x-fusion-pdf-total']),pages=String(headers['x-fusion-pdf-pages']||''),id=String(headers['x-fusion-pdf-id']||'');
  if(!Number.isInteger(total)||total<1||total>300||!/^\d+(,\d+)*$/.test(pages)||!uuid.test(id)||pages.split(',').some(n=>Number(n)<1||Number(n)>total))throw new Error('metadata');
  const raw=String(headers['x-fusion-pdf-name']||'etiquetas_corregidas.pdf');
  if(raw.length>2000)throw new Error('filename');
  const name=decodeURIComponent(raw).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'_').slice(0,200);
  res.setHeader('X-Fusion-Pdf-Total',total);res.setHeader('X-Fusion-Pdf-Pages',pages);res.setHeader('X-Fusion-Pdf-Id',id);
  res.setHeader('X-Fusion-Pdf-Name',encodeURIComponent(name));
  res.setHeader('Content-Disposition',`${download?'attachment':'inline'}; filename="etiquetas_corregidas.pdf"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g,'%27')}`);
}

function parseRule(raw){
  if(typeof raw!=='string'||raw.length>1024)throw new Error();
  const rule=JSON.parse(raw),keys=['weight','width','height','length'];
  if(!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).sort().join(',')!=='after,before')throw new Error();
  for(const values of [rule.before,rule.after]){
    if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).sort().join(',')!=='height,length,weight,width')throw new Error();
    for(const key of keys){const value=values[key];if(typeof value!=='string'||!(key==='weight'?/^[0-9]{1,6}$/:/^[0-9]{1,4}$/).test(value)||Number(value)===0)throw new Error();}
  }
  if(keys.every(key=>rule.before[key]===rule.after[key]))throw new Error();
  return JSON.stringify(rule);
}

export function createPdfProxy(secret, port=8213){
  const token=crypto.createHmac('sha256',secret).update('pdf-corrector-worker-v1').digest('hex');
  let busy=false;
  return async function handlePdf(req,res,user=''){
    const error=(status,message)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({message}));}};
    if(busy)return error(429,'Hay otro PDF en proceso. Volvé a intentar en unos segundos.');
    if(!/^application\/pdf(?:;|$)/i.test(req.headers['content-type']||''))return error(415,'Subí un archivo PDF.');
    if(Number(req.headers['content-length'])>10*1024*1024)return error(413,'El PDF supera los 10 MB.');
    const filename=req.headers['x-fusion-pdf-filename']||'etiquetas.pdf';
    try{if(typeof filename!=='string'||filename.length>2000)throw new Error();decodeURIComponent(filename);}catch{return error(400,'Nombre de archivo no válido.');}
    let rule;
    try{if(req.headers['x-fusion-pdf-rule']!==undefined)rule=parseRule(req.headers['x-fusion-pdf-rule']);}
    catch{return error(400,'Revisá entrada y salida: usá enteros positivos (peso hasta 6 dígitos, medidas hasta 4) y cambiá al menos un valor.');}
    busy=true;
    let upstream;
    try{
      req.setTimeout(15000,()=>req.destroy());
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>10*1024*1024){error(413,'El PDF supera los 10 MB.');return;}chunks.push(chunk);}
      req.setTimeout(0);
      if(bytes<5)return error(400,'El archivo no es un PDF válido.');
      const body=Buffer.concat(chunks);
      if(body.subarray(0,5).toString()!=='%PDF-')return error(400,'El archivo no es un PDF válido.');
      await new Promise(resolve=>{
        const finish=()=>resolve();
        upstream=http.request({hostname:'127.0.0.1',port,path:'/correct',method:'POST',timeout:43000,
          headers:{'Content-Type':'application/pdf','Content-Length':bytes,Authorization:'Bearer '+token,'X-Fusion-Pdf-Filename':filename,'X-Fusion-Pdf-User':encodeURIComponent(user),...(rule?{'X-Fusion-Pdf-Rule':rule}:{})}},response=>{
          if(response.statusCode===200){try{setPdfHeaders(res,response.headers);}catch{response.destroy();error(503,'No se pudo verificar el PDF guardado. Revisá el historial antes de reintentar.');finish();return;}}
          res.statusCode=response.statusCode;
          res.setHeader('Content-Type',response.statusCode===200?'application/pdf':'application/json; charset=utf-8');
          let received=0;
          response.on('data',chunk=>{received+=chunk.length;if(received>20*1024*1024){response.destroy();res.destroy();}});
          response.on('end',finish);response.on('error',()=>{if(res.headersSent)res.destroy();else error(503,'Se interrumpió la descarga. Volvé a intentar.');finish();});
          response.pipe(res);
        });
        upstream.on('timeout',()=>upstream.destroy(new Error('timeout')));
        upstream.on('error',()=>{error(503,'No se pudo confirmar el resultado. Revisá el historial antes de volver a corregir el archivo.');finish();});
        res.once('close',()=>{if(!res.writableFinished)upstream.destroy();});
        upstream.end(body);
      });
    }catch{error(400,'No se pudo recibir el archivo completo. Volvé a cargarlo.');}
    finally{busy=false;}
  };
}

export function createPdfHistory(secret,port=8213){
  const token=crypto.createHmac('sha256',secret).update('pdf-corrector-worker-v1').digest('hex');
  return (req,res,target)=>new Promise(resolve=>{
    const error=message=>{if(res.headersSent)res.destroy();else{res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({message}));}resolve();};
    const file=target.kind==='pdf-file';
    const route=file?'/files/'+target.id:'/history'+new URL(target.local,'http://private.invalid').search;
    const upstream=http.request({hostname:'127.0.0.1',port,path:route,method:req.method,timeout:15000,headers:{Authorization:'Bearer '+token}},response=>{
      if(file&&response.statusCode===200){try{if(response.headers['x-fusion-pdf-id']!==target.id)throw new Error();setPdfHeaders(res,response.headers,target.download);}catch{response.destroy();return error('No se pudo verificar el archivo guardado.');}}
      res.statusCode=response.statusCode;res.setHeader('Content-Type',file&&response.statusCode===200?'application/pdf':'application/json; charset=utf-8');
      let bytes=0;const limit=file?20*1024*1024:512*1024;
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit)response.destroy(new Error('limit'));});
      response.on('error',()=>error('Se interrumpió la consulta al historial.'));response.on('end',resolve);response.pipe(res);
    });
    upstream.on('timeout',()=>upstream.destroy(new Error('timeout')));upstream.on('error',()=>error('El historial no está disponible. Volvé a intentar.'));
    res.once('close',()=>{if(!res.writableFinished)upstream.destroy();});upstream.end();
  });
}
