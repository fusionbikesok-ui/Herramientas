import crypto from 'node:crypto';
// Usa lib/matcherEngine.js — ver su cabecera sobre el contrato de sync con
// public/matcher/matcher-engine.js. NO es exclusivo del Matcher legado: tocar `norm`, `EQUIV`
// o `tsr` cambia también la búsqueda de Producto Fusion, cubierta por identidad-productos.test.js.
import { norm, tsr } from './matcherEngine.js';

const FRESCURA_MS = 60 * 60 * 1000;
const INTERVENCION_MS = 15 * 60 * 1000;
const BACKOFF_MS = [500, 1500, 4000];
// Pausa entre pasos encadenados: da tiempo a que ML refleje la escritura antes de verificarla.
const PAUSA_ENTRE_PASOS_MS = 1500;
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
  // Una transacción para todo el recorrido: con journal_mode=delete cada statement suelto
  // hace su propio fsync, y 5139 productos se vuelven minutos de I/O que bloquean el proceso.
  // `.immediate()` toma RESERVED en el BEGIN: una transacción DEFERRED pide SHARED primero y
  // SQLite no puede reintentar con seguridad la promoción a RESERVED, así que ahí el
  // busy_timeout no ayuda y un lector concurrente abortaría el recorrido entero.
  db.transaction(() => {
    const familiaId = familiaBootstrap(db, ts);
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
  }).immediate();
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

/**
 * Huella de la EVIDENCIA DE IDENTIDAD de una clave ML. Deliberadamente sin stock ni hora de
 * observación: el cache se reescribe entero en cada refresco y esos campos harían cambiar la
 * huella cada 15 minutos, reseteando el estado de todo caso ya decidido.
 *
 * La usan los dos pases de la auditoría —universo activo y deuda dormida— y tiene que ser la
 * misma en ambos: si difirieran, una publicación que se pausa y se reactiva se leería como
 * cambio de identidad en cada scan.
 */
