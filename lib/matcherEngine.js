/**
 * Motor de matching (versión de servidor).
 *
 * Es un port ESM, sin dependencias de DOM/navegador, del motor puro que corre en el
 * cliente (public/matcher/matcher-engine.js). El algoritmo es idéntico: normalización de
 * texto, extracción de atributos color/talle, LCS, token-set-ratio, índice invertido y
 * scoring de candidatos.
 *
 * Se duplica a propósito en vez de importar el archivo del cliente: aquel es un IIFE de
 * browser (se sirve por <script> y lo usa el Web Worker en el modo Excel), mientras que
 * acá necesitamos un módulo ESM importable por las rutas y los tests. Ambos deben quedar
 * en sync: cualquier cambio en el algoritmo hay que reflejarlo en los dos.
 */

const EQUIV = { gray: 'gris', grey: 'gris', black: 'negro', white: 'blanco', red: 'rojo', blue: 'azul', green: 'verde', yellow: 'amarillo', orange: 'naranja', purple: 'violeta', pink: 'rosa', brown: 'marron' };
const COLORES = new Set(['negro', 'blanco', 'rojo', 'azul', 'verde', 'amarillo', 'naranja', 'violeta', 'rosa', 'gris', 'marron', 'celeste', 'teal', 'dorado', 'plateado', 'dark', 'brush', 'fluo', 'turquesa', 'bordo', 'beige', 'crema', 'lima', 'coral', 'fucsia', 'cobre', 'grafito', 'antracita', 'oliva', 'arena', 'vino', 'mostaza', 'salmon', 'menta', 'lavanda',
  // Ampliación data-driven (H-07): términos de color/acabado reales de las publicaciones ML.
  'lila', 'marino', 'navy', 'plata', 'acero', 'bronce', 'cromado', 'titanio', 'titanium', 'ceniza', 'perlado', 'metalizado', 'multicolor', 'transparente', 'indigo', 'agua', 'aqua', 'petroleo', 'caramelo', 'cappuccino', 'castano', 'musgo', 'rosado', 'burgundy', 'borravino', 'terracota', 'ocre', 'mate', 'matte']);
const TALLE_RE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|xxxxxl|\d{2,3}|un|unico)$/;

export function norm(t) {
  if (!t && t !== 0) return '';
  t = String(t).toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const e in EQUIV) t = t.replace(new RegExp('\\b' + e + '\\b', 'g'), EQUIV[e]);
  return t.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function toks(t) { return new Set(norm(t).split(' ').filter((x) => x)); }

export function extraerAtributos(varStr) {
  if (!varStr) return { colores: new Set(), talles: new Set() };
  const lower = String(varStr).toLowerCase().trim();
  if (lower.includes('/')) {
    const partes = lower.split('/').map((p) => norm(p).trim()).filter(Boolean);
    const colores = new Set(), talles = new Set();
    for (const parte of partes) { const tks = parte.split(/\s+/).filter(Boolean); if (tks.length && tks.every((t) => TALLE_RE.test(t))) { tks.forEach((t) => talles.add(t)); } else { tks.forEach((t) => colores.add(t)); } }
    if (colores.size || talles.size) return { colores, talles };
  }
  const tks = norm(lower).split(' ').filter(Boolean); const skip = new Set(['eu', 'un', 'cm', 'mm']);
  return { colores: new Set(tks.filter((t) => COLORES.has(t))), talles: new Set(tks.filter((t) => !COLORES.has(t) && !skip.has(t))) };
}

export function extraerAtributosWC(nombre) {
  if (!nombre) return { colores: new Set(), talles: new Set() };
  const lower = String(nombre).toLowerCase().trim();
  let suffix = lower;
  const emDash = lower.lastIndexOf('—'); const hyphen = lower.lastIndexOf(' - '); const at = Math.max(emDash, hyphen);
  if (at > 0) suffix = lower.slice(at + 1).trim();
  if (suffix.includes('/')) {
    const partes = suffix.split('/').map((p) => norm(p).trim()).filter(Boolean);
    const colores = new Set(), talles = new Set();
    for (const parte of partes) { const tks = parte.split(/\s+/).filter(Boolean); if (tks.length && tks.every((t) => TALLE_RE.test(t))) { tks.forEach((t) => talles.add(t)); } else { tks.forEach((t) => colores.add(t)); } }
    if (colores.size || talles.size) return { colores, talles };
  }
  const tks = norm(lower).split(' ').filter(Boolean); const skip = new Set(['eu', 'un', 'cm', 'mm']);
  return { colores: new Set(tks.filter((t) => COLORES.has(t))), talles: new Set(tks.filter((t) => !COLORES.has(t) && !skip.has(t))) };
}

