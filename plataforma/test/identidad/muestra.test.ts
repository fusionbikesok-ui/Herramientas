import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validarMuestra } from '../../src/identidad/muestra.ts';

const archivo = JSON.stringify({ version: 1, fuente: 'test', catalogo: [], casos: [{ clave: 'A', ml: { id: 'A' } }] });
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
  it('rechaza parcial cuando alcanza la cardinalidad completa', () => {
    expect(() => validarMuestra(archivo, { sha256: sha256(archivo), cardinalidad: 1, parcial: true })).toThrow(/parcial.*menor/i);
  });
  it('rechaza JSON inválido con mensaje claro', () => {
    const invalido = '{';
    expect(() => validarMuestra(invalido, { sha256: sha256(invalido), cardinalidad: 1 })).toThrow(/muestra inválida: JSON/);
  });
  it.each([
    { casos: [{ clave: 1, ml: { id: 'A' } }], mensaje: /casos\[0\].*clave.*string/i },
    { casos: [{ clave: 'A' }], mensaje: /casos\[0\].*ml.*presente/i },
    { casos: [{ clave: 'A', ml: null }], mensaje: /casos\[0\].*ml.*vacío/i },
  ])('rechaza la forma inválida de cada caso', ({ casos, mensaje }) => {
    const contenido = JSON.stringify({ version: 1, fuente: 'test', catalogo: [], casos });
    expect(() => validarMuestra(contenido, { sha256: sha256(contenido), cardinalidad: 1 })).toThrow(mensaje);
  });
});
