import { describe, it, expect } from 'vitest';
import { construirWC, construirML, candidatosDeWC, normalizarMarcas } from '../lib/matcherEngine.js';

/**
 * Validación del matcher inverso contra pares reales (hallazgo 10 del revisor).
 *
 * Este archivo NO fija el número de recall/conflicto de marca en un comentario: ese número
 * cambia con cada corrección del motor y con cada corrida de sync (el corpus real crece). El
 * número reproducible SIEMPRE sale de correr el bloque `describe.skip` de abajo contra
 * data/fusion.sqlite — cualquier comentario en otro archivo (matcherEngine.js incluido) que
 * cite un número puntual debe remitir ACÁ, no repetirlo, porque se desactualiza en silencio
 * (así quedó una vez: un comentario viejo decía "2619 pares" y "6 conflictos" mientras el
 * código medía otra cosa). Este archivo cierra el hueco de reproducibilidad en dos partes:
 *
 * 1. `calcularCurvaRecall` es la MISMA lógica de validación, ahora como utilidad exportable
 *    y testeada — no un script suelto.
 * 2. Un test real (no skip) corre esa lógica sobre una MUESTRA embebida de 34 pares reales
 *    (títulos tal cual figuran en catalogo_cache / ml_publicaciones_cache, tomados de la
 *    validación completa, con su `marca` real) + distractores realistas, así que corre en cada
 *    `npm test` sin necesitar `data/fusion.sqlite` — que ni siquiera existe en este worktree
 *    (regla del proyecto: no tocar `data/`). Sirve de guardia de regresión: si una futura
 *    corrección del motor hunde el recall, o reintroduce un falso conflicto de marca, este
 *    test se pone rojo.
 * 3. Un bloque `describe.skip` con la query EXACTA (incluida la de marcasConocidas, IDÉNTICA a
 *    la de lib/coberturaCola.js#construirIndiceMlSinSku) para recalcular el número completo
 *    contra TODOS los pares reales, para quien tenga acceso a `data/fusion.sqlite` (el VPS de
 *    staging). No corre en CI a propósito (no hay DB real en el repo), pero documenta el
 *    procedimiento paso a paso para que el número se pueda auditar y volver a sacar.
 */

// Utilidad de validación: dado un universo de publicaciones ML SIN seller_sku (`distractores`)
// y una lista de pares reales `{ wcNombre, mlTitulo, mlClave, marca }` ya vinculados, simula que
// cada publicación del par NO tuviera seller_sku (se agrega al universo junto con los
// distractores) y mide en qué puesto del ranking aparece el candidato correcto.
//
// marcasConocidas se arma UNA VEZ, con las marcas de los propios `pares` (como en producción,
// `SELECT DISTINCT marca FROM catalogo_cache`, ver lib/coberturaCola.js#construirIndiceMlSinSku)
// y se cuelga de CADA mlIndex — candidatosDeWC ya no la recibe como parámetro aparte (hallazgo
// del revisor: reenviarla a mano por niveles se olvida en silencio y deja de medir nada del
// conflicto de marca, exactamente lo que le pasó a este archivo la primera vez).
export function calcularCurvaRecall(pares, distractores, cortes = [1, 2, 3, 5, 8]) {
  const catalogo = pares.map((p, i) => ({ id_woo: i, nombre: p.wcNombre, sku: `SKU-${i}`, tipo: 'simple' }));
  const { wcItems } = construirWC(catalogo);
  const marcasConocidas = normalizarMarcas(pares.map((p) => p.marca).filter(Boolean));
  // `distractores` es una lista de títulos (string) — construirML() espera filas con forma
  // {clave, item_id, titulo, ...}, así que hay que envolverlos antes de pasarlos.
  const distractoresRows = distractores.map((titulo, i) => ({ clave: `D${i}|`, item_id: `D${i}`, titulo }));
  const hits = Object.fromEntries(cortes.map((k) => [k, 0]));
  let topAlta = 0, conflictosMarcaParVerdadero = 0;
  pares.forEach((p, i) => {
    const claveVerdadera = p.mlClave || `M${i}|`;
    const universo = [...distractoresRows, { clave: claveVerdadera, item_id: `M${i}`, titulo: p.mlTitulo }];
    const mlIndex = construirML(universo);
    mlIndex.marcasConocidas = marcasConocidas;
    const cands = candidatosDeWC(wcItems[i], mlIndex, p.marca || '');
    // Por clave, no por título: dos distractores podrían compartir texto con el título
    // verdadero (es justo lo que se busca al generar competencia), así que comparar por
    // ml_titulo daría un falso positivo si un distractor casualmente lo reproduce.
    const idx = cands.findIndex((c) => c.ml_clave === claveVerdadera);
    for (const k of cortes) if (idx >= 0 && idx < k) hits[k]++;
    if (idx === 0 && cands[0].confianza === 'alta') topAlta++;
    // Guardia de regresión del hallazgo de marca (no del ranking): el par verdadero NUNCA
    // debería marcar conflicto de marca consigo mismo, sea cual sea su posición en el ranking.
    const candVerdadero = cands.find((c) => c.ml_clave === claveVerdadera);
    if (candVerdadero && candVerdadero.diff.conflicto_marca) conflictosMarcaParVerdadero++;
  });
  const total = pares.length;
  const recall = Object.fromEntries(cortes.map((k) => [k, +(100 * hits[k] / total).toFixed(1)]));
  return { total, recall, top1AltaPct: +(100 * topAlta / total).toFixed(1), conflictosMarcaParVerdadero };
}

