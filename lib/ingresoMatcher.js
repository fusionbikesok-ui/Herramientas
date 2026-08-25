/**
 * Matcher de INGRESO: línea de un documento de proveedor (remito/factura) → producto del
 * catálogo WooCommerce. Es el espejo de candidatosDeWC() (catálogo → publicación ML) del
 * motor, en la dirección documento → catálogo.
 *
 * Puro: sin I/O, sin DB. El llamador arma el índice con construirWCIndex().
 *
 * POR QUÉ EXISTE (incidente reproducido con datos de producción): un remito con talles 41, 43
 * y 45 del mismo producto hacía que las tres líneas matchearan a la MISMA variación ("Negro /
 * 42"). Todo el stock se sumaba a una variación y las otras quedaban en cero — corrupción
 * silenciosa. La causa de fondo es que entre hermanos de un mismo producto padre el título base
 * es IDÉNTICO, así que tsr() no puede distinguirlos: el motor tal cual los ordena mejor (el
 * desempate por color/talle de candidatosDeWC), pero el desempate es el ÚLTIMO criterio y solo
 * desempate — no impide elegir el hermano equivocado con "alta" confianza.
 *
 * Por eso este archivo agrega DOS reglas propias del ingreso, encima del motor:
 *   1) Contradicción de atributo (color/talle declarados de ambos lados sin ningún valor en
 *      común) fuerza confianza 'baja', igual que conflicto_marca en confianzaDesdeScore.
 *   2) Empate ambiguo → nunca auto. Es la red de seguridad final: aunque el score falle, el
 *      sistema no elige solo, deja la decisión a una persona.
 */
import {
  norm, toks, tsr, intersecta, attrScore, colorCanonico, TALLE_RE,
  diffTokens, confianzaDesdeScore, otrasMarcasPosibles, esDiscriminante, TOPE_CANDIDATOS,
  contradiccionAtributo,
} from './matcherEngine.js';

// Distancia de score por debajo de la cual dos candidatos se consideran EMPATADOS. No es un
// umbral de calidad: es el ancho de la zona donde el score ya no distingue nada (entre hermanos
// de un mismo padre la diferencia de tsr es del orden de 0.01 o directamente cero). Si dos
// candidatos empatados difieren en color o talle, elegir por score es elegir por el orden del
// array — exactamente el bug que este módulo corrige.
export const EPSILON_EMPATE = 0.02;

const RANGO = { alta: 2, revisar: 1, baja: 0 };

// Color/talle que DECLARA la línea del documento. Prioridad a los campos estructurados (si el
// parser del remito los separó); si no vienen, se infieren del texto: color por COLORES, talle
// por TALLE_RE (letra o número de 2-3 dígitos).
//
// Costo asumido: del texto libre pueden salir "talles" que no lo son (el "29" de "Rodado 29").
// Cuando eso pasa el efecto es una contradicción de más → confianza 'baja' → revisión manual.
// Conservador por diseño: el error caro de este módulo no es pedir una revisión de más, es
// sumar stock a la variación equivocada.
export function ctDesdeDoc(doc) {
  const colores = new Set(), talles = new Set();
  const declaraColor = doc && doc.color, declaraTalle = doc && doc.talle;
  norm(declaraColor || '').split(' ').filter(Boolean).forEach((t) => colores.add(t));
  norm(declaraTalle || '').split(' ').filter(Boolean).forEach((t) => talles.add(t));
  if (colores.size || talles.size) return { colores, talles };
  for (const t of toks(textoDeDoc(doc))) {
    const col = colorCanonico(t);
    if (col) colores.add(col);
    else if (TALLE_RE.test(t)) talles.add(t);
  }
  return { colores, talles };
}

function textoDeDoc(doc) {
  if (!doc) return '';
  return String(doc.descripcion || doc.nombre || doc.texto || '');
}

/**
 * @param {object} doc  línea del documento: { descripcion|nombre|texto, color?, talle?, marca? }
 * @param {object} wcIndex  resultado de construirWCIndex() (+ marcasConocidas opcional)
 * @returns {{candidatos: object[], sin_candidato: boolean, ambiguo: boolean}}
 */
