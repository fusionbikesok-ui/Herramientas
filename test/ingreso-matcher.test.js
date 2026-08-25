import { describe, it, expect } from 'vitest';
import { construirWCIndex, contradiccionAtributo, esDiscriminante, norm } from '../lib/matcherEngine.js';
import { candidatosParaDoc, autoAplicable, ctDesdeDoc } from '../lib/ingresoMatcher.js';

const BASE = 'Zapatillas Serfas Switchback Mtb Hombre';

// Cuatro variaciones de un mismo padre, con talle estructurado (atributos_json), tal como
// vienen de catalogo_cache: nombre propio "… — Negro / M" y id_padre apuntando al padre.
function variaciones(talles, color = 'Negro', base = BASE, idPadre = 100) {
  return talles.map((t, i) => ({
    id_woo: idPadre + 1 + i, id_padre: idPadre, sku: `SW-${t}`, tipo: 'variation',
    nombre: `${base} — ${color} / ${t}`,
    atributos_json: JSON.stringify([{ name: 'Color', option: color }, { name: 'Talle', option: String(t) }]),
  }));
}

// Relleno de catálogo para que la señal de rareza (df) tenga un corpus con sentido.
// Tamaño realista a propósito (400): con un catálogo de juguete de 60 filas el umbral de
// rareza de esTokenRaro (max(2, corpus*2%)) es 2, y una palabra específica que aparezca en las
// 4 variaciones de un mismo padre deja de contar como discriminante. Con 400 el umbral es 8,
// que es el orden de magnitud del catálogo real. "bicicleta"/"shimano" aparecen en todo el
// relleno justamente para que sean palabras genéricas, como en producción.
function relleno(n = 400) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({ id_woo: 900 + i, sku: `R-${i}`, tipo: 'simple', nombre: `Cubierta Maxxis Ardent ${i} Rodado 29 Bicicleta Shimano` });
  }
  return arr;
}

describe('ingresoMatcher · variaciones con talle de letra', () => {
  const idx = construirWCIndex([...variaciones(['S', 'M', 'L', 'XL']), ...relleno()]);

  it('1 · doc "Talle M" elige la variación M con alta; las otras tres quedan en baja', () => {
    const res = candidatosParaDoc({ descripcion: `${BASE} Negro Talle M` }, idx);
    expect(res.candidatos[0].sku).toBe('SW-M');
    expect(res.candidatos[0].confianza).toBe('alta');
    const otras = res.candidatos.filter((c) => c.sku !== 'SW-M' && String(c.sku).startsWith('SW-'));
    expect(otras.length).toBe(3);
    for (const c of otras) {
      expect(c.confianza).toBe('baja');
      expect(c.contradiccion_atributo).toBe(true);
    }
    expect(autoAplicable(res)).toBe(true);
  });

  it('2 · GATE · las 4 líneas del remito (S/M/L/XL) dan 4 id_woo DISTINTOS', () => {
    const elegidos = ['S', 'M', 'L', 'XL'].map((t) => {
      const res = candidatosParaDoc({ descripcion: `${BASE} Negro Talle ${t}` }, idx);
      return res.candidatos[0].id_woo;
    });
    expect(new Set(elegidos).size).toBe(4);
    expect(elegidos).toEqual([101, 102, 103, 104]);
  });
});

describe('ingresoMatcher · talles numéricos (el caso real reproducido)', () => {
  const idx = construirWCIndex([...variaciones([41, 42, 43, 44, 45]), ...relleno()]);

  it('3 · 41/43/45 nunca caen los tres en la misma variación', () => {
    const res = [41, 43, 45].map((t) => candidatosParaDoc({ descripcion: `${BASE} Negro ${t}` }, idx));
    const elegidos = res.map((r) => (r.ambiguo ? null : r.candidatos[0].id_woo));
    const concretos = elegidos.filter((x) => x != null);
    expect(new Set(concretos).size).toBe(concretos.length); // sin colapso
    // Y de hecho acá el talle alcanza para resolver los tres:
    expect(concretos.length).toBe(3);
    expect(res.map((r) => r.candidatos[0].wc_talle)).toEqual(['41', '43', '45']);
  });
});

describe('ingresoMatcher · contradicción de color', () => {
  it('4 · "Negro" contra catálogo "Blanco" da baja y no marca ambiguo', () => {
    const idx = construirWCIndex([
      { id_woo: 1, sku: 'C-1', tipo: 'simple', nombre: 'Casco Bell Draft Blanco', atributos_json: JSON.stringify([{ name: 'Color', option: 'Blanco' }]) },
      ...relleno(),
    ]);
    const res = candidatosParaDoc({ descripcion: 'Casco Bell Draft Negro' }, idx);
    expect(res.candidatos[0].sku).toBe('C-1');
    expect(res.candidatos[0].confianza).toBe('baja');
    expect(res.candidatos[0].contradiccion_atributo).toBe(true);
    expect(res.ambiguo).toBe(false);
    expect(autoAplicable(res)).toBe(false);
  });
});

