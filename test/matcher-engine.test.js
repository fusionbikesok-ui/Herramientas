import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import vm from 'vm';

// matcher-engine.js es un IIFE de browser (se sirve por <script>), no un módulo ESM.
// Se carga en un contexto vm con `self` para obtener la API expuesta.
const code = readFileSync(fileURLToPath(new URL('../public/matcher/matcher-engine.js', import.meta.url)), 'utf8');
const sandbox = {}; sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const ME = sandbox.MatcherEngine;

const MUESTRAS = [
  'Casco Bell Negro Talle M', 'Cubierta Maxxis 29x2.25', 'Bicicleta MTB Aro 29 Roja',
  'Guante   XL  ', 'Pedales — Negro / L', 'Remera Ciclismo Azul Marino', '', 'ünïcode ÁÉÍ',
];

describe('MatcherEngine · funciones puras (property-style)', () => {
  it('norm es idempotente', () => {
    for (const s of MUESTRAS) expect(ME.norm(ME.norm(s))).toBe(ME.norm(s));
  });

  it('tsr está acotado en [0,1] y es simétrico', () => {
    for (const a of MUESTRAS) for (const b of MUESTRAS) {
      const ab = ME.tsr(ME.norm(a), ME.norm(b));
      expect(ab).toBeGreaterThanOrEqual(0);
      expect(ab).toBeLessThanOrEqual(1);
      expect(ME.tsr(ME.norm(a), ME.norm(b))).toBeCloseTo(ME.tsr(ME.norm(b), ME.norm(a)), 10);
    }
  });

  it('tsr de un texto consigo mismo es 1', () => {
    for (const s of MUESTRAS) {
      const n = ME.norm(s); if (!n) continue;
      expect(ME.tsr(n, n)).toBeCloseTo(1, 10);
    }
  });

  it('ratio y lcsLen son consistentes con casos base', () => {
    expect(ME.ratio('', '')).toBe(1);
    expect(ME.ratio('abc', '')).toBe(0);
    expect(ME.lcsLen('abc', 'abc')).toBe(3);
  });
});

describe('MatcherEngine · vocabulario color/talle', () => {
  it('colores ampliados (H-07) se clasifican como color, no talle', () => {
    for (const c of ['marino', 'lila', 'plata', 'bronce', 'transparente', 'indigo', 'cromado']) {
      expect(ME.COLORES.has(c)).toBe(true);
    }
  });

  it('extraerAtributos no mete un color en el bucket de talles', () => {
    const { colores, talles } = ME.extraerAtributos('Rojo / M');
    expect(colores.has('rojo')).toBe(true);
    expect(talles.has('rojo')).toBe(false);
    expect(talles.has('m')).toBe(true);
  });
});

describe('MatcherEngine · atributos estructurados de WC (H-06)', () => {
  it('extraerAtributosDeAttrsWC clasifica por nombre de atributo', () => {
    const r = ME.extraerAtributosDeAttrsWC(JSON.stringify([
      { name: 'Color', option: 'Negro' }, { name: 'Talle', option: 'M' },
    ]));
    expect(r.colores.has('negro')).toBe(true);
    expect(r.talles.has('m')).toBe(true);
  });

  it('devuelve null ante JSON inválido o vacío', () => {
    expect(ME.extraerAtributosDeAttrsWC('no-json')).toBeNull();
    expect(ME.extraerAtributosDeAttrsWC('[]')).toBeNull();
    expect(ME.extraerAtributosDeAttrsWC(null)).toBeNull();
  });

  it('construirWC prefiere atributos estructurados sobre el nombre', () => {
    // El nombre NO trae color/talle parseable; los atributos sí.
    const { wcPorSku } = ME.construirWC([
      { sku: 'FB-1', nombre: 'Casco Bell', tipo: 'variation',
        atributos_json: JSON.stringify([{ name: 'Color', option: 'Rojo' }, { name: 'Talle', option: 'L' }]) },
    ]);
    expect(wcPorSku['FB-1'].colorToks.has('rojo')).toBe(true);
    expect(wcPorSku['FB-1'].talleToks.has('l')).toBe(true);
  });

  it('construirWC cae al parseo del nombre si no hay atributos', () => {
    const { wcPorSku } = ME.construirWC([
      { sku: 'FB-2', nombre: 'Casco Bell — Azul / M', tipo: 'variation' },
    ]);
    expect(wcPorSku['FB-2'].colorToks.has('azul')).toBe(true);
    expect(wcPorSku['FB-2'].talleToks.has('m')).toBe(true);
  });
});