// Atributos estructurados de una variación WC (atributos_json = [{name,option}]).
export function extraerAtributosDeAttrsWC(atributosJson) {
  if (!atributosJson) return null;
  let arr; try { arr = typeof atributosJson === 'string' ? JSON.parse(atributosJson) : atributosJson; } catch (e) { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  const colores = new Set(), talles = new Set(); const skip = new Set(['eu', 'un', 'cm', 'mm']);
  for (const a of arr) {
    const nm = norm(a && a.name || ''), val = norm(a && a.option || '');
    if (!val) continue;
    const esColor = /\bcolor\b/.test(nm), esTalle = /\b(talle|talla|size|medida)\b/.test(nm);
    for (const t of val.split(' ').filter(Boolean)) {
      if (skip.has(t)) continue;
      if (esColor) colores.add(t);
      else if (esTalle) talles.add(t);
      else if (COLORES.has(t)) colores.add(t);
      else if (TALLE_RE.test(t)) talles.add(t);
      else talles.add(t);
    }
  }
  if (!colores.size && !talles.size) return null;
  return { colores, talles };
}

export function attrScore(v) { return v === true ? 2 : v === false ? 0 : 1; }
export function lcsLen(a, b) { const m = a.length, n = b.length; if (!m || !n) return 0; let prev = new Int32Array(n + 1); for (let i = 1; i <= m; i++) { const cur = new Int32Array(n + 1), ai = a.charCodeAt(i - 1); for (let j = 1; j <= n; j++) { cur[j] = ai === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]); } prev = cur; } return prev[n]; }
export function ratio(a, b) { const la = a.length, lb = b.length; if (!la && !lb) return 1; if (!la || !lb) return 0; return 2 * lcsLen(a, b) / (la + lb); }
export function tsr(a, b) { const sa = new Set(a.split(' ').filter((x) => x)), sb = new Set(b.split(' ').filter((x) => x)); const inter = [...sa].filter((x) => sb.has(x)).sort(), dA = [...sa].filter((x) => !sb.has(x)).sort(), dB = [...sb].filter((x) => !sa.has(x)).sort(); const t0 = inter.join(' '), t1 = inter.concat(dA).join(' ').trim(), t2 = inter.concat(dB).join(' ').trim(); return Math.max(ratio(t0, t1), ratio(t0, t2), ratio(t1, t2)); }
export function intersecta(a, b) { for (const x of a) if (b.has(x)) return true; return false; }

export function construirWC(items) {
  const wcItems = []; const wcPorSku = {};
  for (const r of items) {
    if (!r.sku || !String(r.sku).trim()) continue;
    const sku = String(r.sku).trim();
    const nombre = String(r.nombre || '');
    const tipo = String(r.tipo || 'simple');
    const attrs = extraerAtributosDeAttrsWC(r.atributos_json) || extraerAtributosWC(nombre);
    const item = { sku, nombre, tipo, color: [...attrs.colores].join(' '), talle: [...attrs.talles].join('/'), img: String(r.img || ''), baseNorm: norm(nombre), colorToks: attrs.colores, talleToks: attrs.talles };
    wcItems.push(item); wcPorSku[sku] = item;
  }
  const indice = {};
  wcItems.forEach((w, i) => { for (const t of new Set(w.baseNorm.split(' ').filter((x) => x))) { (indice[t] || (indice[t] = [])).push(i); } });
  return { wcItems, indice, wcPorSku };
}

// Envoltorio de construirWC() que agrega la frecuencia documental (df) y el tamaño del corpus
// del lado del CATÁLOGO, que es lo que necesita esDiscriminante() (regla 3, rareza) cuando la
// dirección de comparación es documento→catálogo (ver lib/ingresoMatcher.js). construirWC()
// queda INTACTA a propósito: la usan routes/matcher.js, lib/matcherResolver.js y
// lib/coberturaCola.js:194, y cambiar su contrato rompe los tres.
//
// OJO con `corpusSize`: cuenta SOLO los productos con SKU, porque construirWC() descarta las
// filas sin SKU antes de indexar. esTokenRaro() compara `df[tok] <= max(2, corpusSize*0.02)`,
// así que si el catálogo tuviera muchas filas sin SKU el umbral de rareza sería más bajo (más
// estricto) que el "tamaño real" del catálogo. Es conservador —marca menos tokens como raros—,
// pero hay que saberlo antes de comparar este número contra un COUNT(*) de catalogo_cache.
//
// Además cuelga en cada ítem los campos de identidad/jerarquía que construirWC no guarda
// (`id_woo`, `id_padre`): son aditivos (nadie los lee hoy) y son lo que permite detectar
// hermanos de un mismo producto padre para el desempate de variaciones.
//
// Hallazgo 1: agrega `atributosEstructurados` (boolean) para marcar si los atributos vinieron
// de la estructura (atributos_json válido) o del fallback del título. Esto permite distinguir
// entre una verdadera contradicción de atributo y una omisión de datos estructurados.
//
// Hallazgo 4: recorre items con el MISMO filtro que construirWC (descartando sin SKU) y aparea
// wcItems por ÍNDICE relativo, no por SKU. SKU no es único en catalogo_cache (nullable, sin
// índice UNIQUE), así que porSku[sku] pierde filas con SKU duplicado.
export function construirWCIndex(items) {
  const base = construirWC(items);
  const df = {};

  // Recorrer items con el mismo filtro que construirWC (descarta sin SKU)
  let wcIndex = 0;
  for (const r of items || []) {
    const sku = r && r.sku ? String(r.sku).trim() : '';
    if (!sku) continue; // mismo criterio que construirWC línea 90

    const w = base.wcItems[wcIndex];
    w.id_woo = r.id_woo ?? r.id ?? null;
    w.id_padre = r.id_padre ?? null;
    // Marcar si los atributos vinieron de la estructura (atributos_json) o del fallback del título
    w.atributosEstructurados = r.atributos_json ? !!extraerAtributosDeAttrsWC(r.atributos_json) : false;
    w.tokens = new Set(w.baseNorm.split(' ').filter((x) => x));
    for (const t of w.tokens) df[t] = (df[t] || 0) + 1;

    wcIndex++;
  }
  return { ...base, df, corpusSize: base.wcItems.length };
}

