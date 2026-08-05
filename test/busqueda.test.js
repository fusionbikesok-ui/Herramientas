import { describe, it, expect } from 'vitest';
import { armarLike } from '../lib/busqueda.js';

describe('armarLike', () => {
  it('envuelve el término entre % literales', () => {
    expect(armarLike('abc')).toBe('%abc%');
  });

  it('escapa % y _ para que se busquen como texto literal, no como comodines', () => {
    expect(armarLike('%')).toBe('%\\%%');
    expect(armarLike('_')).toBe('%\\_%');
    expect(armarLike('50%_off')).toBe('%50\\%\\_off%');
  });

  it('escapa la barra invertida antes que los comodines, para no romper el escape', () => {
    expect(armarLike('a\\b')).toBe('%a\\\\b%');
  });
});
