/**
 * Resolución de matching en el servidor (fuente "API de ML").
 *
 * Antes esto vivía replicado en el cliente (public/matcher/index.html): cada dispositivo
 * traía el catálogo Woo completo + las publicaciones ML y recalculaba el matching en un
 * Web Worker. Ahora el cruce se calcula una sola vez en el backend y se sirve ya resuelto.
 *
 * El modo "Excel" del matcher NO pasa por acá: ese archivo lo sube el usuario y el
 * servidor no lo tiene, así que sigue corriendo el motor client-side (matcher-engine.js +
 * matcher-worker.js). Este módulo es sólo para la fuente API (ML en vivo + catálogo Woo).
 *
 * Espeja la lógica del cliente:
 *  - construirWC (motor): índice invertido del catálogo Woo.
 *  - construirMLdesdeApi: arma los ítems ML con color/talle estructurados.
 *  - candidatosDeItem (motor): scoring caro de candidatos por publicación.
 *  - derivarEstadoApi: modo (asignar/verificar), sku_actual, score_confianza, wc_actual.
 */

import {
  construirWC, candidatosDeItem, ctDesdeApi, norm, tsr, intersecta, extraerAtributos,
} from './matcherEngine.js';

export { construirWC, candidatosDeItem };

/**
 * Arma los ítems ML a partir de las filas del cache de publicaciones (ml_publicaciones_cache).
 * Espejo de construirMLdesdeApi del cliente: separa las que ya tienen un SELLER_SKU válido
 * (FB-xxx existente en WC → bucket "verificar") de las que no (bucket "asignar").
 */
export function construirMLdesdeApi(pubs, wcItems) {
  const wcSkus = new Set(wcItems.map((w) => w.sku));
  const sinSku = [], conSkuValido = [];
  for (const p of pubs) {
    const esVar = p.es_variante === 1 || p.es_variante === true;
    const base = {
      ml_item_id: String(p.item_id),
      ml_variation_id: p.variation_id ? String(p.variation_id) : '',
      ml_title: p.titulo || '(sin título)',
      ml_variations: p.variations_texto || '',
      ml_status: p.status || '',
      ml_sub_status: p.sub_status || '',
      ml_es_variante: esVar,
      ml_permalink: p.permalink || '',
      ml_catalogo: p.catalogo === 1 || p.catalogo === true,
      ml_stock_wc: (p.stockWc === undefined ? null : p.stockWc),
      ml_sin_stock: p.sinStock === true,
      _ct: ctDesdeApi(p.color || '', p.talle || ''),
      _desde_api: true,
    };
    const sku = (p.seller_sku || '').trim();
    const esFbNum = /^FB-\d+$/.test(sku);
    if (esFbNum && wcSkus.has(sku)) { conSkuValido.push({ ...base, sku_actual: sku }); }
    else { sinSku.push(base); }
  }
  return { sinSku, conSkuValido };
}

/**
 * A partir de los ítems ML y sus candidatos ya calculados, deriva el estado que la página
 * necesita para pintar: modo, sku_actual, score_confianza, wc_actual y los candidatos
 * reordenados ("actual primero"). Es la parte barata; se corre siempre.
 *
 * Espejo de derivarEstado del cliente, sin el estado de DOM (TODOS/TODOSmap): devuelve el
 * array de ítems resueltos con `idx`. Quita los campos internos (_ct) que el cliente no usa.
 */
export function derivarEstadoApi(items, candidatosArr, wcPorSku) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const ml = items[i];
    let candidatos = candidatosArr[i] || [];
    let modo, skuActual = null, scoreConfianza = null, wcActual = null;
    if (ml.sku_actual) {
      modo = 'verificar'; skuActual = ml.sku_actual;
      const wc = wcPorSku[skuActual];
      const tn = norm(ml.ml_title);
      scoreConfianza = wc ? +tsr(tn, wc.baseNorm).toFixed(3) : 0;
      const posAct = candidatos.findIndex((c) => c.wc_sku === skuActual);
      if (posAct > 0) { candidatos = [candidatos[posAct], ...candidatos.filter((_, ii) => ii !== posAct)]; }
      else if (posAct < 0 && wc) {
        const ct = ml._ct || (ml.ml_es_variante ? extraerAtributos(ml.ml_variations) : { colores: new Set(), talles: new Set() });
        const cOk = ct.colores.size ? intersecta(ct.colores, wc.colorToks) : null;
        const tOk = ct.talles.size ? intersecta(ct.talles, wc.talleToks) : null;
        candidatos = [{ score: scoreConfianza, color_ok: cOk, talle_ok: tOk, wc_sku: skuActual, wc_nombre: wc.nombre, wc_tipo: wc.tipo, wc_color: wc.color, wc_talle: wc.talle, wc_img: wc.img }, ...candidatos.slice(0, 7)];
      }
      wcActual = wc ? { nombre: wc.nombre, color: wc.color, talle: wc.talle, img: wc.img } : null;
    } else {
      modo = 'asignar';
    }
    const { _ct, ...limpio } = ml;
    out.push({ idx: i, modo, sku_actual: skuActual, score_confianza: scoreConfianza, wc_actual: wcActual, ...limpio, candidatos });
  }
  return out;
}