// Contradicción de atributo entre lo que DECLARA el documento (remito/factura) y lo que declara
// la variación de catálogo. Es contradicción solo si AMBOS lados declaran el atributo y no
// comparten ningún valor: si uno de los dos no lo declara es una omisión, y una omisión no
// contradice nada (mismo criterio que marcaEnConflicto con la marca ausente).
// La comparación es canónica (canonToken): "negra"/"negro" y "700x25c"/"700x25" son el mismo
// valor escrito distinto, no una contradicción.
export function contradiccionAtributo(ctDoc, wcItem) {
  const canon = (set) => new Set([...(set || [])].map((t) => canonToken(t)));
  const choca = (a, b) => {
    if (!a || !b || !a.size || !b.size) return false; // omisión de alguno de los dos lados
    const ca = canon(a), cb = canon(b);
    for (const t of ca) if (cb.has(t)) return false;
    return true;
  };
  const color = choca(ctDoc && ctDoc.colores, wcItem && wcItem.colorToks);
  const talle = choca(ctDoc && ctDoc.talles, wcItem && wcItem.talleToks);
  return { color, talle, hay: color || talle };
}

// Convierte los campos color/talle estructurados de ML en sets de tokens del motor.
export function ctDesdeApi(color, talle) {
  const colores = new Set(), talles = new Set();
  norm(color).split(' ').filter(Boolean).forEach((t) => { if (COLORES.has(t)) colores.add(t); else talles.add(t); });
  norm(talle).split(' ').filter(Boolean).forEach((t) => { if (COLORES.has(t)) colores.add(t); else if (TALLE_RE.test(t)) talles.add(t); });
  return { colores, talles };
}

const TOPE_CANDIDATOS = 50;
export function getCandidatos(tn, esVar, varStr, ctOverride, wcItems, indice) {
  const ct = ctOverride || (esVar ? extraerAtributos(varStr) : { colores: new Set(), talles: new Set() });
  const tks = new Set(tn.split(' ').filter((x) => x));
  const cuenta = {};
  for (const t of tks) if (indice[t]) for (const p of indice[t]) cuenta[p] = (cuenta[p] || 0) + 1;
  const candPos = Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a]).slice(0, TOPE_CANDIDATOS).map(Number);
  const scored = [];
  for (const pos of candPos) {
    const w = wcItems[pos], sm = tsr(tn, w.baseNorm);
    const cOk = ct.colores.size ? intersecta(ct.colores, w.colorToks) : null;
    const tOk = ct.talles.size ? intersecta(ct.talles, w.talleToks) : null;
    let bonus = 0; if (cOk) bonus += 0.5; if (tOk) bonus += 0.5;
    scored.push({ sf: esVar ? sm * (1 + bonus) / 2 : sm, cOk, tOk, w });
  }
  scored.sort((a, b) => { const la = attrScore(a.cOk) + attrScore(a.tOk), lb = attrScore(b.cOk) + attrScore(b.tOk); return lb !== la ? lb - la : b.sf - a.sf; });
  return scored.slice(0, 8).map((s) => ({ score: +s.sf.toFixed(3), color_ok: s.cOk, talle_ok: s.tOk, wc_sku: s.w.sku, wc_nombre: s.w.nombre, wc_tipo: s.w.tipo, wc_color: s.w.color, wc_talle: s.w.talle, wc_img: s.w.img }));
}

// Cómputo caro para un ítem ML: sólo depende de título/atributos, NO del seller_sku actual.
export function candidatosDeItem(ml, wcItems, indice) {
  const tn = norm(ml.ml_title);
  return getCandidatos(tn, ml.ml_es_variante, ml.ml_variations, ml._ct, wcItems, indice);
}

// Hash acumulado simple (DJB2) para firmas de cache livianas.
export function djb2(str) { let h = 5381; for (let i = 0; i < str.length; i++) { h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; } return h >>> 0; }

/* =====================================================================================
 * Matcher inverso WC → ML (Cobertura accionable)
 * =====================================================================================
 * Dado un producto de WooCommerce con stock, buscar la publicación de ML que YA EXISTE
 * pero está sin `seller_sku` (3638 de 6822 en ml_publicaciones_cache al momento de
 * escribir esto). Esto es la contracara de candidatosDeItem() de arriba (esa va ML→WC).
 *
 * El problema medido, con datos reales, es que una bolsa de palabras (tsr) se equivoca
 * con confianza: "Pedales Shimano M520" vs "Pedales Shimano M540" da ~0.75 de similitud
 * porque comparten "pedales" y "shimano", que son palabras genéricas de categoría/marca
 * que sobran en cientos de títulos, mientras que "m520"/"m540" —el único dato que
 * distingue el producto real— pesa exactamente igual que cualquier otra palabra en tsr.
 *
 * La solución no es "bajar el score general", es identificar qué tokens son
 * DISCRIMINANTES (describen una especificación puntual del producto, no la categoría) y
 * tratarlos aparte: si hay uno en conflicto, el candidato no puede ser "alta confianza"
 * sin importar cuánto suba el score de palabras. Un vínculo mal hecho ata el stock al
 * listado equivocado — es peor que no vincular nada.
 * ===================================================================================== */

// Un token es discriminante si describe una especificación puntual y no una palabra de
// categoría/marca genérica. Tres reglas explícitas, cualquiera alcanza:
//
// 1) Código alfanumérico (letras + dígitos mezclados): m520, hg500, sx10, hg50, 60ml, 9v,
//    25t. Son códigos de modelo o de medida — nunca aparecen "por casualidad" en dos
//    productos distintos, y si aparecen en uno y no en otro, son productos distintos.
// 2) Número puro de 2+ dígitos: 116 (eslabones de cadena), 700 (rodado), 25 (ancho de
//    cubierta en mm). Un solo dígito ('9', '7') se deja afuera a propósito: son
//    demasiado comunes (velocidades, cantidades) y su "discriminancia" ya la cubre la
//    regla 3 si de verdad son raros en el corpus.
// 3) Rareza en el corpus (data-driven): el token aparece en muy pocas publicaciones ML
//    del universo comparado. Esto es lo que atrapa "alambre" vs "kevlar" — palabras
//    normales, no códigos, pero que en el corpus real son específicas de un puñado de
//    productos, a diferencia de "pedales"/"shimano"/"negro" que aparecen en cientos.
//    Sin esta regla 3, ningún dictionary hardcodeado de materiales cubriría los casos
//    reales que no se pueden prever de antemano.
const UMBRAL_RAREZA = 0.02; // 2% del corpus: calibrado contra los 3184 pares SKU↔ML reales
// (ver test/matcher-inverso.test.js). Con umbrales más laxos (5-10%) "alambre" seguía
// pasando como no-discriminante en parte del corpus; con este nivel el M520/M540 nunca
// pasa (aparecen en <0.1% del corpus) y las palabras de categoría (>10%) quedan afuera.

