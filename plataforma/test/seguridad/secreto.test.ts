import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leerSecretoProtegido } from '../../src/seguridad/secreto.ts';

describe('leerSecretoProtegido', () => {
  let dir: string; let ruta: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secreto-'));
    ruta = join(dir, 'b2-escritura.clave');
    writeFileSync(ruta, 'K005abcdef\n', { mode: 0o600 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lee un secreto con permisos correctos', () => {
    expect(leerSecretoProtegido(ruta)).toBe('K005abcdef\n');
  });

  it('rechaza un secreto legible por grupo u otros', () => {
    chmodSync(ruta, 0o640);
    expect(() => leerSecretoProtegido(ruta)).toThrow(/legible por grupo u otros/);
  });

  it('rechaza un dueño distinto del esperado', () => {
    expect(() => leerSecretoProtegido(ruta, { uidEsperado: 999999 })).toThrow(/otro dueño/);
  });

  it('rechaza un enlace simbólico, aunque apunte a un archivo válido', () => {
    const enlace = join(dir, 'enlace.clave');
    symlinkSync(ruta, enlace);
    expect(() => leerSecretoProtegido(enlace)).toThrow(/no es un archivo regular/);
  });

  it('rechaza un directorio escribible por otros', () => {
    chmodSync(dir, 0o777);
    expect(() => leerSecretoProtegido(ruta)).toThrow(/directorio de .* es escribible por otros/);
  });

  it('rechaza una ruta vacía', () => {
    expect(() => leerSecretoProtegido('')).toThrow(/ruta de secreto vacía/);
  });
});
