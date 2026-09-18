import { describe, it, expect } from 'vitest';
import { canonizar } from '../../src/informes/jcs.ts';

describe('canonizar', () => {
  it('ordena las claves por su código UTF-16 y no deja espacios', () => {
    expect(canonizar({ b: 1, a: 2, 'ä': 3, A: 4 })).toBe('{"A":4,"a":2,"b":1,"ä":3}');
  });

  it('el mismo objeto con las claves en otro orden da los mismos bytes', () => {
    expect(canonizar({ x: { z: 1, y: 2 } })).toBe(canonizar({ x: { y: 2, z: 1 } }));
  });

  it('serializa los números como pide RFC 8785', () => {
    expect(canonizar([1, 1.0, 1e21, 0.000001, -0])).toBe('[1,1,1e+21,0.000001,0]');
  });

  it('escapa sólo lo que exige el estándar', () => {
    expect(canonizar({ t: 'a"\\\né😀' })).toBe('{"t":"a\\"\\\\\\n\\u0007é😀"}');
  });

  it('descarta las claves con undefined y rechaza undefined dentro de un array', () => {
    expect(canonizar({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonizar([undefined])).toThrow(/undefined/);
  });

  it('rechaza texto con un surrogate suelto, en clave y en valor', () => {
    // RFC 8785 §3.2.2.2 exige fallar: al pasar a UTF-8, Node lo reemplazaría por U+FFFD y la firma dejaría
    // de corresponder al texto original.
    expect(() => canonizar({ t: '\ud800' })).toThrow(/surrogate/);
    expect(() => canonizar({ '\udc00': 1 })).toThrow(/surrogate/);
    expect(canonizar({ t: '😀' })).toBe('{"t":"😀"}');
  });

  it('rechaza lo que no tiene forma canónica', () => {
    expect(() => canonizar(Number.NaN)).toThrow(/finito/);
    expect(() => canonizar({ f: () => 1 })).toThrow(/función/);
    const ciclo: Record<string, unknown> = {}; ciclo.yo = ciclo;
    expect(() => canonizar(ciclo)).toThrow(/ciclo/);
  });

  it('rechaza arrays con huecos (undefined implícito)', () => {
    // Array disperso: los huecos son undefined implícito y deben rechazarse igual que undefined explícito.
    // Sin esta validación, el canonizador emitiría JSON sintácticamente inválido como [1,,3].
    const conHueco = [1, 3];
    conHueco[5] = 7;
    expect(() => canonizar(conHueco)).toThrow(/undefined/);
  });

  it('da exactamente la salida del ejemplo publicado en RFC 8785 (§3.2.4)', () => {
    // Vector externo: el verificador del repo reusa esta misma implementación, así que un error compartido
    // (números, escapado, orden) sólo lo detecta una salida producida por otro.
    const entrada = String.raw`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
      "literals": [null, true, false]
    }`;
    const esperado = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"\u20ac$\u000f\nA'B\"\\\\\"/"}`;
    // El euro va literal en la salida canónica: se reemplaza la secuencia del texto esperado por el carácter.
    expect(canonizar(JSON.parse(entrada))).toBe(esperado.replace('\\u20ac', '€'));
  });
});
