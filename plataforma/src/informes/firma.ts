/*
 * src/informes/firma.ts — firma Ed25519 de la evidencia diaria.
 *
 * La privada nunca sale del VPS y se valida como en `src/seguridad/keyring.ts`, pero más estricto: la
 * revisión externa del 2026-09-17 (hallazgo 7) mostró que mirar sólo los bits de grupo y otros deja pasar
 * un enlace simbólico o un directorio padre escribible por cualquiera.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Sobre { version: 1; kid: string; firma: string; contenido: unknown }
export class ErrorFirma extends Error { override name = 'ErrorFirma'; }

import { canonizar } from './jcs.ts';

const KID = /^[A-Za-z0-9._-]{1,64}$/;

export function cargarClaveFirma(ruta: string, io: { uidEsperado?: number } = {}): { kid: string; privada: KeyObject } {
  const st = lstatSync(ruta);
  if (!st.isFile()) throw new ErrorFirma(`${ruta} no es un archivo regular`);
  if ((st.mode & 0o077) !== 0) throw new ErrorFirma(`la clave ${ruta} es legible por grupo u otros`);
  const uid = io.uidEsperado ?? process.getuid?.() ?? st.uid;
  if (st.uid !== uid) throw new ErrorFirma(`la clave ${ruta} tiene otro dueño (uid ${st.uid})`);
  // Un directorio escribible por otros permite reemplazar la clave entera: no alcanza con el archivo.
  if ((statSync(dirname(ruta)).mode & 0o022) !== 0) throw new ErrorFirma(`el directorio de ${ruta} es escribible por otros`);

  const crudo = readFileSync(ruta, 'utf8');
  const kid = /^kid:\s*(\S+)\s*$/m.exec(crudo)?.[1];
  if (!kid || !KID.test(kid)) throw new ErrorFirma(`la clave ${ruta} no declara un kid válido`);
  const pem = crudo.slice(crudo.indexOf('-----BEGIN'));
  const privada = createPrivateKey(pem);
  if (privada.asymmetricKeyType !== 'ed25519') throw new ErrorFirma('la clave no es Ed25519');
  return { kid, privada };
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
