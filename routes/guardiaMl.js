import express from 'express';
import { escanearGuardiaMl, estadoGuardiaMl, listarGuardiaMl, registrarEventoGuardia, encolarOperacionGuardia } from '../lib/guardiaMl.js';
import { requireAdmin } from '../lib/auth.js';
import { pausarPublicacionMl } from '../lib/matcherPush.js';
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
    if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'solo Ventas, Supervisor o Admin puede resolver Guardia ML'});
    const config = estadoGuardiaMl(db);
    if (config.modo !== 'acciones') return res.status(409).json({ ok:false, error:'Guardia en modo lectura; el Administrador debe habilitar acciones' });
    const c=db.prepare("SELECT * FROM guardia_ml_casos WHERE id=? AND estado!='resuelto'").get(Number(req.params.id));
    if(!c)return res.status(404).json({ok:false,error:'caso no encontrado'});
    if((!c.responsable || c.responsable!==actor(req)) && !req.user?.is_admin)return res.status(409).json({ok:false,error:'Tomá el caso antes de ejecutar la acción; si pertenece a otro operador, solicitá un relevo explícito'});
    const sku=String(req.body?.sku||'').trim(); const prod=db.prepare('SELECT sku,nombre,stock FROM catalogo_cache WHERE sku=? LIMIT 1').get(sku);
    if(!prod)return res.status(400).json({ok:false,error:'SKU inexistente en Woo'});
    const yaCompartido=db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE sku=? AND accion IN ('asignar','confirmar') AND clave<>?").get(sku,c.clave).n;
    if(yaCompartido>0 && !db.prepare('SELECT 1 FROM guardia_ml_stock_compartido WHERE sku=?').get(sku)) {
      return res.status(409).json({ok:false,requiere_stock_compartido:true,claves_adicionales:yaCompartido,error:'Este SKU ya está vinculado a otra publicación; confirmá primero stock compartido con motivo'});
    }
    // Corrección segura: cuando ya existe otro vínculo, primero se elimina en ML.
    // Nunca se reemplaza directamente, porque un fallo del segundo paso no debe
    // dejar la decisión local afirmando un vínculo que ML no confirmó.
    const actualMl=db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave=?').get(c.clave)?.seller_sku||'';
    const decisionAnterior=db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave=? AND accion IN ('asignar','confirmar') ORDER BY id DESC LIMIT 1").get(c.clave)?.sku||'';
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
  });
  router.post('/casos/:id/pausar', async (req, res) => {
    if (!puedeResolver(req)) return res.status(403).json({ok:false,error:'solo Ventas, Supervisor o Admin puede resolver Guardia ML'});
    const config=estadoGuardiaMl(db); if(config.modo!=='acciones')return res.status(409).json({ok:false,error:'Guardia en modo lectura; el Administrador debe habilitar acciones'});
    const c=db.prepare("SELECT * FROM guardia_ml_casos WHERE id=? AND estado!='resuelto'").get(Number(req.params.id)); if(!c)return res.status(404).json({ok:false,error:'caso no encontrado'});
    if(c.responsable && c.responsable!==actor(req) && !req.user?.is_admin)return res.status(409).json({ok:false,error:'El caso está tomado por otro operador; solicitá un relevo explícito'});
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
  return router;
}
