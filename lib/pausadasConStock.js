/*
 * lib/pausadasConStock.js — publicaciones pausadas en ML que tienen stock en Woo, con la causa de la pausa.
 *
 * Fase A de "pausas con sentido" (docs/superpowers/specs/2026-10-03-consolidacion-herramientas.md). El reactivador
 * automático sólo levanta las pausadas por out_of_stock; lo pausado por el vendedor, por el vigía o sin sub_status
 * quedaba pausado para siempre. Esta lista las muestra con su causa para que una PERSONA decida reactivarlas:
 * nada de acá reactiva solo.
 *
 * Es de sólo lectura sobre la caché local; no llama a ML.
 */

import { precioContado } from './mlPrecios.js';

/** Causas, de más a menos específica. El orden es la prioridad al agrupar varias variaciones de una publicación. */
export const CAUSAS = ['vigia', 'solo_local', 'sin_vinculo', 'pausa_app', 'paused_by_seller', 'pausa_vieja', 'out_of_stock', 'otra'];

export const TEXTO_CAUSA = {
  vigia: 'Pausada por el vigía de formato',
  solo_local: 'Config ML en solo local: el stock se fuerza a 0',
  sin_vinculo: 'Sin vínculo con un producto de Woo',
  pausa_app: 'Pausada desde esta aplicación',
  paused_by_seller: 'Pausada por el vendedor en MercadoLibre',
  pausa_vieja: 'Pausa vieja, ML no informa el motivo',
  out_of_stock: 'ML la pausó por falta de stock',
  otra: 'Pausada, motivo no informado',
};

const VENTANA_LOG_MS = 60 * 24 * 60 * 60 * 1000; // una pausa registrada hace más de 60 días ya no explica el estado actual

const CTE = `
  WITH catalogo_dedup AS (
    SELECT sku, stock, regular_price,
      ROW_NUMBER() OVER (PARTITION BY sku ORDER BY stock ASC, id_woo ASC) AS rn
    FROM catalogo_cache
    WHERE sku IS NOT NULL AND sku <> ''
  )`;

const normalizarSub = (v) => (Array.isArray(v) ? v.join(',') : String(v ?? ''));

function causaDeFila(f, ahoraMs) {
  const sub = normalizarSub(f.sub_status);
  if (f.vigia_pausada) return { causa: 'vigia' };
  if (f.modo === 'solo_local') return { causa: 'solo_local' };
  if (!f.vinculado) return { causa: 'sin_vinculo' };
  const pausa = f._pausa;
  if (pausa && pausa.actor === 'vigia') return { causa: 'vigia', detalle: pausa };
  if (pausa && Number.isFinite(Date.parse(pausa.creado_en)) && ahoraMs - Date.parse(pausa.creado_en) <= VENTANA_LOG_MS) return { causa: 'pausa_app', detalle: pausa };
  if (sub.includes('paused_by_seller')) return { causa: 'paused_by_seller' };
  if (!sub) return { causa: 'pausa_vieja' };
  if (sub.includes('out_of_stock')) return { causa: 'out_of_stock' };
  return { causa: 'otra' };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.causa] filtra por una causa (ver CAUSAS)
 * @returns {{ data: object[], resumen: Record<string,number>, total: number }}
 */
