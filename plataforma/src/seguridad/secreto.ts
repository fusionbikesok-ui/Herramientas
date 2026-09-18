/*
 * src/seguridad/secreto.ts — leer un secreto de disco con las guardas fuertes.
 *
 * Hasta el 2026-09-18 sólo la clave privada de firma verificaba dueño, permisos, tipo de archivo y directorio;
 * los secretos de Backblaze y de SMTP se leían con un `readFileSync` pelado, así que un archivo montado con
 * permisos abiertos se aceptaba en silencio (hallazgo alto de la revisión de T4). Es la misma clase de descuido
 * que causó el incidente del canario de ML: configuración que nadie contrasta.
 *
 * Las guardas son las de `informes/firma.ts`, y por el mismo motivo: se abre UN descriptor con O_NOFOLLOW y todo
 * lo demás —fstat y lectura— se hace sobre ese fd, nunca por ruta de nuevo, para que entre la comprobación y la
 * lectura nadie pueda cambiar qué archivo hay ahí.
 */
import { constants, closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export class ErrorSecreto extends Error { override name = 'ErrorSecreto'; }

export interface OpcionesSecreto {
  /** uid esperado del dueño; por omisión, el del proceso. */
  uidEsperado?: number;
  /** Máscara de permisos prohibidos. Por omisión 0o077: nada para grupo ni para otros. */
  prohibidos?: number;
}

/** Devuelve el contenido del archivo, o lanza `ErrorSecreto` si no cumple las guardas. */
export function leerSecretoProtegido(ruta: string, opciones: OpcionesSecreto = {}): string {
  if (!ruta) throw new ErrorSecreto('ruta de secreto vacía');
  // El directorio se verifica por ruta (no hay un descriptor propio que abrir acá): si es escribible por otros,
  // alguien puede reemplazar el archivo entero sin tocar sus permisos.
  if ((statSync(dirname(ruta)).mode & 0o022) !== 0) throw new ErrorSecreto(`el directorio de ${ruta} es escribible por otros`);

  let fd: number;
  try {
    fd = openSync(ruta, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new ErrorSecreto(`${ruta} no es un archivo regular`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ErrorSecreto(`${ruta} no es un archivo regular`);
    if ((st.mode & (opciones.prohibidos ?? 0o077)) !== 0) throw new ErrorSecreto(`el secreto ${ruta} es legible por grupo u otros`);
    const uid = opciones.uidEsperado ?? process.getuid?.() ?? st.uid;
    if (st.uid !== uid) throw new ErrorSecreto(`el secreto ${ruta} tiene otro dueño (uid ${st.uid})`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
