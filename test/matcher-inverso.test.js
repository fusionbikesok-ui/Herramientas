import { describe, it, expect } from 'vitest';
import {
  construirWC, construirML, candidatosDeWC, candidatosParaWC, diffTokens,
  esDiscriminante, esCodigoAlfanumerico, esMedidaNumerica, esTokenRaro, confianzaDesdeScore,
  colorCanonico, medidaCanonica, canonToken, marcaEnConflicto, toks,
} from '../lib/matcherEngine.js';

// Helper: arma el ítem WC (vía construirWC, igual que el resto del motor) y el universo ML
// (vía construirML) para un solo par a comparar. mlExtra son publicaciones de "relleno" que
// simulan el resto del corpus sin SKU, para que la señal de rareza (regla 3) tenga sentido.
function armar(wcNombre, mlTitulo, mlExtra = [], marcaWc = '') {
  const { wcItems } = construirWC([{ sku: 'X', nombre: wcNombre, tipo: 'simple' }]);
  const mlIndex = construirML([{ clave: 'A|', item_id: 'A', titulo: mlTitulo }, ...mlExtra]);
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

  it('conflicto de marca estructurada (catalogo_cache.marca) aunque la marca sea frecuente en el corpus', () => {
    // "shimano" es muy común (no cae por rareza) pero si la marca de WC ni aparece en el
    // título ML, es señal fuerte de producto distinto igual.
    const d = diffTokens(toks('cadena shimano'), toks('cadena sram'), { cadena: 100, shimano: 80, sram: 80 }, 200, 'Shimano');
    expect(d.discriminantes_conflicto).toContain('shimano');
    expect(d.hay_contradiccion).toBe(true);
  });

  it('sin conflicto de marca cuando la marca de WC sí aparece en el título ML', () => {
    const d = diffTokens(toks('cadena shimano hg53'), toks('cadena shimano hg53'), {}, 10, 'Shimano');
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
  it('marca WC vs marca ML totalmente distinta → confianza SIEMPRE baja, aunque el score sea alto', () => {
    const { top } = armar('Jersey Elite KOKUEN Talle S - Fusion Bikes', 'Casco Giro Seyen Mips Talle S - Fusion Bikes', [], 'Kokuen');
    expect(top.score).toBeGreaterThan(0.5); // confirma que el score solo lo salvaría a 'revisar'
    expect(top.diff.conflicto_marca).toBe(true);
    expect(top.confianza).toBe('baja');
  });

  it('marcaEnConflicto: marca distinta sin ningún parecido → true', () => {
    expect(marcaEnConflicto('Kokuen', toks('casco giro seyen mips'))).toBe(true);
  });

  it('marcaEnConflicto: marca ausente en WC → false SIEMPRE (nunca contradicción por ausencia)', () => {
    expect(marcaEnConflicto('', toks('casco giro seyen mips'))).toBe(false);
    expect(marcaEnConflicto(null, toks('casco giro seyen mips'))).toBe(false);
    expect(marcaEnConflicto(undefined, toks('casco giro seyen mips'))).toBe(false);
  });

  it('marcaEnConflicto: escritura distinta pero parecida ("Metha" vs "Mtha") → false, no es conflicto', () => {
    expect(marcaEnConflicto('Metha', toks('bicicleta mtha aro 29'))).toBe(false);
  });

  it('marca ausente en WC no fuerza baja: un match legítimo sin marca estructurada conserva su confianza real', () => {
    const { top } = armar('Cadena Shimano Hg54 10V 116 Links', 'Cadena Shimano 10 Velocidades Hg-54', [], '');
    expect(top.diff.conflicto_marca).toBe(false);
    expect(top.confianza).not.toBe('baja');
  });

  it('confianzaDesdeScore: conflictoMarca gana incluso con score perfecto y sin otra contradicción', () => {
    expect(confianzaDesdeScore(1, false, true)).toBe('baja');
  });

  it('confianzaDesdeScore: sin conflicto de marca, se comporta como antes (compat con llamadas de 2 args)', () => {
    expect(confianzaDesdeScore(0.9, false)).toBe('alta');
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