// Stoplist de muletillas (hallazgo del revisor): palabras que un catálogo real repite como
// rótulo de campo o relleno de marketing y que, precisamente por no ser específicas de NINGÚN
// producto, pueden colarse como "raras" en un corpus chico (regla 3) sin serlo de verdad.
// "Talle" es el caso que lo destapó: aparece poco en un universo de prueba acotado, cae como
// discriminante por rareza, y hunde a 'revisar' un match con score 1.0 y cero diferencia real
// ("Casco Bell Draft Negro Talle M" vs "...Negro M"). Esta lista queda excluida SIEMPRE de
// esDiscriminante, sin importar cuán rara resulte en el corpus — no son especificaciones de
// producto, son metadata de catálogo o relleno.
const RELLENO = new Set([
  'talle', 'talles', 'talla', 'tallas', 'medida', 'medidas', 'color', 'colores',
  'unidad', 'unidades', 'original', 'originales', 'nuevo', 'nueva', 'nuevos', 'nuevas',
  'oficial', 'oficiales', 'bicicleta', 'bicicletas', 'modelo', 'modelos',
]);

export function esCodigoAlfanumerico(tok) { return /[a-z]/.test(tok) && /[0-9]/.test(tok); }
export function esMedidaNumerica(tok) { return /^[0-9]{2,}$/.test(tok); }
export function esTokenRaro(tok, df, corpusSize) {
  if (!corpusSize) return false;
  const apariciones = df[tok] || 0;
  return apariciones <= Math.max(2, corpusSize * UMBRAL_RAREZA);
}
export function esDiscriminante(tok, df, corpusSize) {
  if (!tok || tok.length < 2) return false; // un solo carácter no discrimina nada
  if (RELLENO.has(tok)) return false; // muletilla de catálogo, nunca especificación de producto
  return esCodigoAlfanumerico(tok) || esMedidaNumerica(tok) || esTokenRaro(tok, df, corpusSize);
}

// Variantes morfológicas del MISMO valor (hallazgo del revisor): "negra"/"negro",
// "700x25"/"700x25c" no son una contradicción, son el mismo dato escrito distinto. EQUIV (en
// norm()) ya resuelve sinónimos en inglés, pero no género/plural en español ni sufijos de
// medida. canonToken() normaliza ambos casos SOLO para decidir si un token está "solo" de un
// lado — no toca `coincide` (que sigue siendo comparación exacta, para no inventar coincidencias
// donde el texto realmente difiere en algo que no sea género/plural/sufijo de medida).
export function colorCanonico(tok) {
  if (COLORES.has(tok)) return tok;
  // Plural de color terminado en consonante (gris→grises): quitar "es" completo.
  if (tok.endsWith('es') && COLORES.has(tok.slice(0, -2))) return tok.slice(0, -2);
  // Plural simple (verde→verdes, negro→negros): quitar solo la "s" final.
  if (tok.endsWith('s') && COLORES.has(tok.slice(0, -1))) return tok.slice(0, -1);
  // Femenino plural (negra→negras): "as"→"o" (no lo cubre el paso anterior: "negra" no está
  // en COLORES, solo "negro").
  if (tok.endsWith('as') && COLORES.has(tok.slice(0, -2) + 'o')) return tok.slice(0, -2) + 'o';
  // Femenino singular (negra→negro).
  if (tok.endsWith('a') && COLORES.has(tok.slice(0, -1) + 'o')) return tok.slice(0, -1) + 'o';
  return null; // no es una variante reconocible de ningún color de COLORES
}
export function medidaCanonica(tok) {
  // "700x25c" → "700x25": un sufijo de una sola letra sobre una medida NxM (norm() ya quitó el
  // punto de "29x2.20", así que esto también agarra ese patrón vía los dos tokens "29x2"/"20").
  const m = /^(\d+x\d+)[a-z]$/.exec(tok);
  return m ? m[1] : null;
}
export function canonToken(tok) { return colorCanonico(tok) || medidaCanonica(tok) || tok; }

// Construye el universo de publicaciones ML candidatas (las que no tienen seller_sku),
// con su índice invertido y su frecuencia documental (df) — la df es lo que alimenta la
// regla 3 de esDiscriminante: cuántas publicaciones de ESTE universo usan cada token.
export function construirML(items) {
  const mlItems = [];
  for (const r of items) {
    const titulo = String(r.titulo || '');
    if (!titulo.trim()) continue;
    const baseNorm = norm(titulo);
    const tokens = toks(baseNorm);
    if (!tokens.size) continue;
    const { colores, talles } = ctDesdeApi(r.color, r.talle);
    mlItems.push({
      clave: r.clave, item_id: r.item_id, variation_id: r.variation_id || '',
      titulo, baseNorm, tokens, colorToks: colores, talleToks: talles,
      thumbnail: r.thumbnail || '', precio: r.precio ?? null, stock: r.available_quantity ?? null,
      status: r.status || '',
    });
  }
  const indice = {}; const df = {};
  mlItems.forEach((m, i) => {
    for (const t of m.tokens) { (indice[t] || (indice[t] = [])).push(i); df[t] = (df[t] || 0) + 1; }
  });
  return { mlItems, indice, df, corpusSize: mlItems.length };
}

