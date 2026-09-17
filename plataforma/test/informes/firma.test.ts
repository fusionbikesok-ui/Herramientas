import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

  it('un enlace simbólico a una clave válida sigue fallando (apertura con O_NOFOLLOW)', () => {
    const enlace = join(dir, 'enlace-valido.pem');
    symlinkSync(ruta, enlace);
    expect(() => cargarClaveFirma(enlace)).toThrow(/archivo regular/);
  });

  it('un archivo válido carga bien (guardas y lectura sobre el mismo descriptor)', () => {
    const clave = cargarClaveFirma(ruta);
    expect(clave.kid).toBe('k1');
    expect(clave.privada.asymmetricKeyType).toBe('ed25519');
  });
});

describe('generar-clave-firma.mjs', () => {
  let dir: string; let rutaPem: string; let rutaPub: string;
  const script = join(import.meta.dirname, '..', '..', 'scripts', 'generar-clave-firma.mjs');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genclave-'));
    rutaPem = join(dir, 'firma.pem');
    rutaPub = join(dir, 'firma.pub');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('corrido dos veces sobre la misma ruta, la segunda falla y no toca la clave existente', () => {
    execFileSync('node', [script, 'k1', rutaPem, rutaPub]);
    const pemAntes = readFileSync(rutaPem, 'utf8');
    const pubAntes = readFileSync(rutaPub, 'utf8');

    expect(() => execFileSync('node', [script, 'k2', rutaPem, rutaPub], { stdio: 'pipe' })).toThrow();

    expect(readFileSync(rutaPem, 'utf8')).toBe(pemAntes);
    expect(readFileSync(rutaPub, 'utf8')).toBe(pubAntes);
  });
});
