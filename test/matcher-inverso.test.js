import { describe, it, expect } from 'vitest';
import {
  construirWC, construirML, candidatosDeWC, candidatosParaWC, diffTokens,
  esDiscriminante, esCodigoAlfanumerico, esMedidaNumerica, esTokenRaro, confianzaDesdeScore,
  colorCanonico, medidaCanonica, canonToken, marcaEnConflicto, normalizarMarcas, otrasMarcasPosibles, toks, ratio,
} from '../lib/matcherEngine.js';

// Helper: arma el ítem WC (vía construirWC, igual que el resto del motor) y el universo ML
// (vía construirML) para un solo par a comparar. mlExtra son publicaciones de "relleno" que
// simulan el resto del corpus sin SKU, para que la señal de rareza (regla 3) tenga sentido.
// marcasConocidas (si se pasa) se cuelga de mlIndex — candidatosDeWC ya no la recibe como
// parámetro aparte (hallazgo del revisor: reenviarla a mano por niveles se olvida en silencio).
function armar(wcNombre, mlTitulo, mlExtra = [], marcaWc = '', marcasConocidas) {
  const { wcItems } = construirWC([{ sku: 'X', nombre: wcNombre, tipo: 'simple' }]);
  const mlIndex = construirML([{ clave: 'A|', item_id: 'A', titulo: mlTitulo }, ...mlExtra]);
  if (marcasConocidas) mlIndex.marcasConocidas = marcasConocidas;
  return { wc: wcItems[0], mlIndex, top: candidatosDeWC(wcItems[0], mlIndex, marcaWc)[0] };
}

describe('matcherEngine · tokens discriminantes', () => {
  it('esCodigoAlfanumerico detecta mezcla letra+dígito (m520, hg500, sx10)', () => {
    expect(esCodigoAlfanumerico('m520')).toBe(true);
    expect(esCodigoAlfanumerico('hg500')).toBe(true);
    expect(esCodigoAlfanumerico('pedales')).toBe(false); // solo letras
    expect(esCodigoAlfanumerico('116')).toBe(false); // solo dígitos, lo cubre la otra regla
  });

  it('esMedidaNumerica exige 2+ dígitos; un solo dígito no discrimina por esta regla', () => {
    expect(esMedidaNumerica('116')).toBe(true);
    expect(esMedidaNumerica('25')).toBe(true);
    expect(esMedidaNumerica('9')).toBe(false);
  });

  it('esTokenRaro marca como raro un token con pocas apariciones relativas al corpus', () => {
    const df = { kevlar: 1, pedales: 500 };
    expect(esTokenRaro('kevlar', df, 1000)).toBe(true); // 0.1% del corpus
    expect(esTokenRaro('pedales', df, 1000)).toBe(false); // 50% del corpus
  });

  it('esDiscriminante descarta tokens de un solo carácter', () => {
    expect(esDiscriminante('m', {}, 100)).toBe(false);
    expect(esDiscriminante('a', {}, 100)).toBe(false);
  });
});

describe('matcherEngine · hallazgo del revisor: título ML subconjunto del de WC (agujero cerrado)', () => {
  // El caso que se había colado: cuando el título ML es un subconjunto exacto del de WC,
  // tsr da 1.0 SIEMPRE, sin importar qué le falte a ML. Si a ML le falta justo el código de
  // modelo que WC sí trae ("m520"), antes esto pasaba como 'alta' porque la regla vieja exigía
  // que AMBOS lados tuvieran su propio discriminante en conflicto — acá solo WC lo tiene
  // (discMl queda vacío, ML no aporta nada "propio", solo le falta algo). Eso es exactamente
  // el escenario de riesgo real: "Pedales Shimano SPD" (genérico) resulta ser el M540, no el
  // M520, y el usuario lo confirma de un toque porque el badge daba verde.
  it('WC "Pedales Shimano M520 Spd Mtb" vs ML "Pedales Shimano Spd Mtb" (subconjunto, score=1) → nunca alta', () => {
    const { wc, mlIndex, top } = armar('Pedales Shimano M520 Spd Mtb', 'Pedales Shimano Spd Mtb');
    expect(top.score).toBe(1); // confirma que el score solo no distingue nada acá
    expect(top.diff.solo_wc).toEqual(['m520']);
    expect(top.diff.solo_ml).toEqual([]); // ML no aporta ningún token propio: es subconjunto puro
    expect(top.diff.hay_contradiccion).toBe(true);
    expect(top.confianza).not.toBe('alta');
    expect(top.confianza).toBe('revisar'); // topea en 'revisar' como mínimo, no cae a 'baja'
  });

  it('WC "Cubierta Maxxis Ikon 29x2.20 Alambre" vs ML "Cubierta Maxxis Ikon 29x2.20" → nunca alta', () => {
    const { top } = armar('Cubierta Maxxis Ikon 29x2.20 Alambre', 'Cubierta Maxxis Ikon 29x2.20');
    expect(top.diff.solo_ml).toEqual([]);
    expect(top.confianza).not.toBe('alta');
  });

  it('WC "Cadena Shimano Hg53 11 Velocidades" vs ML "Cadena Shimano 11 Velocidades" → nunca alta', () => {
    const { top } = armar('Cadena Shimano Hg53 11 Velocidades', 'Cadena Shimano 11 Velocidades');
    expect(top.diff.solo_ml).toEqual([]);
    expect(top.confianza).not.toBe('alta');
  });

  it('la asimetría inversa sigue siendo inocua: dato de más SOLO del lado ML no tumba la confianza', () => {
    // Caso real ya cubierto en el positivo "Plato Palanca..." de abajo, repetido acá en
    // aislado para dejar explícito qué NO se rompió al cerrar el agujero.
    const { top } = armar('Cadena Shimano 11 Velocidades', 'Cadena Shimano Hg53 11 Velocidades');
    expect(top.diff.solo_wc).toEqual([]); // WC no declara nada propio: nada que ML contradiga
    expect(top.diff.hay_contradiccion).toBe(false);
    expect(top.confianza).toBe('alta');
  });
});

