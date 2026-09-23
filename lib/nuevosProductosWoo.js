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
  // Los atributos solo son obligatorios cuando Woo los necesita para distinguir variaciones
  // (familia_variable/variacion_existente). Un producto 'simple' no tiene variaciones — exigirle
  // un atributo bloqueaba toda alta simple sin ningún beneficio real (P1.6, hallazgo post-E2E).
  const requiereAtributos = f.modo === 'familia_variable' || f.modo === 'variacion_existente';
  if (f.atributos === undefined && !requiereAtributos) f.atributos = [];
  if (!Array.isArray(f.atributos) || (requiereAtributos && f.atributos.length===0) || f.atributos.some(a=>!String(a?.nombre||'').trim()||!String(a?.valor||'').trim())) throw new Error('atributos inválidos');
  const nombresAtributos = f.atributos.map(a => String(a.nombre).trim().toLowerCase());
  if (new Set(nombresAtributos).size !== nombresAtributos.length) throw new Error('atributos repetidos');
  return f;
}

// Normaliza texto para el hash canónico y para comparar combinaciones de atributos: recorta,
// colapsa espacios internos y pasa a minúsculas. No es la normalización de matcherEngine.js (esa
// quita acentos/plurales para matching difuso) — acá el objetivo es que dos fichas EQUIVALENTES
// (mismo contenido, distinto orden o casing) den el mismo hash, no encontrar productos similares.
function normTxt(s) { return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase(); }

/**
 * P1.7: hash canónico de la ficha, independiente del orden de las claves del objeto de entrada y
 * del orden/casing de los atributos. Sin esto, la idempotencia de operationId (Step 5 del plan)
 * es frágil: la misma ficha lógica enviada dos veces con las claves en otro orden, o con
 * "Color"/"color", generaba un hash distinto y el replay fallaba con "ficha distinta" en vez de
 * devolver el resultado ya creado.
 */
