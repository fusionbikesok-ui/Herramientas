import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class DirectoryError extends Error { constructor(message, status=503) { super(message); this.status=status; } }
export function directoryRoute(local) {
  const u=new URL(local,'http://private.invalid'), route=u.searchParams.get('rest_route');
  if (u.pathname==='/directory/api') return {kind:u.searchParams.get('kind')||'customers',q:u.searchParams.get('q')||'',page:u.searchParams.get('page')||'1',id:u.searchParams.get('id')||''};
  if (route==='/fbpos/v2/customers') return {kind:'pos',q:u.searchParams.get('q')||'',page:'1'};
  if (route==='/fusion-taller/v1/customers') return {kind:'taller',q:u.searchParams.get('q')||'',page:'1'};
  return null;
}
export const normalize=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().trim();
export function createDirectory({path=fileURLToPath(new URL('./directory-cache/directory.sqlite',import.meta.url)),statusPath=fileURLToPath(new URL('./directory-cache/status.json',import.meta.url))}={}) {
  return function readDirectory(request) {
    if (!['customers','orders','customer-orders','status','order','pos','taller'].includes(request.kind)) throw new DirectoryError('Consulta inválida.',400);
    let q=normalize(request.q);
    if(q.length>160||/[\x00-\x1f]/.test(q))throw new DirectoryError('Búsqueda demasiado larga o inválida.',400);
    if (/^[+\d().\-\s]+$/.test(q) && q.replace(/\D/g,'').length>=5) q=q.replace(/\D/g,'');
    if(!/^[1-9]\d{0,5}$/.test(request.page||'1'))throw new DirectoryError('Página inválida.',400);
    let sync;try{sync=JSON.parse(readFileSync(statusPath,'utf8'));}catch{sync={state:'unknown'};}
    let db;try{db=new DatabaseSync(path,{readOnly:true});}catch{throw new DirectoryError(sync.state==='running'?'La primera sincronización está en curso. Volvé a intentar en unos minutos.':'El directorio aún no está disponible.');}
    try {
      const state=Object.fromEntries(db.prepare('SELECT key,value FROM state').all().map(r=>[r.key,JSON.parse(r.value)]));
      const counts=Object.fromEntries(['customers','orders','guests'].map(table=>[table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
      const status={...state,counts,sync,stale:!state.completed_at||Date.now()-Date.parse(state.completed_at)>60*60*1000};
      if(request.kind==='status')return status;
      if(request.kind==='order') {
        if(!/^[1-9]\d{0,14}$/.test(request.id))throw new DirectoryError('Pedido inválido.',400);
        const row=db.prepare('SELECT data FROM orders WHERE id=?').get(Number(request.id));
        if(!row)throw new DirectoryError('Pedido no encontrado en la copia local.',404);
        return {order:JSON.parse(row.data),status};
      }
      const byCustomer=request.kind==='customer-orders';
      if(byCustomer&&!/^[1-9]\d{0,14}$/.test(request.id))throw new DirectoryError('Cliente inválido.',400);
      if(q.length<2&&!byCustomer)return ['pos'].includes(request.kind)?[]:request.kind==='taller'?{rows:[],local_directory:true}:{rows:[],total:0,page:1,pages:0,status};
      const isOrders=request.kind==='orders'||byCustomer, native=['pos','taller'].includes(request.kind);
      const table=isOrders?'orders':native?'customers':'(SELECT id,search,data FROM customers UNION ALL SELECT -order_id,search,data FROM guests)';
      const tokens=q.split(/\s+/).slice(0,12);
      // Bound parameters and escaped wildcard characters; no user-controlled SQL.
      let condition=tokens.map(()=>"search LIKE ? ESCAPE '\\'").join(' AND ');
      let values=tokens.map(token=>'%'+token.replace(/[\\%_]/g,'\\$&')+'%');
      if(byCustomer){condition='customer_id=?';values=[Number(request.id)];}
      else if(isOrders&&/^#[1-9]\d{0,14}$/.test(q)){condition="(id=? OR json_extract(data,'$.number')=?)";values=[Number(q.slice(1)),q.slice(1)];}
      const total=db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${condition}`).get(...values).n;
      const page=Number(request.page||1),limit=native?20:30,offset=(page-1)*limit;
      const rows=db.prepare(`SELECT data FROM ${table} WHERE ${condition} ORDER BY ${isOrders?'created_at DESC,id DESC':'id DESC'} LIMIT ? OFFSET ?`).all(...values,limit,offset).map(row=>JSON.parse(row.data));
      if(native) {
        const adapted=rows.map(c=>({...c,first_name:c.billing?.first_name||'',last_name:c.billing?.last_name||'',
          billing:request.kind==='pos'?{...Object.fromEntries(Object.entries(c.billing||{}).map(([key,value])=>['billing_'+key,value])),billing_dni_cuit:c.document,billing_dni_afip:c.document}:c.billing,
          document_type:c.document?.length===11?'CUIT':'DNI',field_errors:{},_local_directory:{source:'woocommerce',updated_at:state.customers_at,read_only:true}}));
        return request.kind==='pos'?adapted:{rows:adapted,local_directory:true};
      }
      return {rows,total,page,pages:Math.ceil(total/limit),status};
    } finally { db.close(); }
  };
}