describe('matcherEngine · los 4 casos obligatorios (datos reales) NUNCA dan confianza alta', () => {
  it('Maxxis Ikon 29x2.20 Alambre vs Kevlar → material en conflicto, no alta', () => {
    const { top } = armar('Maxxis Ikon 29x2.20 Alambre', 'Maxxis Ikon R-29x2.20 Kevlar');
    expect(top.confianza).not.toBe('alta');
    expect(top.diff.hay_contradiccion).toBe(true);
    expect(top.diff.discriminantes_conflicto).toEqual(expect.arrayContaining(['alambre', 'kevlar']));
  });

  it('Pedales Shimano M520 vs M540 → código de modelo en conflicto, no alta', () => {
    const { top } = armar('Pedales Shimano M520', 'Pedales Shimano M540');
    expect(top.confianza).not.toBe('alta');
    expect(top.diff.discriminantes_conflicto).toEqual(expect.arrayContaining(['m520', 'm540']));
    // Mutation-testing manual: si se sacara m520/m540 de discriminantes, este caso pasaría a
    // 'alta' porque el score de bolsa de palabras es altísimo (comparten "pedales shimano").
    expect(top.score).toBeGreaterThan(0.8); // confirma que el score SOLO no alcanzaría para filtrar
  });

  it('Piñón Shimano Hg500 11-25T vs Hg50 11-36t → modelo Y medida en conflicto, no alta', () => {
    const { top } = armar('Piñón Shimano Hg500 11-25T', 'Piñón Shimano Hg50 11-36t');
    expect(top.confianza).not.toBe('alta');
    expect(top.diff.discriminantes_conflicto).toEqual(expect.arrayContaining(['hg500', 'hg50', '25t', '36t']));
  });

  it('Cadena Shimano Hg53 vs Sumc Sx10 → hasta la marca difiere, no alta', () => {
    const { top } = armar('Cadena Shimano Hg53', 'Cadena Sumc Sx10');
    expect(top.confianza).not.toBe('alta');
    expect(top.diff.discriminantes_conflicto.length).toBeGreaterThan(0);
  });
});

describe('matcherEngine · casos positivos (mismo producto, tiene que poder dar alta)', () => {
  it('título casi idéntico sin tokens discriminantes en conflicto → alta', () => {
    const { top } = armar(
      'Calas / Trabas Shimano Sm-Sh12 Ruta',
      'Calas / Trabas Shimano Sm-sh12 Ruta',
    );
    expect(top.confianza).toBe('alta');
    expect(top.diff.hay_contradiccion).toBe(false);
  });

  it('caso real: Plato Palanca Shimano Ty301 con medidas idénticas → alta', () => {
    const { top } = armar(
      'Plato Palanca Shimano Ty301 6V 7V 8V 42-34-24T',
      'Plato Palanca Shimano Ty301 6v 7v 8v 42-34-24t 175mm',
    );
    // "175mm" queda solo del lado ML pero es información extra (medida de biela), no un
    // conflicto: no hay ningún token discriminante que aparezca CONTRADICHO del otro lado.
    expect(top.confianza).toBe('alta');
  });

  it('un motor que rechaza todo es tan inútil como uno que acepta todo: debe existir al menos un caso alta', () => {
    const pares = [
      ['Cadena Kmc X11 Silver 11V Silver/Black', 'Cadena Kmc X11 Silver Black 11v Missing Link Shimano Sram'],
      ['Caja Pedalera Shimano Xtr Bb94-41A 89,5/92Mm', 'Caja Pedalera Shimano Xtr Bb94-41a Press-fit 89,5-92mm'],
    ];
    const algunaAlta = pares.some(([a, b]) => armar(a, b).top.confianza === 'alta');
    expect(algunaAlta).toBe(true);
  });
});