// Distractores: publicaciones ML "de relleno" sin relación con ningún par de la muestra, para
// que el ranking tenga que competir contra títulos genéricos reales (si no hubiera distractores
// el candidato correcto sería casi siempre el único del universo, y el test no probaría nada).
const DISTRACTORES = [
  'Pedales Shimano M540 Spd Mtb', 'Pedales Shimano M520 Spd Mtb', 'Cubierta Maxxis Ikon R-29x2.20 Kevlar',
  'Piñón Shimano Hg50 11-36t', 'Cadena Sumc Sx10', 'Cadena Shimano 10 Velocidades',
  'Casco Bicicleta Negro Talle M', 'Zapatillas Ciclismo Negro 40', 'Guantes MTB Negro L',
  'Cámara Bicicleta Rodado 29', 'Disco De Freno 160mm', 'Cadena Bicicleta 10v',
  'Cubierta Bicicleta 700x25', 'Multiherramienta Bicicleta 15 Funciones', 'Inflador De Pie Bicicleta',
  'Lentes Bicicleta Deportivos', 'Soporte Ciclocomputador Universal', 'Caja Pedalera Bicicleta',
  'Remera Ciclismo Negro M', 'Cambio Trasero Shimano', 'Asiento Bicicleta Confort',
  'Botella Bicicleta 750ml', 'Luz Trasera Bicicleta Led', 'Candado Bicicleta Cadena',
  // Hallazgo 🔵 del revisor: con solo 24 distractores el recall quedaba clavado en 100% (sin
  // margen para detectar una regresión seria). Estos "casi-hermanos" —misma familia de
  // producto/marca, modelo o velocidad distinta— generan competencia real dentro del
  // TOPE_CANDIDATOS, igual que en el corpus real de 3638 publicaciones sin SKU.
  'Cadena Shimano 11 Velocidades', 'Cadena Shimano 9 Velocidades Plateado', 'Cadena Shimano 8 Velocidades',
  'Cadena Shimano Hg53 10v 116 Links', 'Cadena Shimano Hg93 11v', 'Cadena Kmc X11 Silver Black',
  'Cadena Kmc X10 93 10v', 'Cadena Sram Pc-nx Eagle 11v Mtb', 'Cadena Sram Eagle 12v 126 Links',
  'Cambio Trasero Shimano Deore', 'Cambio Trasero Shimano Altus', 'Cambio Trasero Shimano Tiagra',
  'Cambio Trasero Shimano Altus M310 7v', 'Cambio Trasero Shimano Deore M6100', 'Cambio Trasero Shimano Xt',
  'Caja De Cambios Trasera Shimano Sora', 'Caja De Cambios Trasera Shimano 105',
  'Zapatillas Ciclismo Montaña Negro 38', 'Zapatillas Ciclismo Ruta Negro 42', 'Zapatillas Giro Rincon Negro 37',
  'Zapatillas Mtb Giro Riela Negro 38', 'Zapatillas De Ciclismo Shimano Rc102 Negro',
  'Zapatilla Ciclismo Montaña Giro Rincon Boa Negro', 'Zapatillas Ruta Shimano Rc300 Negro',
  'Disco De Freno Shimano 160mm', 'Disco De Freno Shimano 180mm', 'Disco De Rotor Shimano Deore 160mm',
  'Rotor Disco Freno Ezmtb 160mm', 'Disco De Freno Ezmtb 180mm 6 Tornillos',
  'Inflador De Pie Bicicleta Manómetro', 'Inflador De Pie Serfas Fp-20', 'Inflador De Pie Topeak',
  'Inflador De Pie Serfas Tier1 120psi', 'Multiherramienta Bicicleta 6 Funciones', 'Multiherramienta Bicicleta 11 Funciones',
  'Multiherramienta Bicicleta 18 Funciones Super B', 'Herramienta Bicicleta Merida 15 Funciones',
  'Casco Bicicleta Rudy Project Zumy Negro', 'Casco Bicicleta Rudy Project Egos', 'Casco Bell Draft Blanco M',
  'Casco Bell Draft Negro L', 'Lentes Bicicleta Poc Aspire', 'Lentes Bicicleta Poc Devour Hydrogen',
  'Lentes Shimano Pulsar 2', 'Lentes Oakley Radar', 'Asiento Bicicleta Fabric Scoop Shallow',
  'Asiento Bicicleta Fabric Line Elite', 'Asiento Bicicleta Selle San Marco', 'Caja Pedalera Shimano Press Fit Bb92',
  'Caja Pedalera Shimano Hollowtech Bsa', 'Soporte Ciclocomputador Garmin Universal', 'Soporte Ciclocomputador Wahoo Bolt',
  'Cubierta Vittoria Zaffiro 700x23c Negro', 'Cubierta Vittoria Zaffiro 700x28c Negro', 'Cubierta Goodyear Vector 4seasons 700x28',
  'Cubierta Maxxis Ikon 27.5x2.20 Alambre', 'Cubierta Chaoyang H419 700x28 Negro', 'Cubierta Chaoyang Victory 700x25',
  'Remera Oakley Graffiti 1975 Negro L', 'Remera Ciclismo Oakley Icon Negro', 'Brazalete Wahoo Tickr X',
  'Ciclocomputadora Wahoo Elemnt Bolt Gps', 'Ciclocomputadora Wahoo Elemnt Roam Gps', 'Potenciometro Xcadey Xpower Gen 3',
  'Medidor De Potencia Stages Shimano', 'Piñón Shimano Hg500 11-32t 9v', 'Piñón Shimano Hg500 11-34t 9v',
  // Adversarios deliberados: cuando el título ML VERDADERO trae varias palabras extra (marca de
  // catálogo, "bicicleta", "funciones", etc.) que el título WC no tiene, un distractor MÁS
  // parecido en longitud/estructura al WC —aunque no sea el producto real— puede pesar más en
  // tsr y ganarle el primer puesto. Esto es justo lo que hace que el recall top-3 del corpus
  // real (85%) sea menor a top-8 (89%): no es magia, es competencia legítima. Sin esto, el
  // recall de la muestra quedaba clavado en 100% (hallazgo 🔵 del revisor).
  'Multiherramienta 6 En 1 Super B Tb-9865', 'Disco De Freno Shimano Rt64 180mm',
  'Soporte Gps Frontal Delantero Igpsport M80', 'Cadena Shimano Hg40 8 Velocidades 116 Links',
  'Zapatillas Ciclismo Ruta Shimano Rc102 Blanco 41', 'Inflador De Pie Serfas Airforce Tier2 160psi',
];

