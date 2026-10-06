import Database from 'better-sqlite3';
import { resolverLoteRecepcion } from '../lib/recepcionMatching.js';
const arg=process.argv.indexOf('--db'); const file=arg>=0?process.argv[arg+1]:'data/fusion.sqlite';
const db=new Database(file,{readonly:true,fileMustExist:true}); const before=db.pragma('data_version',{simple:true});
const rows=db.prepare("SELECT ri.id,ri.recepcion_id,r.proveedor,ri.nombre_doc,ri.codigo_proveedor,ri.cantidad FROM recepcion_items ri JOIN recepciones r ON r.id=ri.recepcion_id WHERE ri.estado_item='sin_match' ORDER BY ri.recepcion_id,ri.id").all();
const groups=new Map(); for(const x of rows){if(!groups.has(x.recepcion_id))groups.set(x.recepcion_id,[]);groups.get(x.recepcion_id).push({...x,linea_id:String(x.id)});}
let a=0,b=0,c=0; const por_recepcion=[]; for(const [id,items] of groups){const out=resolverLoteRecepcion(db,items[0].proveedor,items);const automaticos=out.filter(x=>x.auto_aplicable).length;const sinMatch=out.filter(x=>x.estado==='sin_match').length;const r={recepcion_id:id,total:out.length,resuelto_automatico:automaticos,requiere_revision:out.length-automaticos-sinMatch,sin_match:sinMatch};a+=r.resuelto_automatico;b+=r.requiere_revision;c+=r.sin_match;por_recepcion.push(r);}
const after=db.pragma('data_version',{simple:true}); if(before!==after) throw new Error('la base cambió durante auditoría');
console.error('auditoría read-only verificada'); console.log(JSON.stringify({total:rows.length,resuelto_automatico:a,requiere_revision:b,sin_match:c,por_recepcion})); db.close();