export function listarPausadasConStock(db, { causa = null, ahora = new Date() } = {}) {
  const ahoraMs = ahora.getTime();
  const filas = db.prepare(`${CTE}
    SELECT p.clave, p.item_id, p.variation_id, p.titulo, p.thumbnail, p.permalink, p.status, p.sub_status,
           p.variations_texto,
           COALESCE(d.sku, NULLIF(p.seller_sku, '')) AS sku,
           CASE WHEN d.sku IS NOT NULL THEN 1 ELSE 0 END AS vinculado,
           c.stock AS stock_woo, c.regular_price, p.available_quantity AS stock_ml, cfg.modo, COALESCE(cfg.reserva, 0) AS reserva,
           CASE
             WHEN cfg.modo = 'solo_local' THEN 0
             WHEN cfg.modo = 'reserva' THEN MAX(c.stock - COALESCE(cfg.reserva, 0), 0)
             ELSE MAX(c.stock, 0)
           END AS stock_disponible_ml,
           EXISTS (SELECT 1 FROM ml_publicacion_cambios v WHERE v.item_id = p.item_id AND v.pausada = 1 AND v.revisado_en IS NULL) AS vigia_pausada,
           EXISTS (SELECT 1 FROM ml_publicacion_cambios v WHERE v.clave = p.clave AND v.solo_aviso = 0 AND (v.revisado_en IS NULL OR v.bloquea_reactivador = 1)) AS aviso_abierto
    FROM ml_publicaciones_cache p
    LEFT JOIN sku_matcher_decisiones d ON d.clave = p.clave AND d.accion IN ('asignar','confirmar') AND d.sku IS NOT NULL AND d.sku <> ''
    LEFT JOIN catalogo_dedup c ON c.sku = COALESCE(d.sku, NULLIF(p.seller_sku, '')) AND c.rn = 1
    LEFT JOIN skus_config_ml cfg ON cfg.sku = c.sku
    WHERE p.status = 'paused' AND c.stock > 0
    ORDER BY p.titulo, p.clave`).all();

  // Última pausa registrada de cada publicación en UN solo SELECT (antes: una consulta por publicación).
  const pausas = new Map(db.prepare(`SELECT l.item_id, l.actor, l.origen, l.detalle, l.creado_en FROM ml_pausas_log l
    JOIN (SELECT item_id, MAX(id) mid FROM ml_pausas_log GROUP BY item_id) u ON u.mid = l.id`).all().map((r) => [r.item_id, r]));
  const porItem = new Map();
  for (const f of filas) {
    f._pausa = pausas.get(f.item_id) || null;
    const c = causaDeFila(f, ahoraMs);
    let it = porItem.get(f.item_id);
    if (!it) {
      it = { item_id: f.item_id, titulo: f.titulo, thumbnail: f.thumbnail, permalink: f.permalink, status: f.status,
        sub_status: normalizarSub(f.sub_status), causa: c.causa, detalle: null, variaciones: [] };
      porItem.set(f.item_id, it);
    }
    if (CAUSAS.indexOf(c.causa) < CAUSAS.indexOf(it.causa)) it.causa = c.causa;
    if (c.detalle) it.detalle = { actor: c.detalle.actor, origen: c.detalle.origen, desde: c.detalle.creado_en };
    it.variaciones.push({ clave: f.clave, variation_id: f.variation_id, variations_texto: f.variations_texto, sku: f.sku,
      vinculado: !!f.vinculado, stock_woo: f.stock_woo, stock_ml: f.stock_ml ?? 0, stock_disponible_ml: f.stock_disponible_ml,
      precio_contado: precioContado(f.regular_price),
      aviso_abierto: !!f.aviso_abierto });
  }

  const todas = [...porItem.values()].map((it) => {
    let motivoNoReactivable = null;
    if (it.causa === 'solo_local') motivoNoReactivable = 'solo_local';
    else if (it.variaciones.some((v) => !v.vinculado)) motivoNoReactivable = 'sin_vinculo';
    else if (it.variaciones.some((v) => v.aviso_abierto)) motivoNoReactivable = 'aviso_abierto';
    else if (it.variaciones.every((v) => !(v.stock_disponible_ml > 0))) motivoNoReactivable = 'sin_stock_disponible';
    // Plata en juego = unidades que ML recibiría × precio de contado. Una variación sin precio no suma (no se inventa).
    const enJuego = it.variaciones.reduce((a, v) => a + (v.precio_contado != null ? (v.stock_disponible_ml || 0) * v.precio_contado : 0), 0);
    return { ...it, texto_causa: TEXTO_CAUSA[it.causa], stock_woo: it.variaciones.reduce((a, v) => a + (v.stock_woo || 0), 0),
      stock_ml: it.variaciones.reduce((a, v) => a + (v.stock_ml || 0), 0), en_juego: Math.round(enJuego),
      sin_precio: it.variaciones.some((v) => v.precio_contado == null),
      reactivable: !motivoNoReactivable, motivo_no_reactivable: motivoNoReactivable };
  });

  const resumen = Object.fromEntries(CAUSAS.map((c) => [c, 0]));
  for (const it of todas) resumen[it.causa] += 1;
  todas.sort((a, b) => b.en_juego - a.en_juego || String(a.titulo).localeCompare(String(b.titulo)));
  const data = causa ? todas.filter((it) => it.causa === causa) : todas;
  return { data, resumen, total: todas.length };
}

/** Cuántos SKUs y publicaciones tienen el stock forzado a 0 por la config solo_local (visible en Sincronización). */
export function resumenSoloLocal(db) {
  const skus = db.prepare("SELECT COUNT(*) n FROM skus_config_ml WHERE modo = 'solo_local'").get().n;
  const publicaciones = db.prepare(`SELECT COUNT(DISTINCT p.item_id) n
    FROM sku_matcher_decisiones d
    JOIN skus_config_ml cfg ON cfg.sku = d.sku AND cfg.modo = 'solo_local'
    JOIN ml_publicaciones_cache p ON p.clave = d.clave
    WHERE d.accion IN ('asignar','confirmar')`).get().n;
  return { skus, publicaciones };
}
