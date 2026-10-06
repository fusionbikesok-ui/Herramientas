import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface ContextoSobre {
  account: string;
  topic: string;
  resource: string;
  remoteVersion: string;
}

export interface SobreCifrado {
  keyId: string;
  nonce: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export interface KeyringSobre {
  activeKeyId: string;
  keys: Readonly<Record<string, Buffer>>;
}

function clave(keyring: KeyringSobre, keyId: string): Buffer {
  const key = keyring.keys[keyId];
  if (!key) throw new Error(`clave de sobre desconocida: ${keyId}`);
  if (key.length !== 32) throw new Error(`clave de sobre ${keyId} debe tener 32 bytes`);
  return key;
}

export function aadSobre(c: ContextoSobre): Buffer {
  return Buffer.from(`v1\0${c.account}\0${c.topic}\0${c.resource}\0${c.remoteVersion}`, 'utf8');
}

export function cifrarSobre(payload: Buffer, contexto: ContextoSobre, keyring: KeyringSobre): SobreCifrado {
  if (payload.length === 0) throw new Error('el payload del sobre no puede estar vacío');
  const keyId = keyring.activeKeyId;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', clave(keyring, keyId), nonce);
  cipher.setAAD(aadSobre(contexto));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return { keyId, nonce, tag: cipher.getAuthTag(), ciphertext };
}

export function descifrarSobre(sobre: SobreCifrado, contexto: ContextoSobre, keyring: KeyringSobre): Buffer {
  if (sobre.nonce.length !== 12 || sobre.tag.length !== 16 || sobre.ciphertext.length === 0) {
    throw new Error('sobre cifrado inválido');
  }
  const decipher = createDecipheriv('aes-256-gcm', clave(keyring, sobre.keyId), sobre.nonce);
  decipher.setAAD(aadSobre(contexto));
  decipher.setAuthTag(sobre.tag);
  return Buffer.concat([decipher.update(sobre.ciphertext), decipher.final()]);
}
