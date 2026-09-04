import crypto from 'node:crypto';

const FRESCURA_MS = 60 * 60 * 1000;
const INTERVENCION_MS = 15 * 60 * 1000;
const BACKOFF_MS = [500, 1500, 4000];
const PASOS = ['zero', 'verify_zero', 'clear', 'verify_clear', 'write', 'verify_write', 'restore', 'verify_restore', 'activate', 'reprocess'];

const now = () => new Date().toISOString();

function json(value) { return JSON.stringify(value ?? null); }
function parseJson(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }

function estable(value) {
  if (Array.isArray(value)) return value.map(estable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, estable(value[k])]));
  return value;
}

export function fingerprintEvidencia(value) {
  return crypto.createHash('sha256').update(JSON.stringify(estable(value))).digest('hex');
}

export function normalizarGtin(value) {
  const gtin = String(value ?? '').trim();
  return /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(gtin) ? gtin : null;
}

export function esGtinValido(value) {
  const gtin = normalizarGtin(value);
  if (!gtin) return false;
  let suma = 0;
  for (let i = gtin.length - 2, posicion = 0; i >= 0; i--, posicion++) {
    suma += Number(gtin[i]) * (posicion % 2 === 0 ? 3 : 1);
  }
  return (10 - (suma % 10)) % 10 === Number(gtin.at(-1));
}

function registrarHistorial(db, entidadTipo, entidadId, evento, actor, detalle = null, ts = now()) {
  db.prepare(`INSERT INTO identidad_historial
    (entidad_tipo,entidad_id,evento,actor,detalle_json,creado_en) VALUES (?,?,?,?,?,?)`)
    .run(entidadTipo, entidadId ?? null, evento, actor || null, detalle == null ? null : json(detalle), ts);
}

function familiaBootstrap(db, ts) {
  db.prepare(`INSERT OR IGNORE INTO identidad_familias
    (nombre,estado,version,creado_por,creado_en,actualizado_en)
    VALUES ('Legacy Woo','activa',1,'sistema',?,?)`).run(ts, ts);
  const familia = db.prepare("SELECT id FROM identidad_familias WHERE nombre='Legacy Woo'").get();
  db.prepare(`INSERT OR IGNORE INTO identidad_reglas_familia
    (familia_id,version,atributos_requeridos_json,estado,creado_por,creado_en)
    VALUES (?,1,'[]','activa','sistema',?)`).run(familia.id, ts);
  return familia.id;
}

/** Bootstrap idempotente: una fila de catalogo_cache es una unidad vendible, no una familia. */
export function bootstrapProductosFusion(db, actor = 'sistema') {
  const ts = now();
  const familiaId = familiaBootstrap(db, ts);
  let creados = 0;
  const productos = db.prepare(`SELECT id_woo,nombre,sku,gtin,stock,actualizado_en
    FROM catalogo_cache WHERE id_woo IS NOT NULL ORDER BY id_woo`).all();
  const insertarProducto = db.prepare(`INSERT OR IGNORE INTO productos_fusion
    (nombre_canonico,familia_id,primary_woo_id,estado,creado_por,creado_en,actualizado_en)
    VALUES (?,?,?,'activo',?,?,?)`);
  const insertarIdentidad = db.prepare(`INSERT INTO identidades_canal
    (producto_id,canal,external_key,seller_sku_observado,gtin_observado,stock_observado,observado_en,
     sku_verificado_en,stock_verificado_en,evidencia_fingerprint,activa,creado_en,actualizado_en)
    VALUES (?,'woo',?,?,?,?,?,?,?,?,1,?,?)`);
  for (const woo of productos) {
    const r = insertarProducto.run(woo.nombre || `Woo ${woo.id_woo}`, familiaId, woo.id_woo, actor, ts, ts);
    creados += r.changes;
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(woo.id_woo);
    db.prepare(`UPDATE productos_fusion SET nombre_canonico=?, actualizado_en=?
      WHERE id=? AND estado!='archivado'`).run(woo.nombre || producto.nombre_canonico, ts, producto.id);
    const fp = fingerprintEvidencia({ canal: 'woo', id: woo.id_woo, sku: woo.sku || '', gtin: woo.gtin || '', stock: woo.stock, observado_en: woo.actualizado_en });
    const existente = db.prepare("SELECT id FROM identidades_canal WHERE canal='woo' AND external_key=? AND activa=1").get(String(woo.id_woo));
    if (existente) {
      db.prepare(`UPDATE identidades_canal SET producto_id=?,seller_sku_observado=?,gtin_observado=?,
        stock_observado=?,observado_en=?,evidencia_fingerprint=?,actualizado_en=? WHERE id=?`)
        .run(producto.id, woo.sku || null, woo.gtin || null, woo.stock ?? null, woo.actualizado_en || ts, fp, ts, existente.id);
    } else {
      insertarIdentidad.run(producto.id, String(woo.id_woo), woo.sku || null, woo.gtin || null,
        woo.stock ?? null, woo.actualizado_en || ts, woo.actualizado_en || ts, woo.actualizado_en || ts, fp, ts, ts);
    }
    for (const [tipo, valor] of [['fusion_sku', producto.fusion_sku], ['woo_sku', woo.sku], ['gtin', esGtinValido(woo.gtin) ? normalizarGtin(woo.gtin) : null]]) {
      if (!valor) continue;
      db.prepare(`INSERT OR IGNORE INTO identificadores_producto
        (tipo,valor_normalizado,producto_id,estado,creado_en,actualizado_en) VALUES (?,?,?,'activo',?,?)`)
        .run(tipo, valor, producto.id, ts, ts);
    }
  }
  return { total: productos.length, creados };
}

