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

/**
 * Fragmento SQL (EXISTS) equivalente a la parte R2 de `frenaIdentidad`, para la CTE del sync. Vale 1 si frena.
 * `claveSql` y `skuSql` son expresiones de la fila de `sku_matcher_decisiones` (p. ej. 'd.clave', 'd.sku').
 */
export function sqlFrenaIdentidad(claveSql, skuSql) {
  return `EXISTS (SELECT 1 FROM identidad_casos ic
    WHERE ic.direccion='ml_fusion' AND ic.ml_key=${claveSql} AND ic.estado IN ${ABIERTOS}
      AND (ic.estado='intervencion'
        OR (ic.clasificacion IN ${CONTRADICCIONES}
          AND COALESCE(TRIM((SELECT p.seller_sku FROM ml_publicaciones_cache p WHERE p.clave=${claveSql} LIMIT 1)),'') <> TRIM(COALESCE(${skuSql},'')))))`;
}

/** ¿Hay que mandar stock 0 a esta clave? `{ frena, motivo }`. Misma regla que `sqlFrenaIdentidad` + R4. */
export function frenaIdentidad(db, clave) {
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

/**
 * R4 para el sync: publicaciones activas con stock, sin ninguna decisión (ni omitir) y con caso abierto de las
 * clasificaciones «sin vínculo». Devuelve `{ clave, item_id, variation_id, clasificacion, cantidad_ml }`.
 */
export function clavesSinVinculoAFrenar(db) {
  return db.prepare(`SELECT p.clave, p.item_id, p.variation_id, ic.clasificacion, p.available_quantity AS cantidad_ml
    FROM ml_publicaciones_cache p
    JOIN identidad_casos ic ON ic.direccion='ml_fusion' AND ic.ml_key=p.clave
    WHERE p.status='active' AND COALESCE(p.available_quantity,0)>0
      AND ic.estado IN ${ABIERTOS} AND ic.clasificacion IN ${SIN_VINCULO_SQL}
      AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave=p.clave)
    ORDER BY p.clave`).all();
}