// 39 pares reales (WC → ML), títulos tomados tal cual de la validación contra las filas de
// `data/fusion.sqlite`. Representan la mezcla real: casos triviales (título casi idéntico),
// casos con orden de palabras distinto, casos con abreviaturas/sufijos de marca ("- Fusion
// Bikes") que el título ML real siempre agrega — y, agregados tras el hallazgo del revisor
// (los 34 originales mencionan TODOS su propia marca en el título, así que nunca ejercitaban
// la rama nueva de la regla), 5 pares más:
//   - 2 donde el título ML OMITE la marca por completo (era la premisa entera del cambio: la
//     mitad del corpus real la omite). Chaoyang (cámara) e Igpsport (luz).
//   - 2 REALES (FB-16220/MLA737640957, FB-55035/MLA2790986970) donde el título ML escribe una
//     marca de DOS PALABRAS concatenada SIN espacio ("Buzzrack", "Selleitalia") — el caso
//     exacto del hallazgo 🔴 de auto-conflicto: el primer loop de marcaEnConflicto no la
//     reconoce como propia (tokens sueltos "buzz"/"rack" no aparecen), así que sin el fix de
//     otrasMarcasPosibles() la marca conflictúa CONSIGO MISMA.
//   - 1 con marca omitida y escritura distinta a la vez (Cateye/"Cat Eye", dos palabras sueltas
//     en el título en vez de la forma concatenada de catalogo_cache).
const PARES_REALES = [
  { wcNombre: 'Cubierta Chaoyang H419 700X25 Alambre', mlTitulo: 'Cubierta Para Bicicleta Chaoyang 700x25 Negro', marca: 'Chaoyang' },
  { wcNombre: 'Zapatillas Giro Riela Rii (Mujer) — Gris/Celeste / 37', mlTitulo: 'Zapatillas Mtb Giro Riela R Ii - Fusion Bikes Gris 37', marca: 'Giro' },
  { wcNombre: 'Piñon A Rosca Shimano Mf-Tz500 7V 14-28', mlTitulo: 'Piñón Shimano A Rosca Tz-500 14-28t 7v - Fusion Bikes Marrón Oscuro 14 28', marca: 'Shimano' },
  { wcNombre: 'Cambio Trasero Shimano Altus M310 7V 8V', mlTitulo: 'Cambio Bicicleta Shimano Altus M310 7v 8v Negro Medio', marca: 'Shimano' },
  { wcNombre: 'Cadena Kmc X10 Silver 10V Silver/Black 116 Links', mlTitulo: 'Cadena Bicicleta Kmc X10 10v Comp Shimano Sram Original Plateado/negro', marca: 'Kmc' },
  { wcNombre: 'Cadena Shimano Hg54 10V 116 Links', mlTitulo: 'Cadena Shimano 10 Velocidades Hg-54', marca: 'Shimano' },
  { wcNombre: 'Brazalete Wahoo Tickrfit', mlTitulo: 'Wahoo Brazalete Tickr Fit - Fusion Bikes Negro', marca: 'Wahoo' },
  { wcNombre: 'Cubierta Maxxis Ikon 29X2.20 Alambre', mlTitulo: 'Cubiertas Maxxis Ikon R29x2.20 Alambre - Mtb Frosted Black', marca: 'Maxxis' },
  { wcNombre: 'Casco Rudy Project Zumy — Rojo / S/M', mlTitulo: 'Casco Bicicleta Rudy Project Zumy', marca: 'Rudy Project' },
  { wcNombre: 'Cambio Trasero Shimano Deore M6100 12V', mlTitulo: 'Cambio Trasero Shimano Deore M6100 12v', marca: 'Shimano' },
  { wcNombre: 'Lentes Shimano Pulsar (Plsr1)', mlTitulo: 'Lentes Shimano Pulsar (plsr1)', marca: 'Shimano' },
  { wcNombre: 'Cadena SRAM NX Eagle 12v 126L', mlTitulo: 'Cadena Sram Pc-nx Eagle 12v Mtb 126 Links', marca: 'Sram' },
  { wcNombre: 'Asiento Fabric Scoop Radius — Negro / 142mm', mlTitulo: 'Asiento Bicicleta Fabric Scoop Elite Radius Cro-mo', marca: 'Fabric' },
  { wcNombre: 'Remera Oakley Graffiti 1975 — Verde / S', mlTitulo: 'Remera Oakley Graffiti 1975', marca: 'Oakley' },
  { wcNombre: 'Cadena Shimano Hg40 6V 7V 8V 116 Links', mlTitulo: 'Cadena Shimano Hg 40 8 Velocidades Plateado', marca: 'Shimano' },
  { wcNombre: 'Lentes Poc Devour — Transparent Crystal/Clarity MTB Silver Mirror Cat 2', mlTitulo: 'Lentes Poc Devour - Fusion Bikes', marca: 'Poc' },
  { wcNombre: 'Multi Herramienta 6 En 1 - Super B Tb-9865', mlTitulo: 'Multiherramienta Bicicleta 6 Funciones Super B Tb-9865 Llaves Hexagonales', marca: 'Super B' },
  { wcNombre: 'Inflador Serfas Airforce Tier2 160Psi De Pie', mlTitulo: 'Inflador De Pie Serfas Bicicleta Air Force Tier 2 Con Manómetro Metal Negro', marca: 'Serfas' },
  { wcNombre: 'Caja Pedalera Shimano Bb-Rs500-Pb Pressfit', mlTitulo: 'Bottom Bracket Shimano Bb-rs500-pb Press Fit', marca: 'Shimano' },
  { wcNombre: 'Cambio Trasero Shimano Tiagra 10V Rd-4700-Ss', mlTitulo: 'Caja De Cambios Trasera Shimano Tiagra Rd-4700-ss 10 V Cage', marca: 'Shimano' },
  { wcNombre: 'Multiherramienta Merida 11 En 1 Black/Grey', mlTitulo: 'Herramienta Bicicleta Merida Multi Tool 11 Funciones Negro', marca: 'Merida' },
  { wcNombre: 'Disco De Freno Shimano Rt64 180Mm', mlTitulo: 'Disco De Rotor Interno Shimano Deore Sm-rt64 De 180 Mm Con Bloqueo Central, Color Plateado', marca: 'Shimano' },
  { wcNombre: 'Soporte Para Gps Frontal Delantero Igpsport M80', mlTitulo: 'Soporte Ciclocomputador Igpsport M80 Negro Garmin Bryton', marca: 'Igpsport' },
  { wcNombre: 'Disco de Freno 2 Piezas Ezmtb (1002) 160Mm 6 Tornillos Incluidos En Caja - 106G', mlTitulo: 'Rotor Disco Freno Bici Ezmtb 160mm 6 Tornillos 106gr Color Plateado', marca: 'Ezmtb' },
  { wcNombre: 'Zapatillas Giro Rincon W (Mujer) — Negro / 36', mlTitulo: 'Zapatilla Ciclismo Montaña Giro Rincon W Boa - Fusion Bikes Negro 36 Eu', marca: 'Giro' },
  { wcNombre: 'Cubierta GoodYear Vector 4 SEASONS 700X25 Negra - 60 TPI', mlTitulo: 'Goodyear Vector 4seasons Tubetype', marca: 'GoodYear' },
  { wcNombre: 'Ciclocomputadora Wahoo Elemnt ACE GPS', mlTitulo: 'Elemnt Ace Cycling Computer Wahoo Elemnt Ace Gps Color Negro', marca: 'Wahoo' },
  { wcNombre: 'Potenciometro Xcadey Spider BCD104 p/Shimano Direct Mount', mlTitulo: 'Medidor De Potencia Xcadey Xpower-s Gen 2 Shimano Dm 104bcd Shimano', marca: 'Xcadey' },
  { wcNombre: 'Inflador Serfas Fp-10 160Psi', mlTitulo: 'Inflador De Pie Serfas Fp-10 Manómetro Válvulas Presta Schrader 160 Psi Negro', marca: 'Serfas' },
  { wcNombre: 'Zapatillas Shimano RC102 — 41 / Blanco', mlTitulo: 'Zapatillas De Ciclismo De Ruta Shimano Rc102 - Fusion Bikes Negro Lisa 46 Eu', marca: 'Shimano' },
  { wcNombre: 'Casco Bell Negro', mlTitulo: 'Casco Bell Negro', marca: 'Bell' },
  { wcNombre: 'Calas / Trabas Shimano Sm-Sh12 Ruta', mlTitulo: 'Calas / Trabas Shimano Sm-sh12 Ruta', marca: 'Shimano' },
  { wcNombre: 'Plato Palanca Shimano Ty301 6V 7V 8V 42-34-24T', mlTitulo: 'Plato Palanca Shimano Ty301 6v 7v 8v 42-34-24t 175mm', marca: 'Shimano' },
  { wcNombre: 'Pedales Shimano M520 Spd Mtb', mlTitulo: 'Pedales Shimano Spd Mtb Modelo M520', marca: 'Shimano' },
  // --- Agregados tras el hallazgo del revisor (ver comentario arriba) ---
  { wcNombre: 'Cámara Chaoyang R29 Válvula De Auto', mlTitulo: 'Cámara Bicicleta Rodado 29 Válvula De Auto Schrader', marca: 'Chaoyang', mlClave: 'MLA906649043|' },
  { wcNombre: 'Luz Led Trasera Smart Igpsport Tl50 50 Lumens', mlTitulo: 'Luz Trasera Inteligente Ultraligera Tl50 Color Negro', marca: 'IGPSPORT', mlClave: 'MLA3223352630|' },
  { wcNombre: 'Ciclo Computadora Cateye Padrone Digital + Sensor Cad/Vel', mlTitulo: 'Velocímetro Inalámbrico Cat Eye Padrone Digital Pantalla Grande Negro', marca: 'Cateye', mlClave: 'MLA1592168534|' },
  { wcNombre: 'Portabicicletas Buzzrack Mozzquito - Para 3 Bicicletas', mlTitulo: 'Porta Bicicletas Buzzrack Para 3 Bicis Envio Gratis.', marca: 'Buzz Rack', mlClave: 'MLA737640957|' },
  { wcNombre: 'Asiento Selle Italia NOVUS BOOST EVO Endurance TM SuperFlow L3', mlTitulo: 'Sillín Selleitalia Novus Evo Boost Endurance L3 Mng Ancho 145mm Color Negro Largo 245mm 24.5 Cm 14.5 Cm', marca: 'Selle Italia', mlClave: 'MLA2790986970|' },
];