function lookupWoo(db, sellerSku, gtin) {
  const porSku = sellerSku ? db.prepare(`SELECT id_woo,nombre,sku,gtin,stock,actualizado_en
    FROM catalogo_cache WHERE sku=? ORDER BY id_woo`).all(sellerSku) : [];
  const gtinCanonico = esGtinValido(gtin) ? normalizarGtin(gtin) : null;
  const porGtin = gtinCanonico ? db.prepare(`SELECT id_woo,nombre,sku,gtin,stock,actualizado_en
    FROM catalogo_cache WHERE gtin=? ORDER BY id_woo`).all(gtinCanonico) : [];
  return { porSku, porGtin, gtinCanonico };
}

export function clasificarClaveMl(db, publicacion) {
  const sellerSku = String(publicacion.seller_sku ?? '').trim();
  const presente = Number(publicacion.seller_sku_presente) === 1;
  const { porSku, porGtin, gtinCanonico } = lookupWoo(db, sellerSku, publicacion.gtin);
  let clasificacion;
  let productoWoo = null;
  if (!presente) clasificacion = 'sku_ausente';
  else if (!sellerSku) clasificacion = 'sku_vacio';
  else if (porSku.length === 0) clasificacion = 'sku_inexistente';
  else if (porSku.length > 1) clasificacion = 'sku_no_unico';
  else {
    productoWoo = porSku[0];
    const contradice = gtinCanonico && porGtin.length > 0 && !porGtin.some((p) => p.id_woo === productoWoo.id_woo);
    clasificacion = contradice ? 'gtin_contradictorio' : 'sku_exacto';
  }
  // GTIN válido y único puede proponer un producto, pero no transforma una ausencia de SKU
  // en cobertura: la corrección y verificación remota siguen siendo obligatorias.
  if (!productoWoo && porGtin.length === 1) productoWoo = porGtin[0];
  return { clasificacion, sellerSku, productoWoo, coincidenciasSku: porSku.length, coincidenciasGtin: porGtin.length, gtinCanonico };
}

function upsertCaso(db, pub, clasificacion, productoId, fp, estado, ts) {
  const anterior = db.prepare("SELECT * FROM identidad_casos WHERE direccion='ml_fusion' AND ml_key=?").get(pub.clave);
  if (!anterior) {
    const r = db.prepare(`INSERT INTO identidad_casos
      (direccion,ml_key,producto_id,clasificacion,estado,severidad,evidencia_fingerprint,primera_deteccion_en,ultima_deteccion_en,resuelto_en)
      VALUES ('ml_fusion',?,?,?,?,?,?,?, ?,?)`).run(pub.clave, productoId, clasificacion, estado,
        estado === 'verificado' ? 'normal' : 'urgente', fp, ts, ts, estado === 'verificado' ? ts : null);
    return db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(r.lastInsertRowid);
  }
  const cambio = anterior.evidencia_fingerprint !== fp || anterior.clasificacion !== clasificacion || anterior.producto_id !== productoId;
  let proximoEstado = anterior.estado;
  if (cambio) {
    db.prepare(`UPDATE identidad_excepciones SET activa=0,invalidada_en=?,invalidada_motivo='cambio_identidad'
      WHERE caso_id=? AND activa=1`).run(ts, anterior.id);
    proximoEstado = estado;
  } else if (!['exceptuado', 'pendiente', 'intervencion'].includes(anterior.estado)) proximoEstado = estado;
  db.prepare(`UPDATE identidad_casos SET producto_id=?,clasificacion=?,estado=?,severidad=?,
    evidencia_fingerprint=?,ultima_deteccion_en=?,resuelto_en=?,expected_version=expected_version+?
    WHERE id=?`).run(productoId, clasificacion, proximoEstado, proximoEstado === 'verificado' ? 'normal' : 'urgente',
      fp, ts, proximoEstado === 'verificado' ? ts : null, cambio ? 1 : 0, anterior.id);
  return db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(anterior.id);
}

