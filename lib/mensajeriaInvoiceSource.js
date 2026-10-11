import crypto from 'node:crypto';

const failure = (code, message, status=502) => Object.assign(new Error(message), {code,status});
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value)>0 && /^\d{1,15}$/.test(String(value));

// This adapter is deliberately read-only and fixed to the existing store. No
// browser-supplied URL, credential, customer phone or document bytes are accepted.
export function createInvoiceSource({env=process.env,fetchImpl=fetch}={}) {
  return async function read({orderId,invoiceId,phone}) {
    if(!positiveId(orderId) || invoiceId!=null && !positiveId(invoiceId) || !/^\+?[1-9]\d{7,14}$/.test(phone||'')) throw failure('invalid_order','Pedido o teléfono inválido.',400);
    let base;
    try {base=new URL(env.WOO_URL);} catch {throw failure('invoice_source_unavailable','No está configurada la lectura del facturador web.',503);}
    if(base.protocol!=='https:' || !['fusionbikes.com.ar','www.fusionbikes.com.ar'].includes(base.hostname) || base.port || base.username || base.password || !env.WOO_CK || !env.WOO_CS) throw failure('invoice_source_unavailable','No está configurada la lectura del facturador web.',503);
    const route=`/wp-json/wc/v3/fusion-herramientas/messaging-orders/${orderId}${invoiceId!=null?`/invoices/${invoiceId}/pdf`:''}`;
    let response;
    try {response=await fetchImpl(new URL(route,base),{method:'GET',headers:{accept:'application/json',authorization:'Basic '+Buffer.from(`${env.WOO_CK}:${env.WOO_CS}`).toString('base64'),'X-Fusion-Contact-Phone':phone.startsWith('+')?phone:'+'+phone},redirect:'error',signal:AbortSignal.timeout(20000)});} catch {throw failure('invoice_source_unavailable','No se pudo consultar el facturador web. Volvé a intentarlo.');}
    const limit=invoiceId!=null?12*1024*1024:1024*1024;
    if(Number(response.headers.get('content-length'))>limit) {await response.body?.cancel();throw failure('invoice_too_large','El comprobante supera el tamaño permitido.');}
    const chunks=[];let size=0;
    try {for await(const chunk of response.body) {size+=chunk.length;if(size>limit)throw new Error('limit');chunks.push(Buffer.from(chunk));}} catch {throw failure('invoice_read_failed','No se pudo obtener el comprobante completo. Volvé a intentarlo.');}
    let body;try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw failure('invoice_read_failed','El facturador no devolvió un comprobante válido.');}
    if(!response.ok || body.ok===false) {
      if(response.status===404)throw failure('invoice_not_found','No se encontró un comprobante emitido para este pedido.',404);
      if(response.status===403)throw failure('invoice_contact_mismatch','No se pudo confirmar que el comprobante corresponda a este contacto.',403);
      throw failure('invoice_source_unavailable','No se pudo consultar el facturador web. Volvé a intentarlo.',503);
    }
    if(Number(body.order_id)!==Number(orderId))throw failure('invoice_identity_mismatch','El comprobante no coincide con el pedido seleccionado.',409);
    if(invoiceId==null) {
      if(!Array.isArray(body.invoices)||body.invoices.length>100)throw failure('invoice_read_failed','La lista de comprobantes no es válida.');
      return {invoices:body.invoices.filter(i=>positiveId(i.id)).map(i=>({id:Number(i.id),label:String(i.label||`Comprobante ${i.id}`).slice(0,180),date:String(i.date||'').slice(0,40),total:i.total==null?null:String(i.total).slice(0,30)}))};
    }
    if(Number(body.invoice_id)!==Number(invoiceId) || typeof body.data_base64!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data_base64))throw failure('invoice_read_failed','El comprobante no es válido.');
    const bytes=Buffer.from(body.data_base64,'base64');
    if(bytes.length<16 || bytes.length>8*1024*1024 || bytes.subarray(0,5).toString()!=='%PDF-' || !/^[a-f0-9]{64}$/.test(body.sha256||'') || crypto.createHash('sha256').update(bytes).digest('hex')!==body.sha256)throw failure('invoice_read_failed','No se pudo validar el PDF del comprobante.');
    return {data_base64:body.data_base64,name:String(body.filename||`Factura-pedido-${orderId}.pdf`).replace(/[^\p{L}\p{N}_. -]/gu,'_').slice(0,160),mime:'application/pdf'};
  };
}