// PRNG determinista (mulberry32): genera distractores sintéticos recombinando el vocabulario
// REAL de la propia muestra (palabras que ya aparecen en PARES_REALES), en vez de inventar
// títulos a mano. Hallazgo 🔵 del revisor: con distractores curados a mano el recall quedaba
// clavado en 100% — el candidato verdadero siempre ganaba por overlap de tokens, sin
// competencia real. Recombinar el vocabulario real SÍ genera colisiones legítimas (dos
// distractores que comparten "cadena shimano 10 velocidades" con el título verdadero, por
// ejemplo), que es justo el tipo de ruido que hay en el corpus real de 3638 publicaciones sin
// SKU. Semilla fija = mismo resultado en cada corrida, sin flakiness.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generarDistractoresSinteticos(pares, cantidad, seed = 42) {
  const rand = mulberry32(seed);
  const vocabulario = [...new Set(
    pares.flatMap((p) => `${p.wcNombre} ${p.mlTitulo}`.split(/[\s/—-]+/).map((w) => w.trim()).filter((w) => w.length > 1))
  )];
  const pick = () => vocabulario[Math.floor(rand() * vocabulario.length)];
  const out = [];
  for (let i = 0; i < cantidad; i++) {
    const nPalabras = 3 + Math.floor(rand() * 3); // 3 a 5 palabras, como un título real
    const palabras = Array.from({ length: nPalabras }, pick);
    out.push(palabras.join(' '));
  }
  return out;
}