function activarIdentidadObservada(db, caso, pub, producto, fp, ts) {
  db.prepare("UPDATE identidades_canal SET activa=0,archivado_en=?,actualizado_en=? WHERE canal='ml' AND external_key=? AND activa=1 AND producto_id<>?")
    .run(ts, ts, pub.clave, producto.id);
  const actual = db.prepare("SELECT id FROM identidades_canal WHERE canal='ml' AND external_key=? AND producto_id=? ORDER BY id DESC LIMIT 1")
    .get(pub.clave, producto.id);
  if (actual) {
    db.prepare(`UPDATE identidades_canal SET item_id=?,variation_id=?,seller_sku_observado=?,gtin_observado=?,
      stock_observado=?,stock_objetivo=?,observado_en=?,sku_verificado_en=?,stock_verificado_en=?,
      evidencia_fingerprint=?,activa=1,archivado_en=NULL,actualizado_en=?,expected_version=expected_version+1 WHERE id=?`)
      .run(pub.item_id, pub.variation_id || null, pub.seller_sku || null, pub.gtin || null, pub.available_quantity,
        pub.available_quantity, pub.actualizado_en, ts, ts, fp, ts, actual.id);
  } else {
    db.prepare(`INSERT INTO identidades_canal
      (producto_id,canal,external_key,item_id,variation_id,seller_sku_observado,gtin_observado,
       stock_observado,stock_objetivo,observado_en,sku_verificado_en,stock_verificado_en,evidencia_fingerprint,activa,creado_en,actualizado_en)
      VALUES (?,'ml',?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
      .run(producto.id, pub.clave, pub.item_id, pub.variation_id || null, pub.seller_sku || null, pub.gtin || null,
        pub.available_quantity, pub.available_quantity, pub.actualizado_en, ts, ts, fp, ts, ts);
  }
  // Compatibilidad legacy: usa el SKU vigente de Woo, porque los consumidores legacy unen
  // contra catalogo_cache.sku. Solo se refleja después de verificar remoto.
  const woo = db.prepare('SELECT sku,nombre FROM catalogo_cache WHERE id_woo=?').get(producto.primary_woo_id);
  if (woo?.sku) db.prepare(`INSERT INTO sku_matcher_decisiones
    (clave,sku,wc_nombre,accion,actualizado_en,origen,confirmado_por)
    VALUES (?,?,?,'confirmar',?,'identidad_productos','sistema')
    ON CONFLICT(clave) DO UPDATE SET sku=excluded.sku,wc_nombre=excluded.wc_nombre,accion='confirmar',
      actualizado_en=excluded.actualizado_en,origen=excluded.origen,confirmado_por=excluded.confirmado_por`)
    .run(pub.clave, woo.sku, woo.nombre, ts);
  registrarHistorial(db, 'caso', caso.id, 'identidad_verificada', 'sistema', { ml_key: pub.clave, producto_id: producto.id }, ts);
}

/** Auditoría exhaustiva y local. lecturaConfiable solo debe venir de una relectura ML completa exitosa. */
export function auditarIdentidadProductos(db, actor = 'sistema', { lecturaConfiable = false, ahora = new Date() } = {}) {
  const ts = ahora.toISOString();
  bootstrapProductosFusion(db, actor);
  const publicaciones = db.prepare(`SELECT * FROM ml_publicaciones_cache
    WHERE status='active' AND COALESCE(available_quantity,0)>0 ORDER BY clave`).all();
  let verificadas = 0;
  for (const pub of publicaciones) {
    const match = clasificarClaveMl(db, pub);
    const producto = match.productoWoo ? db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(match.productoWoo.id_woo) : null;
    const observacionFresca = lecturaConfiable && Number.isFinite(Date.parse(pub.actualizado_en))
      && ahora.getTime() - Date.parse(pub.actualizado_en) >= 0 && ahora.getTime() - Date.parse(pub.actualizado_en) < FRESCURA_MS;
    const stockCoincide = producto && Number(pub.available_quantity) === Number(match.productoWoo.stock);
    const seVerifica = match.clasificacion === 'sku_exacto' && observacionFresca && stockCoincide;
    const clasificacion = match.clasificacion === 'sku_exacto' && !seVerifica ? 'stock_no_verificado' : match.clasificacion;
    const evidencia = {
      ml: { clave: pub.clave, item_id: pub.item_id, variation_id: pub.variation_id || '', seller_sku_presente: pub.seller_sku_presente,
        seller_sku: pub.seller_sku ?? null, seller_custom_field: pub.seller_custom_field ?? null, gtin: pub.gtin ?? null,
        stock: pub.available_quantity, observado_en: pub.actualizado_en },
      woo: match.productoWoo ? { id_woo: match.productoWoo.id_woo, sku: match.productoWoo.sku, gtin: match.productoWoo.gtin, stock: match.productoWoo.stock } : null,
      clasificacion,
    };
    const fp = fingerprintEvidencia(evidencia);
    const caso = upsertCaso(db, pub, clasificacion, producto?.id ?? null, fp, seVerifica ? 'verificado' : 'urgente', ts);
    db.prepare(`INSERT OR IGNORE INTO identidad_evidencias
      (caso_id,tipo,fuente,contenido_json,fingerprint,confiable,observado_en,creado_por,creado_en)
      VALUES (?,'auditoria','sistema',?,?,?,?,?,?)`)
      .run(caso.id, json(evidencia), fp, observacionFresca ? 1 : 0, pub.actualizado_en || ts, actor, ts);
    if (seVerifica) { activarIdentidadObservada(db, caso, pub, producto, fp, ts); verificadas++; }
  }
  // Una excepción vencida nunca queda contando como cierre explícito.
  db.prepare(`UPDATE identidad_excepciones SET activa=0,invalidada_en=?,invalidada_motivo='vencida'
    WHERE activa=1 AND vence_en IS NOT NULL AND vence_en<=?`).run(ts, ts);
  db.prepare(`UPDATE identidad_casos SET estado='urgente',expected_version=expected_version+1
    WHERE estado='exceptuado' AND NOT EXISTS
      (SELECT 1 FROM identidad_excepciones e WHERE e.caso_id=identidad_casos.id AND e.activa=1)`).run();
  if (lecturaConfiable) db.prepare(`UPDATE identidad_config SET ultimo_scan_confiable_en=?,ultimo_scan_error=NULL,actualizado_en=? WHERE id=1`).run(ts, ts);
  const exceptuadas = db.prepare(`SELECT COUNT(*) n FROM identidad_casos c WHERE c.estado='exceptuado'
    AND EXISTS (SELECT 1 FROM identidad_excepciones e WHERE e.caso_id=c.id AND e.activa=1)`).get().n;
  const urgentes = db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE direccion='ml_fusion' AND estado IN ('urgente','tomado','pendiente','intervencion')").get().n;
  return { total: publicaciones.length, verificadas, excepciones: exceptuadas, urgentes, conciliado: publicaciones.length === verificadas + exceptuadas + urgentes, escaneado_en: ts };
}

export function estadoIdentidadProductos(db, ahora = new Date()) {
  const config = db.prepare('SELECT * FROM identidad_config WHERE id=1').get();
  const ultimo = config?.ultimo_scan_confiable_en ? Date.parse(config.ultimo_scan_confiable_en) : NaN;
  const degradado = !Number.isFinite(ultimo) || ahora.getTime() - ultimo >= FRESCURA_MS || !!config?.ultimo_scan_error;
  const urgentes = db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE estado IN ('urgente','tomado','pendiente','intervencion')").get().n;
  const operaciones = db.prepare("SELECT COUNT(*) n FROM identidad_operaciones WHERE estado NOT IN ('completada','shadow')").get().n;
  return { ...config, degradado, sano: !degradado && urgentes === 0 && operaciones === 0, urgentes, operaciones_pendientes: operaciones };
}

export function listarCasosIdentidad(db, { direccion = 'ml_fusion', estado } = {}) {
  const condiciones = ['c.direccion=?']; const params = [direccion];
  if (estado) { condiciones.push('c.estado=?'); params.push(estado); }
  return db.prepare(`SELECT c.*,p.nombre_canonico,p.fusion_sku,m.titulo,m.seller_sku,m.seller_custom_field,
    m.gtin,m.available_quantity,m.actualizado_en AS ml_observado_en
    FROM identidad_casos c LEFT JOIN productos_fusion p ON p.id=c.producto_id
    LEFT JOIN ml_publicaciones_cache m ON m.clave=c.ml_key
    WHERE ${condiciones.join(' AND ')} ORDER BY CASE c.severidad WHEN 'critica' THEN 0 WHEN 'urgente' THEN 1 ELSE 2 END,c.primera_deteccion_en`).all(...params);
}

export function obtenerCasoIdentidad(db, id) {
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(Number(id));
  if (!caso) return null;
  return { ...caso,
    evidencia: db.prepare('SELECT * FROM identidad_evidencias WHERE caso_id=? ORDER BY id').all(caso.id).map((e) => ({ ...e, contenido: parseJson(e.contenido_json) })),
    decisiones: db.prepare('SELECT * FROM identidad_decisiones WHERE caso_id=? ORDER BY id').all(caso.id),
    excepciones: db.prepare('SELECT * FROM identidad_excepciones WHERE caso_id=? ORDER BY id').all(caso.id),
    notas: db.prepare('SELECT * FROM identidad_notas WHERE caso_id=? ORDER BY id').all(caso.id),
  };
}

export function listarProductosFusion(db) {
  return db.prepare(`SELECT p.*,
    f.nombre AS familia_nombre,
    (SELECT COUNT(*) FROM identidades_canal i WHERE i.producto_id=p.id AND i.canal='ml' AND i.activa=1) AS identidades_ml_activas,
    (SELECT MAX(i.stock_verificado_en) FROM identidades_canal i WHERE i.producto_id=p.id AND i.canal='ml' AND i.activa=1) AS ultima_verificacion_ml
    FROM productos_fusion p LEFT JOIN identidad_familias f ON f.id=p.familia_id
    ORDER BY p.nombre_canonico COLLATE NOCASE,p.id`).all();
}

/**
 * Búsqueda humana de Producto Fusion para vincular una clave ML. Es deliberadamente una
 * búsqueda explícita por texto, no un matcher: el candidato aproximado por familia, su
 * puntaje y su explicación son UM1.4. Acá la persona escribe y elige.
 * Solo devuelve productos `activo`: un provisional no tiene `fusion_sku` y no puede
 * sincronizarse, así que no es un destino válido de vínculo.
 */
export function buscarProductosFusion(db, { q = '', limite = 20 } = {}) {
  const texto = String(q || '').trim();
  // `Number(limite) || 20` mandaba `limite: 0` al default en vez de clamparlo: 0 es falsy.
  const pedido = Number(limite);
  const tope = Math.min(50, Math.max(1, Number.isFinite(pedido) ? pedido : 20));
  const like = `%${texto.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const filtro = texto
    ? `AND (p.nombre_canonico LIKE ? ESCAPE '\\' OR p.fusion_sku LIKE ? ESCAPE '\\' OR w.sku LIKE ? ESCAPE '\\' OR w.gtin LIKE ? ESCAPE '\\')`
    : '';
  const params = texto ? [like, like, like, like, tope] : [tope];
  return db.prepare(`SELECT p.id,p.nombre_canonico,p.fusion_sku,p.estado,p.primary_woo_id,
    w.sku AS sku_woo,w.stock AS stock_woo,w.img,w.marca,w.gtin,
    (SELECT COUNT(*) FROM identidades_canal i WHERE i.producto_id=p.id AND i.canal='ml' AND i.activa=1) AS identidades_ml_activas
    FROM productos_fusion p LEFT JOIN catalogo_cache w ON w.id_woo=p.primary_woo_id
    WHERE p.estado='activo' ${filtro}
    ORDER BY p.nombre_canonico COLLATE NOCASE,p.id LIMIT ?`).all(...params);
}
export function listarOperacionesIdentidad(db) {
  return db.prepare(`SELECT o.*,c.expected_version AS caso_expected_version,c.evidencia_fingerprint,
    p.nombre_canonico,p.fusion_sku
    FROM identidad_operaciones o JOIN identidad_casos c ON c.id=o.caso_id
    JOIN productos_fusion p ON p.id=o.producto_id ORDER BY o.id DESC`).all();
}

export function obtenerOperacionIdentidad(db, id) {
  const operacion = db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(Number(id));
  if (!operacion) return null;
  return { ...operacion, pasos: db.prepare('SELECT * FROM identidad_operacion_pasos WHERE operacion_id=? ORDER BY id').all(operacion.id) };
}

export function listarHistorialIdentidad(db, { limite = 200 } = {}) {
  return db.prepare('SELECT * FROM identidad_historial ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, Number(limite) || 200)));
}

function validarMutacion(caso, input) {
  if (!String(input.operation_id || '').trim()) return { code: 'INVALID_INPUT', error: 'operation_id requerido' };
  if (!Number.isInteger(Number(input.expected_version))) return { code: 'INVALID_INPUT', error: 'expected_version requerido' };
  if (!String(input.evidence_fingerprint || '').trim()) return { code: 'INVALID_INPUT', error: 'evidence_fingerprint requerido' };
  if (Number(input.expected_version) !== caso.expected_version) return { code: 'VERSION_CONFLICT', error: 'El caso cambió; refrescá antes de decidir' };
  if (input.evidence_fingerprint !== caso.evidencia_fingerprint) return { code: 'EVIDENCE_CONFLICT', error: 'La evidencia cambió; revisá el caso nuevamente' };
  return null;
}

export function decidirCasoIdentidad(db, casoId, input, actor) {
  const repetida = db.prepare('SELECT * FROM identidad_decisiones WHERE operation_id=?').get(String(input.operation_id || '').trim());
  if (repetida) return { ok: true, repetido: true, decision: repetida };
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(Number(casoId));
  if (!caso) return { ok: false, code: 'NOT_FOUND', error: 'caso no encontrado' };
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };
  const tipo = input.tipo;
  if (!['vincular', 'solo_ml', 'investigar'].includes(tipo)) return { ok: false, code: 'INVALID_INPUT', error: 'tipo de decisión inválido' };
  if (tipo === 'solo_ml' && !String(input.motivo || '').trim()) return { ok: false, code: 'INVALID_INPUT', error: 'motivo requerido para solo_ml' };
  const producto = tipo === 'vincular' ? db.prepare("SELECT * FROM productos_fusion WHERE id=? AND estado='activo'").get(Number(input.product_id)) : null;
  if (tipo === 'vincular' && !producto) return { ok: false, code: 'INVALID_INPUT', error: 'Producto Fusion activo requerido' };
  const pub = db.prepare('SELECT * FROM ml_publicaciones_cache WHERE clave=?').get(caso.ml_key);
  if (!pub) return { ok: false, code: 'NOT_FOUND', error: 'observación ML no encontrada' };
  const hermanas = db.prepare(`SELECT COUNT(*) n FROM ml_publicaciones_cache
    WHERE item_id=? AND clave<>? AND status='active'`).get(pub.item_id, pub.clave).n;
  if (tipo === 'vincular' && hermanas > 0 && input.confirm_sibling_impact !== true) {
    return { ok: false, code: 'SIBLING_IMPACT_CONFIRMATION_REQUIRED', error: 'La corrección puede afectar variaciones hermanas', sibling_count: hermanas };
  }
  const ts = now();
  return db.transaction(() => {
    const d = db.prepare(`INSERT INTO identidad_decisiones
      (caso_id,producto_id,tipo,explicacion,operation_id,expected_version,evidencia_fingerprint,decidida_por,decidida_en)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(caso.id, producto?.id ?? null, tipo, input.motivo || input.explicacion || null,
        input.operation_id, caso.expected_version, caso.evidencia_fingerprint, actor, ts);
    const decision = db.prepare('SELECT * FROM identidad_decisiones WHERE id=?').get(d.lastInsertRowid);
    if (tipo === 'solo_ml') {
      db.prepare(`INSERT INTO identidad_excepciones
        (caso_id,tipo,motivo,vence_en,evidencia_fingerprint,creada_por,creada_en)
        VALUES (?,'solo_ml',?,?,?,?,?)`).run(caso.id, input.motivo.trim(), input.expires_at || null, caso.evidencia_fingerprint, actor, ts);
      db.prepare("UPDATE identidad_casos SET estado='exceptuado',expected_version=expected_version+1,resuelto_en=?,ultima_deteccion_en=? WHERE id=?")
        .run(ts, ts, caso.id);
      registrarHistorial(db, 'caso', caso.id, 'excepcion_solo_ml', actor, { decision_id: decision.id, vence_en: input.expires_at || null }, ts);
      return { ok: true, decision, caso: db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(caso.id) };
    }
    if (tipo === 'investigar') {
      db.prepare("UPDATE identidad_casos SET estado='tomado',responsable=?,tomado_en=COALESCE(tomado_en,?),expected_version=expected_version+1 WHERE id=?")
        .run(actor, ts, caso.id);
      registrarHistorial(db, 'caso', caso.id, 'investigacion_iniciada', actor, { decision_id: decision.id }, ts);
      return { ok: true, decision, caso: db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(caso.id) };
    }
    const config = db.prepare('SELECT * FROM identidad_config WHERE id=1').get();
    const estadoOperacion = config.modo === 'shadow' || config.escrituras_remotas_habilitadas !== 1 ? 'shadow' : (hermanas > 0 ? 'bloqueada_impacto' : 'pendiente');
    const op = db.prepare(`INSERT INTO identidad_operaciones
      (operation_id,caso_id,decision_id,producto_id,ml_key,sku_anterior,sku_objetivo,stock_objetivo,
       estado,paso_actual,impacto_hermanas,impacto_confirmado,iniciada_en,proximo_intento_en,actualizada_en)
      VALUES (?,?,?,?,?,?,?,?,?,'zero',?,?,?,?,?)`).run(input.operation_id, caso.id, decision.id, producto.id, caso.ml_key,
        pub.seller_sku || null, producto.fusion_sku, Number(db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo=?').get(producto.primary_woo_id)?.stock ?? 0),
        estadoOperacion, hermanas, input.confirm_sibling_impact === true ? 1 : 0, ts, ts, ts);
    db.prepare("UPDATE identidad_casos SET estado='pendiente',responsable=?,tomado_en=COALESCE(tomado_en,?),expected_version=expected_version+1 WHERE id=?")
      .run(actor, ts, caso.id);
    registrarHistorial(db, 'operacion', op.lastInsertRowid, 'decision_persistida_antes_de_efecto', actor, { decision_id: decision.id, modo: config.modo }, ts);
    return { ok: true, decision, operacion: db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.lastInsertRowid) };
  })();
}

export function agregarNotaIdentidad(db, casoId, input, actor) {
  const operationId = String(input.operation_id || '').trim();
  const nota = String(input.nota || '').trim();
  if (!operationId || !nota) return { ok: false, code: 'INVALID_INPUT', error: 'operation_id y nota requeridos' };
  const repetida = db.prepare('SELECT * FROM identidad_notas WHERE operation_id=?').get(operationId);
  if (repetida) return { ok: true, repetido: true, nota: repetida };
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(Number(casoId));
  if (!caso) return { ok: false, code: 'NOT_FOUND', error: 'caso no encontrado' };
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };
  const ts = now();
  const r = db.prepare('INSERT INTO identidad_notas(caso_id,nota,operation_id,creada_por,creada_en) VALUES (?,?,?,?,?)')
    .run(Number(casoId), nota, operationId, actor, ts);
  registrarHistorial(db, 'caso', Number(casoId), 'nota_agregada', actor, { nota_id: r.lastInsertRowid }, ts);
  return { ok: true, nota: db.prepare('SELECT * FROM identidad_notas WHERE id=?').get(r.lastInsertRowid) };
}

function comandoRepetido(db, operationId) {
  const row = db.prepare('SELECT resultado_json FROM identidad_comandos WHERE operation_id=?').get(operationId);
  return row ? parseJson(row.resultado_json, { ok: true, repetido: true }) : null;
}

function guardarComando(db, operationId, tipo, entidadTipo, entidadId, resultado, actor, ts) {
  db.prepare(`INSERT INTO identidad_comandos
    (operation_id,tipo,entidad_tipo,entidad_id,resultado_json,ejecutado_por,ejecutado_en)
    VALUES (?,?,?,?,?,?,?)`).run(operationId, tipo, entidadTipo, entidadId, json(resultado), actor, ts);
}

export function asignarCasoIdentidad(db, casoId, input, actor, { relevo = false } = {}) {
  const operationId = String(input.operation_id || '').trim();
  const repetido = operationId && comandoRepetido(db, operationId);
  if (repetido) return { ...repetido, repetido: true };
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(Number(casoId));
  if (!caso) return { ok: false, code: 'NOT_FOUND', error: 'caso no encontrado' };
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };
  const responsable = String(input.responsable || actor || '').trim();
  if (!responsable) return { ok: false, code: 'INVALID_INPUT', error: 'responsable requerido' };
  if (caso.responsable && caso.responsable !== responsable && !relevo) return { ok: false, code: 'CLAIM_CONFLICT', error: `caso tomado por ${caso.responsable}` };
  if (relevo && caso.responsable && caso.responsable !== responsable && !String(input.motivo || '').trim()) {
    return { ok: false, code: 'INVALID_INPUT', error: 'motivo de relevo requerido' };
  }
  const ts = now();
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE identidad_casos SET responsable=?,tomado_en=?,estado='tomado',
      expected_version=expected_version+1 WHERE id=? AND expected_version=?`).run(responsable, ts, caso.id, caso.expected_version);
    if (!changed.changes) return { ok: false, code: 'VERSION_CONFLICT', error: 'el caso cambió' };
    const actualizado = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(caso.id);
    const resultado = { ok: true, caso: actualizado };
    guardarComando(db, operationId, relevo ? 'relevar' : 'tomar', 'caso', caso.id, resultado, actor, ts);
    registrarHistorial(db, 'caso', caso.id, relevo ? 'relevado' : 'tomado', actor, { responsable, motivo: input.motivo || null }, ts);
    return resultado;
  })();
}

export function reintentarOperacionIdentidad(db, operacionId, input, actor) {
  const operationId = String(input.operation_id || '').trim();
  const repetido = operationId && comandoRepetido(db, operationId);
  if (repetido) return { ...repetido, repetido: true };
  const op = db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(Number(operacionId));
  if (!op) return { ok: false, code: 'NOT_FOUND', error: 'operación no encontrada' };
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(op.caso_id);
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };
  if (!['fallida', 'intervencion', 'shadow'].includes(op.estado)) return { ok: false, code: 'INVALID_STATE', error: 'la operación no admite reintento' };
  const config = db.prepare('SELECT * FROM identidad_config WHERE id=1').get();
  const estado = config.modo === 'enforced' && config.escrituras_remotas_habilitadas === 1 ? 'pendiente' : 'shadow';
  const ts = now();
  return db.transaction(() => {
    db.prepare(`UPDATE identidad_operaciones SET estado=?,intentos=0,ultimo_error=NULL,
      proximo_intento_en=?,claim_hasta=NULL,actualizada_en=? WHERE id=?`).run(estado, ts, ts, op.id);
    db.prepare("UPDATE identidad_casos SET estado='pendiente',expected_version=expected_version+1 WHERE id=?").run(caso.id);
    const resultado = { ok: true, operacion: db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.id) };
    guardarComando(db, operationId, 'reintentar', 'operacion', op.id, resultado, actor, ts);
    registrarHistorial(db, 'operacion', op.id, 'reintento_solicitado', actor, { estado }, ts);
    return resultado;
  })();
}

export function cambiarModoIdentidad(db, modo, actor) {
  if (!['shadow', 'enforced'].includes(modo)) return { ok: false, code: 'INVALID_INPUT', error: 'modo inválido' };
  const ts = now();
  db.prepare('UPDATE identidad_config SET modo=?,actualizado_en=? WHERE id=1').run(modo, ts);
  registrarHistorial(db, 'config', 1, 'modo_cambiado', actor, { modo, escrituras_remotas_habilitadas: false }, ts);
  return { ok: true, config: db.prepare('SELECT * FROM identidad_config WHERE id=1').get(), advertencia: 'Las escrituras remotas permanecen deshabilitadas por gate operativo' };
}

function confirmarLectura(lectura, esperada) {
  const observado = Date.parse(lectura?.observed_at || '');
  return Number.isFinite(observado) && Date.now() - observado >= 0 && Date.now() - observado < FRESCURA_MS && esperada(lectura);
}

/**
 * Ejecuta un único paso durable. El servidor no invoca esta función: requiere un adaptador
 * y allowRemoteWrites=true provistos explícitamente por el rollout/canario. Fail-closed:
 * ninguna respuesta ambigua avanza la saga ni activa la relación local.
 */
export async function procesarPasoOperacionIdentidad(db, operacionId, adapter, { allowRemoteWrites = false } = {}) {
  let op = db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(Number(operacionId));
  if (!op) return { ok: false, code: 'NOT_FOUND' };
  if (!allowRemoteWrites) return { ok: false, code: 'REMOTE_WRITES_DISABLED', operacion: op };
  if (op.estado === 'shadow') db.prepare("UPDATE identidad_operaciones SET estado='pendiente',actualizada_en=? WHERE id=?").run(now(), op.id);
  op = db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.id);
  if (['completada', 'intervencion'].includes(op.estado)) return { ok: op.estado === 'completada', operacion: op };
  const ts = now();
  if (op.intentos >= 3 || Date.now() - Date.parse(op.iniciada_en) >= INTERVENCION_MS) {
    db.prepare("UPDATE identidad_operaciones SET estado='intervencion',ultimo_error='umbral de intervención alcanzado',actualizada_en=? WHERE id=?").run(ts, op.id);
    db.prepare("UPDATE identidad_casos SET estado='intervencion',expected_version=expected_version+1 WHERE id=?").run(op.caso_id);
    return { ok: false, code: 'INTERVENTION_REQUIRED', operacion: db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.id) };
  }
  const paso = op.paso_actual;
  const intento = op.intentos + 1;
  const pasoId = db.prepare(`INSERT INTO identidad_operacion_pasos
    (operacion_id,paso,estado,intento,iniciado_en) VALUES (?,?,'procesando',?,?)`).run(op.id, paso, intento, ts).lastInsertRowid;
  db.prepare("UPDATE identidad_operaciones SET estado='procesando',claim_hasta=?,actualizada_en=? WHERE id=?")
    .run(new Date(Date.now() + INTERVENCION_MS).toISOString(), ts, op.id);
  try {
    let respuesta = null;
    if (paso === 'zero') respuesta = await adapter.setStock(op.ml_key, 0);
    else if (paso === 'verify_zero') { respuesta = await adapter.read(op.ml_key); if (!confirmarLectura(respuesta, (r) => Number(r.stock) === 0)) throw new Error('stock cero no verificado remotamente'); }
    else if (paso === 'clear') respuesta = await adapter.clearSku(op.ml_key);
    else if (paso === 'verify_clear') { respuesta = await adapter.read(op.ml_key); if (!confirmarLectura(respuesta, (r) => !String(r.seller_sku || '').trim() && Number(r.stock) === 0)) throw new Error('SKU vacío no verificado remotamente'); }
    else if (paso === 'write') respuesta = await adapter.writeSku(op.ml_key, op.sku_objetivo);
    else if (paso === 'verify_write') { respuesta = await adapter.read(op.ml_key); if (!confirmarLectura(respuesta, (r) => r.seller_sku === op.sku_objetivo && Number(r.stock) === 0)) throw new Error('SKU objetivo no verificado remotamente'); }
    else if (paso === 'restore') respuesta = await adapter.setStock(op.ml_key, op.stock_objetivo);
    else if (paso === 'verify_restore') { respuesta = await adapter.read(op.ml_key); if (!confirmarLectura(respuesta, (r) => r.seller_sku === op.sku_objetivo && Number(r.stock) === op.stock_objetivo)) throw new Error('SKU y stock restaurado no verificados remotamente'); }
    else if (paso === 'activate') {
      const pub = db.prepare('SELECT * FROM ml_publicaciones_cache WHERE clave=?').get(op.ml_key);
      const producto = db.prepare('SELECT * FROM productos_fusion WHERE id=?').get(op.producto_id);
      const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(op.caso_id);
      const lectura = await adapter.read(op.ml_key);
      if (!confirmarLectura(lectura, (r) => r.seller_sku === op.sku_objetivo && Number(r.stock) === op.stock_objetivo)) throw new Error('activación rechazada: verificación remota vencida o divergente');
      const fp = fingerprintEvidencia({ ml_key: op.ml_key, seller_sku: lectura.seller_sku, stock: lectura.stock, observed_at: lectura.observed_at });
      activarIdentidadObservada(db, caso, { ...pub, seller_sku: lectura.seller_sku, available_quantity: lectura.stock, actualizado_en: lectura.observed_at }, producto, fp, now());
      respuesta = lectura;
    } else if (paso === 'reprocess') {
      // No crea pedidos ni llama a Woo: vuelve a poner la retención en estado liberable para
      // que el flujo probado de ventas la reprocesse por su propio worker.
      db.prepare("UPDATE guardia_ml_pedidos_retenidos SET estado='liberado',liberado_en=?,liberado_por='identidad_productos',actualizado_en=? WHERE estado='retenido' AND ml_order_id IN (SELECT pedido_ml_order_id FROM guardia_ml_casos WHERE clave=?)")
        .run(now(), now(), op.ml_key);
      respuesta = { reencolada: true };
    }
    const siguiente = PASOS[PASOS.indexOf(paso) + 1];
    const final = !siguiente;
    db.transaction(() => {
      db.prepare("UPDATE identidad_operacion_pasos SET estado='confirmado',respuesta_json=?,finalizado_en=? WHERE id=?").run(json(respuesta), now(), pasoId);
      db.prepare(`UPDATE identidad_operaciones SET estado=?,paso_actual=?,intentos=0,ultimo_error=NULL,
        claim_hasta=NULL,proximo_intento_en=?,actualizada_en=?,completada_en=? WHERE id=?`)
        .run(final ? 'completada' : 'pendiente', siguiente || paso, final ? null : now(), now(), final ? now() : null, op.id);
      if (final) db.prepare("UPDATE identidad_casos SET estado='verificado',resuelto_en=?,expected_version=expected_version+1 WHERE id=?").run(now(), op.caso_id);
    })();
    return { ok: true, operacion: db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.id) };
  } catch (error) {
    const intentos = intento;
    const intervencion = intentos >= 3 || Date.now() - Date.parse(op.iniciada_en) >= INTERVENCION_MS;
    const delay = BACKOFF_MS[Math.min(intentos - 1, BACKOFF_MS.length - 1)];
    db.transaction(() => {
      db.prepare("UPDATE identidad_operacion_pasos SET estado='fallido',error=?,finalizado_en=? WHERE id=?").run(error.message, now(), pasoId);
      db.prepare(`UPDATE identidad_operaciones SET estado=?,intentos=?,ultimo_error=?,claim_hasta=NULL,
        proximo_intento_en=?,actualizada_en=? WHERE id=?`).run(intervencion ? 'intervencion' : 'fallida', intentos,
        error.message.slice(0, 500), new Date(Date.now() + delay).toISOString(), now(), op.id);
      if (intervencion) db.prepare("UPDATE identidad_casos SET estado='intervencion',expected_version=expected_version+1 WHERE id=?").run(op.caso_id);
    })();
    return { ok: false, code: intervencion ? 'INTERVENTION_REQUIRED' : 'REMOTE_STEP_FAILED', error: error.message,
      operacion: db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.id) };
  }
}