describe('matcherEngine · diffTokens, requisito de contrato (no solo un score)', () => {
  it('devuelve coincide/solo_wc/solo_ml/discriminantes_conflicto como listas, no un número', () => {
    const d = diffTokens(toks('pedales shimano m520'), toks('pedales shimano m540'), { pedales: 10, shimano: 10 }, 100);
    expect(d.coincide).toEqual(['pedales', 'shimano']);
    expect(d.solo_wc).toEqual(['m520']);
    expect(d.solo_ml).toEqual(['m540']);
    expect(d.discriminantes_conflicto).toContain('m520');
    expect(d.discriminantes_conflicto).toContain('m540');
    expect(d.hay_contradiccion).toBe(true);
  });

  it('conflicto de marca estructurada (catalogo_cache.marca): el título ML nombra OTRA marca conocida', () => {
    // "shimano" es muy común (no cae por rareza); el conflicto acá no viene de rareza sino de
    // que el título ML nombra explícitamente otra marca del catálogo ("sram").
    const marcas = normalizarMarcas(['Shimano', 'Sram']);
    const d = diffTokens(toks('cadena shimano'), toks('cadena sram'), { cadena: 100, shimano: 80, sram: 80 }, 200, 'Shimano', otrasMarcasPosibles('Shimano', marcas));
    expect(d.discriminantes_conflicto).toContain('shimano');
    expect(d.hay_contradiccion).toBe(true);
  });

  it('sin conflicto de marca cuando la marca de WC sí aparece en el título ML', () => {
    const d = diffTokens(toks('cadena shimano hg53'), toks('cadena shimano hg53'), {}, 10, 'Shimano');
    expect(d.hay_contradiccion).toBe(false);
  });

  it('sin conflicto de marca cuando el título ML simplemente OMITE la marca (no nombra otra)', () => {
    // El defecto que esto corrige: la mitad de los títulos de ML no mencionan la marca. Antes
    // eso solo ya era "conflicto"; ahora hace falta que ML nombre otra marca conocida. (El "r29"
    // de WC sigue siendo un discriminante propio aparte —no relacionado a marca— así que acá se
    // valida puntualmente conflicto_marca, no hay_contradiccion en general.)
    const marcas = normalizarMarcas(['Chaoyang', 'Maxxis', 'Vittoria']);
    const d = diffTokens(toks('camara chaoyang valvula de auto'), toks('camara bicicleta rodado 29 valvula de auto'), { camara: 5, chaoyang: 5, valvula: 5, de: 5, auto: 5, bicicleta: 5, rodado: 5, 29: 5 }, 10, 'Chaoyang', otrasMarcasPosibles('Chaoyang', marcas));
    expect(d.conflicto_marca).toBe(false);
    expect(d.hay_contradiccion).toBe(false);
  });
});

describe('matcherEngine · confianzaDesdeScore', () => {
  it('nunca da alta con contradicción, sin importar cuán alto sea el score', () => {
    expect(confianzaDesdeScore(0.99, true)).not.toBe('alta');
    expect(confianzaDesdeScore(1, true)).not.toBe('alta');
  });

  it('sin contradicción, respeta los umbrales por score', () => {
    expect(confianzaDesdeScore(0.9, false)).toBe('alta');
    expect(confianzaDesdeScore(0.6, false)).toBe('revisar');
    expect(confianzaDesdeScore(0.2, false)).toBe('baja');
  });
});

describe('matcherEngine · candidatosParaWC (piso razonable / sin_candidato)', () => {
  it('sin_candidato=true cuando el mejor candidato es baja confianza', () => {
    const { wcItems } = construirWC([{ sku: 'X', nombre: 'Producto Totalmente Inventado Zzz', tipo: 'simple' }]);
    const mlIndex = construirML([{ clave: 'A|', item_id: 'A', titulo: 'Otra Cosa Sin Relación Alguna' }]);
    const { sin_candidato } = candidatosParaWC(wcItems[0], mlIndex, '');
    expect(sin_candidato).toBe(true);
  });

  it('sin_candidato=false cuando hay al menos un candidato revisar o alta', () => {
    const { wcItems } = construirWC([{ sku: 'X', nombre: 'Pedales Shimano M520', tipo: 'simple' }]);
    const mlIndex = construirML([{ clave: 'A|', item_id: 'A', titulo: 'Pedales Shimano M520' }]);
    const { sin_candidato, candidatos } = candidatosParaWC(wcItems[0], mlIndex, '');
    expect(sin_candidato).toBe(false);
    expect(candidatos[0].confianza).toBe('alta');
  });

  it('universo ML vacío no revienta: sin_candidato=true y candidatos=[]', () => {
    const { wcItems } = construirWC([{ sku: 'X', nombre: 'Cualquier Cosa', tipo: 'simple' }]);
    const mlIndex = construirML([]);
    const { sin_candidato, candidatos } = candidatosParaWC(wcItems[0], mlIndex, '');
    expect(sin_candidato).toBe(true);
    expect(candidatos).toEqual([]);
  });
});

