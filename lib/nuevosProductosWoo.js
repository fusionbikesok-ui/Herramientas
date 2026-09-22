import crypto from 'node:crypto';
import { wooFetch } from '../routes/woo.js';

/**
 * P0.2: upsert atómico del alta recién creada en catalogo_cache, para que la recepción se pueda
 * confirmar de inmediato (aplicar stock) sin esperar al próximo sync Woo→cache. `tipo` es 'simple'
 * o 'variation'; para 'variation' se persiste `id_padre`.
 *
 * ON CONFLICT DO NOTHING a propósito, no DO UPDATE: catalogo_cache en producción tiene columnas
 * (categorias_json, precio, regular_price, no_contable, marca, gtin, img, atributos_json) que este
 * upsert no conoce ni puebla. Si por cualquier motivo (reintento sobre un id_woo ya sincronizado,
 * base restaurada, id mal propagado) esta llamada cayera sobre una fila YA existente, esa fila viene
 * del sync real y es estrictamente mejor que los datos parciales de un borrador recién creado — un
 * DO UPDATE la degradaría en silencio (p. ej. no_contable, que usa inventario.js para el conteo).
 * Alcanza con que la fila EXISTA para que aplicarStockItem la encuentre; si ya existía, no tocarla.
 */
function upsertCatalogoCacheAlta(db, { id_woo, id_padre, tipo, sku, nombre, stock }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id_woo) DO NOTHING`
  ).run(id_woo, nombre, sku, tipo, id_padre, stock, now);
}

export function validarFichaAlta(input = {}) {
  const f={...input};
  if (!['simple','familia_variable','variacion_existente'].includes(f.modo)) throw new Error('modo inválido');
  if (!String(f.titulo||'').trim() || !String(f.marca||'').trim() || !f.categoria_id || !String(f.categoria_nombre||'').trim()) throw new Error('título, marca y categoría requeridos');
  if (!(Number(f.precio)>0)) throw new Error('precio inválido');
  if (f.modo==='simple' && f.parent_id) throw new Error('simple no admite padre');
  if (f.modo==='variacion_existente' && !f.parent_id) throw new Error('padre requerido');
  if (!Array.isArray(f.atributos) || f.atributos.some(a=>!a?.nombre||!a?.valor)) throw new Error('atributos inválidos');
  const nombresAtributos = f.atributos.map(a => String(a.nombre).trim().toLowerCase());
  if (new Set(nombresAtributos).size !== nombresAtributos.length) throw new Error('atributos repetidos');
  return f;
}
export async function listarCategoriasWoo(cfg,{fetchWoo=wooFetch}={}) { const out=[]; for(let page=1;page<=20;page++){ const r=await fetchWoo(cfg,`/products/categories?per_page=100&page=${page}&hide_empty=false`); const a=r.data||[]; out.push(...a.map(x=>({id:x.id,name:x.name,parent:x.parent}))); if(a.length<100) break; } return out; }
export async function crearBorradorWoo({db,cfg,operationId,ficha,actor,fetchWoo=wooFetch}) {
  const f=validarFichaAlta(ficha), hash=crypto.createHash('sha256').update(JSON.stringify(f)).digest('hex'), now=new Date().toISOString();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new Error('operationId inválido');
  const old=db.prepare('SELECT * FROM recepcion_altas_woo WHERE operation_id=?').get(operationId); if(old){if(old.request_hash!==hash) throw new Error('operationId reutilizado con ficha distinta'); if(old.estado!=='creado') throw new Error(`operación bloqueada: ${old.estado}`); return JSON.parse(old.respuesta_json);}
  // Padre inexistente/no variable: falla antes de tocar red ni de insertar 'procesando' — no hay
  // nada que quede a medias en Woo si ni siquiera existe el padre localmente.
  if (f.modo==='variacion_existente') {
    const padre=db.prepare('SELECT tipo FROM catalogo_cache WHERE id_woo=?').get(f.parent_id);
    if (!padre) throw new Error('padre inexistente en catálogo');
    if (padre.tipo!=='variable') throw new Error('padre no es un producto variable');
  }
  db.prepare(`INSERT INTO recepcion_altas_woo(operation_id,request_hash,estado,modo,creado_por,creado_en,actualizado_en) VALUES (?,?, 'procesando',?,?,?,?)`).run(operationId,hash,f.modo,actor,now,now);
  let parentId=f.parent_id||null;
  try {
    const atributos=(f.atributos||[]).map(a=>({name:a.nombre,options:[a.valor],visible:true,variation:true}));
    const payload={name:f.titulo,status:'draft',type:f.modo==='familia_variable'?'variable':'simple',regular_price:String(f.precio),description:f.descripcion||'',manage_stock:true,stock_quantity:0,categories:[{id:Number(f.categoria_id)}],attributes:atributos};
    if (!parentId && f.modo==='familia_variable') {
      parentId=(await fetchWoo(cfg,'/products','post',payload)).data.id;
      db.prepare("UPDATE recepcion_altas_woo SET id_padre=?,actualizado_en=? WHERE operation_id=?").run(parentId,new Date().toISOString(),operationId);
    }
    let resource;
    if (f.modo==='familia_variable' || f.modo==='variacion_existente') {
      resource=(await fetchWoo(cfg,`/products/${parentId}/variations`,'post',{status:'draft',regular_price:String(f.precio),manage_stock:true,stock_quantity:0,attributes:atributos.map(a=>({name:a.name,option:a.options[0]}))})).data;
    } else resource=(await fetchWoo(cfg,'/products','post',payload)).data;
    const id=resource.id;
    const path=f.modo==='simple'?`/products/${id}`:`/products/${parentId}/variations/${id}`;
    const verified=(await fetchWoo(cfg,path)).data;
    if (verified.status!=='draft' || Number(verified.stock_quantity||0)!==0) throw new Error('Woo no confirmó draft con stock cero');
    const sku=`FB-${id}`;
    await fetchWoo(cfg,path,'patch',{sku});
    // P0.2: no confiamos en la respuesta del PATCH — un GET posterior es la única fuente de verdad
    // sobre si el SKU/draft/stock/id/tipo/padre quedaron como se espera antes de dar el alta por buena.
    const verifiedFinal=(await fetchWoo(cfg,path)).data;
    if (verifiedFinal.sku!==sku) throw new Error(`Woo no confirmó el SKU: esperado ${sku}, encontrado ${verifiedFinal.sku}`);
    if (verifiedFinal.status!=='draft') throw new Error(`Woo no confirmó draft tras el alta: status=${verifiedFinal.status}`);
    if (Number(verifiedFinal.stock_quantity||0)!==0) throw new Error(`Woo no confirmó stock cero tras el alta: stock_quantity=${verifiedFinal.stock_quantity}`);
    if (Number(verifiedFinal.id)!==id) throw new Error(`Woo no confirmó el id esperado: esperado ${id}, encontrado ${verifiedFinal.id}`);
    const result={id_woo:id,id_padre:parentId,sku,status:verifiedFinal.status};
    const tipo=f.modo==='simple'?'simple':'variation';
    upsertCatalogoCacheAlta(db,{id_woo:id,id_padre:tipo==='variation'?parentId:null,tipo,sku,nombre:f.titulo,stock:0});
    db.prepare("UPDATE recepcion_altas_woo SET estado='creado',id_woo=?,id_padre=?,sku=?,respuesta_json=?,actualizado_en=? WHERE operation_id=?").run(id,parentId,result.sku,JSON.stringify(result),new Date().toISOString(),operationId);
    return result;
  } catch(e){ const incierto=Boolean(parentId) || e.code==='ETIMEDOUT'||/timeout|network|red/i.test(e.message); db.prepare("UPDATE recepcion_altas_woo SET estado=?,error=?,actualizado_en=? WHERE operation_id=?").run(incierto?'incierto':'fallido',e.message,new Date().toISOString(),operationId); throw e; }
}