export function listarColasIdentidad(db) {
  const mlFusion = listarCasosIdentidad(db, { direccion: 'ml_fusion' }).filter((c) => c.estado !== 'verificado' && c.estado !== 'resuelto');
  const wooMl = db.prepare(`SELECT p.*,w.stock AS stock_woo,w.sku AS sku_woo,
    t.id AS tarea_publicacion_id,t.estado AS tarea_estado,t.vence_en,
    e.id AS exclusion_id
    FROM productos_fusion p JOIN catalogo_cache w ON w.id_woo=p.primary_woo_id
    LEFT JOIN identidad_tareas_publicacion t ON t.producto_id=p.id AND t.estado IN ('pendiente','tomada','vencida')
    LEFT JOIN identidad_exclusiones_canal e ON e.producto_id=p.id AND e.canal='ml' AND e.activa=1
    WHERE p.estado='activo' AND COALESCE(w.stock,0)>0
      AND NOT EXISTS (SELECT 1 FROM identidades_canal i WHERE i.producto_id=p.id AND i.canal='ml' AND i.activa=1)
    ORDER BY p.id`).all();
  return { ml_to_fusion: mlFusion, woo_to_ml: wooMl };
}

export function crearTareaPublicacion(db, productoId, input, actor) {
  const operationId = String(input.operation_id || '').trim();
  if (!operationId) return { ok: false, code: 'INVALID_INPUT', error: 'operation_id requerido' };
  const repetida = db.prepare('SELECT * FROM identidad_tareas_publicacion WHERE operation_id=?').get(operationId);
  if (repetida) return { ok: true, repetido: true, tarea: repetida };
  const producto = db.prepare("SELECT * FROM productos_fusion WHERE id=? AND estado='activo'").get(Number(productoId));
  if (!producto) return { ok: false, code: 'NOT_FOUND', error: 'producto no encontrado' };
  const abierta = db.prepare("SELECT * FROM identidad_tareas_publicacion WHERE producto_id=? AND estado IN ('pendiente','tomada','vencida')").get(producto.id);
  if (abierta) return { ok: false, code: 'ALREADY_EXISTS', error: 'el producto ya tiene una tarea abierta' };
  const ts = now(); const vence = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const r = db.prepare(`INSERT INTO identidad_tareas_publicacion
    (producto_id,responsable,vence_en,operation_id,creada_por,creada_en,actualizada_en) VALUES (?,?,?,?,?,?,?)`)
    .run(producto.id, input.responsable || null, vence, operationId, actor, ts, ts);
  return { ok: true, tarea: db.prepare('SELECT * FROM identidad_tareas_publicacion WHERE id=?').get(r.lastInsertRowid) };
}

export function registrarEventoIdentidad(db, { canal, event_key, entidad_key, payload, ocurrido_en = null }) {
  const ts = now();
  const r = db.prepare(`INSERT OR IGNORE INTO identidad_eventos_integracion
    (canal,event_key,entidad_key,payload_json,ocurrido_en,recibido_en,proximo_intento_en)
    VALUES (?,?,?,?,?,?,?)`).run(canal, event_key, entidad_key, json(payload), ocurrido_en, ts, ts);
  return { ok: true, duplicate: r.changes === 0 };
}