describe('matcherEngine · desempate por color/talle estructurado entre hermanos (variaciones)', () => {
  // Caso real (calibrado contra los 3184 pares): cuando el título base es idéntico entre
  // variantes de talle/color de un mismo producto padre, tsr da 1 para TODOS los hermanos y
  // el orden queda arbitrario. El color/talle estructurado (columnas de ml_publicaciones_cache,
  // no texto libre) desempata sin tocar score/confianza.
  it('con títulos base empatados, prioriza el hermano cuyo color coincide', () => {
    const { wcItems } = construirWC([
      { sku: 'X', nombre: 'Remera Oakley Graffiti 1975 — Verde / S', tipo: 'variation' },
    ]);
    const mlIndex = construirML([
      { clave: 'A|1', item_id: 'A', variation_id: '1', titulo: 'Remera Oakley Graffiti 1975', color: 'Blanco', talle: 'S' },
      { clave: 'A|2', item_id: 'A', variation_id: '2', titulo: 'Remera Oakley Graffiti 1975', color: 'Verde', talle: 'S' },
      { clave: 'A|3', item_id: 'A', variation_id: '3', titulo: 'Remera Oakley Graffiti 1975', color: 'Negro', talle: 'M' },
    ]);
    const cands = candidatosDeWC(wcItems[0], mlIndex, '');
    // Los tres hermanos comparten score/confianza (título idéntico) — el color correcto va primero.
    expect(cands[0].ml_clave).toBe('A|2');
    expect(cands.every((c) => c.score === 1)).toBe(true); // confirma que sin el desempate, empatan
  });

  it('el desempate no agrega el campo interno attrBonus al contrato de salida', () => {
    const { wcItems } = construirWC([{ sku: 'X', nombre: 'Casco Bell Negro', tipo: 'simple' }]);
    const mlIndex = construirML([{ clave: 'A|', item_id: 'A', titulo: 'Casco Bell Negro' }]);
    const cands = candidatosDeWC(wcItems[0], mlIndex, '');
    expect(cands[0]).not.toHaveProperty('attrBonus');
  });

  it('el desempate NO ablanda los 4 casos negativos: sigue sin dar alta aunque el color coincida', () => {
    const { wcItems } = construirWC([{ sku: 'X', nombre: 'Pedales Shimano M520 Negro', tipo: 'simple' }]);
    const mlIndex = construirML([{ clave: 'A|', item_id: 'A', titulo: 'Pedales Shimano M540', color: 'Negro' }]);
    const cands = candidatosDeWC(wcItems[0], mlIndex, '');
    expect(cands[0].confianza).not.toBe('alta'); // el conflicto m520/m540 sigue ganando
  });
});

describe('matcherEngine · hallazgo del revisor: relleno y variantes morfológicas (no son especificación)', () => {
  it('"talle" no arrastra a revisar un match con score 1.0 (RELLENO, no discriminante)', () => {
    const { top } = armar('Casco Bell Draft Negro Talle M', 'Casco Bell Draft Negro M');
    expect(top.score).toBe(1);
    expect(top.diff.solo_wc).toEqual(['talle']); // sigue apareciendo en el diff para mostrar...
    expect(top.diff.discriminantes_conflicto).toEqual([]); // ...pero no como discriminante
    expect(top.diff.hay_contradiccion).toBe(false);
    expect(top.confianza).toBe('alta');
  });

  it('género/plural de color ("negra" vs "negro") no es contradicción', () => {
    const { top } = armar('Cubierta Vittoria Zaffiro Negra', 'Cubierta Vittoria Zaffiro Negro');
    expect(top.diff.hay_contradiccion).toBe(false);
    expect(top.confianza).toBe('alta');
  });

  it('sufijo de una letra en medida ("700x25c" vs "700x25") no es contradicción', () => {
    const { top } = armar('Cubierta Vittoria Zaffiro 700x25 Negra', 'Cubierta Vittoria Zaffiro 700x25c Negro');
    expect(top.diff.hay_contradiccion).toBe(false);
    expect(top.confianza).toBe('alta');
  });

  it('canonToken: colorCanonico cubre singular/plural y ambos géneros', () => {
    expect(colorCanonico('negra')).toBe('negro');
    expect(colorCanonico('negras')).toBe('negro');
    expect(colorCanonico('negros')).toBe('negro');
    expect(colorCanonico('verdes')).toBe('verde');
    expect(colorCanonico('negro')).toBe('negro'); // ya canónico
    expect(colorCanonico('shimano')).toBeNull(); // no es color: no inventa nada
  });

  it('canonToken: medidaCanonica solo pela UNA letra de sufijo sobre patrón NxM', () => {
    expect(medidaCanonica('700x25c')).toBe('700x25');
    expect(medidaCanonica('700x25')).toBeNull(); // ya sin sufijo, no aplica
    expect(medidaCanonica('m520')).toBeNull(); // no es un patrón NxM, no lo toca
  });

  it('la stoplist de relleno NO ablanda los 4 casos negativos obligatorios', () => {
    // "modelo" está en RELLENO; confirma que igual el conflicto real (m520/m540) prevalece.
    const { top } = armar('Pedales Shimano Modelo M520', 'Pedales Shimano Modelo M540');
    expect(top.confianza).not.toBe('alta');
  });
});

