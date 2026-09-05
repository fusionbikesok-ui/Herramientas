/** Guardia ML: cobertura exacta por publicación+variación. No escribe ML en modo lectura. */
function now() { return new Date().toISOString(); }
const RETRY_MS = [500, 1500, 4000];
import { escribirSkuEnMl, desvincularSkuEnMl, pausarPublicacionMl } from './matcherPush.js';
import { claveBloqueadaGuardia } from './guardiaBloqueo.js';
import { perfilPublicacionMl, registrarAprendizajeGuardia } from './guardiaMlAprendizaje.js';
export { claveBloqueadaGuardia } from './guardiaBloqueo.js';
const VALIDAS = "('asignar','confirmar')";

export function esClaveCubierta(db, clave) {
  // Invariante: cobertura exacta requiere:
  // 1. decisión local asignar/confirmar
  // 2. SKU Woo único en catalogo_cache
  // 3. seller_sku en ml_publicaciones_cache EXACTAMENTE igual al SKU decidido
  // Si hay divergencia remota, el caso se abre/mantiene y bloquea sync; nunca se auto-acepta.
  const decision = db.prepare(`SELECT sku FROM sku_matcher_decisiones d
    WHERE d.clave=? AND d.accion IN ${VALIDAS} AND trim(COALESCE(d.sku,''))<>''
      AND (SELECT COUNT(*) FROM catalogo_cache c WHERE c.sku=d.sku)=1 LIMIT 1`).get(clave);

  if (!decision) return false;

  // Verificar que seller_sku remoto coincida exactamente con la decisión local
  const remoto = db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave=?').get(clave);
  const sellerSkuRemoto = remoto?.seller_sku || '';
  const skuLocal = decision.sku || '';

  return sellerSkuRemoto === skuLocal;
}

