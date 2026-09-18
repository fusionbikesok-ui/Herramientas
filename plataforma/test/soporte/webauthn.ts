/*
 * test/soporte/webauthn.ts — un autenticador WebAuthn virtual para los tests (E1-WA-01).
 *
 * Arma, byte por byte, lo que devolvería un teléfono o una llave USB: el clientDataJSON, los datos del
 * autenticador y la atestación "none" en CBOR al registrar, y la firma ECDSA P-256 sobre
 * `authenticatorData || sha256(clientDataJSON)` al autenticar. No usa la librería del servidor para nada: si
 * compartieran código, un error común pasaría en los dos lados.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// --- CBOR mínimo (RFC 8949): lo justo para la atestación y la clave COSE ---
interface CborMapa extends Map<number | string, Cbor> {}
type Cbor = number | string | Uint8Array | CborMapa | { [clave: string]: Cbor };

function cabecera(tipo: number, largo: number): Buffer {
  if (largo < 24) return Buffer.from([(tipo << 5) | largo]);
  if (largo < 0x100) return Buffer.from([(tipo << 5) | 24, largo]);
  if (largo < 0x10000) { const b = Buffer.alloc(3); b[0] = (tipo << 5) | 25; b.writeUInt16BE(largo, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (tipo << 5) | 26; b.writeUInt32BE(largo, 1); return b;
}

function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cabecera(0, v) : cabecera(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cabecera(3, b.length), b]); }
  if (v instanceof Uint8Array) return Buffer.concat([cabecera(2, v.length), Buffer.from(v)]);
  const entradas = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([cabecera(5, entradas.length), ...entradas.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

// Banderas de los datos del autenticador (WebAuthn §6.1).
const UP = 0x01; const UV = 0x04; const AT = 0x40;

export interface AutenticadorVirtual {
  credentialId: Buffer;
  /** Contador de firmas que informa; se puede fijar para probar la regla del contador. */
  contador: number;
  responderRegistro(opciones: { challenge: string }, extra?: { origen?: string; sinVerificacion?: boolean }): unknown;
  responderLogin(opciones: { challenge: string }, extra?: { origen?: string; userHandle?: string }): unknown;
}

export function crearAutenticador(cfg: { rpID: string; origin: string }): AutenticadorVirtual {
  const par = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privada: KeyObject = par.privateKey;
  const jwk = par.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  // Clave COSE EC2 (RFC 9053): kty=2, alg=ES256(-7), crv=P-256(1), x, y.
  const cose = cbor(new Map<number, Cbor>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
  const credentialId = randomBytes(32);

  const datosCliente = (tipo: string, challenge: string, origen: string) =>
    Buffer.from(JSON.stringify({ type: tipo, challenge, origin: origen, crossOrigin: false }), 'utf8');

  const autenticador: AutenticadorVirtual = {
    credentialId,
    contador: 0,

    responderRegistro(opciones, extra = {}) {
      const flags = UP | AT | (extra.sinVerificacion ? 0 : UV);
      const contador = Buffer.alloc(4); contador.writeUInt32BE(autenticador.contador);
      const largo = Buffer.alloc(2); largo.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(cfg.rpID), Buffer.from([flags]), contador, Buffer.alloc(16) /* aaguid nulo */, largo, credentialId, cose,
      ]);
      const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
      return {
        id: b64u(credentialId), rawId: b64u(credentialId), type: 'public-key', clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(datosCliente('webauthn.create', opciones.challenge, extra.origen ?? cfg.origin)),
          attestationObject: b64u(attestationObject), transports: ['internal'],
        },
      };
    },

    responderLogin(opciones, extra = {}) {
      const contador = Buffer.alloc(4); contador.writeUInt32BE(autenticador.contador);
      const authData = Buffer.concat([sha256(cfg.rpID), Buffer.from([UP | UV]), contador]);
      const clientData = datosCliente('webauthn.get', opciones.challenge, extra.origen ?? cfg.origin);
      // ECDSA sobre authenticatorData || sha256(clientDataJSON), en DER, que es lo que manda un autenticador.
      const firma = sign('sha256', Buffer.concat([authData, sha256(clientData)]), privada);
      return {
        id: b64u(credentialId), rawId: b64u(credentialId), type: 'public-key', clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(firma),
          ...(extra.userHandle ? { userHandle: extra.userHandle } : {}),
        },
      };
    },
  };
  return autenticador;
}