describe('matcherEngine · hallazgo de probador-e2e: conflicto de marca fuerza baja (no solo revisar)', () => {
  // Caso real sacado de la cola: "Jersey Elite KOKUEN" contra "Casco Giro Seyen Mips". Marca Y
  // categoría distintas, pero "Fusion Bikes" + "Talle S" compartidos alcanzaban para un score
  // 0.69 → 'revisar' → un solo click de confirmación, la misma fricción que un match legítimo.
  it('marca WC vs marca ML totalmente distinta (ML nombra la otra marca) → confianza SIEMPRE baja, aunque el score sea alto', () => {
    const marcas = normalizarMarcas(['Kokuen', 'Giro']);
    const { top } = armar('Jersey Elite KOKUEN Talle S - Fusion Bikes', 'Casco Giro Seyen Mips Talle S - Fusion Bikes', [], 'Kokuen', marcas);
    expect(top.score).toBeGreaterThan(0.5); // confirma que el score solo lo salvaría a 'revisar'
    expect(top.diff.conflicto_marca).toBe(true);
    expect(top.confianza).toBe('baja');
  });

  it('marcaEnConflicto: marca distinta y el título ML nombra OTRA marca conocida → true', () => {
    const marcas = normalizarMarcas(['Kokuen', 'Giro']);
    expect(marcaEnConflicto('Kokuen', toks('casco giro seyen mips'), otrasMarcasPosibles('Kokuen', marcas))).toBe(true);
  });

  it('marcaEnConflicto: marca ausente en WC → false SIEMPRE (nunca contradicción por ausencia)', () => {
    const marcas = normalizarMarcas(['Giro']);
    expect(marcaEnConflicto('', toks('casco giro seyen mips'), marcas)).toBe(false);
    expect(marcaEnConflicto(null, toks('casco giro seyen mips'), marcas)).toBe(false);
    expect(marcaEnConflicto(undefined, toks('casco giro seyen mips'), marcas)).toBe(false);
  });

  it('marcaEnConflicto: escritura distinta pero parecida ("Metha" vs "Mtha") → false, no es conflicto', () => {
    expect(marcaEnConflicto('Metha', toks('bicicleta mtha aro 29'))).toBe(false);
  });

  it('marcaEnConflicto: SIN marcasConocidas, marca ausente → false (fail-open: no hay forma de afirmar "otra marca")', () => {
    // Regresión directa del defecto en producción: antes, "no aparece" ya alcanzaba solo.
    expect(marcaEnConflicto('Kokuen', toks('casco giro seyen mips'))).toBe(false);
    expect(marcaEnConflicto('Kokuen', toks('casco giro seyen mips'), new Set())).toBe(false);
  });

  it('marcaEnConflicto: el título ML solo OMITE la marca (no nombra ninguna otra conocida) → false', () => {
    // Los dos casos reales del encargo: la mitad de los títulos de ML no mencionan la marca.
    const marcas = normalizarMarcas(['Chaoyang', 'Maxxis', 'Cateye', 'Giant']);
    expect(marcaEnConflicto('Chaoyang', toks('camara bicicleta rodado 29 valvula de auto'), otrasMarcasPosibles('Chaoyang', marcas))).toBe(false);
    expect(marcaEnConflicto('Cateye', toks('velocimetro inalambrico cat eye padrone'), otrasMarcasPosibles('Cateye', marcas))).toBe(false);
  });

  it('marca ausente en WC no fuerza baja: un match legítimo sin marca estructurada conserva su confianza real', () => {
    const { top } = armar('Cadena Shimano Hg54 10V 116 Links', 'Cadena Shimano 10 Velocidades Hg-54', [], '');
    expect(top.diff.conflicto_marca).toBe(false);
    expect(top.confianza).not.toBe('baja');
  });

  it('mutation testing: si se revierte a la regla vieja (ausencia sola = conflicto, ignorando marcasConocidas) este caso rompe', () => {
    // Ancla explícita contra volver a "no aparece" como criterio único: con marcasConocidas
    // vacío/ausente, una marca simplemente omitida en el título ML NUNCA es conflicto.
    expect(marcaEnConflicto('Chaoyang', toks('camara bicicleta rodado 29 valvula de auto'))).toBe(false);
  });

  it('confianzaDesdeScore: conflictoMarca gana incluso con score perfecto y sin otra contradicción', () => {
    expect(confianzaDesdeScore(1, false, true)).toBe('baja');
  });

  it('confianzaDesdeScore: sin conflicto de marca, se comporta como antes (compat con llamadas de 2 args)', () => {
    expect(confianzaDesdeScore(0.9, false)).toBe('alta');
  });
});