export function escanearGuardiaMl(db, actor = 'sistema', { lecturaMlConfirmada = false } = {}) {
  const ts = now();
  const vencidas = db.prepare("SELECT id FROM guardia_ml_casos WHERE estado='excepcion' AND excepcion_vence_en IS NOT NULL AND excepcion_vence_en<=?").all(ts);
  for (const caso of vencidas) {
    db.prepare("UPDATE guardia_ml_casos SET estado='abierto', excepcion_vence_en=NULL, actualizado_en=?, expected_version=expected_version+1 WHERE id=? AND estado='excepcion'").run(ts, caso.id);
    registrarEventoGuardia(db, caso.id, 'excepcion_vencida', actor, { reabierto: true });
  }
  // En modo lectura solo se detecta. Tras la habilitación explícita del Admin,
  // un seller_sku exacto y único puede confirmarse localmente; nunca se escribe
  // en ML desde este barrido y nunca se auto-confirma un SKU compartido.
  const modo = db.prepare('SELECT modo FROM guardia_ml_config WHERE id=1').get()?.modo || 'lectura';
  if (modo === 'acciones') {
    const candidatas = db.prepare(`SELECT p.clave,p.seller_sku AS sku,c.nombre
      FROM ml_publicaciones_cache p JOIN catalogo_cache c ON c.sku=p.seller_sku
      WHERE p.status='active' AND COALESCE(p.available_quantity,0)>0
        AND p.seller_sku IS NOT NULL AND trim(p.seller_sku)<>''
        AND (SELECT COUNT(*) FROM catalogo_cache c2 WHERE c2.sku=p.seller_sku)=1
        AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave=p.clave)
        AND NOT EXISTS (SELECT 1 FROM errores_descartados e WHERE e.clave=p.clave)`).all();
    const insertarAuto = db.prepare(`INSERT OR IGNORE INTO sku_matcher_decisiones
      (clave,sku,wc_nombre,accion,origen,confirmado_por,actualizado_en) VALUES (?,?,?,'confirmar','guardia_ml_auto','sistema',?)`);
    db.transaction(() => { for (const c of candidatas) {
      // Compartir SKU entre publicaciones es lo NORMAL. Auto-vinculación siempre que el
      // seller_sku sea único en el catálogo, sin excepciones por compartición previa.
      if (insertarAuto.run(c.clave,c.sku,c.nombre,ts).changes) {
        const caso = db.prepare('SELECT id FROM guardia_ml_casos WHERE clave=?').get(c.clave);
        if (caso) registrarEventoGuardia(db,caso.id,'vinculado_auto_seller_sku','sistema',{sku:c.sku});
        // Registrar en guardia_ml_stock_compartido si el SKU ya estaba vinculado a otra clave
        const otrasClaves = db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE sku=? AND accion IN ('asignar','confirmar') AND clave<>?").get(c.sku,c.clave).n;
        if (otrasClaves > 0) {
          db.prepare('INSERT OR IGNORE INTO guardia_ml_stock_compartido (sku,confirmado_en) VALUES (?,?)').run(c.sku,ts);
        }
      }
    }})();
  }
  // Claves sin cobertura: sin decisión válida O con decisión pero seller_sku divergente
  const filas = db.prepare(`
    SELECT p.clave FROM ml_publicaciones_cache p
    WHERE p.status='active' AND COALESCE(p.available_quantity,0)>0
      AND (
        -- Caso 1: sin decisión válida
        NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d JOIN catalogo_cache c ON c.sku=d.sku
          WHERE d.clave=p.clave AND d.accion IN ${VALIDAS} AND trim(COALESCE(d.sku,''))<>''
            AND (SELECT COUNT(*) FROM catalogo_cache c2 WHERE c2.sku=d.sku)=1)
        -- Caso 2: decisión existe pero seller_sku remoto diverge (no coincide exactamente)
        OR EXISTS (SELECT 1 FROM sku_matcher_decisiones d JOIN catalogo_cache c ON c.sku=d.sku
          WHERE d.clave=p.clave AND d.accion IN ${VALIDAS} AND trim(COALESCE(d.sku,''))<>''
            AND (SELECT COUNT(*) FROM catalogo_cache c2 WHERE c2.sku=d.sku)=1
            AND COALESCE(p.seller_sku,'') <> COALESCE(d.sku,''))
      )
  `).all();
  const insertar = db.prepare(`INSERT INTO guardia_ml_casos (clave,estado,severidad,motivo,bloquea_sync,creado_en,actualizado_en)
    VALUES (?,'abierto','urgente','sin_cobertura',1,?,?)
    ON CONFLICT(clave) DO UPDATE SET estado=CASE WHEN guardia_ml_casos.estado='resuelto' THEN 'abierto' ELSE guardia_ml_casos.estado END,
      severidad='urgente', motivo='sin_cobertura', actualizado_en=excluded.actualizado_en, expected_version=guardia_ml_casos.expected_version+1`);
  const evento = db.prepare(`INSERT INTO guardia_ml_eventos (caso_id,evento,actor,detalle_json,creado_en)
    SELECT id,'detectado',?,?,? FROM guardia_ml_casos WHERE clave=?`);
  const cerrar = db.prepare("SELECT id, clave FROM guardia_ml_casos WHERE estado!='resuelto'");
  const cerrarCaso = db.prepare("UPDATE guardia_ml_casos SET estado='resuelto', resuelto_en=?, actualizado_en=?, expected_version=expected_version+1 WHERE id=?");
  const cerrarEvento = db.prepare('INSERT INTO guardia_ml_eventos (caso_id,evento,actor,detalle_json,creado_en) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    const clavesRiesgo = new Set(filas.map((r) => r.clave));
    for (const r of filas) { insertar.run(r.clave, ts, ts); evento.run(actor, JSON.stringify({ motivo: 'sin_cobertura' }), ts, r.clave); }
    for (const c of cerrar.all()) {
      if (!clavesRiesgo.has(c.clave)) {
        cerrarCaso.run(ts, ts, c.id);
        cerrarEvento.run(c.id, 'cubierto_o_sin_exposicion', actor, JSON.stringify({ motivo: 'scan_sano' }), ts);
      }
    }
    if (lecturaMlConfirmada) db.prepare(`UPDATE guardia_ml_config SET ultimo_scan_exitoso_en=?, ultimo_scan_error=NULL, actualizado_en=? WHERE id=1`).run(ts, ts);
  })();
  return { total: filas.length, escaneado_en: ts };
}