export function candidatosParaDoc(doc, wcIndex) {
  const { wcItems, indice, df, corpusSize, marcasConocidas } = wcIndex;
  const tn = norm(textoDeDoc(doc));
  const tks = toks(tn);
  const ctDoc = ctDesdeDoc(doc);
  const marcaDoc = (doc && doc.marca) || '';

  const cuenta = {};
  for (const t of tks) if (indice[t]) for (const p of indice[t]) cuenta[p] = (cuenta[p] || 0) + 1;
  const candPos = Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a]).slice(0, TOPE_CANDIDATOS).map(Number);

  // Línea genérica: ninguna palabra de la línea es discriminante (todo categoría/marca/relleno,
  // tipo "bicicleta shimano"). tsr() le da 1.0 a cualquier producto que contenga esas palabras
  // (el subconjunto exacto puntúa perfecto), así que el score NO es señal acá. Una línea así no
  // identifica un producto: no puede proponer nada automático. Reemplaza el piso arbitrario
  // `score >= 2` del prototipo de public/recepcion.
  const docGenerico = ![...tks].some((t) => esDiscriminante(t, df, corpusSize));

  // Una sola vez por línea, no una por candidato (ver comentario de otrasMarcasPosibles).
  const otrasMarcas = otrasMarcasPosibles(marcaDoc, marcasConocidas);

  const scored = [];
  for (const pos of candPos) {
    const wc = wcItems[pos];
    const wcToks = wc.tokens || toks(wc.baseNorm);
    const sm = tsr(tn, wc.baseNorm);
    // Primer argumento = "el lado que declara". Acá declara el documento, y la asimetría de
    // diffTokens juega a favor: si el remito dice "M520" y el producto no lo nombra, es duda.
    const diff = diffTokens(tks, wcToks, df, corpusSize, marcaDoc, otrasMarcas);
    // Hallazgo 1: contradicción de atributo SOLO cuando los atributos del catálogo son
    // estructurados (de atributos_json). Si vienen del fallback del título, es una omisión de
    // datos estructurados, no una contradicción.
    const contra = wc.atributosEstructurados ? contradiccionAtributo(ctDoc, wc) : { color: false, talle: false, hay: false };
    let confianza = confianzaDesdeScore(sm, diff.hay_contradiccion, diff.conflicto_marca);
    if (contra.hay || docGenerico) confianza = 'baja'; // regla 1 del ingreso
    const cOk = ctDoc.colores.size ? intersecta(ctDoc.colores, wc.colorToks) : null;
    const tOk = ctDoc.talles.size ? intersecta(ctDoc.talles, wc.talleToks) : null;
    scored.push({
      score: +sm.toFixed(3), confianza, diff, attrBonus: attrScore(cOk) + attrScore(tOk),
      contradiccion_atributo: contra.hay, color_ok: cOk, talle_ok: tOk,
      id_woo: wc.id_woo, id_padre: wc.id_padre, sku: wc.sku, nombre: wc.nombre, tipo: wc.tipo,
      wc_color: wc.color, wc_talle: wc.talle, filtrado_por_atributo: false,
    });
  }

  // Regla 1 (segunda mitad): si entre los hermanos de un mismo id_padre hay al menos UNO que no
  // contradice, los contradichos quedan fuera del top — no se borran de la lista (la interfaz
  // los muestra como descartados y explica por qué), pero no pueden ser candidatos[0] ni entrar
  // al chequeo de empate.
  const hermanoLimpio = new Set();
  for (const c of scored) if (c.id_padre != null && !c.contradiccion_atributo) hermanoLimpio.add(String(c.id_padre));
  for (const c of scored) {
    if (c.contradiccion_atributo && c.id_padre != null && hermanoLimpio.has(String(c.id_padre))) c.filtrado_por_atributo = true;
  }

  // Hallazgo 3: ordenar por score dentro del mismo nivel de confianza, no demorar un candidato
  // con score alto por tener confianza baja si otro con score bajo tiene confianza revisar.
  scored.sort((a, b) => (a.filtrado_por_atributo - b.filtrado_por_atributo)
    || (RANGO[b.confianza] - RANGO[a.confianza])
    || (b.score - a.score) // score es el desempate principal dentro de la misma confianza
    || (b.attrBonus - a.attrBonus));

  const candidatos = scored.slice(0, 8);
  const enJuego = candidatos.filter((c) => !c.filtrado_por_atributo);
  const usables = enJuego.filter((c) => c.confianza !== 'baja');

  // Regla 2 del ingreso: empate ambiguo → nunca auto. Solo cuenta como contendiente un segundo
  // candidato del MISMO nivel de confianza (uno 'baja' no le disputa nada a uno 'alta') y a
  // menos de EPSILON_EMPATE de score. Si además difieren en color o talle, el score no está
  // eligiendo: está desempatando por orden de catálogo.
  // Hallazgo 2: empate TAMBIÉN es ambiguo si son id_woo DISTINTOS sin diferencia de atributo.
  // Hallazgo 5: entre hermanos (mismo id_padre), SIEMPRE ambiguo, sin epsilon — el epsilon
  // entre hermanos es arbitrario porque sus scores son casi idénticos por definición (mismo
  // título base).
  let ambiguo = false;
  const [c1, c2] = enJuego;
  if (c1 && c2 && RANGO[c1.confianza] === RANGO[c2.confianza]) {
    const sonHermanos = c1.id_padre != null && c1.id_padre === c2.id_padre;
    const empate = Math.abs(c1.score - c2.score) < EPSILON_EMPATE;

    if (sonHermanos) {
      // Entre hermanos, siempre ambiguo, sin consideración del epsilon
      ambiguo = true;
    } else if (empate) {
      // Entre no-hermanos, ambiguo si empatan en score y difieren en atributo o id_woo
      const hayDiferenciaAtributo = difierenEnAtributo(c1, c2);
      const sonIdWooDiferentes = c1.id_woo !== c2.id_woo;
      ambiguo = hayDiferenciaAtributo || sonIdWooDiferentes;
    }
  }

  return { candidatos, sin_candidato: usables.length === 0, ambiguo };
}

function difierenEnAtributo(a, b) {
  return norm(a.wc_color || '') !== norm(b.wc_color || '') || norm(a.wc_talle || '') !== norm(b.wc_talle || '');
}

export function autoAplicable(res) {
  return !!res && res.candidatos[0]?.confianza === 'alta' && !res.ambiguo;
}
