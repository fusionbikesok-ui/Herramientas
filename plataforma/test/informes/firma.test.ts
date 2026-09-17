import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cargarClaveFirma, firmar, huella, verificar } from '../../src/informes/firma.ts';

describe('firma', () => {
  let dir: string; let ruta: string; let publicaPem: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'firma-'));
    ruta = join(dir, 'firma-informes.pem');
    const par = generateKeyPairSync('ed25519');
    publicaPem = par.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    writeFileSync(ruta, `kid: k1\n${par.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()}`, { mode: 0o600 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('una firma válida verifica y devuelve el contenido', () => {
    const sobre = firmar({ dia: '2026-09-17', n: 3 }, cargarClaveFirma(ruta));
    expect(sobre).toMatchObject({ version: 1, kid: 'k1' });
    const r = verificar(sobre, { k1: publicaPem });
    expect(r.valido).toBe(true);
    expect(r.contenido).toEqual({ dia: '2026-09-17', n: 3 });
  });

  it('un contenido alterado no verifica', () => {
    const sobre = firmar({ n: 3 }, cargarClaveFirma(ruta));
    const r = verificar({ ...sobre, contenido: { n: 4 } }, { k1: publicaPem });
    expect(r).toMatchObject({ valido: false, motivo: 'firma_invalida' });
  });

  it('el mismo contenido con las claves en otro orden da la misma firma', () => {
    const clave = cargarClaveFirma(ruta);
    expect(firmar({ a: 1, b: 2 }, clave).firma).toBe(firmar({ b: 2, a: 1 }, clave).firma);
  });

  it('un kid desconocido no verifica', () => {
    const sobre = firmar({ n: 1 }, cargarClaveFirma(ruta));
    expect(verificar({ ...sobre, kid: 'otro' }, { k1: publicaPem })).toMatchObject({ valido: false, motivo: 'kid_desconocido' });
  });

  it('rechaza permisos amplios, dueño ajeno, enlace y directorio abierto', () => {
    chmodSync(ruta, 0o640);
    expect(() => cargarClaveFirma(ruta)).toThrow(/legible por grupo u otros/);
    chmodSync(ruta, 0o600);
    expect(() => cargarClaveFirma(ruta, { uidEsperado: 999999 })).toThrow(/dueño/);
    const enlace = join(dir, 'enlace.pem');
    symlinkSync(ruta, enlace);
    expect(() => cargarClaveFirma(enlace)).toThrow(/archivo regular/);
    chmodSync(dir, 0o777);
    expect(() => cargarClaveFirma(ruta)).toThrow(/directorio/);
  });

  it('la huella es estable y no es la clave', () => {
    expect(huella(publicaPem)).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(huella(publicaPem)).not.toContain('BEGIN');
  });
});