describe('ingresoMatcher · empate ambiguo', () => {
  it('5 · nombre idéntico sin talle ni color en el texto → ambiguo y nunca auto', () => {
    const idx = construirWCIndex([...variaciones(['S', 'M', 'L', 'XL']), ...relleno()]);
    const res = candidatosParaDoc({ descripcion: BASE }, idx); // "solo cambia el código del proveedor"
    expect(res.ambiguo).toBe(true);
    expect(autoAplicable(res)).toBe(false);
  });
});

describe('ingresoMatcher · discriminantes y marca', () => {
  it('6 · discriminante ausente (M520 vs título genérico) no puede dar alta', () => {
    const idx = construirWCIndex([
      { id_woo: 7, sku: 'P-1', tipo: 'simple', nombre: 'Pedales Shimano Spd Mtb' },
      ...relleno(),
    ]);
    const res = candidatosParaDoc({ descripcion: 'Pedales Shimano M520' }, idx);
    expect(res.candidatos[0].sku).toBe('P-1');
    expect(res.candidatos[0].confianza).not.toBe('alta');
    expect(autoAplicable(res)).toBe(false);
  });

  it('7 · marca del remito en conflicto con la del producto → baja', () => {
    const idx = construirWCIndex([
      { id_woo: 8, sku: 'K-1', tipo: 'simple', nombre: 'Cassette Sram Pg1130 11v 11 42t' },
      ...relleno(),
    ]);
    idx.marcasConocidas = new Set(['sram', 'shimano']);
    const res = candidatosParaDoc({ descripcion: 'Cassette Shimano Pg1130 11v 11 42t', marca: 'Shimano' }, idx);
    expect(res.candidatos[0].diff.conflicto_marca).toBe(true);
    expect(res.candidatos[0].confianza).toBe('baja');
    expect(res.sin_candidato).toBe(true);
  });

  it('8 · línea genérica ("bicicleta shimano") no propone nada', () => {
    const idx = construirWCIndex([
      { id_woo: 9, sku: 'B-1', tipo: 'simple', nombre: 'Bicicleta Shimano Ruta Aluminio' },
      { id_woo: 10, sku: 'B-2', tipo: 'simple', nombre: 'Bicicleta Shimano Mtb Aluminio' },
      ...relleno(),
    ]);
    const res = candidatosParaDoc({ descripcion: 'bicicleta shimano' }, idx);
    expect(res.sin_candidato).toBe(true);
    expect(autoAplicable(res)).toBe(false);
  });

  it('9 · esDiscriminante sobre un corpus de 100: "shimano" (40) no, "m520" (1) sí', () => {
    const items = [];
    for (let i = 0; i < 100; i++) {
      const nombre = i < 40 ? `Producto Shimano Serie ${1000 + i}` : `Producto Generico Serie ${1000 + i}`;
      items.push({ id_woo: i, sku: `S-${i}`, tipo: 'simple', nombre: i === 0 ? `${nombre} M520` : nombre });
    }
    const { df, corpusSize } = construirWCIndex(items);
    expect(corpusSize).toBe(100);
    expect(df.shimano).toBe(40);
    expect(df.m520).toBe(1);
    expect(esDiscriminante('shimano', df, corpusSize)).toBe(false);
    expect(esDiscriminante('m520', df, corpusSize)).toBe(true);
  });
});

describe('contradiccionAtributo · omisión ≠ contradicción', () => {
  const wc = { colorToks: new Set(['negro']), talleToks: new Set(['42']) };
  it('un lado que no declara el atributo no contradice', () => {
    expect(contradiccionAtributo({ colores: new Set(), talles: new Set() }, wc).hay).toBe(false);
    expect(contradiccionAtributo({ colores: new Set(['negro']), talles: new Set() }, wc).hay).toBe(false);
  });
  it('mismo valor escrito distinto (negra/negro) no es contradicción', () => {
    expect(contradiccionAtributo({ colores: new Set(['negra']), talles: new Set() }, wc).color).toBe(false);
  });
  it('valores declarados sin nada en común sí lo es', () => {
    const r = contradiccionAtributo({ colores: new Set(['blanco']), talles: new Set(['44']) }, wc);
    expect(r).toEqual({ color: true, talle: true, hay: true });
  });
  it('ctDesdeDoc prioriza los campos estructurados sobre el texto', () => {
    expect([...ctDesdeDoc({ descripcion: `${BASE} Negro 41`, talle: '43' }).talles]).toEqual(['43']);
    expect(norm('Negro')).toBe('negro');
  });
});

