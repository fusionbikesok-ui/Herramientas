import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cargarKeyring, ErrorKeyring } from '../../src/seguridad/keyring.ts';
import { cifrarSobre, descifrarSobre } from '../../src/seguridad/sobre.ts';

const dir = mkdtempSync(join(tmpdir(), 'keyring-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function archivo(nombre: string, contenido: string, modo = 0o600): string {
  const ruta = join(dir, nombre);
  writeFileSync(ruta, contenido);
  chmodSync(ruta, modo);
  return ruta;
}

const clave = Buffer.alloc(32, 3).toString('base64');

describe('keyring de sobres', () => {
  it('carga la clave activa y las anteriores, y descifra lo que cifró', () => {
    const ruta = archivo('ok.json', JSON.stringify({ activeKeyId: 'k2', keys: { k1: Buffer.alloc(32, 1).toString('base64'), k2: clave } }));
    const keyring = cargarKeyring(ruta);
    expect(Object.keys(keyring.keys).sort()).toEqual(['k1', 'k2']);
    const contexto = { account: 'a', topic: 'ml.orders', resource: 'r', remoteVersion: 'v1' };
    const sobre = cifrarSobre(Buffer.from('{"id":1}'), contexto, keyring);
    expect(sobre.keyId).toBe('k2');
    expect(descifrarSobre(sobre, contexto, keyring).toString()).toBe('{"id":1}');
  });

  it('rechaza un archivo legible por grupo u otros', () => {
    const ruta = archivo('abierto.json', JSON.stringify({ activeKeyId: 'k1', keys: { k1: clave } }), 0o644);
    expect(() => cargarKeyring(ruta)).toThrow(/legible por grupo/);
  });

  it('rechaza JSON inválido, clave de largo incorrecto, base64 falso y clave activa ausente', () => {
    expect(() => cargarKeyring(archivo('roto.json', '{'))).toThrow(ErrorKeyring);
    expect(() => cargarKeyring(archivo('corta.json', JSON.stringify({ activeKeyId: 'k1', keys: { k1: Buffer.alloc(16).toString('base64') } })))).toThrow(/32 bytes/);
    expect(() => cargarKeyring(archivo('falsa.json', JSON.stringify({ activeKeyId: 'k1', keys: { k1: 'no-es-base64!!' } })))).toThrow(/base64/);
    expect(() => cargarKeyring(archivo('sin-activa.json', JSON.stringify({ activeKeyId: 'k9', keys: { k1: clave } })))).toThrow(/no está en el keyring/);
    expect(() => cargarKeyring(archivo('sin-id.json', JSON.stringify({ keys: { k1: clave } })))).toThrow(/activeKeyId/);
  });
});