describe('matcherEngine · validación reproducible (muestra embebida, sin depender de data/fusion.sqlite)', () => {
  it('recall top-3 sobre la muestra de 39 pares reales no baja de un piso razonable, y el recall NO está saturado en 100%', () => {
    const distractoresReforzados = [...DISTRACTORES, ...generarDistractoresSinteticos(PARES_REALES, 40)];
    const { total, recall, top1AltaPct, conflictosMarcaParVerdadero } = calcularCurvaRecall(PARES_REALES, distractoresReforzados);
    console.log('[validación matcher inverso] total=%d distractores=%d recall=%o top1Alta=%s%% conflictosMarcaParVerdadero=%d', total, distractoresReforzados.length, recall, top1AltaPct, conflictosMarcaParVerdadero);
    expect(total).toBe(39);
    // Piso conservador: la muestra es más chica que el corpus completo (2643 pares), así que
    // el número exacto fluctúa; lo que este test protege es que una regresión del motor no
    // hunda el recall en silencio, no reproducir el decimal exacto del corpus completo.
    expect(recall[3]).toBeGreaterThanOrEqual(60);
    expect(recall[8]).toBeGreaterThanOrEqual(recall[3]); // monotonía: más candidatos, nunca peor
    // Guardia real (antes esto no se afirmaba: con 24 distractores curados a mano el recall
    // quedaba clavado en 100%, con 40 puntos de colchón antes de que la aserción de arriba
    // detectara algo). Con los distractores sintéticos reforzados, el top-1 debe mostrar
    // fricción real (no ser un 100% artificial) para que el test discrimine de verdad.
    expect(recall[1]).toBeLessThan(100);
    // top1AltaPct es la métrica que SÍ se movió con el cambio de regla de contradicción
    // (33.9% → 23.4% en el corpus completo tras cerrar el agujero del hallazgo 🔴, y volvió a
    // subir tras la stoplist de relleno + normalización de género/plural de este hallazgo).
    // Banda amplia a propósito: agarra tanto "la regla se aflojó de nuevo" (top demasiado
    // alto) como "quedó tan dura que casi nadie llega a alta" (top demasiado bajo), sin fijar
    // un número exacto que dependa de detalles finos de la muestra sintética.
    expect(top1AltaPct).toBeGreaterThanOrEqual(10);
    expect(top1AltaPct).toBeLessThanOrEqual(45);
    // Guardia de regresión del hallazgo de marca (🔴 del revisor): de los 39 pares, 34 mencionan
    // su propia marca literal en el título ML y 5 no (2 la OMITEN por completo, 2 la escriben
    // CONCATENADA sin espacio — Buzz Rack/Selle Italia, el caso exacto del auto-conflicto — y 1
    // combina omisión con escritura distinta). Ninguno de los 39 debería quedar marcado como
    // conflicto de marca consigo mismo. A diferencia de la versión anterior (34 pares, todos con
    // la marca presente), este número SÍ ejercita la rama nueva: revertir a la regla vieja
    // completa (ausencia sola = conflicto, sin el requisito de "otra marca") pone esto en rojo.
    expect(conflictosMarcaParVerdadero).toBe(0);
  });
});