// Diff estructurado entre los tokens de un producto WC y una publicación ML candidata.
// No es un extra: es requisito de contrato (la tarjeta de la interfaz resalta diferencias
// a partir de esto, no de un score suelto). `discriminantes_conflicto` son los tokens que,
// estando solo de un lado, alcanzan para tumbar la confianza aunque el score sea alto.
// Hallazgo de probador-e2e (caso real: "Jersey Elite KOKUEN" vs "Casco Giro Seyen Mips" quedó
// en 'revisar' con un solo click de fricción, siendo marca Y categoría distintas). Se usa tanto
// para hay_contradiccion (como antes) como, más abajo, para forzar 'baja' — pero ahí con más
// cuidado: no alcanza con "el token de marca no aparece literal", porque en catálogos reales la
// marca de Woo puede estar mal tipeada o abreviada distinto al título de ML ("Metha" vs
// "Mtha"). Por eso se tolera un parecido alto (ratio() ya existe en este archivo, LCS-based)
// antes de declarar conflicto — así no se castiga una diferencia de escritura como si fuera una
// marca distinta.
// Marcas conocidas del catálogo, normalizadas para comparar contra tokens de título ML.
// Filtra ruido de 1-2 caracteres: con umbral 3 se recuperan marcas cortas reales (Kmc, Poc,
// Fox, Fsa, Bbb, Rst, Rpm, Esi, Mti, Awa, Koo — todas presentes en catalogo_cache y con
// hermanos parecidos en su categoría, justo donde más falta la señal). Verificado contra el
// corpus real de títulos ML: las 15 marcas de 3 caracteres del catálogo (salvo "Pro", ver
// abajo) aparecen SIEMPRE nombrando la marca real, sin colisión con palabras comunes. Quedan
// afuera de 2 caracteres (QR, entre otras) a propósito: "QR" colisiona de lleno con la
// categoría real "QR PAGOS" del catálogo — bajar a 2 sería ruido garantizado, no señal. Puro:
// no hace I/O — el llamador arma la lista (típicamente `SELECT DISTINCT marca FROM
// catalogo_cache`) y la pasa acá.
//
// "Pro" es la excepción medida que NO se explica por ser color: es una marca real (línea de
// accesorios de Shimano) pero también una palabra de catálogo genérica ("Pro Team" es una
// LÍNEA de producto de Rapha, no una mención de la marca Pro). Contra los pares reales, esto
// dio 15 falsos conflictos de marca de 17 medidos (Rapha vs. "Calzas/Jersey Pro Team..."). Se
// excluye puntualmente — no se baja el corte general de 3 caracteres, que sí funciona bien
// para las otras 15 marcas cortas.
const MARCAS_AMBIGUAS = new Set(['pro']);

// Cualquier marca cuya forma normalizada coincida con un color de COLORES (arriba en este
// archivo) se excluye automáticamente: hallazgo del revisor con "Lima" — es una marca real de
// catalogo_cache Y a la vez un color real del corpus ("Verde Lima", "Negro Matte/Lima": 6 de 7
// apariciones en el corpus son el color, no la marca). Hoy da 0 falsos conflictos (ningún WC
// con marca "Lima" quedó sin la marca literal en su propio título en los pares medidos), pero
// es una regla derivada de datos que YA vive en el motor (COLORES), preferible a mantener a
// mano una lista de excepciones cada vez que aparezca un caso — a diferencia de "Pro" (arriba),
// que no es un color y sí necesita la lista manual.
//
// EL COSTO de que la regla sea derivada, para que no sorprenda: si mañana entra al catálogo una
// marca real que se llame como un color de la lista, se va a excluir sola y en silencio. No es
// hipotético — COLORES incluye 'arena', 'coral', 'menta', 'vino', 'lavanda', 'salmon', y Arena
// existe como marca deportiva. El síntoma sería perder la protección de conflicto para esa
// marca (fail-open, conservador), nunca un vínculo equivocado. Se asume a propósito: mantener
// una stoplist a mano tiene un costo peor, que es olvidarse de actualizarla.
export function normalizarMarcas(marcas) {
  const set = new Set();
  for (const m of marcas || []) {
    const n = norm(m);
    if (n && n.length >= 3 && !MARCAS_AMBIGUAS.has(n) && !COLORES.has(n)) set.add(n);
  }
  return set;
}

// Umbral para declarar "el título ML nombra otra marca". 0.85 (el umbral que ya usa este
// archivo para tolerar escritura distinta de la MISMA marca, ej. "Metha"/"Mtha") daba falsos
// positivos reales barriendo los tokens de títulos ML contra las 136+ marcas del catálogo:
// "cubre"→Cube (0.89), "funda"→Fundax (0.91), "lite"→Elite (0.89), "slim"→Slime (0.89),
// "clima"→Lima (0.89), "volt"→Volta (0.89) — palabras de catálogo comunes que por casualidad
// se parecen a una marca, no la nombran. 0.92 los deja afuera a todos (los seis miden ≤0.909)
// sin perder detección real: coincidencias genuinas (typo cerrado, plural, concatenado sin
// espacio como "buzzrack") miden ≥0.94 en los casos medidos. Hallazgo del revisor.
const UMBRAL_OTRA_MARCA = 0.92;

