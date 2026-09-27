import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validarMuestra } from '../../src/identidad/muestra.ts';

const archivo = JSON.stringify({ version: 1, fuente: 'test', catalogo: [], casos: [{ clave: 'A', ml: {} }] });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('validarMuestra', () => {
  it('rechaza cardinalidad distinta', () => {
    expect(() => validarMuestra(archivo, { sha256: sha256(archivo), cardinalidad: 299 })).toThrow(/cardinalidad/);
  });
  it('rechaza hash distinto', () => {
    expect(() => validarMuestra(archivo, { sha256: '0'.repeat(64), cardinalidad: 1 })).toThrow(/sha256/);
  });
  it('acepta cardinalidad y hash correctos', () => {
    expect(validarMuestra(archivo, { sha256: sha256(archivo), cardinalidad: 1 }).parcial).toBe(false);
  });
  it('marca parcial cuando se solicita explícitamente', () => {
    expect(validarMuestra(archivo, { sha256: sha256(archivo), cardinalidad: 299, parcial: true }).parcial).toBe(true);
  });
});
