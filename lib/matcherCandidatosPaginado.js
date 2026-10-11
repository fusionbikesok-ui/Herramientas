// Filtro y paginación server-side de GET /api/matcher/candidatos (modo Publicación ML de Vínculos).
//
// Los filtros de modo/filtro replican la pantalla (filtroMatcher y claveDeMl de
// public/catalogo-vinculos/catalogo-vinculos.js).
//
// CAMBIO DE SEMÁNTICA (texto `q`): ya no es subcadena exacta sino AND por palabras, sin distinguir
// acentos ni mayúsculas, sobre "título + espacio + clave" (lib/textoBusqueda.js, la misma lógica que
// la cola de casos). Una palabra sola sigue siendo subcadena. Documentado en docs/api-contrato.md.
//
// Trabaja sobre los ítems ya resueltos de la caché en memoria (no recalcula nada) y devuelve solo
// los campos que la pantalla lee, para que una página pese decenas de KB y no los ~21 MB del cruce.

import { tokensQ, normTexto } from './textoBusqueda.js';

export const FILTROS_CANDIDATOS = ['all', 'asignar', 'verificar', 'conf-baja', 'color-talle'];
export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 200;

// Igual que claveDeMl del cliente: el Matcher no trae `clave`, se arma item|variación.
export function claveDeMl(it) {
  return it.clave || (it.ml_item_id + (it.ml_variation_id ? '|' + it.ml_variation_id : ''));
}

// Igual que filtroMatcher del cliente. Cualquier valor fuera de la lista no llega acá (se valida antes).
export function coincideFiltro(it, filtro) {
  if (filtro === 'all') return true;
  if (filtro === 'asignar') return it.modo === 'asignar';
  if (filtro === 'verificar') return it.modo === 'verificar';
  if (filtro === 'conf-baja') return it.modo === 'verificar' && it.score_confianza < 0.7;
  // 'color-talle'
  return !!(it.candidatos && it.candidatos[0] && it.candidatos[0].color_ok && it.candidatos[0].talle_ok);
}

// Texto de búsqueda normalizado por ítem (título + clave), precalculado una vez por objeto de caché:
// el WeakMap se descarta solo cuando la caché se rearma (objetos nuevos), no por request.
const textoPorItem = new WeakMap();
function textoNormalizado(it) {
  let t = textoPorItem.get(it);
  if (t === undefined) {
    t = normTexto(String(it.ml_title || '') + ' ' + claveDeMl(it));
    textoPorItem.set(it, t);
  }
  return t;
}

// `tokens` = tokensQ(q). Vacío = sin filtro de texto. Cada palabra debe aparecer en el texto del ítem.
export function coincideTexto(it, tokens) {
  if (!tokens.length) return true;
  const t = textoNormalizado(it);
  return tokens.every((k) => t.includes(k));
}

// Proyección a los campos que la tarjeta y el panel de la pantalla leen (tarjetaML, claveDeMl,
// filtroMatcher). `candidatos` y el resto del cruce NO viajan: el detalle del vínculo se pide aparte.
export function proyectarCandidato(it) {
  return {
    clave: claveDeMl(it),
    ml_item_id: it.ml_item_id,
    ml_variation_id: it.ml_variation_id,
    ml_title: it.ml_title,
    modo: it.modo,
    score_confianza: it.score_confianza,
  };
}

// Valida y normaliza los parámetros de paginación. Devuelve { params } o { error }.
// - q: texto libre (opcional).
// - filtro: uno de FILTROS_CANDIDATOS (default 'all'); otro valor → error.
// - limit: entero >= 1 (default 50); por encima de 200 se recorta a 200 (se devuelve el valor efectivo).
// - offset: entero >= 0 (default 0).
export function parsearPaginado(query) {
  const filtro = query.filtro === undefined || query.filtro === '' ? 'all' : String(query.filtro);
  if (!FILTROS_CANDIDATOS.includes(filtro)) return { error: `filtro inválido: ${filtro}` };
  let limit = LIMIT_DEFAULT;
  if (query.limit !== undefined && query.limit !== '') {
    if (!/^\d+$/.test(String(query.limit)) || Number(query.limit) < 1) return { error: 'limit debe ser un entero >= 1' };
    limit = Math.min(Number(query.limit), LIMIT_MAX);
  }
  let offset = 0;
  if (query.offset !== undefined && query.offset !== '') {
    if (!/^\d+$/.test(String(query.offset))) return { error: 'offset debe ser un entero >= 0' };
    offset = Number(query.offset);
  }
  const q = query.q === undefined ? '' : String(query.q);
  return { params: { q, filtro, limit, offset } };
}

// Filtra y pagina. `items` son los ítems resueltos de la caché (no se modifican).
// total: cuántos cumplen q + filtro (lo que se pagina). conteos: cuántos cumple cada filtro con q
// aplicado (para los chips). total_todas: tamaño del cruce sin ningún filtro.
export function paginarCandidatos(items, { q = '', filtro = 'all', limit = LIMIT_DEFAULT, offset = 0 } = {}) {
  const tokens = tokensQ(q);
  const conteos = Object.fromEntries(FILTROS_CANDIDATOS.map((f) => [f, 0]));
  const seleccion = [];
  for (const it of items) {
    if (!coincideTexto(it, tokens)) continue;
    for (const f of FILTROS_CANDIDATOS) if (coincideFiltro(it, f)) conteos[f]++;
    if (coincideFiltro(it, filtro)) seleccion.push(it);
  }
  return {
    total: seleccion.length,
    items: seleccion.slice(offset, offset + limit).map(proyectarCandidato),
    limit,
    offset,
    conteos,
    total_todas: items.length,
  };
}