function huellaIdentidad(pub, match, clasificacion) {
  return `v2:${fingerprintEvidencia({
    v: 2,
    ml: { clave: pub.clave, item_id: pub.item_id, variation_id: pub.variation_id || '',
      seller_sku_presente: pub.seller_sku_presente, seller_sku: pub.seller_sku ?? null,
      seller_custom_field: pub.seller_custom_field ?? null, gtin: pub.gtin ?? null },
    woo: match.productoWoo ? { id_woo: match.productoWoo.id_woo, sku: match.productoWoo.sku, gtin: match.productoWoo.gtin } : null,
    clasificacion,
  })}`;
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
  // Una huella vieja (anterior al versionado v2) se reescribe SIN tratarla como cambio: si no,
  // el propio arreglo del formato provocaría un último reseteo masivo de los casos decididos.
  const huellaVieja = !String(anterior.evidencia_fingerprint || '').startsWith('v2:');
  const cambio = !huellaVieja
    && (anterior.evidencia_fingerprint !== fp || anterior.clasificacion !== clasificacion || anterior.producto_id !== productoId);
  const producto = productoId == null ? null
    : db.prepare('SELECT fusion_sku FROM productos_fusion WHERE id=?').get(productoId);
  const ultimaOperacion = db.prepare('SELECT id,decision_id,estado,producto_id,intentos FROM identidad_operaciones WHERE caso_id=? ORDER BY id DESC LIMIT 1')
    .get(anterior.id);
  const shadowSinEfecto = anterior.estado === 'pendiente'
    && ultimaOperacion?.estado === 'shadow'
    && Number(ultimaOperacion.intentos) === 0
    && !db.prepare('SELECT 1 FROM identidad_operacion_pasos WHERE operacion_id=? LIMIT 1').get(ultimaOperacion.id);
  const identidadAplicada = ['verificado', 'urgente'].includes(anterior.estado)
    && anterior.producto_id === productoId
    && clasificacion === 'gtin_contradictorio'
    && pub.seller_sku === producto?.fusion_sku
    && ultimaOperacion?.estado === 'completada'
    && ultimaOperacion.producto_id === productoId;
  let proximoEstado = anterior.estado;
  let recuperacionEstado = false;
  let liberaResponsable = false;
  if (cambio) {
    if (identidadAplicada) {
      // La escritura ya terminó y ML conserva exactamente el SKU objetivo. Un GTIN nuevo o
      // contradictorio es deuda de catálogo, no deshace una identidad remota verificada ni
      // obliga a repetir la misma operación. La clasificación queda visible y auditada.
      proximoEstado = 'verificado';
      registrarHistorial(db, 'caso', anterior.id, 'gtin_contradictorio_post_verificacion', 'sistema', {
        ml_key: pub.clave, producto_id: productoId, seller_sku: pub.seller_sku, gtin: pub.gtin ?? null,
      }, ts);
    } else {
      db.prepare(`UPDATE identidad_excepciones SET activa=0,invalidada_en=?,invalidada_motivo='cambio_identidad'
        WHERE caso_id=? AND activa=1`).run(ts, anterior.id);
      // Si el cambio llega antes del primer intento remoto, la operación `shadow` no representa
      // un efecto que alguien deba reparar. Se inmoviliza como evidencia obsoleta y el caso
      // vuelve a urgente para que una nueva decisión use la identidad actual. Reintentar esa
      // operación vieja podría escribir el SKU equivocado.
      if (shadowSinEfecto) {
        const motivo = 'obsoleta_por_cambio_identidad_antes_de_efecto_remoto';
        db.prepare(`UPDATE identidad_operaciones SET estado='intervencion',ultimo_error=?,
          claim_hasta=NULL,actualizada_en=? WHERE id=?`).run(motivo, ts, ultimaOperacion.id);
        registrarHistorial(db, 'operacion', ultimaOperacion.id, 'operacion_shadow_obsoleta_por_cambio_identidad', 'sistema', {
          caso_id: anterior.id, decision_id: ultimaOperacion.decision_id, clasificacion_anterior: anterior.clasificacion,
          clasificacion_nueva: clasificacion,
        }, ts);
        proximoEstado = estado;
        liberaResponsable = true;
      } else {
        // Una operación que ya empezó conserva su decisión y requiere intervención humana:
        // ya puede haber efectos remotos parciales que no se pueden descartar automáticamente.
        proximoEstado = anterior.estado === 'pendiente' ? 'intervencion' : estado;
      }
    }
  } else if (identidadAplicada) {
    proximoEstado = 'verificado';
    recuperacionEstado = anterior.estado === 'urgente';
    if (recuperacionEstado) registrarHistorial(db, 'caso', anterior.id, 'gtin_contradictorio_post_verificacion', 'sistema', {
      ml_key: pub.clave, producto_id: productoId, seller_sku: pub.seller_sku, gtin: pub.gtin ?? null, recuperado: true,
    }, ts);
  }
  else if (!['exceptuado', 'pendiente', 'intervencion'].includes(anterior.estado)) proximoEstado = estado;
  db.prepare(`UPDATE identidad_casos SET producto_id=?,clasificacion=?,estado=?,severidad=?,
    responsable=CASE WHEN ? THEN NULL ELSE responsable END,tomado_en=CASE WHEN ? THEN NULL ELSE tomado_en END,
    evidencia_fingerprint=?,ultima_deteccion_en=?,resuelto_en=?,expected_version=expected_version+?
    WHERE id=?`).run(productoId, clasificacion, proximoEstado, proximoEstado === 'verificado' ? 'normal' : 'urgente',
      liberaResponsable ? 1 : 0, liberaResponsable ? 1 : 0, fp, ts, proximoEstado === 'verificado' ? ts : null,
      cambio || recuperacionEstado ? 1 : 0, anterior.id);
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
  // Mismo motivo que en el bootstrap: sin transacción, un escaneo de ~1200 claves con varias
  // escrituras cada una tardaba ~3 minutos y, como better-sqlite3 es síncrono, dejaba el
  // servidor HTTP sin responder mientras corría el cron.
  // `.immediate()` por el mismo motivo que en el bootstrap: el lock se toma en el BEGIN,
  // donde el busy_timeout sí puede absorber la contención de un lector concurrente.
  return db.transaction(() => {
    bootstrapProductosFusion(db, actor);
    const publicaciones = db.prepare(`SELECT * FROM ml_publicaciones_cache
      WHERE status='active' AND COALESCE(available_quantity,0)>0 AND ${FILTRO_MARKETPLACE}
      ORDER BY clave`).all();
    let verificadas = 0;
    let incompletas = 0;
    for (const pub of publicaciones) {
      // Una observación anterior a la migración 082 no trae `seller_sku_presente`, `gtin` ni
      // `atributos_json`: con el default 0 toda clave se leería como `sku_ausente` aunque tenga
      // SKU exacto. No se clasifica sobre eso — se cuenta aparte y se exige un refresco ML
      // completo. `atributos_json` nulo es la marca: un refresco nuevo siempre lo escribe.
      if (pub.atributos_json === null || pub.atributos_json === undefined) { incompletas += 1; continue; }
      const match = clasificarClaveMl(db, pub);
      const producto = match.productoWoo ? db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(match.productoWoo.id_woo) : null;
      const observacionFresca = lecturaConfiable && Number.isFinite(Date.parse(pub.actualizado_en))
        && ahora.getTime() - Date.parse(pub.actualizado_en) >= 0 && ahora.getTime() - Date.parse(pub.actualizado_en) < FRESCURA_MS;
      const stockCoincide = producto && Number(pub.available_quantity) === Number(match.productoWoo.stock);
      // Una decisión tomada que ML todavía no refleja invalida la identidad, por más que el SKU
      // que ML lleva exista y sea único en Woo. Sin esto la publicación se auto-verifica contra
      // el producto EQUIVOCADO: `clasificarClaveMl` sólo mira lo que ML tiene, no lo que se
      // decidió. Es el caso peligroso de las pausadas huérfanas cuando se reactivan.
      const skuDecidido = db.prepare(`SELECT sku FROM sku_matcher_decisiones
        WHERE clave=? AND accion IN ('asignar','confirmar') AND TRIM(COALESCE(sku,''))<>''`).get(pub.clave)?.sku;
      const decisionDivergente = !!skuDecidido && !!String(pub.seller_sku || '').trim()
        && String(pub.seller_sku).trim() !== String(skuDecidido).trim();
      const seVerifica = !decisionDivergente && match.clasificacion === 'sku_exacto' && observacionFresca && stockCoincide;
      const clasificacion = decisionDivergente ? 'decision_no_aplicada'
        : (match.clasificacion === 'sku_exacto' && !seVerifica ? 'stock_no_verificado' : match.clasificacion);
      // La huella representa la EVIDENCIA DE IDENTIDAD, no la observación. Incluir
      // `observado_en` o el stock la hacía cambiar en cada refresco —el cache se borra y se
      // reescribe con timestamp nuevo— y eso reseteaba el estado de todo caso ya decidido,
      // devolviéndolo a la cola cada 15 minutos. Un cambio de stock que altere la
      // verificación se refleja igual, porque `clasificacion` sí forma parte de la huella.
      const evidencia = {
        v: 2,
        ml: { clave: pub.clave, item_id: pub.item_id, variation_id: pub.variation_id || '', seller_sku_presente: pub.seller_sku_presente,
          seller_sku: pub.seller_sku ?? null, seller_custom_field: pub.seller_custom_field ?? null, gtin: pub.gtin ?? null },
        woo: match.productoWoo ? { id_woo: match.productoWoo.id_woo, sku: match.productoWoo.sku, gtin: match.productoWoo.gtin } : null,
        clasificacion,
      };
      const fp = huellaIdentidad(pub, match, clasificacion);
    // Lo observado se conserva en la evidencia auditable aunque no forme parte de la huella.
    const evidenciaAuditable = { ...evidencia, observado: { stock_ml: pub.available_quantity, observado_en: pub.actualizado_en,
      stock_woo: match.productoWoo ? match.productoWoo.stock : null } };
      // La severidad previa se lee ANTES del upsert: `upsertCaso` reescribe el campo en cada
      // scan ('normal' si quedó verificado, 'urgente' si no), así que después ya se perdió.
      const severidadPrevia = db.prepare("SELECT severidad FROM identidad_casos WHERE direccion='ml_fusion' AND ml_key=?")
        .get(pub.clave)?.severidad ?? null;
      const caso = upsertCaso(db, pub, clasificacion, producto?.id ?? null, fp, seVerifica ? 'verificado' : 'urgente', ts);
      // Regla del plan: una publicación que vuelve a estar activa con stock y sigue con la
      // identidad inválida es urgencia máxima, no una urgente más. Se detecta porque el caso
      // venía marcado como deuda dormida ('normal'), y se sostiene mientras siga inválida
      // ('critica'), porque si no el upsert la degradaría a 'urgente' en el scan siguiente.
      if (!seVerifica && ['normal', 'critica'].includes(severidadPrevia) && ['urgente', 'tomado'].includes(caso.estado)) {
        db.prepare("UPDATE identidad_casos SET severidad='critica' WHERE id=?").run(caso.id);
        if (severidadPrevia === 'normal') {
          registrarHistorial(db, 'caso', caso.id, 'reactivada_con_identidad_invalida', 'sistema',
            { ml_key: pub.clave, clasificacion, seller_sku: pub.seller_sku ?? null }, ts);
        }
      }
      db.prepare(`INSERT OR IGNORE INTO identidad_evidencias
        (caso_id,tipo,fuente,contenido_json,fingerprint,confiable,observado_en,creado_por,creado_en)
        VALUES (?,'auditoria','sistema',?,?,?,?,?,?)`)
        .run(caso.id, json(evidenciaAuditable), fp, observacionFresca ? 1 : 0, pub.actualizado_en || ts, actor, ts);
      if (seVerifica) { activarIdentidadObservada(db, caso, pub, producto, fp, ts); verificadas++; }
    }
    // ── Deuda dormida: pausadas y sin stock ──────────────────────────────────────
    // Una publicación de marketplace que está pausada o en cero NO está «fuera de alcance»:
    // conserva la identidad que tenga, y si se reactiva sale a la venta con ella. Cerrarla
    // como `resuelto` la volvía invisible. El cron legacy que las corregía
    // (`pushSkusPendientes`) ya no está agendado, así que hoy nada las mira: observadas en
    // producción 3 pausadas con una decisión que nada iba a ejecutar, cada una con el SKU de
    // OTRO producto (MLA1401411650|180043410439, MLA2000138388|192504429779 y
    // MLA1927478426|187049488547).
    //
    // Se registran como deuda NO urgente (severidad 'normal'): quedan visibles en la cola sin
    // contar como trabajo humano pendiente, porque `conciliacionIdentidad` cuenta sólo el
    // universo activo con stock. Esto es detección; poner el stock remoto en cero al
    // reactivarse es la protección Woo→ML y va aparte, porque escribe en ML.
    // El corte es ESTRECHO a propósito: sólo las que tienen una decisión tomada que ML todavía
    // no refleja. Marcar toda pausada sin SKU daría 4047 casos —medido— y eso no es deuda, es
    // el backlog entero del catálogo pausado: enterraría la cola sin que nadie pueda actuar.
    // Una pausada SIN SKU no es peligrosa: si se reactiva sigue sin SKU y el pase del universo
    // activo la toma como urgente. La peligrosa es la que lleva un SKU que CONTRADICE una
    // decisión: al reactivarse se auto-verifica contra el producto equivocado, porque ese SKU
    // existe y es único en Woo. Es exactamente lo que quedó huérfano al desagendarse
    // `pushSkusPendientes`.
    const dormidas = db.prepare(`SELECT p.* FROM ml_publicaciones_cache p
      JOIN sku_matcher_decisiones d ON d.clave = p.clave
      WHERE ${FILTRO_MARKETPLACE} AND p.atributos_json IS NOT NULL
        AND NOT (p.status='active' AND COALESCE(p.available_quantity,0)>0)
        AND d.accion IN ('asignar','confirmar')
        AND TRIM(COALESCE(d.sku,'')) <> ''
        AND TRIM(COALESCE(p.seller_sku,'')) <> ''
        AND TRIM(COALESCE(p.seller_sku,'')) <> TRIM(d.sku)
      ORDER BY p.clave`).all();
    const clavesConDeuda = [];
    const decisionDe = db.prepare(`SELECT sku FROM sku_matcher_decisiones
      WHERE clave=? AND accion IN ('asignar','confirmar')`);
    for (const pub of dormidas) {
      const match = clasificarClaveMl(db, pub);
      // NO se usa la clasificación del matcher acá. El SKU que ML lleva hoy existe y es único
      // en Woo, así que clasifica `sku_exacto` — y es justamente lo engañoso: parece resuelta
      // mientras contradice la decisión tomada. Se nombra el problema por lo que es, y el caso
      // apunta al producto DECIDIDO, no al que ML lleva por error.
      const clasificacion = 'decision_no_aplicada';
      const skuDecidido = decisionDe.get(pub.clave)?.sku;
      const wooDecidido = skuDecidido
        ? db.prepare('SELECT * FROM catalogo_cache WHERE sku=?').get(skuDecidido) : null;
      const producto = wooDecidido
        ? db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(wooDecidido.id_woo) : null;
      const fp = huellaIdentidad(pub, { productoWoo: wooDecidido }, clasificacion);
      const caso = upsertCaso(db, pub, clasificacion, producto?.id ?? null, fp, 'urgente', ts);
      clavesConDeuda.push(pub.clave);
      // La severidad se fija acá y no en `upsertCaso`: es lo único que distingue la deuda
      // dormida de una urgencia real, y no debe pisar un caso que ya está en curso.
      if (['urgente', 'tomado'].includes(caso.estado) && caso.severidad !== 'normal') {
        db.prepare("UPDATE identidad_casos SET severidad='normal' WHERE id=?").run(caso.id);
      }
    }

    // Una clave que salió del universo (link de pago, o dada de baja) no puede seguir pidiendo
  // trabajo: se cierra como fuera de alcance en vez de quedar urgente para siempre. La deuda
  // dormida de arriba queda excluida: esa sí sigue existiendo y tiene que verse.
  const exclusionDeuda = clavesConDeuda.length
    ? ` AND ml_key NOT IN (${clavesConDeuda.map(() => '?').join(',')})` : '';
  db.prepare(`UPDATE identidad_casos SET estado='resuelto',resuelto_en=?,ultima_deteccion_en=?
    WHERE direccion='ml_fusion' AND estado IN ('urgente','tomado')
      AND ml_key NOT IN (SELECT clave FROM ml_publicaciones_cache
        WHERE status='active' AND COALESCE(available_quantity,0)>0 AND ${FILTRO_MARKETPLACE})
      ${exclusionDeuda}`).run(ts, ts, ...clavesConDeuda);

  // Una excepción vencida nunca queda contando como cierre explícito.
    db.prepare(`UPDATE identidad_excepciones SET activa=0,invalidada_en=?,invalidada_motivo='vencida'
      WHERE activa=1 AND vence_en IS NOT NULL AND vence_en<=?`).run(ts, ts);
    db.prepare(`UPDATE identidad_casos SET estado='urgente',expected_version=expected_version+1
      WHERE estado='exceptuado' AND NOT EXISTS
        (SELECT 1 FROM identidad_excepciones e WHERE e.caso_id=identidad_casos.id AND e.activa=1)`).run();
    if (lecturaConfiable) db.prepare(`UPDATE identidad_config SET ultimo_scan_confiable_en=?,ultimo_scan_error=NULL,actualizado_en=? WHERE id=1`).run(ts, ts);
    // El gate 2 no se da por cumplido con la igualdad sola: se cumplía igual de bien con el
    // 100% de la clasificación equivocada, y también con el universo vacío.
    return { ...conciliacionIdentidad(db), verificadas_en_esta_corrida: verificadas, escaneado_en: ts };
  }).immediate();
}

