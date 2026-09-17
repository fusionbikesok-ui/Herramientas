/*
 * src/informes/firma.ts — firma Ed25519 de la evidencia diaria.
 *
 * La privada nunca sale del VPS y se valida como en `src/seguridad/keyring.ts`, pero más estricto: la
 * revisión externa del 2026-09-17 (hallazgo 7) mostró que mirar sólo los bits de grupo y otros deja pasar
 * un enlace simbólico o un directorio padre escribible por cualquiera.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Sobre { version: 1; kid: string; firma: string; contenido: unknown }
export class ErrorFirma extends Error { override name = 'ErrorFirma'; }

import { canonizar } from './jcs.ts';

const KID = /^[A-Za-z0-9._-]{1,64}$/;

export function cargarClaveFirma(ruta: string, io: { uidEsperado?: number } = {}): { kid: string; privada: KeyObject } {
  // El directorio se sigue verificando por ruta (no tiene un descriptor propio que abrir acá):
  // si es escribible por otros, alguien puede reemplazar el archivo entero sin tocar sus permisos.
  if ((statSync(dirname(ruta)).mode & 0o022) !== 0) throw new ErrorFirma(`el directorio de ${ruta} es escribible por otros`);

  // TOCTOU: si las guardas (tipo, permisos, dueño) se hacen sobre la ruta y el contenido se lee
  // después con una llamada separada, entre medio alguien puede cambiar qué archivo hay en esa
  // ruta (reemplazarlo o convertirlo en un enlace simbólico) y `cargarClaveFirma` terminaría
  // firmando con una clave que nunca pasó las guardas. Por eso se abre un único descriptor con
  // O_NOFOLLOW (rechaza un enlace simbólico ahí mismo, sin necesidad de un lstat previo) y todo
  // lo demás —fstat y lectura— se hace sobre ESE fd, nunca por ruta de nuevo.
  let fd: number;
  try {
    fd = openSync(ruta, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new ErrorFirma(`${ruta} no es un archivo regular`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ErrorFirma(`${ruta} no es un archivo regular`);
    if ((st.mode & 0o077) !== 0) throw new ErrorFirma(`la clave ${ruta} es legible por grupo u otros`);
    const uid = io.uidEsperado ?? process.getuid?.() ?? st.uid;
    if (st.uid !== uid) throw new ErrorFirma(`la clave ${ruta} tiene otro dueño (uid ${st.uid})`);

    const crudo = readFileSync(fd, 'utf8');
    const kid = /^kid:\s*(\S+)\s*$/m.exec(crudo)?.[1];
    if (!kid || !KID.test(kid)) throw new ErrorFirma(`la clave ${ruta} no declara un kid válido`);
    const pem = crudo.slice(crudo.indexOf('-----BEGIN'));
    const privada = createPrivateKey(pem);
    if (privada.asymmetricKeyType !== 'ed25519') throw new ErrorFirma('la clave no es Ed25519');
    return { kid, privada };
  } finally {
    closeSync(fd);
  }
}

export function firmar(contenido: unknown, clave: { kid: string; privada: KeyObject }): Sobre {
  const bytes = Buffer.from(canonizar(contenido), 'utf8');
  return { version: 1, kid: clave.kid, firma: sign(null, bytes, clave.privada).toString('base64'), contenido };
}

export function verificar(sobre: unknown, publicas: Record<string, string>): { valido: boolean; motivo?: string; contenido?: unknown } {
  if (sobre === null || typeof sobre !== 'object') return { valido: false, motivo: 'sobre_invalido' };
  const { version, kid, firma, contenido } = sobre as Partial<Sobre>;
  if (version !== 1 || typeof kid !== 'string' || typeof firma !== 'string') return { valido: false, motivo: 'sobre_invalido' };
  const pem = publicas[kid];
  if (!pem) return { valido: false, motivo: 'kid_desconocido' };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(canonizar(contenido), 'utf8'), createPublicKey(pem), Buffer.from(firma, 'base64'));
  } catch { return { valido: false, motivo: 'firma_invalida' }; }
  return ok ? { valido: true, contenido } : { valido: false, motivo: 'firma_invalida' };
}

export function huella(publicaPem: string): string {
  const spki = createPublicKey(publicaPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}