export function estadoGuardiaMl(db) {
  const cfg = db.prepare('SELECT * FROM guardia_ml_config WHERE id=1').get();
  const urgentes = db.prepare("SELECT COUNT(*) n FROM guardia_ml_casos WHERE estado IN ('abierto','tomado','pendiente_ml','excepcion') AND severidad='urgente'").get().n;
  const operacionesPendientes = db.prepare("SELECT COUNT(*) n FROM guardia_ml_operaciones WHERE estado='pendiente'").get().n;
  const edad = cfg?.ultimo_scan_exitoso_en ? Date.now() - Date.parse(cfg.ultimo_scan_exitoso_en) : Infinity;
  return { ...cfg, urgentes, operaciones_pendientes: operacionesPendientes, degradado: edad > 30 * 60 * 1000 || !!cfg?.ultimo_scan_error, sano: edad <= 30 * 60 * 1000 && !cfg?.ultimo_scan_error && urgentes === 0 && operacionesPendientes === 0 };
}

export function listarGuardiaMl(db, { soloUrgentes = false } = {}) {
  const where = soloUrgentes ? "AND g.severidad='urgente'" : '';
  return db.prepare(`SELECT g.*, p.titulo, p.variations_texto, p.seller_sku, p.available_quantity, p.permalink,
    (SELECT MIN(pc.fecha_despacho_limite) FROM pedidos_cache pc WHERE pc.canal='ml' AND pc.ml_order_id IS NOT NULL AND pc.items_json LIKE '%' || p.clave || '%') AS pedido_limite,
    d.sku AS sku_decidido, c.nombre AS producto_woo, c.stock AS stock_woo,
    (SELECT COUNT(*) FROM pedidos_cache pc WHERE pc.canal='ml' AND pc.fecha >= datetime('now','-30 day')
      AND NULLIF(COALESCE(p.seller_sku,d.sku),'') IS NOT NULL
      AND pc.items_json LIKE '%' || COALESCE(NULLIF(p.seller_sku,''),d.sku) || '%') ventas_30d
    FROM guardia_ml_casos g JOIN ml_publicaciones_cache p ON p.clave=g.clave
    LEFT JOIN sku_matcher_decisiones d ON d.clave=g.clave AND d.accion IN ${VALIDAS}
    LEFT JOIN catalogo_cache c ON c.sku=d.sku
    WHERE g.estado!='resuelto' ${where}
    ORDER BY CASE WHEN g.severidad='urgente' THEN 0 ELSE 1 END,
      CASE WHEN pedido_limite IS NULL THEN 1 ELSE 0 END, pedido_limite ASC,
      g.creado_en ASC, p.available_quantity DESC, g.actualizado_en ASC`).all();
}

export function registrarEventoGuardia(db, casoId, evento, actor, detalle = null) {
  db.prepare('INSERT INTO guardia_ml_eventos (caso_id,evento,actor,detalle_json,creado_en) VALUES (?,?,?,?,?)')
    .run(casoId, evento, actor || null, detalle ? JSON.stringify(detalle) : null, now());
}

export function retenerPedidoMl(db, { orderId, items, claves, motivo = 'sin_cobertura' }) {
  const ts = now();
  db.transaction(() => {
    db.prepare(`INSERT INTO guardia_ml_pedidos_retenidos
      (ml_order_id,motivo,items_json,creado_en,actualizado_en)
      VALUES (?,?,?,?,?) ON CONFLICT(ml_order_id) DO UPDATE SET actualizado_en=excluded.actualizado_en`)
      .run(String(orderId), motivo, JSON.stringify(items || []), ts, ts);
    for (const clave of claves || []) {
      db.prepare(`INSERT INTO guardia_ml_casos (clave,estado,severidad,motivo,bloquea_sync,pedido_ml_order_id,creado_en,actualizado_en)
        VALUES (?,'abierto','urgente','pedido_retenido',1,?,?,?)
        ON CONFLICT(clave) DO UPDATE SET severidad='urgente', motivo='pedido_retenido', bloquea_sync=1, pedido_ml_order_id=?, actualizado_en=excluded.actualizado_en`)
        .run(clave, String(orderId), ts, ts, String(orderId));
    }
  })();
}

export function pedidoMlRetenido(db, orderId) {
  return db.prepare("SELECT * FROM guardia_ml_pedidos_retenidos WHERE ml_order_id=? AND estado='retenido'").get(String(orderId));
}