/**
 * Conciliación del gate 2, en un solo lugar para que auditoría y resumen no puedan divergir.
 * Se cuenta SIEMPRE sobre el mismo universo: claves activas con stock y con observación
 * completa. Un caso de una clave que se pausó o quedó en cero no puede seguir sumando del
 * lado derecho de la igualdad, o el gate se vuelve inalcanzable.
 */
// Un ítem cuyo `channels` no incluye "marketplace" es un link de pago de Mercado Pago: no se
// vende por el marketplace, no llega a preparación por esa vía y no tiene por qué exigir
// identidad de catálogo. `canales_json IS NULL` = todavía no observado: se conserva, para no
// sacar del universo algo que nunca miramos.
export const FILTRO_MARKETPLACE = "(canales_json IS NULL OR canales_json LIKE '%marketplace%')";

export function conciliacionIdentidad(db) {
  const universo = `SELECT clave FROM ml_publicaciones_cache
    WHERE status='active' AND COALESCE(available_quantity,0)>0 AND ${FILTRO_MARKETPLACE}`;
  const total = db.prepare(`SELECT COUNT(*) n FROM (${universo})`).get().n;
  const incompletas = db.prepare(`SELECT COUNT(*) n FROM ml_publicaciones_cache
    WHERE status='active' AND COALESCE(available_quantity,0)>0 AND ${FILTRO_MARKETPLACE}
      AND atributos_json IS NULL`).get().n;
  const enUniverso = `c.direccion='ml_fusion' AND c.ml_key IN (${universo} AND atributos_json IS NOT NULL)`;
  const verificadas = db.prepare(`SELECT COUNT(*) n FROM identidad_casos c WHERE ${enUniverso} AND c.estado='verificado'`).get().n;
  const excepciones = db.prepare(`SELECT COUNT(*) n FROM identidad_casos c WHERE ${enUniverso} AND c.estado='exceptuado'
    AND EXISTS (SELECT 1 FROM identidad_excepciones e WHERE e.caso_id=c.id AND e.activa=1)`).get().n;
  const urgentes = db.prepare(`SELECT COUNT(*) n FROM identidad_casos c WHERE ${enUniverso}
    AND c.estado IN ('urgente','tomado','pendiente','intervencion')`).get().n;
  // Se informa aparte cuántos ya tienen su operación encolada: salen de la cola de trabajo
  // (nadie tiene que hacer nada con ellos) pero no desaparecen del tablero.
  const esperandoOperacion = db.prepare(`SELECT COUNT(*) n FROM identidad_casos c WHERE ${enUniverso}
    AND c.estado='pendiente'`).get().n;
  const auditadas = total - incompletas;
  // `total > 0` es parte del gate: con el universo vacío la igualdad se cumple sola y la
  // pantalla anunciaría "conciliado" sin haber mirado nada.
  const conciliado = total > 0 && incompletas === 0 && auditadas === verificadas + excepciones + urgentes;
  return { total, auditadas, observacion_incompleta: incompletas, verificadas, excepciones,
    esperando_operacion: esperandoOperacion, urgentes, conciliado };
}

