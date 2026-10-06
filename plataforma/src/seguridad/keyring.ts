import { readFileSync, statSync } from 'node:fs';
import type { KeyringSobre } from './sobre.ts';

export class ErrorKeyring extends Error { override name = 'ErrorKeyring'; }

const ID_VALIDO = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Lee el keyring de sobres desde un archivo JSON fuera del repo y la base:
 * `{"activeKeyId":"k1","keys":{"k1":"<32 bytes en base64>"}}`.
 * Rechaza un archivo legible por grupo u otros: la clave es lo único que protege la PII de un backup.
 */
export function cargarKeyring(ruta: string, io: {
  leer?: (r: string) => string;
  modo?: (r: string) => number;
} = {}): KeyringSobre {
  const leer = io.leer ?? ((r) => readFileSync(r, 'utf8'));
  const modo = io.modo ?? ((r) => statSync(r).mode);

  if ((modo(ruta) & 0o077) !== 0) throw new ErrorKeyring(`el keyring ${ruta} es legible por grupo u otros`);

  let crudo: unknown;
  try { crudo = JSON.parse(leer(ruta)); } catch { throw new ErrorKeyring(`el keyring ${ruta} no es JSON válido`); }
  if (crudo === null || typeof crudo !== 'object' || Array.isArray(crudo)) throw new ErrorKeyring('el keyring no es un objeto');
  const { activeKeyId, keys } = crudo as { activeKeyId?: unknown; keys?: unknown };
  if (typeof activeKeyId !== 'string' || !ID_VALIDO.test(activeKeyId)) throw new ErrorKeyring('activeKeyId ausente o inválido');
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) throw new ErrorKeyring('keys ausente o inválido');

  const claves: Record<string, Buffer> = {};
  for (const [id, valor] of Object.entries(keys as Record<string, unknown>)) {
    if (!ID_VALIDO.test(id)) throw new ErrorKeyring(`id de clave inválido: ${id}`);
    if (typeof valor !== 'string') throw new ErrorKeyring(`la clave ${id} no es base64`);
    const bytes = Buffer.from(valor, 'base64');
    // Buffer.from ignora lo que no es base64: se compara el ida y vuelta para no aceptar basura.
    if (bytes.length !== 32 || bytes.toString('base64') !== valor.trim()) {
      throw new ErrorKeyring(`la clave ${id} debe ser 32 bytes en base64`);
    }
    claves[id] = bytes;
  }
  if (!claves[activeKeyId]) throw new ErrorKeyring(`la clave activa ${activeKeyId} no está en el keyring`);
  return { activeKeyId, keys: claves };
}