export function resolverRetencionPedidoMl(db, orderId, actor, estado = 'liberado') {
  const ts = now();
  const result = db.prepare("UPDATE guardia_ml_pedidos_retenidos SET estado=?, responsable=?, liberado_en=?, liberado_por=?, actualizado_en=? WHERE ml_order_id=? AND estado='retenido'")
    .run(estado, actor, ts, actor, ts, String(orderId));
  return result.changes > 0;
}

export function encolarOperacionGuardia(db, { casoId, tipo, sku = null, itemId = null, error = null, operador = null, casoVersion = null }) {
  const ts = now(); const baseIdempotencia = `${tipo}:${casoId}:${sku || itemId || ''}`;
  db.transaction(() => {
    const caso = db.prepare("SELECT expected_version,estado FROM guardia_ml_casos WHERE id=?").get(casoId);
    if (!caso || caso.estado === 'resuelto') throw new Error('caso no disponible para operación remota');
    const versionBase = casoVersion ?? caso.expected_version;
    const versionOperacion = versionBase + 1;
    const anterior = db.prepare("SELECT estado FROM guardia_ml_operaciones WHERE idempotencia=? ORDER BY id DESC LIMIT 1").get(baseIdempotencia);
    if (anterior && ['pendiente','procesando'].includes(anterior.estado)) return;
    const reintentos = db.prepare("SELECT COUNT(*) n FROM guardia_ml_operaciones WHERE idempotencia LIKE ?").get(`${baseIdempotencia}%`).n;
    const idempotencia = reintentos ? `${baseIdempotencia}:retry:${reintentos}` : baseIdempotencia;
    const insertada = db.prepare(`INSERT OR IGNORE INTO guardia_ml_operaciones
      (caso_id,tipo,sku,item_id,estado,intentos,proximo_intento_en,ultimo_error,idempotencia,creado_en,actualizado_en,operador,caso_version)
      VALUES (?,?,?,?, 'pendiente',0,?,?,?,?,?,?,?)`).run(casoId,tipo,sku,itemId,ts,error,idempotencia,ts,ts,operador,versionOperacion);
    if (insertada.changes) {
      const actualizado = db.prepare("UPDATE guardia_ml_casos SET estado='pendiente_ml', actualizado_en=?, expected_version=? WHERE id=? AND expected_version=? AND estado!='resuelto'").run(ts,versionOperacion,casoId,versionBase);
      if (!actualizado.changes) throw new Error('el caso cambió mientras se encolaba la operación');
    }
  })();
}