describe.skip('matcherEngine · validación COMPLETA contra los pares reales (requiere data/fusion.sqlite, correr a mano en el VPS)', () => {
  // Este bloque documenta —no ejecuta en CI, porque data/fusion.sqlite no existe en el repo ni
  // en los worktrees (regla del proyecto: no tocar data/)— el procedimiento exacto para volver
  // a sacar el número completo (recall top-1..top-8, y el conteo de conflicto de marca) sobre
  // TODOS los pares SKU↔publicación reales. Para correrlo: sacar el `.skip` de este describe y
  // ejecutar contra un entorno con acceso de LECTURA a data/fusion.sqlite (nunca escritura).
  //
  // marcasConocidas se arma con la MISMA query que lib/coberturaCola.js#construirIndiceMlSinSku
  // en producción — si esa query cambia ahí, hay que reflejarlo acá para que el número siga
  // siendo comparable. Sin esto (hallazgo 🔴 del revisor, agujero reabierto una vez ya): el
  // bloque corría por la rama fail-open de marcaEnConflicto, conflicto_marca daba siempre
  // false, y el número reportado no medía nada de este cambio.
  //
  // Última corrida (2026-08-13, contra 2643 pares reales, revisada por el revisor): recall
  // 75.1/83.5/86.3/89.4/90.2 (top-1..top-8), top1Alta 24.2%. Conflicto de marca en el par
  // verdadero: 4 publicaciones, 4 SKU distintos — los dos casos documentados como limitación
  // conocida en marcaEnConflicto: KAWI FB-5936/FB-5937 (compatibilidad "p/Shimano o Tektro",
  // "Compatible con Sram") y Truvativ FB-19140 / Trek FB-63433 (marca madre, Truvativ es de
  // Sram y Bontrager es de Trek). Este párrafo es solo un ancla histórica de la última vez que
  // se corrió — desactualizate solo, no lo repitas en otro archivo; volvé a correr esto para el
  // número vigente.
  it('procedimiento', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database('/opt/fusionbikes/herramientas/data/fusion.sqlite', { readonly: true });

    // Las publicaciones YA vinculadas: son los pares verdaderos contra los que se valida.
    const conSku = db.prepare(
      "SELECT clave,item_id,titulo,seller_sku,color,talle FROM ml_publicaciones_cache WHERE seller_sku IS NOT NULL AND seller_sku != ''"
    ).all();
    // El universo real de publicaciones sin vincular (los "distractores" reales, no la muestra
    // sintética de este archivo).
    const sinSku = db.prepare(
      "SELECT clave,item_id,titulo,color,talle,thumbnail,precio,available_quantity,status FROM ml_publicaciones_cache WHERE seller_sku IS NULL OR seller_sku = ''"
    ).all();
    const cat = db.prepare('SELECT id_woo,nombre,sku,tipo,atributos_json,marca FROM catalogo_cache').all();
    // Misma query que construirIndiceMlSinSku en producción.
    const marcasRows = db.prepare(
      "SELECT DISTINCT marca FROM catalogo_cache WHERE marca IS NOT NULL AND marca != ''"
    ).all().map((r) => r.marca);
    const marcasConocidas = normalizarMarcas(marcasRows);

    const { wcItems, wcPorSku } = construirWC(cat);
    const catBySku = {}; for (const c of cat) catBySku[c.sku] = c;

    const cortes = [1, 2, 3, 5, 8];
    const hits = Object.fromEntries(cortes.map((k) => [k, 0]));
    let total = 0, top1Alta = 0;
    // Conflicto de marca medido sobre el PAR VERDADERO (no el top-1 del ranking): cuántas
    // publicaciones quedan con conflicto_marca=true contra su propio SKU vinculado. Se
    // deduplica por SKU aparte porque el patrón 1 SKU → N publicaciones es intencional en este
    // catálogo (ver docs/superpowers/plans o memoria del proyecto) — reportar solo el número de
    // publicaciones sobrestima cuántos PRODUCTOS distintos están afectados.
    const skusConConflicto = new Set();
    let conflictosMarcaPublicacion = 0;
    for (const pub of conSku) {
      const wc = wcPorSku[pub.seller_sku];
      if (!wc) continue; // SKU ya no vigente en el catálogo actual: no es un caso válido
      total++;
      // Simula que ESTA publicación no tuviera seller_sku, agregándola al universo real.
      const mlIndex = construirML([...sinSku, { ...pub, seller_sku: undefined }]);
      mlIndex.marcasConocidas = marcasConocidas;
      const marcaWc = (catBySku[pub.seller_sku] || {}).marca || '';
      const cands = candidatosDeWC(wc, mlIndex, marcaWc);
      const idx = cands.findIndex((c) => c.ml_clave === pub.clave);
      for (const k of cortes) if (idx >= 0 && idx < k) hits[k]++;
      if (idx === 0 && cands[0].confianza === 'alta') top1Alta++;
      const candVerdadero = cands.find((c) => c.ml_clave === pub.clave);
      if (candVerdadero && candVerdadero.diff.conflicto_marca) {
        conflictosMarcaPublicacion++;
        skusConConflicto.add(pub.seller_sku);
      }
    }
    console.log('total', total, 'recall', Object.fromEntries(cortes.map((k) => [k, (100 * hits[k] / total).toFixed(1) + '%'])), 'top1Alta', (100 * top1Alta / total).toFixed(1) + '%');
    console.log('conflicto_marca en el par verdadero: publicaciones=', conflictosMarcaPublicacion, 'productos (SKU) distintos=', skusConConflicto.size);
    db.close();
  });
});