export function estadoIdentidadProductos(db, ahora = new Date()) {
  const config = db.prepare('SELECT * FROM identidad_config WHERE id=1').get();
  const ultimo = config?.ultimo_scan_confiable_en ? Date.parse(config.ultimo_scan_confiable_en) : NaN;
  const degradado = !Number.isFinite(ultimo) || ahora.getTime() - ultimo >= FRESCURA_MS || !!config?.ultimo_scan_error;
  const urgentes = db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE estado IN ('urgente','tomado','pendiente','intervencion')").get().n;
  const operaciones = db.prepare("SELECT COUNT(*) n FROM identidad_operaciones WHERE estado NOT IN ('completada','shadow')").get().n;
  // Claves activas con stock que todavía no fueron observadas con el detalle de la 082.
  const incompletas = db.prepare(`SELECT COUNT(*) n FROM ml_publicaciones_cache
    WHERE status='active' AND COALESCE(available_quantity,0)>0 AND ${FILTRO_MARKETPLACE}
      AND atributos_json IS NULL`).get().n;
  return { ...config, degradado: degradado || incompletas > 0,
    sano: !degradado && incompletas === 0 && urgentes === 0 && operaciones === 0,
    urgentes, operaciones_pendientes: operaciones, observacion_incompleta: incompletas };
}

export function listarCasosIdentidad(db, { direccion = 'ml_fusion', estado, pendientes } = {}) {
  const condiciones = ['c.direccion=?']; const params = [direccion];
  if (estado) { condiciones.push('c.estado=?'); params.push(estado); }
  // La cola de trabajo lista sólo lo que espera a una persona. Un caso `verificado` o
  // `resuelto` no es una tarea, y uno `pendiente` ya tiene su operación encolada: mezclarlos
  // esconde el trabajo real entre miles de filas y hace parecer que decidir no hizo nada.
  // Los `pendiente` siguen visibles en Operaciones, no se ocultan.
  if (pendientes === true || pendientes === 'true' || pendientes === '1') {
    condiciones.push("c.estado IN ('urgente','tomado','intervencion')");
  }
  return db.prepare(`SELECT c.*,p.nombre_canonico,p.fusion_sku,m.titulo,m.seller_sku,m.seller_custom_field,
    m.gtin,m.available_quantity,m.thumbnail,m.permalink,m.variations_texto,m.canales_json,m.actualizado_en AS ml_observado_en
    FROM identidad_casos c LEFT JOIN productos_fusion p ON p.id=c.producto_id
    LEFT JOIN ml_publicaciones_cache m ON m.clave=c.ml_key
    WHERE ${condiciones.join(' AND ')} ORDER BY CASE c.severidad WHEN 'critica' THEN 0 WHEN 'urgente' THEN 1 ELSE 2 END,c.primera_deteccion_en`)
    .all(...params).map((c) => ({ ...c, thumbnail: imagenSegura(c.thumbnail), es_marketplace: esMarketplace(c.canales_json) }));
}

/**
 * Las miniaturas de MercadoLibre llegan en http:// y la herramienta se sirve por HTTPS: el
 * navegador las bloquea por contenido mixto y la comparación se vuelve inútil. mlstatic
 * responde igual por https, así que se normaliza al entregarlas.
 */
export function imagenSegura(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  return u.startsWith('http://') ? `https://${u.slice('http://'.length)}` : u;
}

// Atributos de ML que no ayudan a decidir identidad: logística, impuestos, condición, y los
// que la pantalla ya muestra en campos propios. El resto (largo, modelo, medida) es
// exactamente lo que distingue una variación de otra.
const ATRIBUTOS_ML_RUIDO = new Set(['SELLER_SKU', 'GTIN', 'EAN', 'UPC', 'ITEM_CONDITION',
  'IMPORT_DUTY', 'VALUE_ADDED_TAX', 'SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_LENGTH',
  'SELLER_PACKAGE_WEIGHT', 'SELLER_PACKAGE_WIDTH', 'EMPTY_GTIN_REASON',
  // No distinguen una variante de otra: son constantes de catálogo o de logística.
  'UNIT_MEASURE', 'UNITS_PER_PACKAGE', 'SALE_FORMAT', 'SHIPMENT_PACKING', 'WARRANTY_TYPE',
  'WARRANTY_TIME', 'IS_KIT', 'MANUFACTURING_TYPE']);

export function atributosMlLegibles(atributosJson) {
  const arr = parseJson(atributosJson);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((a) => a && !ATRIBUTOS_ML_RUIDO.has(String(a.id || '')))
    .map((a) => ({ nombre: a.name || a.id, valor: a.value_name ?? a.value_id ?? '' }))
    .filter((a) => a.nombre && a.valor !== '' && a.valor !== null);
}

// MercadoLibre publica 99999 como centinela de "stock ilimitado / atípico", no como una
// cantidad real. Mostrarlo crudo hace creer que hay 99.999 unidades. Hoy son 72 publicaciones.
export const STOCK_ATIPICO = 99999;
/**
 * Un ítem cuyo `channels` no incluye "marketplace" es un link de pago de Mercado Pago: existe
 * en la API y está `active`, pero nunca estuvo publicado en el marketplace, no se encuentra
 * buscando en MercadoLibre y no llega a preparación por la vía de una venta ML.
 * `null` = todavía no observado (cache anterior a la migración 083): no se asume nada.
 */
export function esMarketplace(canalesJson) {
  if (canalesJson === null || canalesJson === undefined) return null;
  const ch = parseJson(canalesJson);
  if (!Array.isArray(ch)) return null;
  return ch.includes('marketplace');
}

export function stockLegible(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v >= STOCK_ATIPICO ? { valor: v, atipico: true } : { valor: v, atipico: false };
}

