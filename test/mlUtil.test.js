import { describe, it, expect } from 'vitest';
import { normVariationId, armarClaveMl, partirClaveMl, extraerErrorMl } from '../lib/mlUtil.js';

describe('normVariationId', () => {
  it('quita el sufijo .0', () => {
    expect(normVariationId('123456789.0')).toBe('123456789');
  });

  it('deja intacto un id sin sufijo', () => {
    expect(normVariationId('123456789')).toBe('123456789');
  });

  it('devuelve "" para null/undefined/""', () => {
    expect(normVariationId(null)).toBe('');
    expect(normVariationId(undefined)).toBe('');
    expect(normVariationId('')).toBe('');
  });
});

describe('armarClaveMl', () => {
  it('arma la clave con variación, normalizando el sufijo .0', () => {
    expect(armarClaveMl('MLA123', '456.0')).toBe('MLA123|456');
  });

  it('arma la clave de un item simple (sin variación) con "|" final', () => {
    expect(armarClaveMl('MLA123', '')).toBe('MLA123|');
    expect(armarClaveMl('MLA123', undefined)).toBe('MLA123|');
  });
});

describe('partirClaveMl', () => {
  it('parte una clave con variación', () => {
    expect(partirClaveMl('MLA123|456')).toEqual({ itemId: 'MLA123', variationId: '456' });
  });

  it('parte una clave simple (sin variación)', () => {
    expect(partirClaveMl('MLA123|')).toEqual({ itemId: 'MLA123', variationId: '' });
  });

  it('clave malformada (sin "|") deja variationId en ""', () => {
    expect(partirClaveMl('MLA123')).toEqual({ itemId: 'MLA123', variationId: '' });
  });

  it('clave vacía o null no rompe', () => {
    expect(partirClaveMl('')).toEqual({ itemId: '', variationId: '' });
    expect(partirClaveMl(null)).toEqual({ itemId: '', variationId: '' });
  });
});

describe('extraerErrorMl', () => {
  it('prioriza cause[].message, unidas con " | "', () => {
    const resp = { status: 400, data: { cause: [{ message: 'a' }, { code: 'b' }], message: 'ignorada' } };
    expect(extraerErrorMl(resp)).toBe('a | b');
  });

  it('usa data.message si no hay cause', () => {
    const resp = { status: 400, data: { message: 'algo falló' } };
    expect(extraerErrorMl(resp)).toBe('algo falló');
  });

  it('usa el fallback custom si no hay cause ni message', () => {
    const resp = { status: 500, data: {} };
    expect(extraerErrorMl(resp, 'fallback custom')).toBe('fallback custom');
  });

  it('usa "HTTP <status>" como fallback por defecto', () => {
    const resp = { status: 503, data: {} };
    expect(extraerErrorMl(resp)).toBe('HTTP 503');
  });

  it('no rompe con resp/data vacíos o ausentes', () => {
    expect(extraerErrorMl({})).toBe('HTTP undefined');
    expect(extraerErrorMl(undefined, 'x')).toBe('x');
  });
});