// La regla vieja —marca de WC ausente del título ML = conflicto, sin más— midió 74 falsas
// alarmas de marca (contadas por publicación) contra los ~2643 vínculos ML↔WC ya verificados,
// de las cuales la enorme mayoría eran simplemente títulos de ML que OMITEN la marca (la mitad
// del corpus de ML no la menciona; se vende por modelo/categoría). Rebajaba la confianza de
// matches correctos y volvía inútil la señal: si el rojo aparece sin razón, el usuario deja de
// creerle.
//
// La regla refinada exige más que una ausencia: para ser conflicto, el título de ML tiene que
// mencionar OTRA marca conocida del catálogo, no solo callarse la de WC. El número reproducible
// y actualizado (recall, conteo por publicación Y por producto/SKU deduplicado, que NO es el
// mismo número por el patrón intencional 1 SKU → N publicaciones de este catálogo) vive en
// test/matcher-validacion.test.js (bloque `describe.skip`, correr a mano contra
// data/fusion.sqlite) — no lo repitas acá, se desactualiza con cada corrección del motor y con
// cada sync que crece el corpus.
//
// Limitaciones conocidas y aceptadas (no se resuelven acá, ver test/matcher-validacion.test.js
// para el conteo real actualizado):
// 1. Marca propia de otra marca madre: "Bontrager" es de Trek, "Truvativ" es de Sram. Si el
//    título ML usa la marca madre en vez de la sub-marca (o viceversa) sigue dando conflicto.
//    Degrada a 'revisar'/'baja', que es conservador, no peligroso. Armar un mapa de marcas
//    madre es sobre-ingeniería para un puñado de casos conocidos — si aparecen muchos más, se
//    reevalúa con datos, no de antemano.
// 2. Frases de compatibilidad ("Pastillas… Para Shimano Y Tektro", "Compatible Con Sram"): el
//    título ML nombra una marca ajena a propósito, no por error — describe con qué otra marca
//    es compatible el producto, no de qué marca ES. El motor no distingue "es de" de "es
//    compatible con"; es un patrón sistemático en pastillas de freno, cassettes y movimientos
//    centrales. Mismo criterio que el punto 1: se documenta, no se resuelve sin más casos.
// Excluye de `marcasConocidas` la que sea, en realidad, la propia marca de WC escrita distinto
// (mismo umbral que "otra marca", comparando la marca WC COMPLETA normalizada, no token a
// token — hallazgo 🔴 del revisor: el chequeo de token de marcaEnConflicto compara TOKENS de
// marcaWc ("buzz","rack") contra tokens de ML, así que una marca multi-palabra escrita SIN
// espacio en el título ML, "Buzzrack", no la reconoce como propia (ratio('buzz','buzzrack')=
// 0.67<0.75) y sin este filtro terminaba conflictuando CONSIGO MISMA vía la marca conocida
// completa ("buzz rack" vs "buzzrack" da ratio 0.94≥0.92). Hay 20 marcas multi-palabra reales
// en catalogo_cache, varias ya concatenadas en títulos ML reales — verificado que el filtro no
// se come una marca AJENA por error: el máximo ratio entre dos marcas DISTINTAS del catálogo
// (barrido de las 151×150 combinaciones) es 0.889, por debajo de 0.92).
//
// Depende SOLO de `marcaWc`, que es constante para todo un producto (no cambia entre los hasta
// 50 candidatos ML que evalúa candidatosDeWC) — por eso se calcula UNA VEZ por producto, no una
// vez por candidato. Medido: recalcularla adentro de marcaEnConflicto en cada llamada costaba
// +30% en una página real (125ms→162ms para 20 productos), porque son 151 ratio() sobre
// strings completos repetidos sin necesidad. `candidatosDeWC` (y `buscarMlManual` en
// coberturaCola.js) la calculan acá y la pasan ya filtrada a diffTokens/marcaEnConflicto.
export function otrasMarcasPosibles(marcaWc, marcasConocidas) {
  if (!marcaWc || !marcasConocidas || !marcasConocidas.size) return marcasConocidas || new Set();
  const marcaWcNorm = norm(marcaWc);
  return new Set([...marcasConocidas].filter((mc) => ratio(marcaWcNorm, mc) < UMBRAL_OTRA_MARCA));
}

// `otrasMarcas` es el resultado de otrasMarcasPosibles(marcaWc, marcasConocidas) — YA excluye
// la propia marca de WC. No se recalcula acá adentro (ver comentario de otrasMarcasPosibles):
// si se llama directo (fuera de candidatosDeWC/diffTokens), el llamador es responsable de
// pasar por otrasMarcasPosibles() primero.
export function marcaEnConflicto(marcaWc, tksMl, otrasMarcas) {
  if (!marcaWc) return false; // marca ausente en WC: nunca contradicción (no hay nada que comparar)
  const tksMarca = [...toks(marcaWc)].filter((t) => t.length >= 3);
  if (!tksMarca.length) return false;
  for (const tm of tksMarca) {
    for (const tml of tksMl) {
      if (tm === tml || ratio(tm, tml) >= 0.75) return false; // exacta o variante de escritura: la marca SÍ está
    }
  }
  // La marca de WC no aparece (ni exacta ni parecida) en el título ML. Antes esto ya era
  // conflicto; ahora es solo el punto de partida. Sin lista de marcas conocidas no hay forma de
  // distinguir "el título la omitió" de "el título habla de otra marca" — fail-open (no marcar
  // conflicto) es la opción segura acá: la alternativa es exactamente el defecto que esto corrige.
  if (!otrasMarcas || !otrasMarcas.size) return false;
  // Guarda barata contra el uso incorrecto (medido en la práctica: pasar la lista CRUDA de
  // marcasConocidas acá en vez del resultado de otrasMarcasPosibles(marcaWc, ...) — la firma
  // acepta cualquier Set sin quejarse y devuelve un resultado plausible pero falso, el auto-
  // conflicto del hallazgo 🔴 reaparece en silencio). Esto NO reemplaza el filtro completo por
  // ratio (sería volver a pagar el costo que otrasMarcasPosibles evita, hallazgo 🟡 de
  // performance): es un chequeo de membresía exacta, O(1), que sí atrapa el caso más común —
  // la propia marca normalizada tal cual está en el catálogo. Un typo/escritura distinta que
  // otrasMarcasPosibles sí filtraría (ratio, no exacto) puede colarse igual; para eso está el
  // comentario y el test de contrato en test/matcher-inverso.test.js.
  if (otrasMarcas.has(norm(marcaWc))) {
    throw new Error(`marcaEnConflicto: "otrasMarcas" incluye la propia marca ("${marcaWc}") — ¿te olvidaste de pasar por otrasMarcasPosibles(marcaWc, marcasConocidas) antes de llamar?`);
  }
  for (const tml of tksMl) {
    if (tml.length < 3) continue; // por debajo de la marca conocida más corta (normalizarMarcas ya filtra <3): no puede alcanzar el umbral
    for (const mc of otrasMarcas) {
      if (ratio(tml, mc) >= UMBRAL_OTRA_MARCA) return true; // el título ML nombra otra marca conocida del catálogo
    }
  }
  return false; // ninguna palabra del título ML coincide con otra marca conocida: omisión, no contradicción
}