export async function procesarOperacionesGuardia(db, cfg) {
  const modoActual = db.prepare('SELECT modo FROM guardia_ml_config WHERE id=1').get()?.modo || 'lectura';
  if (modoActual !== 'acciones') return { procesadas: 0, ok: 0, fallidas: 0, pausadas_por_modo: true };
  const inicio = now();
  const recuperadas = db.prepare("SELECT id,caso_id FROM guardia_ml_operaciones WHERE estado='procesando' AND claim_hasta<=?").all(inicio);
  db.prepare("UPDATE guardia_ml_operaciones SET estado='pendiente', actualizado_en=? WHERE estado='procesando' AND claim_hasta<=?").run(inicio, inicio);
  for (const op of recuperadas) registrarEventoGuardia(db,op.caso_id,'lease_recuperado','sistema',{operacion_id:op.id});
  const rows = db.prepare("SELECT * FROM guardia_ml_operaciones WHERE estado='pendiente' AND proximo_intento_en<=? ORDER BY id LIMIT 20").all(inicio);
  let ok=0, fallidas=0;
  for (const op of rows) {
    if ((db.prepare('SELECT modo FROM guardia_ml_config WHERE id=1').get()?.modo || 'lectura') !== 'acciones') break;
    // El lease cubre una desvinculación + vinculación y el backoff de ML; un
    // ciclo de cinco minutos no debe recuperar una operación todavía en vuelo.
    const claim = db.prepare("UPDATE guardia_ml_operaciones SET estado='procesando',claim_hasta=?,actualizado_en=? WHERE id=? AND estado='pendiente'").run(new Date(Date.now()+15*60*1000).toISOString(), inicio, op.id);
    if (!claim.changes) continue;
    let resultado;
    const renovar = () => db.prepare("UPDATE guardia_ml_operaciones SET claim_hasta=?, actualizado_en=? WHERE id=? AND estado='procesando'")
      .run(new Date(Date.now()+15*60*1000).toISOString(), now(), op.id);
    const heartbeat = setInterval(renovar, 60*1000);
    try {
      const casoActual = db.prepare("SELECT estado,responsable,expected_version FROM guardia_ml_casos WHERE id=?").get(op.caso_id);
      const estadoCaso = casoActual?.estado;
      if (estadoCaso !== 'pendiente_ml') throw new Error('caso ya no está pendiente de operación remota');
      if (op.caso_version !== null && op.caso_version !== casoActual.expected_version) throw new Error('la versión del caso cambió antes de ejecutar');
      if (op.operador && casoActual.responsable !== op.operador) throw new Error('el responsable del caso cambió antes de ejecutar');
      if (op.tipo === 'vincular') {
        const caso = db.prepare('SELECT clave FROM guardia_ml_casos WHERE id=?').get(op.caso_id);
        // Compartir SKU entre publicaciones es lo NORMAL. Se registra en guardia_ml_stock_compartido
        // como dato informativo, pero NO bloquea la operación remota.
        const otrasClaves = db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones d JOIN ml_publicaciones_cache p ON p.clave=d.clave WHERE d.sku=? AND d.accion IN ('asignar','confirmar') AND d.clave<>? AND p.status='active' AND COALESCE(p.available_quantity,0)>0").get(op.sku,caso?.clave).n;
        if (otrasClaves > 0 && !db.prepare('SELECT 1 FROM guardia_ml_stock_compartido WHERE sku=?').get(op.sku)) {
          db.prepare('INSERT OR IGNORE INTO guardia_ml_stock_compartido (sku,confirmado_en) VALUES (?,?)').run(op.sku,now());
        }
        const previo = db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave=?').get(caso?.clave)?.seller_sku || '';
        const decision = db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave=? AND accion IN ('asignar','confirmar')").get(caso?.clave)?.sku || '';
        if ((previo && previo !== op.sku) || (decision && decision !== op.sku)) {
          // Desvinculación autorizada por Guardia: bypassea el bloqueo de Guardia con guardianOperation=true
          const r = await desvincularSkuEnMl(db,cfg?.ml||cfg,caso?.clave, { guardianOperation: true });
          if (!r?.ok) throw new Error(r?.error || 'ML no confirmó la desvinculación');
          db.prepare("DELETE FROM sku_matcher_decisiones WHERE clave=? AND accion IN ('asignar','confirmar')").run(caso.clave);
          registrarEventoGuardia(db,op.caso_id,'desvinculado', 'sistema', {sku_anterior:previo||decision});
        }
        // Escritura autorizada por Guardia: bypassea el bloqueo de Guardia con guardianOperation=true
        resultado = await escribirSkuEnMl(db,cfg?.ml||cfg,caso?.clave,op.sku,{manual:true, guardianOperation: true});
      } else resultado = await pausarPublicacionMl(db,cfg?.ml||cfg,op.item_id,{ guardianOperation: true });
    } catch(e) { resultado={ok:false,error:e.message}; }
    finally { clearInterval(heartbeat); }
    const ts=now();
    if (!resultado?.ok && /caso ya no está pendiente|versión del caso cambió|responsable del caso cambió/.test(String(resultado?.error||''))) {
      db.prepare("UPDATE guardia_ml_operaciones SET estado='conflicto',claim_hasta=NULL,ultimo_error=?,actualizado_en=? WHERE id=?").run(String(resultado.error).slice(0,500),ts,op.id);
      db.prepare("UPDATE guardia_ml_casos SET estado='abierto',actualizado_en=?,expected_version=expected_version+1 WHERE id=? AND estado='pendiente_ml'").run(ts,op.caso_id);
      registrarEventoGuardia(db,op.caso_id,'conflicto_pre_ml','sistema',{operacion:op.tipo,operacion_id:op.id,error:resultado.error});
      fallidas++;
      continue;
    }
    const casoFinal = db.prepare("SELECT estado,expected_version,responsable FROM guardia_ml_casos WHERE id=?").get(op.caso_id);
    if (resultado?.ok && (!casoFinal || casoFinal.estado !== 'pendiente_ml' ||
      (op.caso_version !== null && casoFinal.expected_version !== op.caso_version) ||
      (op.operador && casoFinal.responsable !== op.operador))) {
      db.prepare("UPDATE guardia_ml_operaciones SET estado='conflicto',claim_hasta=NULL,ultimo_error=?,actualizado_en=? WHERE id=?").run('ML confirmó, pero el caso cambió antes del cierre local',ts,op.id);
      db.prepare("UPDATE guardia_ml_casos SET estado='abierto',actualizado_en=?,expected_version=expected_version+1 WHERE id=? AND estado='pendiente_ml'").run(ts,op.caso_id);
      registrarEventoGuardia(db,op.caso_id,'conflicto_post_ml','sistema',{operacion:op.tipo});
      fallidas++;
      continue;
    }
    if(resultado?.ok){
      if (op.tipo === 'vincular' && !db.prepare('SELECT sku FROM catalogo_cache WHERE sku=? GROUP BY sku HAVING COUNT(*)=1').get(op.sku)) {
        db.prepare("UPDATE guardia_ml_operaciones SET estado='conflicto',claim_hasta=NULL,ultimo_error=?,actualizado_en=? WHERE id=?").run('ML confirmó, pero el SKU Woo desapareció antes del cierre local',ts,op.id);
        db.prepare("UPDATE guardia_ml_casos SET estado='abierto',actualizado_en=?,expected_version=expected_version+1 WHERE id=? AND estado='pendiente_ml'").run(ts,op.caso_id);
        registrarEventoGuardia(db,op.caso_id,'conflicto_post_ml','sistema',{operacion:op.tipo,error:'SKU Woo ausente al cerrar operación'});
        fallidas++;
        continue;
      }
      db.transaction(() => {
        db.prepare("UPDATE guardia_ml_operaciones SET estado='completada',claim_hasta=NULL,actualizado_en=?,ultimo_error=NULL WHERE id=?").run(ts,op.id);
        if (op.tipo === 'vincular') {
          const caso = db.prepare("SELECT * FROM guardia_ml_casos WHERE id=?").get(op.caso_id);
          const producto = db.prepare('SELECT nombre,stock FROM catalogo_cache WHERE sku=?').get(op.sku);
          if (caso && producto) {
            db.prepare(`INSERT INTO sku_matcher_decisiones (clave,sku,wc_nombre,accion,origen,confirmado_por,actualizado_en) VALUES (?,?,?,'confirmar','guardia_ml','sistema',?)
              ON CONFLICT(clave) DO UPDATE SET sku=excluded.sku,wc_nombre=excluded.wc_nombre,accion='confirmar',origen='guardia_ml',confirmado_por=excluded.confirmado_por,actualizado_en=excluded.actualizado_en`).run(caso.clave,op.sku,producto.nombre,ts);
            db.prepare("UPDATE guardia_ml_casos SET estado='resuelto',bloquea_sync=0,resuelto_en=?,actualizado_en=?,expected_version=expected_version+1 WHERE id=? AND estado='pendiente_ml'").run(ts,ts,op.caso_id);
            registrarAprendizajeGuardia(db, perfilPublicacionMl(caso), op.sku, ts);
          }
        } else {
          db.prepare("UPDATE guardia_ml_casos SET estado='resuelto',bloquea_sync=0,resuelto_en=?,actualizado_en=?,expected_version=expected_version+1 WHERE id=? AND estado='pendiente_ml'").run(ts,ts,op.caso_id);
        }
        registrarEventoGuardia(db,op.caso_id,'operacion_confirmada','sistema',{operacion:op.tipo});
      })();
      ok++;
    }
    else {const intentos=op.intentos+1;const demora=RETRY_MS[Math.min(intentos-1,RETRY_MS.length-1)];const error=String(resultado?.error||'fallo remoto').slice(0,500);db.prepare("UPDATE guardia_ml_operaciones SET estado='pendiente',claim_hasta=NULL,intentos=?,proximo_intento_en=?,ultimo_error=?,actualizado_en=? WHERE id=?").run(intentos,new Date(Date.now()+demora).toISOString(),error,ts,op.id);registrarEventoGuardia(db,op.caso_id,'operacion_reintentada','sistema',{operacion:op.tipo,operacion_id:op.id,intentos,error,proximo_intento_en:new Date(Date.now()+demora).toISOString()});fallidas++;}
  }
  return {procesadas:rows.length,ok,fallidas};
}
