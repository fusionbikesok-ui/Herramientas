/*
 * lib/proteccionIdentidad.js — una sola protección para el sync de stock ML: los casos de Identidad.
 *
 * Spec: docs/superpowers/specs/2026-10-07-fase-c-una-proteccion.md (R2, R4, R5). Módulo hoja: sólo lee.
 *
 * Qué frena = el sync manda available_quantity=0 a esa clave (no pausa ni toca precio):
 *  - R2, publicación VINCULADA (decisión asignar/confirmar) con caso abierto:
 *      · estado `intervencion` (una persona lo marcó);
 *      · contradicción (gtin_contradictorio o contradiccion_titulo) con seller_sku de ML faltante o distinto del
 *        vinculado. Con el SKU igual el sync sigue normal: el error está en el GTIN/título de catálogo de ML.
 *    `pendiente`, `decision_no_aplicada` y el resto de lo leve no frenan.
 *  - R4, publicación SIN decisión: si el audit de Identidad le abrió un caso por no poder vincularla, queda en 0
 *    hasta que alguien la vincule o la marque `omitir`. No se crea clase de caso nueva: son los casos que
 *    auditarIdentidadProductos ya abre (CLASIFICACIONES_SIN_VINCULO).
 *  - `omitir` (links de pago) nunca frena: no se sincroniza.
 */
const ABIERTOS = "('urgente','tomado','pendiente','intervencion')";
const CONTRADICCIONES = "('gtin_contradictorio','contradiccion_titulo')";

/** Clasificaciones del audit que, en una clave sin decisión, equivalen a «no se pudo vincular sola» (R4). */
export const CLASIFICACIONES_SIN_VINCULO = ['sku_ausente', 'sku_vacio', 'sku_inexistente', 'sku_no_unico', 'contradiccion_titulo'];
const SIN_VINCULO_SQL = `(${CLASIFICACIONES_SIN_VINCULO.map((c) => `'${c}'`).join(',')})`;

/**
 * `IDENTIDAD_PROTECCION`: apagado | sombra | activo. Default y valor inválido = sombra (fail-closed: lo que se manda a
 * ML no cambia). En sombra se calcula todo pero el sync sigue como hoy; `apagado` ni siquiera calcula el reporte.
 */
export function modoProteccion(env = process.env) {
  const v = String(env.IDENTIDAD_PROTECCION ?? '').trim().toLowerCase();
  return v === 'activo' || v === 'apagado' || v === 'sombra' ? v : 'sombra';
}

/** R2 propia (SQL): `claveSql` y `skuSql` son expresiones de una fila de `sku_matcher_decisiones` vinculada. */
function sqlFrenaPropio(claveSql, skuSql) {
  return `EXISTS (SELECT 1 FROM identidad_casos ic
    WHERE ic.direccion='ml_fusion' AND ic.ml_key=${claveSql} AND ic.estado IN ${ABIERTOS}
      AND (ic.estado='intervencion'
        OR (ic.clasificacion IN ${CONTRADICCIONES}
          AND COALESCE(TRIM((SELECT p.seller_sku FROM ml_publicaciones_cache p WHERE p.clave=${claveSql} LIMIT 1)),'') <> TRIM(COALESCE(${skuSql},'')))))`;
}

/**
 * Fragmento SQL (EXISTS) equivalente a la parte R2 de `frenaIdentidad`, para la CTE del sync. Vale 1 si frena.
 * `claveSql` y `skuSql` son expresiones de la fila de `sku_matcher_decisiones` (p. ej. 'd.clave', 'd.sku').
 *
 * Invariante: el stock de ML es POR user_product. Dos publicaciones con el mismo `user_product_id` comparten UNA cantidad,
 * así que si una frena por R2, su hermana también: un stock > 0 en la hermana (sync o reactivador) subiría y reactivaría
 * a la frenada. Medido en prod: FB-5966 volvía a 1 cada ~3 h porque su hermana la reactivaba con el stock de Woo.
 */
export function sqlFrenaIdentidad(claveSql, skuSql) {
  return `(${sqlFrenaPropio(claveSql, skuSql)}
    OR EXISTS (SELECT 1 FROM ml_publicaciones_cache me
      CROSS JOIN ml_publicaciones_cache sib ON sib.user_product_id=me.user_product_id AND sib.clave<>me.clave
      CROSS JOIN sku_matcher_decisiones ds ON ds.clave=sib.clave AND ds.accion IN ('asignar','confirmar') AND TRIM(COALESCE(ds.sku,''))<>''
      WHERE me.clave=${claveSql} AND COALESCE(TRIM(me.user_product_id),'')<>''
        AND ${sqlFrenaPropio('sib.clave', 'ds.sku')}))`;
}