// `otrasMarcas` (si se pasa) debe venir YA filtrada por otrasMarcasPosibles(marcaWc, ...) — ver
// el comentario de esa función para el motivo (evitar recalcular el filtro de auto-marca una
// vez por candidato). candidatosDeWC y buscarMlManual (coberturaCola.js) ya lo hacen así.
export function diffTokens(tksWc, tksMl, df, corpusSize, marcaWc, otrasMarcas) {
  const coincide = [...tksWc].filter((t) => tksMl.has(t)).sort();
  // canonMl/canonWc: qué formas canónicas (color sin género/plural, medida sin sufijo de una
  // letra) tiene CADA lado. Un token que no coincide literal pero cuya forma canónica sí existe
  // del otro lado ("negra" vs "negro", "700x25c" vs "700x25") no es "solo de un lado": es el
  // mismo valor escrito distinto, y no entra a la lista de candidatos a discriminante.
  const canonMl = new Set([...tksMl].map((t) => canonToken(t)));
  const canonWc = new Set([...tksWc].map((t) => canonToken(t)));
  const soloWc = [...tksWc].filter((t) => !tksMl.has(t) && !canonMl.has(canonToken(t))).sort();
  const soloMl = [...tksMl].filter((t) => !tksWc.has(t) && !canonWc.has(canonToken(t))).sort();
  const discWc = new Set(), discMl = new Set();
  for (const t of soloWc) if (esDiscriminante(t, df, corpusSize)) discWc.add(t);
  for (const t of soloMl) if (esDiscriminante(t, df, corpusSize)) discMl.add(t);
  // Asimetría deliberada, hallazgo del revisor (M520/M540 con título ML subconjunto del WC):
  // si WC declara un token discriminante ("m520") y el título ML NI SIQUIERA LO NOMBRA, eso
  // ya es motivo de duda — "Pedales Shimano M520" contra la publicación genérica "Pedales
  // Shimano Spd Mtb" da tsr=1.0 (el título ML es subconjunto exacto del de WC) y sin embargo
  // puede ser el M540, el M530 o cualquier otro modelo: el título genérico no confirma nada.
  // Por eso discWc.size > 0 SOLO ya alcanza para tumbar la confianza, sin exigir que ML tenga
  // su propio discriminante en conflicto. La dirección inversa sigue siendo inocua a propósito
  // (calibrado contra los 3184 pares reales): "175mm" que aparece SOLO del lado ML, sin que WC
  // diga nada al respecto, es un dato de más del título más largo/específico de ML, no una
  // contradicción — ahí no se exige nada de discMl.
  let hayContradiccion = discWc.size > 0;
  // Señal extra, no data-driven: si WC trae marca estructurada (catalogo_cache.marca, no
  // inferida del título) y ninguno de sus tokens (ni parecido) aparece en el título ML, es
  // conflicto de marca aunque "shimano"/"maxxis" sean demasiado frecuentes para caer por
  // rareza (regla 3). Esta sí es una contradicción aunque el lado ML no tenga "discriminantes
  // propios": la marca declarada de WC contradice directamente lo que dice el título ML.
  const discMarca = new Set();
  const conflictoMarca = marcaEnConflicto(marcaWc, tksMl, otrasMarcas);
  if (conflictoMarca) {
    [...toks(marcaWc)].filter((t) => t.length >= 3).forEach((t) => discMarca.add(t));
    hayContradiccion = true;
  }
  const discriminantes = [...new Set([...discWc, ...discMl, ...discMarca])].sort();
  return { coincide, solo_wc: soloWc, solo_ml: soloMl, discriminantes_conflicto: discriminantes, hay_contradiccion: hayContradiccion, conflicto_marca: conflictoMarca };
}

// Confianza en tres niveles, NUNCA un porcentaje suelto (decisión de diseño, no negociable):
// una contradicción en token discriminante jamás puede dar 'alta', sin importar el score.
const UMBRAL_ALTA = 0.85;
const UMBRAL_REVISAR = 0.5;
// `conflictoMarca` (probador-e2e, caso "Jersey Kokuen" vs "Casco Giro"): la fricción extra del
// checkbox de "¿Seguro?" en la tarjeta solo se dispara con 'baja' — un conflicto de marca que
// quedaba en 'revisar' se confirmaba con el mismo único click que un match legítimo, justo en
// el caso más grave posible (marca Y categoría distintas). Por eso una marca en conflicto
// fuerza 'baja' directamente, sin importar cuán alto sea el score (a diferencia de un
// discriminante genérico, que solo topea en 'revisar'). marcaEnConflicto() ya filtra el efecto
// colateral pedido: marca ausente en WC nunca entra acá, y una escritura distinta pero parecida
// ("Metha" vs "Mtha") tampoco cuenta como conflicto — solo una marca genuinamente DISTINTA.
export function confianzaDesdeScore(score, hayContradiccion, conflictoMarca = false) {
  if (conflictoMarca) return 'baja';
  if (hayContradiccion) return score >= UMBRAL_REVISAR ? 'revisar' : 'baja';
  if (score >= UMBRAL_ALTA) return 'alta';
  if (score >= UMBRAL_REVISAR) return 'revisar';
  return 'baja';
}