describe('matcherEngine · hallazgo 🔴 del revisor: marca multi-palabra NO puede entrar en conflicto consigo misma', () => {
  // Bug real: el primer chequeo (marca SÍ está) compara TOKENS de marcaWc ("buzz","rack") contra
  // tokens de ML; el segundo (¿otra marca?) compara la marca conocida ENTERA normalizada ("buzz
  // rack", con el espacio) contra esos mismos tokens. Con la marca escrita SIN espacio en el
  // título ML ("Buzzrack"), el primero no la reconoce (ratio('buzz','buzzrack')=0.67<0.75) pero
  // el segundo sí matchea contra sí misma (ratio('buzz rack','buzzrack')=0.94≥0.92) y la declara
  // "otra marca". catalogo_cache tiene 20 marcas multi-palabra reales (Buzz Rack, Selle Italia,
  // Rudy Project, Crank Brothers, Super B...), y el daño no es solo un falso rojo: con un solo
  // candidato correcto, candidatosParaWC lo filtra por 'baja' y manda el producto a "hay que
  // publicarlo" en vez de mostrarlo — el conflicto falso ESCONDE el match, no solo lo margina.
  //
  // Los dos pares de acá son REALES (data/fusion.sqlite, FB-16220/MLA737640957 y
  // FB-55035/MLA2790986970): también protegen el caso central del cambio completo — el título
  // ML omite la marca como tokens separados ("buzz"/"rack" no aparecen sueltos), la reconoce
  // solo concatenada. marcaEnConflicto ya NO hace el filtro de auto-marca internamente (motivo:
  // hallazgo 🟡 de performance, ver otrasMarcasPosibles) — el llamador tiene que pasar por
  // otrasMarcasPosibles() primero, igual que hacen candidatosDeWC y buscarMlManual en producción.
  it('marcaEnConflicto: "Buzz Rack" vs título ML real que la escribe sin espacio ("Buzzrack") → false, es la MISMA marca', () => {
    const marcas = normalizarMarcas(['Buzz Rack', 'Thule', 'Yakima']);
    const otrasMarcas = otrasMarcasPosibles('Buzz Rack', marcas);
    expect(marcaEnConflicto('Buzz Rack', toks('Porta Bicicletas Buzzrack Para 3 Bicis Envio Gratis.'), otrasMarcas)).toBe(false);
  });

  it('marcaEnConflicto: "Selle Italia" vs título ML real que la escribe sin espacio ("Selleitalia") → false, es la MISMA marca', () => {
    const marcas = normalizarMarcas(['Selle Italia', 'Fizik', 'Fabric']);
    const otrasMarcas = otrasMarcasPosibles('Selle Italia', marcas);
    expect(marcaEnConflicto('Selle Italia', toks('Sillín Selleitalia Novus Evo Boost Endurance L3'), otrasMarcas)).toBe(false);
  });

  it('candidatosDeWC: producto real Buzz Rack no queda oculto como sin_candidato por auto-conflicto', () => {
    const marcas = normalizarMarcas(['Buzz Rack', 'Thule']);
    const { wcItems } = construirWC([{ sku: 'FB-16220', nombre: 'Portabicicletas Buzzrack Mozzquito - Para 3 Bicicletas', tipo: 'simple' }]);
    const mlIndex = construirML([{ clave: 'MLA737640957|', item_id: 'MLA737640957', titulo: 'Porta Bicicletas Buzzrack Para 3 Bicis Envio Gratis.' }]);
    mlIndex.marcasConocidas = marcas;
    const { sin_candidato, candidatos } = candidatosParaWC(wcItems[0], mlIndex, 'Buzz Rack');
    expect(candidatos[0].diff.conflicto_marca).toBe(false);
    expect(sin_candidato).toBe(false); // antes del fix: 'baja' por auto-conflicto → sin_candidato true → se pierde el match
  });

  it('contrato: si el llamador NO pasa por otrasMarcasPosibles primero (marcasConocidas cruda), marcaEnConflicto explota en vez de mentir', () => {
    // marcaEnConflicto ya no filtra la propia marca internamente (se movió a otrasMarcasPosibles
    // para no recalcularlo por candidato, hallazgo 🟡 de performance). El riesgo que eso abre —
    // medido en la práctica por el revisor: pasar la lista CRUDA de marcasConocidas en vez del
    // resultado de otrasMarcasPosibles da un resultado plausible pero FALSO (el auto-conflicto
    // del hallazgo 🔴 reaparece en silencio) — está cubierto por una guarda O(1) (membresía
    // exacta) que hace fallar esto ruidosamente en vez de devolver un booleano equivocado.
    const marcasCrudas = normalizarMarcas(['Buzz Rack', 'Thule']);
    expect(() => marcaEnConflicto('Buzz Rack', toks('Porta Bicicletas Buzzrack Para 3 Bicis Envio Gratis.'), marcasCrudas))
      .toThrow(/otrasMarcasPosibles/);
  });
});