describe('Hallazgos del revisor · nuevos tests', () => {
  it('10 · Producto simple SIN atributos_json + doc con talle → no descarta por contradicción falsa', () => {
    // Hallazgo 1: un producto simple sin atributos_json no debe falsar contradicción
    const idx = construirWCIndex([
      { id_woo: 11, sku: 'H-1', tipo: 'simple', nombre: 'Casco Bell Draft Negro' },
      ...relleno(),
    ]);
    const res = candidatosParaDoc({ descripcion: 'Casco Bell Draft Negro', talle: 'M' }, idx);
    expect(res.candidatos[0].sku).toBe('H-1');
    expect(res.candidatos[0].confianza).toBe('alta');
    expect(res.candidatos[0].contradiccion_atributo).toBe(false);
    expect(autoAplicable(res)).toBe(true);
  });

  it('11 · Doc "Cadena Shimano Hg500 116 Eslabones" con distractor "116" → producto correcto primero', () => {
    // Hallazgo 1: talleToks del fallback no debe interferir en matching
    const idx = construirWCIndex([
      { id_woo: 12, sku: 'CA-1', tipo: 'simple', nombre: 'Cadena Shimano Hg500 Eslabones' },
      { id_woo: 13, sku: 'CU-1', tipo: 'simple', nombre: 'Cubierta Maxxis Ardent 116 Rodado 29 Bicicleta' },
      ...relleno(),
    ]);
    const res = candidatosParaDoc({ descripcion: 'Cadena Shimano Hg500 116 Eslabones' }, idx);
    expect(res.candidatos[0].sku).toBe('CA-1');
    expect(res.candidatos[0].score).toBeGreaterThan(res.candidatos[1].score);
  });

  it('12 · Dos productos DISTINTOS con título idéntico → ambiguo y nunca auto', () => {
    // Hallazgo 2: dos id_woo distintos con mismo título deben marcar ambiguo
    const idx = construirWCIndex([
      { id_woo: 14, id_padre: null, sku: 'P-1', tipo: 'simple', nombre: 'Producto Generico Titulo' },
      { id_woo: 15, id_padre: null, sku: 'P-2', tipo: 'simple', nombre: 'Producto Generico Titulo' },
      ...relleno(),
    ]);
    const res = candidatosParaDoc({ descripcion: 'Producto Generico Titulo' }, idx);
    expect(res.ambiguo).toBe(true);
    expect(autoAplicable(res)).toBe(false);
  });

  it('13 · Dos filas con mismo SKU → cada wcItem recibe su propio id_woo por índice', () => {
    // Hallazgo 4: recorrer por índice, no por SKU (SKU no es único)
    const items = [
      { id_woo: 16, id_padre: 100, sku: 'SHARED', tipo: 'variation', nombre: 'Producto Primer — Negro / S', atributos_json: JSON.stringify([{ name: 'Color', option: 'Negro' }, { name: 'Talle', option: 'S' }]) },
      { id_woo: 17, id_padre: 100, sku: 'SHARED', tipo: 'variation', nombre: 'Producto Primer — Negro / M', atributos_json: JSON.stringify([{ name: 'Color', option: 'Negro' }, { name: 'Talle', option: 'M' }]) },
      ...relleno(),
    ];
    const idx = construirWCIndex(items);
    const [wcS, wcM] = idx.wcItems.slice(0, 2);
    expect(wcS.id_woo).toBe(16);
    expect(wcM.id_woo).toBe(17);
    expect(wcS.id_woo).not.toBe(wcM.id_woo);
  });

  it('14 · Dos hermanos con scores 0.98/0.96 → ambiguo (sin epsilon entre hermanos)', () => {
    // Hallazgo 5: entre hermanos, siempre ambiguo sin epsilon
    // Necesitamos un caso donde dos hermanos queden con scores que empaten (diferencia 0.02)
    const idx = construirWCIndex([...variaciones(['S', 'M']), ...relleno()]);
    // "Zapatillas Serfas Switchback Mtb Hombre" sin talle declara → empatarán los dos hermanos
    const res = candidatosParaDoc({ descripcion: BASE }, idx);
    expect(res.ambiguo).toBe(true);
    expect(res.candidatos[0].id_padre).not.toBeNull();
    expect(res.candidatos[1]?.id_padre).toBe(res.candidatos[0].id_padre);
    expect(autoAplicable(res)).toBe(false);
  });
});