// Cómputo caro para un producto WC: candidatos entre las publicaciones ML sin SKU.
// `wc` es un ítem ya construido por construirWC() (trae baseNorm/colorToks/talleToks);
// `marcaWc` es opcional (catalogo_cache.marca) para el conflicto de marca de diffTokens.
// `marcasConocidas` NO se recibe como parámetro separado (hallazgo del revisor: pasarla a mano
// por tres niveles de llamada es fácil de olvidar en alguno y degrada en silencio, sin fallar
// ni avisar — ya pasó una vez). Se lee de `mlIndex.marcasConocidas`: mlIndex ya es el objeto
// que viaja completo por toda esta cadena, así que colgarla ahí (la arma el llamador de
// construirML, ver lib/coberturaCola.js#construirIndiceMlSinSku) es la única fuente posible.
export function candidatosDeWC(wc, mlIndex, marcaWc) {
  const { mlItems, indice, df, corpusSize, marcasConocidas } = mlIndex;
  const tn = wc.baseNorm;
  const tks = toks(tn);
  const cuenta = {};
  for (const t of tks) if (indice[t]) for (const p of indice[t]) cuenta[p] = (cuenta[p] || 0) + 1;
  const candPos = Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a]).slice(0, TOPE_CANDIDATOS).map(Number);
  // Se calcula UNA VEZ para todo el producto, no una vez por candidato — ver el comentario de
  // otrasMarcasPosibles(). marcaWc es constante acá adentro; recalcularla en el loop de abajo
  // (hasta 50 candidatos) fue el costo medido por el revisor: +30% por página.
  const otrasMarcas = otrasMarcasPosibles(marcaWc, marcasConocidas);
  const scored = [];
  for (const pos of candPos) {
    const ml = mlItems[pos];
    const sm = tsr(tn, ml.baseNorm);
    const diff = diffTokens(tks, ml.tokens, df, corpusSize, marcaWc, otrasMarcas);
    const confianza = confianzaDesdeScore(sm, diff.hay_contradiccion, diff.conflicto_marca);
    // Desempate por color/talle estructurado (columnas color/talle de ml_publicaciones_cache,
    // no texto libre): calibrado contra los 3184 pares reales — el 75% de los casos que caían
    // fuera del top-3 pero SÍ estaban en el top-8 eran variaciones (talle/color) de un mismo
    // producto padre. Ahí el título base es IDÉNTICO entre hermanos ("Remera Oakley Graffiti
    // 1975" con tsr=1 para los 7 talles/colores a la vez), así que tsr no puede distinguirlos:
    // el desempate quedaba en manos del orden arbitrario de recorrido del índice. El 96% de las
    // publicaciones-variante en ml_publicaciones_cache SÍ trae color/talle estructurado (no de
    // texto libre), así que compararlo contra el color/talle YA extraído de wc (construirWC)
    // es gratis (no recorre texto de nuevo) y no toca el score, la confianza ni diffTokens: no
    // puede ablandar los 4 casos negativos ni empeorar el recall global, solo reordena empates.
    const cOk = wc.colorToks.size ? intersecta(wc.colorToks, ml.colorToks) : null;
    const tOk = wc.talleToks.size ? intersecta(wc.talleToks, ml.talleToks) : null;
    const attrBonus = attrScore(cOk) + attrScore(tOk);
    scored.push({
      score: +sm.toFixed(3), confianza, diff, attrBonus,
      ml_clave: ml.clave, ml_item_id: ml.item_id, ml_variation_id: ml.variation_id, ml_titulo: ml.titulo,
      ml_img: ml.thumbnail, ml_precio: ml.precio, ml_stock: ml.stock, ml_status: ml.status,
    });
  }
  // Orden: primero por nivel de confianza (alta > revisar > baja) —un candidato con score alto
  // pero contradicción NO puede ganarle a uno limpio más bajo—, después por score, y recién
  // como último desempate el color/talle estructurado (ver comentario arriba).
  const rango = { alta: 2, revisar: 1, baja: 0 };
  scored.sort((a, b) => (rango[b.confianza] - rango[a.confianza]) || (b.score - a.score) || (b.attrBonus - a.attrBonus));
  return scored.slice(0, 8).map(({ attrBonus, ...c }) => c); // attrBonus es interno, no va en el contrato de salida
}

// Envoltorio de contrato para la cola de trabajo: separa "hay candidatos usables" de "no
// hay ninguno que llegue a un piso razonable" (item 5 del encargo). 'baja' nunca es
// usable como propuesta automática: el producto debe cruzar a "hay que publicarlo" en vez
// de mostrar el candidato menos malo como si fuera una sugerencia.
export function candidatosParaWC(wc, mlIndex, marcaWc) {
  const candidatos = candidatosDeWC(wc, mlIndex, marcaWc);
  const usables = candidatos.filter((c) => c.confianza !== 'baja');
  return { candidatos, sin_candidato: usables.length === 0 };
}

export { EQUIV, COLORES, TALLE_RE, TOPE_CANDIDATOS, UMBRAL_RAREZA, UMBRAL_ALTA, UMBRAL_REVISAR, UMBRAL_OTRA_MARCA };
