// test/apnsJwt.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { tokenProveedor, _resetCacheJwt } from '../lib/apnsJwt.js';

// Clave EC P-256 real generada en el test: firmar de verdad es la única forma de probar
// que el JWT es válido, y generar una clave es más barato que guardar una en el repo.
const { privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CFG = { keyId: 'ABCDE12345', teamId: '2GXNRP23GZ', privateKey };

const partes = (jwt) => jwt.split('.').map((p, i) =>
  i < 2 ? JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) : p);

describe('lib/apnsJwt', () => {
  beforeEach(() => _resetCacheJwt());

  it('arma un JWT ES256 con kid, iss e iat', () => {
    const [header, payload] = partes(tokenProveedor(CFG, 1_700_000_000_000));
    expect(header).toEqual({ alg: 'ES256', kid: 'ABCDE12345' });
    expect(payload.iss).toBe('2GXNRP23GZ');
    expect(payload.iat).toBe(1_700_000_000);
  });

  // Apple responde 429 TooManyProviderTokenUpdates si se regenera muy seguido.
  it('reusa el mismo token dentro de la ventana de 20 minutos', () => {
    const a = tokenProveedor(CFG, 1_700_000_000_000);
    const b = tokenProveedor(CFG, 1_700_000_000_000 + 19 * 60 * 1000);
    expect(b).toBe(a);
  });

  // Y Apple responde 403 ExpiredProviderToken si tiene más de una hora.
  it('regenera pasados los 20 minutos', () => {
    const a = tokenProveedor(CFG, 1_700_000_000_000);
    const b = tokenProveedor(CFG, 1_700_000_000_000 + 21 * 60 * 1000);
    expect(b).not.toBe(a);
  });

  it('regenera si cambia la clave, aunque esté dentro de la ventana', () => {
    const a = tokenProveedor(CFG, 1_700_000_000_000);
    const b = tokenProveedor({ ...CFG, keyId: 'ZZZZZ99999' }, 1_700_000_000_000 + 60_000);
    expect(b).not.toBe(a);
  });

  it('falla claro si falta configuración, en vez de firmar algo inservible', () => {
    expect(() => tokenProveedor({ keyId: '', teamId: '', privateKey: '' }))
      .toThrow(/APNS_KEY_ID|configuración/i);
  });
});