export function hashFichaCanonica(f) {
  const atributos = (f.atributos || [])
    .map(a => ({ nombre: normTxt(a.nombre), valor: normTxt(a.valor) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre) || a.valor.localeCompare(b.valor));
  const canon = {
    modo: f.modo || null,
    titulo: normTxt(f.titulo),
    marca: normTxt(f.marca),
    categoria_id: f.categoria_id != null ? Number(f.categoria_id) : null,
    categoria_nombre: normTxt(f.categoria_nombre),
    precio: Number(f.precio),
    descripcion: normTxt(f.descripcion),
    parent_id: f.parent_id != null ? Number(f.parent_id) : null,
    atributos,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

export async function listarCategoriasWoo(cfg,{fetchWoo=wooFetch}={}) { const out=[]; for(let page=1;page<=20;page++){ const r=await fetchWoo(cfg,`/products/categories?per_page=100&page=${page}&hide_empty=false`); const a=r.data||[]; out.push(...a.map(x=>({id:x.id,name:x.name,parent:x.parent}))); if(a.length<100) break; } return out; }

// Combinación de atributos ya usada por una variación existente del padre — comparación por
// conjunto {nombre normalizado: valor normalizado}, sin importar el orden en que vengan.
function mismaCombinacion(a, b) {
  const na = Object.keys(a), nb = Object.keys(b);
  if (na.length !== nb.length) return false;
  return na.every(k => Object.prototype.hasOwnProperty.call(b, k) && b[k] === a[k]);
}
function combinacionDe(atributos) {
  const out = {};
  for (const a of atributos) out[normTxt(a.name ?? a.nombre)] = normTxt((a.option ?? a.valor));
  return out;
}

// Marca buscable e independiente del id_woo (que todavía no existe cuando se arma el payload):
// SKU provisional derivado del operationId + meta_data con el operationId crudo. Es lo que permite
// encontrar el recurso después de un timeout en el POST que lo crea, cuando nunca llegamos a leer
// la respuesta con el id real — sin esto esa alta queda 'incierto' para siempre, sin salida.
const PREFIJO_SKU_PROVISORIO = 'FB-PEND-';
function skuProvisional(operationId) { return `${PREFIJO_SKU_PROVISORIO}${operationId}`; }
function skuProvisionalPadre(operationId) { return `${PREFIJO_SKU_PROVISORIO}PADRE-${operationId}`; }
function metaOperacion(operationId) { return [{ key: '_fb_recepcion_op', value: operationId }]; }

/**
 * Busca el recurso de una alta 'incierto' que nunca llegó a persistir un id_woo, por el SKU
 * provisional que se mandó en el POST original. Simple/familia_variable (la variación creada, no
 * el padre) se buscan en el nivel raíz de products; variacion_existente y la variación de
 * familia_variable (una vez que el padre SÍ se conoce) se buscan entre las variaciones del padre.
 * Si no hay padre conocido tampoco (el timeout fue en el POST del padre mismo), no hay nada
 * verificable: se devuelve null y el llamador deja la operación en 'incierto'.
 */
async function buscarIdPorMarca({ cfg, fetchWoo, modo, idPadre, operationId }) {
  const sku = skuProvisional(operationId);
  try {
    if (modo === 'simple') {
      const r = await fetchWoo(cfg, `/products?sku=${encodeURIComponent(sku)}`);
      return (r.data || [])[0]?.id ?? null;
    }
    if (!idPadre) return null; // familia_variable sin padre conocido: nada bajo qué buscar.
    const r = await fetchWoo(cfg, `/products/${idPadre}/variations?sku=${encodeURIComponent(sku)}`);
    return (r.data || [])[0]?.id ?? null;
  } catch (_e) {
    return null;
  }
}

/**
 * Busca el padre perdido de una familia_variable cuyo POST de creación timeouteo antes de
 * persistir el id_padre. Busca en el nivel raíz de products por el SKU provisional del padre
 * (skuProvisionalPadre), que se mandó en el POST original.
 * Devuelve el id del padre si lo encuentra, null en caso contrario o si hay error de red.
 */
async function buscarIdPadrePorMarca({ cfg, fetchWoo, operationId }) {
  const sku = skuProvisionalPadre(operationId);
  try {
    const r = await fetchWoo(cfg, `/products?sku=${encodeURIComponent(sku)}`);
    const results = r.data || [];
    // Bug 2: validación defensiva — si hay múltiples resultados para un SKU que debería ser único,
    // tratarlo como no encontrado. Woo filtra por SKU en la query, así que múltiples resultados
    // indican inconsistencia de datos: mejor no adivinar cuál es el padre correcto.
    if (results.length > 1) {
      console.warn(`[buscarIdPadrePorMarca] ${results.length} resultados para SKU ${sku}: inconsistencia de datos, tratando como no encontrado`);
      return null;
    }
    return results[0]?.id ?? null;
  } catch (_e) {
    return null;
  }
}

/**
 * P1.6 (b): última instancia cuando la búsqueda automática no alcanza — una persona que miró Woo
 * a mano confirma qué pasó. Exige actor y motivo (auditado en `error`, igual que cualquier otro
 * cierre de operación). Dos decisiones:
 *  - 'no_se_creo': la persona confirmó que no hay nada en Woo → 'fallido' (libera reintento).
 *  - 'es_este_id': la persona identificó el id_woo real → se verifica contra Woo (nunca se confía
 *    ciegamente en el dato humano) y, si Woo confirma un draft, se completa igual que un alta
 *    normal (PATCH del SKU final si hace falta, upsert en catalogo_cache, 'creado').
 */
async function aplicarResolucionManual({ db, cfg, fetchWoo, row, resolucionManual }) {
  const { decision, id_woo: idWooManual, actor, motivo } = resolucionManual || {};
  if (!actor || !String(motivo || '').trim()) throw new Error('actor y motivo son obligatorios para resolver a mano');
  const now = new Date().toISOString();
  const registro = `resuelto a mano por ${actor}: ${motivo}`;
  if (decision === 'no_se_creo') {
    db.prepare("UPDATE recepcion_altas_woo SET estado='fallido',error=?,actualizado_en=? WHERE operation_id=?")
      .run(registro, now, row.operation_id);
    return { estado: 'fallido' };
  }
  if (decision === 'es_este_id') {
    if (!idWooManual) throw new Error('id_woo requerido para la resolución "es_este_id"');
    const path = row.modo === 'simple' ? `/products/${idWooManual}` : `/products/${row.id_padre}/variations/${idWooManual}`;
    const data = (await fetchWoo(cfg, path)).data;
    if (!data || data.status !== 'draft') throw new Error('Woo no confirma un draft en ese id_woo: no se puede dar el alta por buena');
    const skuFinal = `FB-${idWooManual}`;
    if (data.sku !== skuFinal) await fetchWoo(cfg, path, 'patch', { sku: skuFinal });
    const result = { id_woo: idWooManual, id_padre: row.id_padre, sku: skuFinal, status: 'draft' };
    const tipo = row.modo === 'simple' ? 'simple' : 'variation';
    upsertCatalogoCacheAlta(db, { id_woo: idWooManual, id_padre: tipo === 'variation' ? row.id_padre : null, tipo, sku: skuFinal, nombre: data.name || '', stock: 0 });
    db.prepare("UPDATE recepcion_altas_woo SET estado='creado',id_woo=?,sku=?,respuesta_json=?,error=?,actualizado_en=? WHERE operation_id=?")
      .run(idWooManual, skuFinal, JSON.stringify(result), registro, now, row.operation_id);
    return { estado: 'creado', ...result };
  }
  throw new Error('decisión de resolución manual inválida: use "no_se_creo" o "es_este_id"');
}

export async function crearBorradorWoo({db,cfg,operationId,ficha,actor,fetchWoo=wooFetch}) {
  const f=validarFichaAlta(ficha), hash=hashFichaCanonica(f), now=new Date().toISOString();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new Error('operationId inválido');
  const old=db.prepare('SELECT * FROM recepcion_altas_woo WHERE operation_id=?').get(operationId); if(old){if(old.request_hash!==hash) throw new Error('operationId reutilizado con ficha distinta'); if(old.estado!=='creado') throw new Error(`operación bloqueada: ${old.estado}`); return JSON.parse(old.respuesta_json);}

  // Padre inexistente/no variable: falla antes de tocar red ni de insertar 'procesando' — no hay
  // nada que quede a medias en Woo si ni siquiera existe el padre localmente.
  if (f.modo==='variacion_existente') {
    const padre=db.prepare('SELECT tipo FROM catalogo_cache WHERE id_woo=?').get(f.parent_id);
    if (!padre) throw new Error('padre inexistente en catálogo');
    if (padre.tipo!=='variable') throw new Error('padre no es un producto variable');
  }

  // P1.6: validaciones de backend contra el estado real de Woo, todas ANTES de la primera llamada
  // que crea algo (así un rechazo acá es 'fallido' limpio, sin fila 'procesando' ni nada del lado
  // de Woo que reconciliar).
  const categorias = await listarCategoriasWoo(cfg, { fetchWoo });
  const catEncontrada = categorias.find(c => Number(c.id) === Number(f.categoria_id));
  if (!catEncontrada) throw new Error('categoría inexistente en Woo');
  if (normTxt(catEncontrada.name) !== normTxt(f.categoria_nombre)) throw new Error('categoría: id y nombre no coinciden');

  if (f.modo === 'familia_variable' || f.modo === 'variacion_existente') {
    const combinacionNueva = combinacionDe(f.atributos.map(a => ({ name: a.nombre, option: a.valor })));
    if (f.parent_id) {
      // Pagina todas las variaciones del padre (máximo 20 páginas de 100 cada una)
      const variacionesExistentes = [];
      for (let page = 1; page <= 20; page++) {
        const r = await fetchWoo(cfg, `/products/${f.parent_id}/variations?per_page=100&page=${page}`);
        const a = r.data || [];
        variacionesExistentes.push(...a);
        if (a.length < 100) break; // Última página
      }
      const yaExiste = variacionesExistentes.some(v => mismaCombinacion(combinacionDe(v.attributes || []), combinacionNueva));
      if (yaExiste) throw new Error('combinación de atributos ya existe en el padre');
    }
  }

  db.prepare(`INSERT INTO recepcion_altas_woo(operation_id,request_hash,estado,modo,creado_por,creado_en,actualizado_en) VALUES (?,?, 'procesando',?,?,?,?)`).run(operationId,hash,f.modo,actor,now,now);
  let parentId=f.parent_id||null;
  if (f.modo==='variacion_existente') {
    // Ya conocemos el padre (viene de la ficha, no de una respuesta de Woo): lo persistimos ya,
    // no recién al final, para que buscarIdPorMarca pueda usarlo si el POST de la variación
    // timeoutea antes de devolvernos el id.
    db.prepare("UPDATE recepcion_altas_woo SET id_padre=? WHERE operation_id=?").run(parentId, operationId);
  }
  // P1.6: la clasificación fallido/incierto depende exclusivamente de si YA se disparó la primera
  // llamada remota que puede haber tenido efecto en Woo (el primer POST de creación) — no de si
  // hay parentId ni de adivinar por el texto del mensaje de error. Cualquier error a partir de ese
  // punto (incluida una verificación que no confirma, un PATCH que falla, un timeout) dice
  // "no sé si Woo quedó con algo a medias": es 'incierto', nunca 'fallido'.
  let remotoIniciado = false;
  try {
    const atributos=(f.atributos||[]).map(a=>({name:a.nombre,options:[a.valor],visible:true,variation:true}));
    const skuProv = skuProvisional(operationId), metaOp = metaOperacion(operationId);
    const skuProvPadre = skuProvisionalPadre(operationId);
    // El payload genérico es para el recurso final: simple o variación.
    // Simple lleva sku/meta_data. Para familia_variable, la variación lleva sku/meta_data,
    // pero el padre (variable) necesita su propio SKU/meta_data distinto.
    const payload={name:f.titulo,status:'draft',type:f.modo==='familia_variable'?'variable':'simple',regular_price:String(f.precio),description:f.descripcion||'',manage_stock:true,stock_quantity:0,categories:[{id:Number(f.categoria_id)}],attributes:atributos,...(f.modo==='simple'?{sku:skuProv,meta_data:metaOp}:{})};
    if (!parentId && f.modo==='familia_variable') {
      remotoIniciado = true;
      // Payload específico del padre: incluye su propio SKU/meta_data, distinto al del recurso final
      const payloadPadre={name:f.titulo,status:'draft',type:'variable',regular_price:String(f.precio),description:f.descripcion||'',manage_stock:true,stock_quantity:0,categories:[{id:Number(f.categoria_id)}],attributes:atributos,sku:skuProvPadre,meta_data:metaOp};
      parentId=(await fetchWoo(cfg,'/products','post',payloadPadre)).data.id;
      db.prepare("UPDATE recepcion_altas_woo SET id_padre=?,actualizado_en=? WHERE operation_id=?").run(parentId,new Date().toISOString(),operationId);

      // Decisión de diseño: finalizar el SKU del padre inmediatamente después de crearlo.
      // El padre empieza con un SKU provisional (FB-PEND-PADRE-{operationId}) que debe
      // ser reemplazado por el SKU final (FB-{parentId}) para consistencia con el rest del
      // sistema. Best-effort: si este PATCH falla o se pierde su respuesta, el padre queda
      // con el SKU provisional, que es inofensivo (no bloquea nada) — aceptado como riesgo
      // residual, sin implementar máquina de recuperación adicional.
      try {
        const skuFinalPadre = `FB-${parentId}`;
        await fetchWoo(cfg, `/products/${parentId}`, 'patch', { sku: skuFinalPadre });
      } catch (_e) {
        // PATCH del padre fallido: riesgo residual aceptado. El padre quedará con SKU provisional.
      }
    }
    let resource;
    remotoIniciado = true;
    if (f.modo==='familia_variable' || f.modo==='variacion_existente') {
      resource=(await fetchWoo(cfg,`/products/${parentId}/variations`,'post',{status:'draft',regular_price:String(f.precio),manage_stock:true,stock_quantity:0,sku:skuProv,meta_data:metaOp,attributes:atributos.map(a=>({name:a.name,option:a.options[0]}))})).data;
    } else resource=(await fetchWoo(cfg,'/products','post',payload)).data;
    const id=resource.id;
    // Persistimos el id apenas lo conocemos, no recién al final: si algo falla después (verify,
    // PATCH del SKU, verify final), conciliarAltaIncierta necesita este id para poder leer Woo y
    // reconciliar sin adivinar.
    db.prepare("UPDATE recepcion_altas_woo SET id_woo=?,id_padre=?,actualizado_en=? WHERE operation_id=?").run(id,parentId,new Date().toISOString(),operationId);
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
  } catch(e){
    const incierto = remotoIniciado;
    db.prepare("UPDATE recepcion_altas_woo SET estado=?,error=?,actualizado_en=? WHERE operation_id=?").run(incierto?'incierto':'fallido',e.message,new Date().toISOString(),operationId);
    throw e;
  }
}

/**
 * P1.6: recuperación de una alta 'incierto'. Lee Woo para decidir sin adivinar: si el recurso
 * existe con el SKU final y draft esperados, la operación pasa a 'creado' (con el upsert en
 * catalogo_cache, igual que un alta exitosa). Si Woo confirma que NO existe, pasa a 'fallido',
 * que es el único estado que libera reintento (ver comentario en routes/recepciones.js sobre el
 * claim de /crear-alta).
 *
 * Si el id_woo no quedó persistido (el timeout ocurrió en el POST que lo crea, antes de leer la
 * respuesta), se busca por la marca buscable que ese POST ya mandó (skuProvisional/meta_data) —
 * ver buscarIdPorMarca. Si ni siquiera eso encuentra nada (o no hay padre conocido bajo el cual
 * buscar), se deja 'incierto' explícito para que una persona lo resuelva con `resolucionManual`
 * (ver aplicarResolucionManual): fail-closed, nunca se asume que no se creó nada sin evidencia.
 *
 * `resolucionManual`, si se pasa, tiene prioridad total sobre la reconciliación automática.
 */
export async function conciliarAltaIncierta({ db, cfg, operationId, fetchWoo = wooFetch, resolucionManual = null }) {
  const row = db.prepare('SELECT * FROM recepcion_altas_woo WHERE operation_id=?').get(operationId);
  if (!row) throw new Error('operación no encontrada');
  if (row.estado !== 'incierto') return { estado: row.estado, id_woo: row.id_woo, sku: row.sku };

  if (resolucionManual) return aplicarResolucionManual({ db, cfg, fetchWoo, row, resolucionManual });

  let idWoo = row.id_woo;
  let idPadre = row.id_padre;

  // Bug 1 fix: recuperar el padre ANTES de evaluar idWoo, si es familia_variable sin padre.
  // Esto asegura que idPadre esté resuelto incluso si idWoo ya está en BD pero id_padre es null
  // (caso de corrupción parcial o restauración incompleta de datos).
  if (row.modo === 'familia_variable' && !idPadre) {
    idPadre = await buscarIdPadrePorMarca({ cfg, fetchWoo, operationId });
    if (idPadre) {
      // Se encontró el padre perdido: persistirlo y continuar con la reconciliación normal
      db.prepare('UPDATE recepcion_altas_woo SET id_padre=?,actualizado_en=? WHERE operation_id=?')
        .run(idPadre, new Date().toISOString(), operationId);

      // Decisión de diseño: finalizar el SKU del padre si aún tiene el SKU provisional.
      // El padre fue encontrado pero quizá nunca se ejecutó el PATCH de finalización original.
      // Aplicamos best-effort sin validación GET posterior (el padre ya existe, low-risk).
      const skuProvPadre = skuProvisionalPadre(operationId);
      const skuFinalPadre = `FB-${idPadre}`;
      try {
        const padreActual = (await fetchWoo(cfg, `/products/${idPadre}`)).data;
        if (padreActual && padreActual.sku === skuProvPadre) {
          // El padre sigue con el SKU provisional: aplicar PATCH de finalización
          await fetchWoo(cfg, `/products/${idPadre}`, 'patch', { sku: skuFinalPadre });
        }
      } catch (_e) {
        // PATCH fallido o GET de verificación no disponible: aceptado como riesgo residual.
        // El padre sigue con SKU provisional, inofensivo, no bloquea la reconciliación.
      }
    }
  }

  if (!idWoo) {
    idWoo = await buscarIdPorMarca({ cfg, fetchWoo, modo: row.modo, idPadre: idPadre, operationId });
    if (!idWoo) return { estado: 'incierto', motivo: 'sin id_woo conocido: no se encontró por marca buscable, requiere resolución manual' };
    db.prepare('UPDATE recepcion_altas_woo SET id_woo=?,actualizado_en=? WHERE operation_id=?').run(idWoo, new Date().toISOString(), operationId);
  }

  const path = row.modo === 'simple' ? `/products/${idWoo}` : `/products/${idPadre}/variations/${idWoo}`;
  const skuFinal = `FB-${idWoo}`;
  let data;
  try {
    data = (await fetchWoo(cfg, path)).data;
  } catch (e) {
    if (e.status === 404 || /not.?found|no existe/i.test(e.message || '')) {
      db.prepare("UPDATE recepcion_altas_woo SET estado='fallido',error=?,actualizado_en=? WHERE operation_id=?")
        .run('conciliado: el producto no existe en Woo', new Date().toISOString(), operationId);
      return { estado: 'fallido' };
    }
    throw e; // error de red/lectura: no autoriza ninguna conclusión, se propaga tal cual.
  }
  if (!data || data.status !== 'draft') {
    db.prepare("UPDATE recepcion_altas_woo SET estado='fallido',error=?,actualizado_en=? WHERE operation_id=?")
      .run('conciliado: no está en draft', new Date().toISOString(), operationId);
    return { estado: 'fallido' };
  }
  if (data.sku !== skuFinal) {
    // Encontrado por la marca (sku provisional) o el intento falló antes del PATCH final: el
    // recurso existe pero todavía no tiene el SKU definitivo. Lo completamos acá.
    await fetchWoo(cfg, path, 'patch', { sku: skuFinal });
    data = (await fetchWoo(cfg, path)).data;
    if (!data || data.sku !== skuFinal) {
      db.prepare("UPDATE recepcion_altas_woo SET estado='fallido',error=?,actualizado_en=? WHERE operation_id=?")
        .run('conciliado: Woo no confirmó el SKU final', new Date().toISOString(), operationId);
      return { estado: 'fallido' };
    }
  }
  const result = { id_woo: idWoo, id_padre: idPadre, sku: skuFinal, status: 'draft' };
  const tipo = row.modo === 'simple' ? 'simple' : 'variation';
  upsertCatalogoCacheAlta(db, { id_woo: idWoo, id_padre: tipo === 'variation' ? idPadre : null, tipo, sku: skuFinal, nombre: data.name || '', stock: 0 });
  db.prepare("UPDATE recepcion_altas_woo SET estado='creado',id_woo=?,sku=?,respuesta_json=?,actualizado_en=? WHERE operation_id=?")
    .run(idWoo, skuFinal, JSON.stringify(result), new Date().toISOString(), operationId);
  return { estado: 'creado', ...result };
}
