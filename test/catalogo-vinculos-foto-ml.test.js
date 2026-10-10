import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Prueba el código real de public/catalogo-vinculos/foto-ml.js (no una copia), cargado con vm.
// Criterio documentado: solo https://*.mlstatic.com con sufijo -I.jpg|webp se transforma a -O;
// cualquier otro caso (http, otro host, ya -O, sin sufijo) devuelve la URL tal cual;
// null/undefined/'' se devuelven sin cambios.
const src = readFileSync(new URL('../public/catalogo-vinculos/foto-ml.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(src, sandbox);
const { fotoMlGrande } = sandbox.module.exports;

describe('fotoMlGrande', () => {
  it('cambia -I.jpg por -O.jpg en mlstatic https', () => {
    expect(fotoMlGrande('https://http2.mlstatic.com/D_NQ_NP_123-I.jpg')).toBe('https://http2.mlstatic.com/D_NQ_NP_123-O.jpg');
  });

  it('cambia -I.webp por -O.webp', () => {
    expect(fotoMlGrande('https://http2.mlstatic.com/D_NQ_NP_123-I.webp')).toBe('https://http2.mlstatic.com/D_NQ_NP_123-O.webp');
  });

  it('acepta la extensión en mayúsculas', () => {
    expect(fotoMlGrande('https://http2.mlstatic.com/D_NQ_NP_123-I.JPG')).toBe('https://http2.mlstatic.com/D_NQ_NP_123-O.JPG');
  });

  it('una URL que ya es -O queda igual', () => {
    const u = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
    expect(fotoMlGrande(u)).toBe(u);
  });

  it('un host que no es mlstatic queda igual', () => {
    const u = 'https://ejemplo.com/foto-I.jpg';
    expect(fotoMlGrande(u)).toBe(u);
  });

  it('un host que solo termina parecido a mlstatic queda igual', () => {
    const u = 'https://evilmlstatic.com/foto-I.jpg';
    expect(fotoMlGrande(u)).toBe(u);
  });

  it('http:// queda igual (no transforma)', () => {
    const u = 'http://http2.mlstatic.com/D_NQ_NP_123-I.jpg';
    expect(fotoMlGrande(u)).toBe(u);
  });

  it('null, undefined y cadena vacía se devuelven sin cambios', () => {
    expect(fotoMlGrande(null)).toBe(null);
    expect(fotoMlGrande(undefined)).toBe(undefined);
    expect(fotoMlGrande('')).toBe('');
  });

  it('una cadena que no es URL queda igual', () => {
    expect(fotoMlGrande('no-es-url-I.jpg')).toBe('no-es-url-I.jpg');
  });

  it('preserva la query string', () => {
    expect(fotoMlGrande('https://http2.mlstatic.com/D_NQ_NP_123-I.jpg?v=2&x=1'))
      .toBe('https://http2.mlstatic.com/D_NQ_NP_123-O.jpg?v=2&x=1');
  });

  it('sin sufijo -I (p. ej. -F.jpg) queda igual', () => {
    const u = 'https://http2.mlstatic.com/D_NQ_NP_123-F.jpg';
    expect(fotoMlGrande(u)).toBe(u);
  });
});