describe('matcherEngine · hallazgo 🟠 del revisor: umbral de "otra marca" (0.92) — tests que sí ejercitan la rama', () => {
  // Hallazgo del revisor sobre la primera versión de estos tests: los tres usaban 'Shimano'
  // como marcaWc CON 'shimano' presente en el título ML — el primer loop de marcaEnConflicto
  // (la marca SÍ está) devuelve false ANTES de llegar a la rama del umbral, así que ninguno de
  // los tres ejercitaba lo que decían proteger (mutantes 0.85, 0.60 y 1.0 pasaban igual). Acá
  // la marcaWc está SIEMPRE ausente del título ('Kokuen', que no aparece en ningún caso), para
  // forzar el camino real hasta la comparación de umbral.
  it('palabra de catálogo común que se PARECE a una marca (ratio 0.889) NO dispara conflicto — mata los mutantes 0.85 y 0.60', () => {
    // ratio('cubre','cube')=0.889: por debajo del umbral real (0.92, correcto: es una palabra
    // de catálogo, no una mención de la marca Cube) pero por encima de 0.85 (el umbral viejo
    // rechazado) y muy por encima de 0.60. Cualquier mutante que baje el umbral a 0.85 o 0.60
    // hace que este caso pase a `true` — la marcaWc ('Kokuen') está ausente del título, así que
    // SÍ se llega a la rama del umbral.
    expect(ratio('cubre', 'cube')).toBeGreaterThan(0.85);
    expect(ratio('cubre', 'cube')).toBeLessThan(0.92);
    const marcas = normalizarMarcas(['Cube', 'Fundax', 'Elite']);
    const otrasMarcas = otrasMarcasPosibles('Kokuen', marcas);
    expect(marcaEnConflicto('Kokuen', toks('cadena bicicleta cubre negro'), otrasMarcas)).toBe(false);
  });

  it('mención real de otra marca, concatenada sin espacio (ratio 0.94) SÍ dispara conflicto — mata el mutante 1.0', () => {
    // Lado opuesto del caso anterior: "buzzrack" contra la marca conocida "Buzz Rack" (ratio
    // 0.94, por debajo de un umbral mutante de 1.0 pero por encima del real 0.92). Acá la
    // marcaWc ('Kokuen') es DISTINTA de Buzz Rack — es la mención de una marca ajena real, no
    // el auto-conflicto del hallazgo 🔴 (ese usa la propia marca, este usa una diferente).
    const marcas = normalizarMarcas(['Buzz Rack', 'Thule']);
    const otrasMarcas = otrasMarcasPosibles('Kokuen', marcas);
    expect(marcaEnConflicto('Kokuen', toks('porta bicicletas buzzrack para 3 bicis'), otrasMarcas)).toBe(true);
  });

  it('mención real de otra marca (match exacto, ratio 1.0) sigue detectándose con el umbral nuevo', () => {
    const marcas = normalizarMarcas(['Giro', 'Bell']);
    const otrasMarcas = otrasMarcasPosibles('Kokuen', marcas);
    expect(marcaEnConflicto('Kokuen', toks('casco giro seyen mips'), otrasMarcas)).toBe(true);
  });
});

