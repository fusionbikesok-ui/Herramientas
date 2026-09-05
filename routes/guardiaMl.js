import express from 'express';
import { escanearGuardiaMl, estadoGuardiaMl, listarGuardiaMl, registrarEventoGuardia, encolarOperacionGuardia } from '../lib/guardiaMl.js';
import { requireAdmin } from '../lib/auth.js';
import { pausarPublicacionMl } from '../lib/matcherPush.js';
import { perfilPublicacionMl } from '../lib/guardiaMlAprendizaje.js';
import { decidirCasoIdentidad } from '../lib/identidadProductos.js';
import { randomUUID } from 'node:crypto';
function actor(req) { return req.user?.username || 'desconocido'; }
function puedeResolver(req) {
  // El modelo vigente no persiste un rol nominal; la autorización efectiva es
  // Matcher con nivel write. Los permisos de Ventas/Supervisor se expresan allí.
  return !!req.user?.is_admin || req.user?.permisos?.some((p) => p.herramienta === 'matcher' && p.nivel === 'write');
}
function motivoValido(m) { return ['sin_sku_woo','producto_inexistente','vinculo_dudoso','excepcion_comercial','incidencia_ml','otro'].includes(m); }

export function guardiaMlRouter(db, cfg) {
  const router = express.Router();
  router.get('/estado', (_req, res) => res.json({ ok:true, data:estadoGuardiaMl(db) }));
  router.get('/casos', (req, res) => res.json({ ok:true, modo:estadoGuardiaMl(db).modo, data:listarGuardiaMl(db, { soloUrgentes:req.query.urgentes==='1' }) }));
  router.get('/casos/:id/opciones', (req, res) => {
    const caso = db.prepare(`SELECT g.id,g.clave,p.item_id,p.variation_id,p.titulo,p.variations_texto,p.seller_sku,
      p.available_quantity,p.status,p.sub_status,p.color,p.talle,p.precio,p.precio_actualizado_en,p.catalogo,p.thumbnail,p.permalink
      FROM guardia_ml_casos g JOIN ml_publicaciones_cache p ON p.clave=g.clave
      WHERE g.id=?`).get(Number(req.params.id));
    if (!caso) return res.status(404).json({ ok:false, error:'caso no encontrado' });
    const q = String(req.query.q || '').trim().toLowerCase();
    const tokens = (q || caso.titulo || '').split(/[^a-z0-9áéíóúüñ]+/i)
      .map((token) => token.trim()).filter((token) => token.length >= 3).slice(0, 3);
    const condiciones = [];
    const params = [];
    if (q) {
      condiciones.push('(LOWER(COALESCE(c.sku,\'\')) LIKE ? OR LOWER(c.nombre) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    } else if (tokens.length) {
      for (const token of tokens) { condiciones.push('LOWER(c.nombre) LIKE ?'); params.push(`%${token}%`); }
    }
    const filtro = condiciones.length ? `AND ${condiciones.join(' AND ')}` : '';
    const perfil = perfilPublicacionMl(caso);
    const opciones = db.prepare(`SELECT c.id_woo,c.sku,c.nombre,c.stock,c.img,c.marca,c.gtin,c.tipo,
      CASE WHEN LOWER(COALESCE(c.sku,''))=LOWER(?) THEN 0
           WHEN EXISTS (SELECT 1 FROM guardia_ml_aprendizajes a WHERE a.perfil=? AND a.sku=c.sku) THEN 1
           ELSE 2 END AS prioridad,
      COALESCE((SELECT MAX(a.confirmaciones) FROM guardia_ml_aprendizajes a WHERE a.perfil=? AND a.sku=c.sku),0) AS confirmaciones_aprendizaje
      FROM catalogo_cache c
      WHERE trim(COALESCE(c.sku,''))<>''
        AND (SELECT COUNT(*) FROM catalogo_cache c2 WHERE c2.sku=c.sku)=1
        ${filtro}
      ORDER BY prioridad ASC, confirmaciones_aprendizaje DESC, c.nombre COLLATE NOCASE ASC LIMIT 30`).all(caso.seller_sku || '', perfil, perfil, ...params);
    res.json({ ok:true, data:{ publicacion:caso, opciones, busqueda: q || tokens.join(' ') } });
  });
  router.get('/casos/:id/eventos', (req, res) => {
    const caso=db.prepare('SELECT id FROM guardia_ml_casos WHERE id=?').get(Number(req.params.id));
    if(!caso)return res.status(404).json({ok:false,error:'caso no encontrado'});
    res.json({ok:true,data:db.prepare('SELECT evento,actor,detalle_json,creado_en FROM guardia_ml_eventos WHERE caso_id=? ORDER BY id').all(caso.id)});
  });
  router.get('/pedidos-retenidos', (req, res) => res.json({ ok:true, data:db.prepare("SELECT * FROM guardia_ml_pedidos_retenidos WHERE estado='retenido' ORDER BY creado_en").all() }));
  router.get('/stock-compartido', (_req, res) => res.json({ ok:true, data:db.prepare('SELECT * FROM guardia_ml_stock_compartido ORDER BY sku').all() }));
  router.post('/escanear', requireAdmin, (req, res) => res.json({ ok:true, data:escanearGuardiaMl(db, actor(req), { lecturaMlConfirmada: false }), advertencia:'lectura basada en cache local; no actualiza la frescura de ML' }));
  router.post('/habilitar-acciones', requireAdmin, (req, res) => {
    const ts=new Date().toISOString(); db.prepare("UPDATE guardia_ml_config SET modo='acciones', habilitado_por=?, habilitado_en=?, actualizado_en=? WHERE id=1").run(actor(req),ts,ts);
    res.json({ ok:true, data:estadoGuardiaMl(db) });
  });
  router.post('/casos/:id/tomar', (req,res) => {
    if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'sin permiso'});
    const c=db.prepare("SELECT * FROM guardia_ml_casos WHERE id=? AND estado!='resuelto'").get(Number(req.params.id)); if(!c) return res.status(404).json({ok:false,error:'caso no encontrado'});
    if(c.responsable && c.responsable!==actor(req) && !req.body?.motivo) return res.status(409).json({ok:false,error:'caso tomado; indicá motivo de relevo'});
    const ts=new Date().toISOString();
    const tomado=db.prepare("UPDATE guardia_ml_casos SET responsable=?, tomado_en=?, estado='tomado', actualizado_en=?, expected_version=expected_version+1 WHERE id=? AND expected_version=? AND estado!='resuelto'").run(actor(req),ts,ts,c.id,c.expected_version);
    if(!tomado.changes)return res.status(409).json({ok:false,error:'El caso cambió mientras intentabas tomarlo; actualizá y reintentá'});
    registrarEventoGuardia(db,c.id,c.responsable&&c.responsable!==actor(req)?'relevo':'tomado',actor(req),{motivo:req.body?.motivo||null}); res.json({ok:true});
  });
  router.post('/casos/:id/excepcion', (req,res) => {
    if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'solo Ventas, Supervisor o Admin puede resolver Guardia ML'});
    const c=db.prepare("SELECT * FROM guardia_ml_casos WHERE id=? AND estado!='resuelto'").get(Number(req.params.id)); if(!c)return res.status(404).json({ok:false,error:'caso no encontrado'});
    if((!c.responsable || c.responsable!==actor(req)) && !req.user?.is_admin)return res.status(409).json({ok:false,error:'Tomá el caso antes de ejecutar la acción; si pertenece a otro operador, solicitá un relevo explícito'});
    const {motivo,nota}=req.body||{}; if(!motivoValido(motivo)||!String(nota||'').trim()) return res.status(400).json({ok:false,error:'motivo y nota obligatorios'});
    const vence=new Date(); vence.setHours(23,59,59,999); const ts=new Date().toISOString(); const excepcion=db.prepare("UPDATE guardia_ml_casos SET estado='excepcion',excepcion_motivo=?,excepcion_nota=?,excepcion_vence_en=?,actualizado_en=?,expected_version=expected_version+1 WHERE id=? AND expected_version=? AND estado!='resuelto'").run(motivo,String(nota).trim(),vence.toISOString(),ts,c.id,c.expected_version);
    if(!excepcion.changes)return res.status(409).json({ok:false,error:'El caso cambió mientras registrabas la excepción; actualizá y reintentá'});
    registrarEventoGuardia(db,c.id,'excepcion',actor(req),{motivo,nota,vence_en:vence.toISOString()});res.json({ok:true});
  });
  router.post('/casos/:id/vincular', async (req, res) => {
    try {
      if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'solo Ventas, Supervisor o Admin puede resolver Guardia ML'});
      const config = estadoGuardiaMl(db);
      if (config.modo !== 'acciones') return res.status(409).json({ ok:false, error:'Guardia en modo lectura; el Administrador debe habilitar acciones' });
      const c=db.prepare("SELECT * FROM guardia_ml_casos WHERE id=? AND estado!='resuelto'").get(Number(req.params.id));
      if(!c)return res.status(404).json({ok:false,error:'caso no encontrado'});
      if((!c.responsable || c.responsable!==actor(req)) && !req.user?.is_admin)return res.status(409).json({ok:false,error:'Tomá el caso antes de ejecutar la acción; si pertenece a otro operador, solicitá un relevo explícito'});
      // Asignar responsable si no lo tiene o si es admin haciendo relevo implícito
      const responsableAnterior = c.responsable;
      if (!responsableAnterior || (responsableAnterior !== actor(req) && req.user?.is_admin)) {
        const ts = new Date().toISOString();
        db.prepare("UPDATE guardia_ml_casos SET responsable=?, actualizado_en=? WHERE id=?").run(actor(req), ts, c.id);
        const evento = responsableAnterior ? 'relevo' : 'tomado';
        registrarEventoGuardia(db, c.id, evento, actor(req), { motivo_implicito: true, accion: 'vincular' });
      }
      const sku=String(req.body?.sku||'').trim(); const prod=db.prepare('SELECT sku,nombre,stock FROM catalogo_cache WHERE sku=? GROUP BY sku HAVING COUNT(*)=1').get(sku);
      if(!prod)return res.status(400).json({ok:false,error:'SKU inexistente en Woo'});
      // Compartir SKU entre publicaciones es lo NORMAL del negocio (511 SKUs ya comparten entre
      // 1.176 publicaciones). Se registra en guardia_ml_stock_compartido como dato informativo
      // si no estaba, pero NO se bloquea la vinculación.
      const yaCompartido=db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE sku=? AND accion IN ('asignar','confirmar') AND clave<>?").get(sku,c.clave).n;
      if(yaCompartido>0 && !db.prepare('SELECT 1 FROM guardia_ml_stock_compartido WHERE sku=?').get(sku)) {
        db.prepare('INSERT OR IGNORE INTO guardia_ml_stock_compartido (sku,confirmado_en) VALUES (?,?)').run(sku,new Date().toISOString());
      }
      // Corrección segura: cuando ya existe otro vínculo, primero se elimina en ML.
      // Nunca se reemplaza directamente, porque un fallo del segundo paso no debe
      // dejar la decisión local afirmando un vínculo que ML no confirmó.
      const actualMl=db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave=?').get(c.clave)?.seller_sku||'';
      const decisionAnterior=db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave=? AND accion IN ('asignar','confirmar')").get(c.clave)?.sku||'';
      if ((actualMl && actualMl!==sku) || (decisionAnterior && decisionAnterior!==sku)) {
        // Persistir la intención antes de cualquier efecto remoto. El worker ejecuta
        // ambos pasos y puede recuperar la operación después de un reinicio.
        encolarOperacionGuardia(db,{casoId:c.id,tipo:'vincular',sku,error:null,operador:actor(req),casoVersion:c.expected_version});
        registrarEventoGuardia(db,c.id,'correccion_encolada',actor(req),{sku_anterior:actualMl||decisionAnterior,sku_nuevo:sku});
        return res.status(202).json({ok:true,estado:'pendiente_ml',mensaje:'Corrección encolada; se desvinculará y vinculará de forma ordenada'});
      }
      // Toda vinculación se persiste antes del efecto remoto. Así un reinicio no
      // puede dejar ML actualizado y Fusion sin decisión local.
      encolarOperacionGuardia(db,{casoId:c.id,tipo:'vincular',sku,error:null,operador:actor(req),casoVersion:c.expected_version});
      registrarEventoGuardia(db,c.id,'vinculacion_encolada',actor(req),{sku});
      return res.status(202).json({ok:true,estado:'pendiente_ml',mensaje:'Vinculación encolada; se confirmará cuando ML responda'});
    } catch (err) {
      console.error('[guardiaMl] error en POST /casos/:id/vincular:', err);
      return res.status(500).json({ok:false,error:err.message});
    }
  });
  router.post('/casos/:id/pausar', async (req, res) => {
    if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'solo Ventas, Supervisor o Admin puede resolver Guardia ML'});
    const config=estadoGuardiaMl(db); if(config.modo!=='acciones')return res.status(409).json({ok:false,error:'Guardia en modo lectura; el Administrador debe habilitar acciones'});
    const c=db.prepare("SELECT * FROM guardia_ml_casos WHERE id=? AND estado!='resuelto'").get(Number(req.params.id)); if(!c)return res.status(404).json({ok:false,error:'caso no encontrado'});
    if(c.responsable && c.responsable!==actor(req) && !req.user?.is_admin)return res.status(409).json({ok:false,error:'El caso está tomado por otro operador; solicitá un relevo explícito'});
    // Asignar responsable si no lo tiene o si es admin haciendo relevo implícito
    const responsableAnterior = c.responsable;
    if (!responsableAnterior || (responsableAnterior !== actor(req) && req.user?.is_admin)) {
      const ts = new Date().toISOString();
      db.prepare("UPDATE guardia_ml_casos SET responsable=?, actualizado_en=? WHERE id=?").run(actor(req), ts, c.id);
      const evento = responsableAnterior ? 'relevo' : 'tomado';
      registrarEventoGuardia(db, c.id, evento, actor(req), { motivo_implicito: true, accion: 'pausar' });
    }
    const p=db.prepare('SELECT item_id,variation_id FROM ml_publicaciones_cache WHERE clave=?').get(c.clave); if(!p)return res.status(404).json({ok:false,error:'publicación no encontrada'});
    const hermanas=p.variation_id?db.prepare("SELECT COUNT(*) n FROM ml_publicaciones_cache WHERE item_id=? AND variation_id IS NOT NULL AND variation_id!=?").get(p.item_id,p.variation_id).n:0;
    if(hermanas>0 && req.body?.confirmado!==true)return res.status(409).json({ok:false,requiere_confirmacion:true,variaciones_afectadas:hermanas,error:'La pausa afecta toda la publicación y sus variantes hermanas'});
    encolarOperacionGuardia(db,{casoId:c.id,tipo:'pausar',itemId:p.item_id,error:null,operador:actor(req),casoVersion:c.expected_version});
    registrarEventoGuardia(db,c.id,'pausa_encolada',actor(req),{confirmado:!!req.body?.confirmado,variaciones_afectadas:hermanas});
    return res.status(202).json({ok:true,estado:'pendiente_ml',mensaje:'Pausa encolada; se confirmará cuando ML responda'});
  });
  router.post('/pedidos-retenidos/:orderId/liberar', (req, res) => {
    if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'solo Ventas, Supervisor o Admin puede liberar una venta retenida'});
    const motivo=String(req.body?.motivo||'').trim(); if(!motivo)return res.status(400).json({ok:false,error:'motivo obligatorio'});
    let ok=false;
    db.transaction(()=>{
      const ts=new Date().toISOString();
      const actualizado=db.prepare("UPDATE guardia_ml_pedidos_retenidos SET estado='liberado', responsable=?, liberado_en=?, liberado_por=?, actualizado_en=? WHERE ml_order_id=? AND estado='retenido'").run(actor(req),ts,actor(req),ts,String(req.params.orderId));
      if(!actualizado.changes)return;
      db.prepare("DELETE FROM ordenes_ml_wc_pedidos WHERE ml_order_id=? AND wc_order_id=0 AND retenido_en IS NULL").run(String(req.params.orderId));
      db.prepare("DELETE FROM ordenes_ml_procesadas WHERE order_id=? AND NOT EXISTS (SELECT 1 FROM ordenes_ml_wc_pedidos WHERE ml_order_id=? AND wc_order_id<>0)").run(String(req.params.orderId),String(req.params.orderId));
      const caso=db.prepare("SELECT id FROM guardia_ml_casos WHERE pedido_ml_order_id=? AND estado!='resuelto' ORDER BY id DESC LIMIT 1").get(String(req.params.orderId));
      if(caso)registrarEventoGuardia(db,caso.id,'pedido_liberado',actor(req),{order_id:req.params.orderId,motivo});
      ok=true;
    })();
    if(!ok)return res.status(404).json({ok:false,error:'retención no encontrada o ya resuelta'});
    res.json({ok:true,estado:'liberado'});
  });
  router.post('/pedidos-retenidos/:orderId/cancelar', (req, res) => {
    if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'solo Ventas, Supervisor o Admin puede cancelar una venta retenida'});
    const motivo=String(req.body?.motivo||'').trim(); if(!motivo)return res.status(400).json({ok:false,error:'motivo obligatorio'});
    let ok=false; const casos=[];
    db.transaction(()=>{
      const ts=new Date().toISOString();
      const actualizado=db.prepare("UPDATE guardia_ml_pedidos_retenidos SET estado='cancelado', responsable=?, liberado_en=?, liberado_por=?, actualizado_en=? WHERE ml_order_id=? AND estado='retenido'").run(actor(req),ts,actor(req),ts,String(req.params.orderId));
      if(!actualizado.changes)return;
      casos.push(...db.prepare("SELECT id FROM guardia_ml_casos WHERE pedido_ml_order_id=? AND estado!='resuelto'").all(String(req.params.orderId)));
      db.prepare("UPDATE guardia_ml_casos SET estado='resuelto', bloquea_sync=0, resuelto_en=?, actualizado_en=?, expected_version=expected_version+1 WHERE pedido_ml_order_id=? AND estado!='resuelto'").run(ts,ts,String(req.params.orderId));
      for (const c of casos) registrarEventoGuardia(db,c.id,'pedido_cancelado',actor(req),{order_id:req.params.orderId,motivo});
      ok=true;
    })();
    if(!ok)return res.status(404).json({ok:false,error:'retención no encontrada o ya resuelta'});
    res.json({ok:true,estado:'cancelado'});
  });
  router.post('/stock-compartido/:sku/confirmar', (req, res) => {
    if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'solo Ventas, Supervisor o Admin puede confirmar stock compartido'});
    const sku=decodeURIComponent(req.params.sku).trim(); const motivo=String(req.body?.motivo||'').trim();
    if(!sku||!motivo)return res.status(400).json({ok:false,error:'SKU y motivo obligatorios'});
    const claves=db.prepare(`SELECT COUNT(*) n FROM sku_matcher_decisiones d JOIN ml_publicaciones_cache p ON p.clave=d.clave WHERE d.sku=? AND d.accion IN ('asignar','confirmar') AND p.status='active' AND COALESCE(p.available_quantity,0)>0`).get(sku).n;
    if(claves<2)return res.status(409).json({ok:false,error:'el SKU no tiene dos claves ML activas confirmadas'});
    const ts=new Date().toISOString();db.prepare(`INSERT INTO guardia_ml_stock_compartido(sku,confirmado_por,motivo,confirmado_en) VALUES(?,?,?,?)
      ON CONFLICT(sku) DO UPDATE SET confirmado_por=excluded.confirmado_por,motivo=excluded.motivo,confirmado_en=excluded.confirmado_en`).run(sku,actor(req),motivo,ts);
    db.prepare('INSERT INTO guardia_ml_stock_compartido_eventos(sku,evento,actor,motivo,creado_en) VALUES(?,?,?,?,?)').run(sku,'confirmado',actor(req),motivo,ts);
    res.json({ok:true,sku,claves,confirmado_por:actor(req)});
  });
  router.post('/vincular-clave', async (req, res) => {
    // Vincular un SKU a una publicación que NO tiene caso abierto en Guardia.
    // Crea el caso al vuelo y encolma la vinculación con el mismo flujo durable.
    // Requiere permisos de Ventas/Supervisor/Admin y modo 'acciones' habilitado.
    try {
      if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'solo Ventas, Supervisor o Admin puede vincular'});
      const config = estadoGuardiaMl(db);
      if (config.modo !== 'acciones') return res.status(409).json({ ok:false, error:'Guardia en modo lectura; el Administrador debe habilitar acciones' });
      const clave=String(req.body?.clave||'').trim(); const sku=String(req.body?.sku||'').trim();
      if(!clave||!sku)return res.status(400).json({ok:false,error:'clave y sku obligatorios'});
      const pub=db.prepare('SELECT clave,titulo,available_quantity FROM ml_publicaciones_cache WHERE clave=?').get(clave);
      if(!pub)return res.status(404).json({ok:false,error:'publicación no encontrada en ML'});
      const prod=db.prepare('SELECT sku,nombre,stock FROM catalogo_cache WHERE sku=? GROUP BY sku HAVING COUNT(*)=1').get(sku);
      if(!prod)return res.status(400).json({ok:false,error:'SKU inexistente en Woo'});

      // ── Un solo escritor por clave (UM1.6) ─────────────────────────────────────
      // Si Identidad de productos ya gobierna esta clave, la decisión se toma AHÍ y la
      // escritura la hace su worker. Antes esta ruta encolaba una operación de Guardia y
      // quedaban dos schedulers pudiendo tocar la misma publicación —uno cada minuto y otro
      // cada cinco—; la colisión no era teórica: 26 operaciones de Guardia terminaron en
      // `conflicto`, frenadas sólo por su control de versión.
      //
      // Se delega en vez de rechazar para no romper el botón del Matcher: el usuario hace lo
      // mismo de siempre y la escritura sale por un único camino, con caso, decisión,
      // operación durable, verificación por relectura e intervención ante fallo.
      const casoUm1 = db.prepare("SELECT * FROM identidad_casos WHERE direccion='ml_fusion' AND ml_key=? AND estado<>'resuelto'").get(clave);
      if (casoUm1) {
        const productoFusion = db.prepare(`SELECT f.* FROM productos_fusion f
          JOIN catalogo_cache c ON c.id_woo=f.primary_woo_id
          WHERE c.sku=? AND f.estado='activo'`).get(sku);
        if (!productoFusion) {
          return res.status(400).json({ ok:false, error:`el SKU ${sku} no tiene un Producto Fusion activo`, code:'NO_FUSION_PRODUCT' });
        }
        const r = decidirCasoIdentidad(db, casoUm1.id, {
          tipo: 'vincular', product_id: productoFusion.id, operation_id: randomUUID(),
          expected_version: casoUm1.expected_version, evidence_fingerprint: casoUm1.evidencia_fingerprint,
          explicacion: 'vinculación desde el Matcher',
        }, actor(req));
        if (!r.ok) {
          // El freno por hermanas necesita ver cuántas son y sobre qué publicación antes de
          // confirmar: eso sólo lo ofrece la pantalla de Identidad. Confirmar a ciegas desde
          // acá vaciaría el freno.
          const estado = r.code === 'SIBLING_IMPACT_CONFIRMATION_REQUIRED' ? 409 : (r.code === 'NOT_FOUND' ? 404 : 400);
          return res.status(estado).json({ ...r, motor: 'identidad', migracion: 'Resolvelo en Identidad de productos: /herramientas/identidad-productos/' });
        }
        return res.status(202).json({ ok:true, motor:'identidad', estado:'pendiente_ml', caso_id:casoUm1.id,
          mensaje:'Vinculación decidida en Identidad de productos; su worker la escribe y verifica en ML' });
      }
      // Crear o reusar el caso: si no existe, crearlo en estado 'abierto'.
      const ts=new Date().toISOString();
      const casoExistente=db.prepare("SELECT id,estado,expected_version FROM guardia_ml_casos WHERE clave=? AND estado!='resuelto'").get(clave);
      let casoId,casoVersion;
      if(casoExistente){
        casoId=casoExistente.id;
        casoVersion=casoExistente.expected_version;
      }else{
        // Crear caso nuevo: sin SKU decidido todavía, sin responsable, listo para vincular.
        const insertado=db.prepare(`INSERT INTO guardia_ml_casos (clave,estado,severidad,motivo,bloquea_sync,creado_en,actualizado_en)
          VALUES (?,'abierto','normal','vinculacion_manual',0,?,?)`).run(clave,ts,ts);
        if(!insertado.changes)return res.status(500).json({ok:false,error:'No se pudo crear el caso'});
        casoId=insertado.lastInsertRowid;
        casoVersion=1; // guardia_ml_casos.expected_version DEFAULT 1 (migrations/059); 0 hace
        // que encolarOperacionGuardia compare contra la versión real (1) y falle siempre para
        // un caso recién creado — es el bug que rompía /vincular-clave en el 100% de los casos.
        // Registrar evento de creación
        registrarEventoGuardia(db,casoId,'caso_creado_auto_matcher',actor(req),{razon:'vinculacion_desde_matcher'});
      }
      // Asignar responsable si no lo tiene
      const casoParaAct=db.prepare("SELECT responsable FROM guardia_ml_casos WHERE id=?").get(casoId);
      if(!casoParaAct.responsable){
        const tsAct=new Date().toISOString();
        db.prepare("UPDATE guardia_ml_casos SET responsable=?, actualizado_en=? WHERE id=?").run(actor(req),tsAct,casoId);
        registrarEventoGuardia(db,casoId,'tomado',actor(req),{motivo:'vinculacion_auto'});
      }
      // Registrar stock compartido si aplica (SKU ya vinculado a otra clave)
      const yaCompartido=db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE sku=? AND accion IN ('asignar','confirmar')").get(sku).n;
      if(yaCompartido>0 && !db.prepare('SELECT 1 FROM guardia_ml_stock_compartido WHERE sku=?').get(sku)) {
        db.prepare('INSERT OR IGNORE INTO guardia_ml_stock_compartido (sku,confirmado_en) VALUES (?,?)').run(sku,ts);
      }
      // Encolar la vinculación exactamente como el endpoint POST /casos/:id/vincular
      encolarOperacionGuardia(db,{casoId,tipo:'vincular',sku,error:null,operador:actor(req),casoVersion});
      registrarEventoGuardia(db,casoId,'vinculacion_encolada',actor(req),{sku});
      return res.status(202).json({ok:true,estado:'pendiente_ml',caso_id:casoId,mensaje:'Vinculación encolada desde matcher; se confirmará cuando ML responda'});
    } catch (err) {
      console.error('[guardiaMl] error en POST /vincular-clave:', err);
      return res.status(500).json({ok:false,error:err.message});
    }
  });
  return router;
}