/** R2 + R4 sobre la clave misma (sin mirar hermanas). */
function frenaPropio(db, clave) {
  const decision = db.prepare('SELECT sku, accion FROM sku_matcher_decisiones WHERE clave=?').get(clave);
  if (decision?.accion === 'omitir') return { frena: false, motivo: 'omitir' };
  const caso = db.prepare(`SELECT clasificacion, estado FROM identidad_casos
    WHERE direccion='ml_fusion' AND ml_key=? AND estado IN ${ABIERTOS}`).get(clave);
  if (!caso) return { frena: false, motivo: null };
  const vinculada = ['asignar', 'confirmar'].includes(decision?.accion) && String(decision.sku ?? '').trim() !== '';
  if (!vinculada) {
    // R4: sin decisión. Sólo las clasificaciones de «no se pudo vincular».
    return CLASIFICACIONES_SIN_VINCULO.includes(caso.clasificacion)
      ? { frena: true, motivo: `sin_vinculo:${caso.clasificacion}` } : { frena: false, motivo: null };
  }
  if (caso.estado === 'intervencion') return { frena: true, motivo: 'intervencion' };
  if (['gtin_contradictorio', 'contradiccion_titulo'].includes(caso.clasificacion)) {
    const remoto = String(db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave=? LIMIT 1').get(clave)?.seller_sku ?? '').trim();
    if (remoto !== String(decision.sku).trim()) return { frena: true, motivo: 'contradiccion_sku_distinto' };
  }
  return { frena: false, motivo: null };
}

/** ¿Hay que mandar stock 0 a esta clave? `{ frena, motivo }`. Misma regla que `sqlFrenaIdentidad` + R4 (+ hermanas por R2). */
export function frenaIdentidad(db, clave) {
  const propio = frenaPropio(db, clave);
  if (propio.frena || propio.motivo === 'omitir') return propio;
  const up = String(db.prepare('SELECT user_product_id FROM ml_publicaciones_cache WHERE clave=?').get(clave)?.user_product_id ?? '').trim();
  if (!up) return propio;
  const hermanas = db.prepare(`SELECT sib.clave, ds.sku FROM ml_publicaciones_cache sib
    JOIN sku_matcher_decisiones ds ON ds.clave=sib.clave AND ds.accion IN ('asignar','confirmar') AND TRIM(COALESCE(ds.sku,''))<>''
    WHERE sib.user_product_id=? AND sib.clave<>? ORDER BY sib.clave`).all(up, clave);
  for (const h of hermanas) {
    if (frenaPropio(db, h.clave).frena) return { frena: true, motivo: `hermana_user_product:${h.clave}` };
  }
  return propio;
}

/**
 * R4 para el sync: publicaciones activas con stock, sin ninguna decisión (ni omitir) y con caso abierto de las
 * clasificaciones «sin vínculo». Devuelve `{ clave, item_id, variation_id, clasificacion, cantidad_ml }`.
 */
export function clavesSinVinculoAFrenar(db) {
  return db.prepare(`SELECT p.clave, p.item_id, p.variation_id, ic.clasificacion, p.available_quantity AS cantidad_ml,
      p.seller_sku, p.actualizado_en AS observado_en
    FROM ml_publicaciones_cache p
    JOIN identidad_casos ic ON ic.direccion='ml_fusion' AND ic.ml_key=p.clave
    WHERE p.status='active' AND COALESCE(p.available_quantity,0)>0
      AND ic.estado IN ${ABIERTOS} AND ic.clasificacion IN ${SIN_VINCULO_SQL}
      AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave=p.clave)
    ORDER BY p.clave`).all();
}

// Frenos contra un 0 masivo (revisión de PR #12). R4 manda stock 0 sin que nadie lo haya decidido clave por clave, así
// que un audit roto o un catálogo vacío (todo SKU «inexistente») no puede vaciar el stock de ML de golpe.
/** Más claves R4 que esto en UNA corrida = señal de falla del audit/catálogo, no de publicaciones nuevas: no se aplica ninguna. */
export const R4_MAX_POR_CORRIDA = 20;
/** El audit de Identidad corre con cada refresco de ML (~15 min); más viejo que esto, sus casos no son confiables. */
export const R4_FRESCURA_AUDIT_MS = 6 * 3600 * 1000;

/**
 * Qué claves R4 hay que mandar a 0 en esta corrida. Devuelve `{ aplicar, omitido, total }`; `omitido` es
 * 'catalogo_vacio' | 'audit_no_confiable' | 'tope' | null. Una clave ya está en 0 cuando nuestro último 0 es más nuevo que la
 * observación de ML; si el cache de ML es más nuevo (alguien subió stock a mano) se reenvía.
 */
export function planR4(db, ahora = Date.now()) {
  const pendientes = clavesSinVinculoAFrenar(db).filter((r) => {
    const e = db.prepare('SELECT cantidad_ml, actualizado_en FROM ml_stock_estado WHERE clave=?').get(r.clave);
    return !(e && e.cantidad_ml === 0 && (!r.observado_en || String(e.actualizado_en) >= String(r.observado_en)));
  });
  const total = pendientes.length;
  if (!total) return { aplicar: [], omitido: null, total };
  if (!db.prepare("SELECT 1 FROM catalogo_cache WHERE sku IS NOT NULL AND sku<>'' LIMIT 1").get()) return { aplicar: [], omitido: 'catalogo_vacio', total };
  const t = Date.parse(db.prepare('SELECT ultimo_scan_confiable_en FROM identidad_config WHERE id=1').get()?.ultimo_scan_confiable_en);
  if (!Number.isFinite(t) || ahora - t > R4_FRESCURA_AUDIT_MS) return { aplicar: [], omitido: 'audit_no_confiable', total };
  if (total > R4_MAX_POR_CORRIDA) return { aplicar: [], omitido: 'tope', total };
  return { aplicar: pendientes, omitido: null, total };
}
