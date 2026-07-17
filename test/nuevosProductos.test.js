import { describe, it, expect } from 'vitest';
import { armarTitulo, tituloCase } from '../routes/nuevosProductos.js';

describe('armarTitulo', () => {
  it('joins tipo, marca, modelo and dato skipping empty parts', () => {
    expect(armarTitulo('Cubierta', 'Continental', 'DP25', 'R29')).toBe('Cubierta Continental DP25 R29');
    expect(armarTitulo('Caramañola', 'Venzo', '', '')).toBe('Caramañola Venzo');
  });

  it('tituloCase capitalizes first letter only', () => {
    expect(tituloCase('CONTINENTAL')).toBe('Continental');
  });
});