describe('matcherEngine · hallazgo 🟠 del revisor: marcas cortas (3 caracteres) recuperadas por normalizarMarcas', () => {
  // Kmc, Poc, Fox, Fsa, Bbb son marcas reales de catalogo_cache con hermanos parecidos en su
  // categoría (cadenas, cascos/lentes) — justo donde más hace falta la señal. El corte viejo
  // (4+) las dejaba completamente afuera de marcasConocidas.
  it('normalizarMarcas conserva marcas de 3 caracteres (Kmc, Poc)', () => {
    const marcas = normalizarMarcas(['Kmc', 'Poc', 'Shimano']);
    expect(marcas.has('kmc')).toBe(true);
    expect(marcas.has('poc')).toBe(true);
  });

  it('normalizarMarcas descarta marcas de 2 caracteres o menos (QR: colisiona con la categoría "QR Pagos")', () => {
    const marcas = normalizarMarcas(['QR', 'Kmc']);
    expect(marcas.has('qr')).toBe(false);
    expect(marcas.has('kmc')).toBe(true);
  });

  it('marcaEnConflicto detecta una marca corta de 3 caracteres mencionada en el título ML', () => {
    const marcas = normalizarMarcas(['Poc', 'Giro']);
    const otrasMarcas = otrasMarcasPosibles('Giro', marcas);
    expect(marcaEnConflicto('Giro', toks('lentes ciclismo poc devour hydrogen'), otrasMarcas)).toBe(true);
  });

  it('normalizarMarcas excluye "Pro" (línea de producto genérica, ej. "Rapha Pro Team") aunque tenga 3+ caracteres', () => {
    const marcas = normalizarMarcas(['Pro', 'Kmc']);
    expect(marcas.has('pro')).toBe(false);
    expect(marcas.has('kmc')).toBe(true);
  });

  it('normalizarMarcas excluye cualquier marca que sea también un color de COLORES (ej. "Lima")', () => {
    // Hallazgo del revisor: "Lima" es marca real de catalogo_cache Y color real del motor
    // (COLORES) — 6 de sus 7 apariciones en el corpus son el color ("Verde Lima"), no la marca.
    // Regla derivada de datos que ya vive en el motor, en vez de mantener una lista a mano.
    const marcas = normalizarMarcas(['Lima', 'Kmc']);
    expect(marcas.has('lima')).toBe(false);
    expect(marcas.has('kmc')).toBe(true);
  });

  it('mutation testing: si el corte de longitud volviera a 4, "Kmc" deja de detectarse como otra marca', () => {
    const marcasConCorteViejo = new Set([...normalizarMarcas(['Poc'])].filter((m) => m.length >= 4)); // simula el corte roto
    expect(marcasConCorteViejo.has('poc')).toBe(false); // confirma que el corte de 4 sí perdía "poc"
  });
});

describe('matcherEngine · hallazgo 🟡 del revisor: otrasMarcasPosibles se calcula una vez por producto, no por candidato', () => {
  // Función pura extraída de adentro de marcaEnConflicto (antes recalculaba el filtro de
  // auto-marca en cada llamada — hasta 50 veces por producto, una por candidato). Tests directos
  // sobre el contrato: excluye la propia marca (exacta o escrita distinto), deja el resto intacto.
  it('excluye del set la propia marca, exacta', () => {
    const marcas = normalizarMarcas(['Shimano', 'Sram', 'Maxxis']);
    const otras = otrasMarcasPosibles('Shimano', marcas);
    expect(otras.has('shimano')).toBe(false);
    expect(otras.has('sram')).toBe(true);
    expect(otras.has('maxxis')).toBe(true);
  });

  it('excluye del set la propia marca aunque esté escrita distinto (concatenada sin espacio)', () => {
    const marcas = normalizarMarcas(['Buzz Rack', 'Thule']);
    const otras = otrasMarcasPosibles('Buzz Rack', marcas);
    expect(otras.has('buzz rack')).toBe(false);
    expect(otras.has('thule')).toBe(true);
  });

  it('sin marcaWc o sin marcasConocidas, devuelve el set tal cual (sin filtrar nada)', () => {
    const marcas = normalizarMarcas(['Shimano']);
    expect(otrasMarcasPosibles('', marcas)).toBe(marcas);
    expect([...otrasMarcasPosibles('Shimano', new Set())]).toEqual([]);
  });
});

describe('matcherEngine · construirML', () => {
  it('ignora filas sin título (no aportan nada al índice)', () => {
    const { mlItems, corpusSize } = construirML([{ clave: 'A|', item_id: 'A', titulo: '' }, { clave: 'B|', item_id: 'B', titulo: '  ' }]);
    expect(mlItems).toEqual([]);
    expect(corpusSize).toBe(0);
  });

  it('calcula df (frecuencia documental) correctamente sobre el corpus construido', () => {
    const { df } = construirML([
      { clave: 'A|', item_id: 'A', titulo: 'Pedales Shimano M520' },
      { clave: 'B|', item_id: 'B', titulo: 'Pedales Shimano M540' },
      { clave: 'C|', item_id: 'C', titulo: 'Cubierta Maxxis' },
    ]);
    expect(df.pedales).toBe(2);
    expect(df.shimano).toBe(2);
    expect(df.m520).toBe(1);
  });
});
