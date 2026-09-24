import { describe, expect, it } from 'vitest';
import { otrosAtributos } from '../../src/identidad/comparar.ts';

const m = (o: Record<string, string>) => new Map(Object.entries(o));
describe('otrosAtributos (mismas reglas de marca que T4)', () => {
  it('coincide con normalización (acentos y mayúsculas)', () => {
    expect(otrosAtributos(m({ marca: 'Béll' }), m({ marca: 'bell' }))).toEqual([{ nombre: 'marca', marca: 'coincide', valorMl: 'Béll', valorCandidato: 'bell' }]);
  });
  it('difiere cuando los valores son distintos', () => {
    expect(otrosAtributos(m({ rodado: '29' }), m({ rodado: '26' }))[0]!.marca).toBe('difiere');
  });
  it("ML declaró y el candidato no: 'difiere' (no 'falta')", () => {
    expect(otrosAtributos(m({ marca: 'Bell' }), m({}))[0]).toMatchObject({ marca: 'difiere', valorCandidato: '' });
  });
  it("ML no declaró: 'falta' (aunque el candidato lo tenga)", () => {
    expect(otrosAtributos(m({}), m({ marca: 'Bell' }))[0]!.marca).toBe('falta');
  });
  it('color y talle los compara el motor: no se repiten acá', () => {
    expect(otrosAtributos(m({ color: 'negro', talle: 'M' }), m({ color: 'rojo' }))).toEqual([]);
  });
});
