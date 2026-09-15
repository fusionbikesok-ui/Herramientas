import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cifrarSobre, descifrarSobre, type ContextoSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';

const contexto: ContextoSobre = {
  account: '00000000-0000-0000-0000-000000000001',
  topic: 'ml.orders',
  resource: '200000000001',
  remoteVersion: '2026-09-15T12:00:00.000Z',
};

function keyring(): KeyringSobre {
  return { activeKeyId: 'test-1', keys: { 'test-1': randomBytes(32), anterior: randomBytes(32) } };
}

describe('sobre AES-256-GCM de inbox', () => {
  it('cifra un payload no vacío y lo recupera con AAD exacto', () => {
    const keys = keyring();
    const plano = Buffer.from('{"id":200000000001,"status":"paid"}');
    const sobre = cifrarSobre(plano, contexto, keys);
    expect(sobre.nonce).toHaveLength(12);
    expect(sobre.tag).toHaveLength(16);
    expect(sobre.ciphertext.equals(plano)).toBe(false);
    expect(descifrarSobre(sobre, contexto, keys)).toEqual(plano);
  });

  it('rechaza AAD alterado', () => {
    const keys = keyring();
    const sobre = cifrarSobre(Buffer.from('{"id":1}'), contexto, keys);
    expect(() => descifrarSobre(sobre, { ...contexto, resource: 'otro' }, keys)).toThrow();
  });

  it('rechaza key id desconocido y claves con longitud incorrecta', () => {
    const keys = keyring();
    const sobre = cifrarSobre(Buffer.from('{"id":1}'), contexto, keys);
    expect(() => descifrarSobre({ ...sobre, keyId: 'ausente' }, contexto, keys)).toThrow(/desconocida/);
    expect(() => cifrarSobre(Buffer.from('x'), contexto, { activeKeyId: 'mala', keys: { mala: randomBytes(16) } })).toThrow(/32 bytes/);
  });

  it('rechaza payload vacío y estructura de sobre inválida', () => {
    const keys = keyring();
    expect(() => cifrarSobre(Buffer.alloc(0), contexto, keys)).toThrow(/vacío/);
    const sobre = cifrarSobre(Buffer.from('x'), contexto, keys);
    expect(() => descifrarSobre({ ...sobre, nonce: Buffer.alloc(11) }, contexto, keys)).toThrow(/inválido/);
  });
});