export function obtenerCasoIdentidad(db, id) {
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(Number(id));
  if (!caso) return null;
  // La instantánea de evidencia guarda identificadores, no cómo se ve el producto. Para
  // decidir hace falta ver la publicación y el candidato Woo: foto, nombre y enlace.
  const pub = caso.ml_key
    ? db.prepare('SELECT * FROM ml_publicaciones_cache WHERE clave=?').get(caso.ml_key) : null;
  const producto = caso.producto_id
    ? db.prepare(`SELECT p.id,p.nombre_canonico,p.fusion_sku,p.estado,p.primary_woo_id,
        w.nombre AS nombre_woo,w.sku AS sku_woo,w.stock AS stock_woo,w.gtin AS gtin_woo,w.img,
        w.tipo AS tipo_woo,w.id_padre,w.atributos_json
        FROM productos_fusion p LEFT JOIN catalogo_cache w ON w.id_woo=p.primary_woo_id
        WHERE p.id=?`).get(caso.producto_id) : null;
  // Triangulación: cuando el catálogo Woo no distingue dos variaciones, las OTRAS
  // publicaciones ML de la misma familia sí lo hacen. Dos señales que resuelven casos reales:
  //  - otras publicaciones que reclaman el MISMO SELLER_SKU (duplicados o medidas distintas);
  //  - publicaciones cuyo GTIN coincide con el del producto candidato, que revelan a qué
  //    medida corresponde ese SKU aunque Woo no lo diga.
  const skuPub = String(pub?.seller_sku || '').trim();
  const hermanasSku = skuPub
    ? db.prepare(`SELECT clave,item_id,titulo,gtin,available_quantity,permalink
        FROM ml_publicaciones_cache
        WHERE seller_sku=? AND clave<>? AND status='active' ORDER BY titulo`).all(skuPub, caso.ml_key)
    : [];
  const gtinProd = producto && esGtinValido(producto.gtin_woo) ? normalizarGtin(producto.gtin_woo) : null;
  const porGtinProducto = gtinProd
    ? db.prepare(`SELECT clave,item_id,titulo,gtin,available_quantity,permalink
        FROM ml_publicaciones_cache
        WHERE gtin LIKE ? AND clave<>? AND status='active' ORDER BY titulo`).all(`%${gtinProd}%`, caso.ml_key)
    : [];
  return { ...caso,
    hermanas_ml: hermanasSku.map((h) => ({ ...h, motivo: 'mismo SELLER_SKU' })),
    ml_por_gtin_producto: porGtinProducto.map((h) => ({ ...h, motivo: 'GTIN del producto Woo' })),
    publicacion: pub
      ? { ...pub, thumbnail: imagenSegura(pub.thumbnail), atributos: atributosMlLegibles(pub.atributos_json),
          es_marketplace: esMarketplace(pub.canales_json) }
      : null,
    producto: producto
      ? { ...producto, img: imagenSegura(producto.img), atributos: atributosLegibles(producto.atributos_json),
          es_padre: String(producto.tipo_woo || '') === 'variable' }
      : null,
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
// `norm` sobre miles de nombres en cada búsqueda era el costo dominante, no el SQL. Los
// nombres son estables y finitos, así que se memoriza el resultado.
const memoNorm = new Map();
function normCache(texto) {
  const clave = String(texto || '');
  let v = memoNorm.get(clave);
  if (v === undefined) {
    if (memoNorm.size > 20000) memoNorm.clear();
    v = norm(clave);
    memoNorm.set(clave, v);
  }
  return v;
}

/**
 * Atributos de una variación Woo (`[{name,option}]`) como texto corto. Es lo que distingue
 * a dos variaciones con el mismo nombre —largo, medida, color, talle— y sin esto la persona
 * ve una lista de productos idénticos y no puede elegir.
 */
export function atributosLegibles(atributosJson) {
  const arr = parseJson(atributosJson);
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.map((a) => `${a?.name ?? ''}: ${a?.option ?? ''}`.trim()).filter((x) => x && x !== ':').join(' · ') || null;
}

export function buscarProductosFusion(db, { q = '', limite = 20, gtin_ml: gtinMl, sku_ml: skuMl } = {}) {
  const texto = String(q || '').trim();
  const pedido = Number(limite);
  const tope = Math.min(50, Math.max(1, Number.isFinite(pedido) ? pedido : 20));
  const filas = db.prepare(`SELECT p.id,p.nombre_canonico,p.fusion_sku,p.estado,p.primary_woo_id,
    w.sku AS sku_woo,w.stock AS stock_woo,w.img,w.marca,w.gtin,w.nombre AS nombre_woo,
    w.tipo AS tipo_woo,w.id_padre,w.atributos_json,
    (SELECT COUNT(*) FROM identidades_canal i WHERE i.producto_id=p.id AND i.canal='ml' AND i.activa=1) AS identidades_ml_activas
    FROM productos_fusion p LEFT JOIN catalogo_cache w ON w.id_woo=p.primary_woo_id
    WHERE p.estado='activo'`).all();

  // Una consulta de sólo puntuación (".", "---") normaliza a vacío. Sin este corte,
  // `tokens` queda vacío, `every` es verdadero por vacuidad y devolvía TODO el catálogo con
  // un orden distinto al de la búsqueda vacía. Se trata igual que no haber escrito nada.
  const sinConsulta = !texto || !norm(texto);
  if (sinConsulta) {
    return filas.sort((a, b) => String(a.nombre_canonico).localeCompare(String(b.nombre_canonico), 'es'))
      .slice(0, tope).map((o) => ({ ...o, img: imagenSegura(o.img) }));
  }

  // `norm` del motor de matching: baja a minúsculas, saca acentos y puntuación y unifica
  // colores en inglés. Sin esto, escribir "ninos" en vez de "niños" devolvía cero.
  const consulta = norm(texto);
  const tokens = consulta.split(' ').filter(Boolean);
  const exacto = texto.toLowerCase();

  // Una sola lectura de las publicaciones activas para poder decir, por candidato, en qué
  // títulos de ML aparece SU GTIN. Cuando Woo no distingue dos variaciones, ese cruce sí:
  // el GTIN de FB-28298 aparece en las publicaciones de «117,5 mm» y eso identifica la medida
  // que el catálogo no tiene cargada.
  const publicaciones = db.prepare(`SELECT titulo,gtin FROM ml_publicaciones_cache
    WHERE status='active' AND COALESCE(gtin,'')<>''`).all();
  const titulosPorGtin = new Map();
  for (const pu of publicaciones) {
    for (const g of String(pu.gtin).split(',').map((x) => x.trim()).filter(Boolean)) {
      const canon = esGtinValido(g) ? normalizarGtin(g) : null;
      if (!canon) continue;
      if (!titulosPorGtin.has(canon)) titulosPorGtin.set(canon, new Set());
      titulosPorGtin.get(canon).add(pu.titulo);
    }
  }

  // La publicación ML aporta dos señales que deciden el caso y que una lista de nombres
  // iguales no muestra: el GTIN y el SELLER_SKU. Se marcan y se priorizan explícitamente.
  const gtinRef = esGtinValido(gtinMl) ? normalizarGtin(gtinMl) : null;
  const skuRef = String(skuMl || '').trim().toLowerCase() || null;
  const puntuadas = [];
  for (const f of filas) {
    const nombre = normCache(f.nombre_canonico || f.nombre_woo || '');
    // El identificador se compara sin normalizar: un SKU o GTIN es literal, no texto libre.
    const idents = [f.fusion_sku, f.sku_woo, f.gtin].filter(Boolean).map((x) => String(x).trim().toLowerCase());
    const identExacto = idents.some((x) => x === exacto);
    const identParcial = idents.some((x) => x.includes(exacto));
    // Todos los tokens tienen que aparecer, en cualquier orden: "rembrandt casco" y
    // "casco rembrandt" son la misma intención de búsqueda.
    const pajar = `${nombre} ${idents.join(' ')}`;
    const presentes = tokens.filter((t) => pajar.includes(t)).length;
    const todos = presentes === tokens.length;
    // Dos pasadas. Exigir todos los tokens da precisión cuando la persona escribe, pero el
    // buscador arranca precargado con el título de ML, que suele traer palabras que el
    // catálogo Woo no tiene ("Bb-un300 123mm" contra "Caja Pedalera Shimano Un300"): con la
    // regla estricta eso da CERO resultados y obliga a adivinar una consulta más corta.
    // Se conservan los parciales y se usan sólo si ningún candidato cumple todo.
    if (!identExacto && !identParcial && presentes === 0) continue;
    // El orden lo da la similitud de conjunto de tokens del motor, no el alfabeto: el
    // resultado más parecido al título que la persona está mirando tiene que ir primero.
    // Es ordenamiento, no un puntaje calibrado: no se muestra porcentaje (eso es UM1.4).
    const coincideGtin = !!gtinRef && esGtinValido(f.gtin) && normalizarGtin(f.gtin) === gtinRef;
    const coincideSku = !!skuRef && idents.includes(skuRef);
    const similitud = nombre ? tsr(consulta, nombre) : 0;
    // `tsr` satura en 1 cuando los tokens de la consulta son subconjunto exacto del nombre,
    // sin importar cuántas palabras extra traiga el candidato: para "cubierta 29" empatan
    // todas y el orden cae al alfabeto. Se desempata por especificidad, contando las palabras
    // del nombre que la consulta no pidió: menos sobrantes, coincidencia más ajustada.
    const sobrantes = nombre ? nombre.split(' ').filter((t) => t && !tokens.includes(t)).length : 99;
    // Un GTIN que coincide pesa más que el nombre y más que el SKU: es el identificador del
    // fabricante y no depende de cómo esté cargado el catálogo.
    // Un `variable` de Woo es el producto padre: no tiene stock propio ni es una unidad
    // vendible, así que no puede ser destino de un vínculo ML. Se conserva visible (su GTIN
    // suele ser el que ML trae) pero nunca se ofrece como opción elegible.
    const esPadre = String(f.tipo_woo || '') === 'variable';
    const orden = esPadre ? -1 : (coincideGtin ? 4 : coincideSku ? 3 : identExacto ? 2 : identParcial ? 1 : 0);
    puntuadas.push({ f, orden, similitud, sobrantes, coincideGtin, coincideSku, todos, presentes, esPadre });
  }
  // Nada se oculta: los que cumplen todo (o coinciden por identificador) van primero y los
  // parciales quedan abajo, marcados. Filtrarlos escondería el candidato correcto cuando el
  // título de ML trae palabras que el catálogo Woo no tiene.
  const completo = (x) => !x.esPadre && (x.todos || x.orden >= 1);
  puntuadas.sort((a, b) => (completo(b) ? 1 : 0) - (completo(a) ? 1 : 0)
    || b.orden - a.orden || b.presentes - a.presentes || b.similitud - a.similitud
    || a.sobrantes - b.sobrantes
    || String(a.f.nombre_canonico).localeCompare(String(b.f.nombre_canonico), 'es'));
  // Si el GTIN de ML coincide con un producto PADRE, la publicación pertenece a esa familia
  // y la respuesta correcta es una de sus variaciones. Se marcan para no perder la señal al
  // hundir el padre, que no es enlazable.
  const padreGtin = puntuadas.find((x) => x.esPadre && x.coincideGtin)?.f || null;
  const elegidas = puntuadas.slice(0, tope);
  // Si varios candidatos comparten nombre normalizado, el nombre no alcanza para elegir y
  // hay que decirlo: es un problema del catálogo Woo, no algo que la persona deba adivinar.
  const porNombre = new Map();
  for (const { f } of elegidas) {
    const k = normCache(f.nombre_canonico || f.nombre_woo || '');
    porNombre.set(k, (porNombre.get(k) || 0) + 1);
  }
  return elegidas.map(({ f, coincideGtin, coincideSku, todos, orden, esPadre }) => ({
    ...f,
    img: imagenSegura(f.img),
    coincide_gtin: coincideGtin,
    coincide_sku: coincideSku,
    nombre_ambiguo: (porNombre.get(normCache(f.nombre_canonico || f.nombre_woo || '')) || 0) > 1,
    coincidencia_parcial: !esPadre && !(todos || orden >= 1),
    ml_con_su_gtin: (() => {
      const canon = esGtinValido(f.gtin) ? normalizarGtin(f.gtin) : null;
      const set = canon ? titulosPorGtin.get(canon) : null;
      return set ? [...set].slice(0, 3) : [];
    })(),
    es_padre: esPadre,
    atributos: atributosLegibles(f.atributos_json),
    de_familia_gtin: !!padreGtin && !esPadre && Number(f.id_padre) === Number(padreGtin.primary_woo_id),
    padre_gtin_sku: padreGtin ? padreGtin.fusion_sku : null,
  }));
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
    // El impacto en hermanas frena la operación SALVO que quien decide ya lo haya confirmado en
    // el mismo acto. Sin esta condición la operación nacía con `impacto_confirmado=1` y estado
    // `bloqueada_impacto` a la vez: nadie la desbloqueaba porque el impacto ya estaba confirmado
    // y el worker no la tomaba porque el estado era terminal. Pasó con la operación 104
    // (`MLA1116131600|174011478611`, 4 hermanas), que quedó trabada sin salida desde la pantalla.
    const impactoYaConfirmado = input.confirm_sibling_impact === true;
    const estadoOperacion = config.modo === 'shadow' || config.escrituras_remotas_habilitadas !== 1
      ? 'shadow'
      : (hermanas > 0 && !impactoYaConfirmado ? 'bloqueada_impacto' : 'pendiente');
    const op = db.prepare(`INSERT INTO identidad_operaciones
      (operation_id,caso_id,decision_id,producto_id,ml_key,sku_anterior,sku_objetivo,stock_objetivo,
       estado,paso_actual,impacto_hermanas,impacto_confirmado,iniciada_en,proximo_intento_en,actualizada_en)
      VALUES (?,?,?,?,?,?,?,?,?,'zero',?,?,?,?,?)`).run(input.operation_id, caso.id, decision.id, producto.id, caso.ml_key,
        pub.seller_sku || null, producto.fusion_sku, Number(db.prepare('SELECT stock FROM catalogo_cache WHERE id_woo=?').get(producto.primary_woo_id)?.stock ?? 0),
        estadoOperacion, hermanas, impactoYaConfirmado ? 1 : 0, ts, ts, ts);
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

/**
 * Confirma el impacto sobre variaciones hermanas de una operación bloqueada.
 *
 * La saga frena cuando la publicación tiene otras variaciones activas, porque escribir el SKU
 * puede afectarlas. Esa confirmación es una decisión humana: hasta ahora sólo se podía dar por
 * script, así que las operaciones quedaban trabadas sin salida desde la herramienta.
 *
 * Devuelve además cuántas hermanas hay, para que la pantalla muestre qué se está confirmando.
 */
export function confirmarImpactoIdentidad(db, operacionId, input, actor) {
  const operationId = String(input.operation_id || '').trim();
  const repetido = operationId && comandoRepetido(db, operationId);
  if (repetido) return { ...repetido, repetido: true };
  const op = db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(Number(operacionId));
  if (!op) return { ok: false, code: 'NOT_FOUND', error: 'operación no encontrada' };
  if (op.estado !== 'bloqueada_impacto') {
    return { ok: false, code: 'INVALID_STATE', error: 'la operación no está bloqueada por impacto en hermanas' };
  }
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(op.caso_id);
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };

  const config = db.prepare('SELECT * FROM identidad_config WHERE id=1').get();
  const estado = config.modo === 'enforced' && config.escrituras_remotas_habilitadas === 1 ? 'pendiente' : 'shadow';
  const ts = now();
  return db.transaction(() => {
    // `iniciada_en` se reinicia por el mismo motivo que en el reintento: el umbral de
    // intervención mide un intento, y la operación estuvo esperando una decisión humana.
    db.prepare(`UPDATE identidad_operaciones SET impacto_confirmado=1,estado=?,intentos=0,ultimo_error=NULL,
      iniciada_en=?,proximo_intento_en=?,claim_hasta=NULL,actualizada_en=? WHERE id=?`)
      .run(estado, ts, ts, ts, op.id);
    db.prepare("UPDATE identidad_casos SET estado='pendiente',expected_version=expected_version+1 WHERE id=?").run(caso.id);
    const resultado = { ok: true, hermanas: op.impacto_hermanas,
      operacion: db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.id) };
    guardarComando(db, operationId, 'confirmar_impacto', 'operacion', op.id, resultado, actor, ts);
    registrarHistorial(db, 'operacion', op.id, 'impacto_hermanas_confirmado', actor,
      { hermanas: op.impacto_hermanas, motivo: input.motivo || null }, ts);
    return resultado;
  })();
}

export function reintentarOperacionIdentidad(db, operacionId, input, actor) {
  const operationId = String(input.operation_id || '').trim();
  const repetido = operationId && comandoRepetido(db, operationId);
  if (repetido) return { ...repetido, repetido: true };
  const op = db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(Number(operacionId));
  if (!op) return { ok: false, code: 'NOT_FOUND', error: 'operación no encontrada' };
  if (op.ultimo_error === 'obsoleta_por_cambio_identidad_antes_de_efecto_remoto') {
    return { ok: false, code: 'OBSOLETE_OPERATION', error: 'la identidad cambió antes de ejecutar esta operación; creá una decisión nueva' };
  }
  const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(op.caso_id);
  const invalida = validarMutacion(caso, input); if (invalida) return { ok: false, ...invalida };
  if (!['fallida', 'intervencion', 'shadow'].includes(op.estado)) return { ok: false, code: 'INVALID_STATE', error: 'la operación no admite reintento' };
  const config = db.prepare('SELECT * FROM identidad_config WHERE id=1').get();
  const estado = config.modo === 'enforced' && config.escrituras_remotas_habilitadas === 1 ? 'pendiente' : 'shadow';
  const ts = now();
  return db.transaction(() => {
    // `iniciada_en` también se reinicia: el umbral de intervención (15 min) mide contra ese
    // campo, así que sin esto una operación vieja rebotaba a `intervencion` en el mismo
    // instante en que se la reintentaba, y nada encolado hacía más de 15 minutos podía
    // ejecutarse jamás. El presupuesto de 15 minutos es POR INTENTO, no por vida del registro.
    db.prepare(`UPDATE identidad_operaciones SET estado=?,intentos=0,ultimo_error=NULL,
      iniciada_en=?,proximo_intento_en=?,claim_hasta=NULL,actualizada_en=? WHERE id=?`)
      .run(estado, ts, ts, ts, op.id);
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
  // El umbral de 15 minutos mide un intento que no progresa, NO la antigüedad del registro.
  // Con `intentos === 0` la operación nunca se ejecutó: descartarla por vieja manda a
  // intervención trabajo que el sistema jamás intentó, y obliga a un reintento manual. Pasó
  // con 51 operaciones que quedaron encoladas mientras las escrituras estaban deshabilitadas.
  // Una operación con decisión tomada debe poder ejecutarse sola cuando le toque.
  if (op.intentos >= 3 || (op.intentos > 0 && Date.now() - Date.parse(op.iniciada_en) >= INTERVENCION_MS)) {
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
    // Atajo verificado: si MercadoLibre YA tiene el SKU objetivo, no hay identidad que
    // corregir. Correr la saga completa bajaría el stock de una publicación viva a 0 durante
    // varias corridas para terminar escribiendo exactamente lo mismo. Se releé igual —el plan
    // exige verificación remota antes de resolver—, pero no se escribe nada de más:
    //  - SKU y stock ya correctos  -> se completa sin ninguna escritura;
    //  - SKU correcto, stock distinto -> se salta directo a restaurar el stock, sin poner 0.
    if (paso === 'zero') {
      const actual = await adapter.read(op.ml_key);
      if (confirmarLectura(actual, (r) => String(r.seller_sku || '').trim() === String(op.sku_objetivo).trim())) {
        const stockOk = Number(actual.stock) === Number(op.stock_objetivo);
        db.prepare(`UPDATE identidad_operacion_pasos SET estado='confirmado',respuesta_json=?,finalizado_en=? WHERE id=?`)
          .run(json({ atajo: stockOk ? 'sku_y_stock_ya_correctos' : 'sku_ya_correcto', leido: actual }), ts, pasoId);
        registrarHistorial(db, 'operacion', op.id, 'atajo_sin_escritura', 'sistema',
          { motivo: stockOk ? 'ML ya tiene el SKU y el stock objetivo' : 'ML ya tiene el SKU objetivo; sólo falta el stock' }, ts);
        const siguiente = stockOk ? 'activate' : 'restore';
        db.prepare("UPDATE identidad_operaciones SET paso_actual=?,estado='pendiente',intentos=0,claim_hasta=NULL,proximo_intento_en=?,actualizada_en=? WHERE id=?")
          .run(siguiente, ts, ts, op.id);
        return { ok: true, atajo: true, paso_actual: siguiente,
          operacion: db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.id) };
      }
      // Camino directo: si el destino es un SKU válido, se sobrescribe de una. Poner el stock
      // en 0 y limpiar el SKU sólo hace falta cuando la publicación debe quedar SIN SKU: es
      // esa limpieza la que abre una ventana sin identidad, y el cero existe para cubrirla.
      // Sobrescribiendo, el SKU pasa de un valor válido a otro en una sola escritura y no hay
      // ventana que cubrir. Verificado: MercadoLibre acepta el cambio con stock disponible
      // (`escribirSkuEnMl` de matcherPush lo hace en producción desde hace meses) y el cero
      // tiene costo propio: ML pausa la publicación con `out_of_stock`.
      if (String(op.sku_objetivo || '').trim()) {
        db.prepare(`UPDATE identidad_operacion_pasos SET estado='confirmado',respuesta_json=?,finalizado_en=? WHERE id=?`)
          .run(json({ atajo: 'escritura_directa_sin_cero', leido: actual }), ts, pasoId);
        registrarHistorial(db, 'operacion', op.id, 'camino_directo_sin_cero', 'sistema',
          { motivo: 'destino con SKU válido: se sobrescribe sin poner el stock en 0' }, ts);
        db.prepare("UPDATE identidad_operaciones SET paso_actual='write',estado='pendiente',intentos=0,sin_cero=1,claim_hasta=NULL,proximo_intento_en=?,actualizada_en=? WHERE id=?")
          .run(ts, ts, op.id);
        return { ok: true, directo: true, paso_actual: 'write',
          operacion: db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.id) };
      }
      respuesta = await adapter.setStock(op.ml_key, 0);
    } else if (paso === 'verify_zero') { respuesta = await adapter.read(op.ml_key); if (!confirmarLectura(respuesta, (r) => Number(r.stock) === 0)) throw new Error('stock cero no verificado remotamente'); }
    else if (paso === 'clear') respuesta = await adapter.clearSku(op.ml_key);
    else if (paso === 'verify_clear') { respuesta = await adapter.read(op.ml_key); if (!confirmarLectura(respuesta, (r) => !String(r.seller_sku || '').trim() && Number(r.stock) === 0)) throw new Error('SKU vacío no verificado remotamente'); }
    else if (paso === 'write') respuesta = await adapter.writeSku(op.ml_key, op.sku_objetivo);
    else if (paso === 'verify_write') {
      // Se verifica el SKU, no el stock: en el camino directo la publicación conserva su stock
      // a propósito. El estado final igual se verifica entero en `verify_restore`.
      respuesta = await adapter.read(op.ml_key);
      if (!confirmarLectura(respuesta, (r) => r.seller_sku === op.sku_objetivo)) throw new Error('SKU objetivo no verificado remotamente');
      // Una operación que nunca bajó el stock no lo "restaura": escribiría el valor capturado
      // al decidir sobre un stock que el sync normal ya mantiene al día.
      if (Number(op.sin_cero) === 1) {
        db.prepare("UPDATE identidad_operacion_pasos SET estado='confirmado',respuesta_json=?,finalizado_en=? WHERE id=?").run(json(respuesta), now(), pasoId);
        db.prepare("UPDATE identidad_operaciones SET paso_actual='activate',estado='pendiente',intentos=0,ultimo_error=NULL,claim_hasta=NULL,proximo_intento_en=?,actualizada_en=? WHERE id=?")
          .run(now(), now(), op.id);
        return { ok: true, sin_restore: true, paso_actual: 'activate',
          operacion: db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(op.id) };
      }
    }
    else if (paso === 'restore') respuesta = await adapter.setStock(op.ml_key, op.stock_objetivo);
    else if (paso === 'verify_restore') { respuesta = await adapter.read(op.ml_key); if (!confirmarLectura(respuesta, (r) => r.seller_sku === op.sku_objetivo && Number(r.stock) === op.stock_objetivo)) throw new Error('SKU y stock restaurado no verificados remotamente'); }
    else if (paso === 'activate') {
      const pub = db.prepare('SELECT * FROM ml_publicaciones_cache WHERE clave=?').get(op.ml_key);
      const producto = db.prepare('SELECT * FROM productos_fusion WHERE id=?').get(op.producto_id);
      const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(op.caso_id);
      const lectura = await adapter.read(op.ml_key);
      // En el camino directo el stock no se tocó a propósito: exigir el valor capturado al
      // decidir haría fallar la activación cada vez que el stock cambió legítimamente entre
      // medio, que es lo normal. Lo que esta operación tiene que garantizar es la IDENTIDAD;
      // el stock es autoridad de Woo y lo mantiene el sync habitual. Cuando la operación sí
      // bajó el stock a 0, verificar que lo restauró al valor objetivo sigue siendo su
      // responsabilidad, porque fue ella quien lo rompió.
      const esperado = Number(op.sin_cero) === 1
        ? (r) => r.seller_sku === op.sku_objetivo
        : (r) => r.seller_sku === op.sku_objetivo && Number(r.stock) === op.stock_objetivo;
      if (!confirmarLectura(lectura, esperado)) throw new Error('activación rechazada: verificación remota vencida o divergente');
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
    // Mismo criterio: acá `intentos` ya es al menos 1 (este intento), así que el umbral de
    // tiempo sí corresponde: mide un intento que falla y no avanza.
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

/**
 * Worker de operaciones remotas de UM1. Es el único ejecutor de la saga.
 *
 * FAIL-CLOSED en tres niveles, y ninguno depende de que el llamador se acuerde:
 *  1. `modo` tiene que ser `enforced` Y `escrituras_remotas_habilitadas` = 1;
 *  2. si hay `canario_ml_key`, SOLO se procesan esas claves (hasta dos, separadas por coma);
 *  3. se procesan como mucho `lote_max` operaciones por corrida (default 1).
 *
 * El punto 3 existe porque habilitar el modo con operaciones ya encoladas las largaría todas
 * juntas, y cada una pone el stock de la publicación en 0 antes de escribir el SKU.
 */
export async function procesarOperacionesIdentidad(db, adapter, { ahora = new Date() } = {}) {
  const cfg = db.prepare('SELECT * FROM identidad_config WHERE id=1').get();
  const habilitado = cfg?.modo === 'enforced' && Number(cfg?.escrituras_remotas_habilitadas) === 1;
  if (!habilitado) return { ok: true, omitido: 'escrituras_remotas_deshabilitadas', modo: cfg?.modo ?? null, procesadas: 0 };
  if (!adapter) return { ok: false, code: 'SIN_ADAPTADOR', procesadas: 0 };

  const canarios = [...new Set(String(cfg.canario_ml_key || '').split(',').map((key) => key.trim()).filter(Boolean))].slice(0, 2);
  const tope = Math.max(1, Math.min(2, Number(cfg.lote_max) || 1));
  // `claim_hasta` vigente = otra corrida tomó esta operación y sigue trabajando. Sin este
  // filtro, dos corridas del cron podían ejecutar el MISMO paso a la vez y escribir dos veces
  // en MercadoLibre. Con el cron cada 5 minutos era improbable; cada 1 minuto, no. Este repo
  // ya tuvo un incidente de concurrencia en el worker de Guardia: acá se corta de entrada.
  // Un claim vencido (proceso caído a mitad de camino) sí se vuelve a tomar.
  const pendientes = db.prepare(`SELECT id FROM identidad_operaciones
    WHERE estado IN ('shadow','pendiente','procesando','verificando')
      ${canarios.length ? `AND ml_key IN (${canarios.map(() => '?').join(',')})` : ''}
      AND (proximo_intento_en IS NULL OR proximo_intento_en<=?)
      AND (claim_hasta IS NULL OR claim_hasta<=?)
    ORDER BY id LIMIT ?`)
    .all(...(canarios.length ? [...canarios, ahora.toISOString(), ahora.toISOString(), tope]
      : [ahora.toISOString(), ahora.toISOString(), tope]));

  const resultados = [];
  const terminal = (e) => ['completada', 'intervencion', 'fallida', 'bloqueada_impacto'].includes(e);
  for (const { id } of pendientes) {
    // Se encadenan los pasos dentro de la MISMA corrida mientras cada uno confirme. Con un
    // paso por corrida, una publicación pasaba minutos en stock 0 esperando al cron; así la
    // ventana es la suma de unas pocas llamadas a ML. Cada paso se sigue persistiendo y
    // verificando igual: la durabilidad no cambia, sólo deja de haber espera muerta.
    let pasos = 0;
    try {
      // Tope duro: la saga tiene 10 pasos. Corta cualquier lazo inesperado.
      while (pasos < PASOS.length + 2) {
        const r = await procesarPasoOperacionIdentidad(db, id, adapter, { allowRemoteWrites: habilitado });
        pasos += 1;
        resultados.push({ id, paso: pasos, ...r });
        const estadoAhora = db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(id)?.estado;
        if (!r.ok || terminal(estadoAhora)) break;
        // MercadoLibre no siempre refleja una escritura al instante y el paso siguiente suele
        // ser su verificación: una pausa corta evita fallar por leer demasiado pronto.
        await new Promise((res) => setTimeout(res, PAUSA_ENTRE_PASOS_MS));
      }
    } catch (e) {
      resultados.push({ id, ok: false, error: e.message });
    }
  }
  return { ok: true, canario: canarios, tope, procesadas: resultados.length, resultados };
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
