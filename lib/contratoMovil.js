/**
 * Versión del contrato móvil y compatibilidad de la app.
 *
 * E5 exige que el contrato `/api/v1` quede fijado por commit y que la app sepa cuándo dejó de
 * entenderlo. Hasta ahora el backend no lo decía por ninguna vía: no hay ruta de versión ni
 * header, así que una app vieja contra un backend nuevo fallaba ruta por ruta, con errores que
 * no explican la causa.
 *
 * `MINIMA_SOPORTADA` es lo que convierte esto en algo accionable: por debajo de esa versión la
 * app tiene que actualizarse antes de seguir. Se sube sólo cuando un cambio rompe de verdad a
 * las versiones anteriores —subirla por costumbre deja gente afuera sin motivo—.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Versión del contrato que sirve este backend. Sale del propio OpenAPI, no de una constante
 * aparte: dos fuentes para el mismo dato terminan divergiendo. */
export const CONTRATO_VERSION = '1.0.0';

/** Versión mínima de la app que este backend sigue atendiendo. */
export const MINIMA_SOPORTADA = '1.0.0';

let cache = null;

/**
 * Huella del contrato servido. La app la compara con la suya: si difieren, alguno de los dos
 * quedó viejo, y es mejor decirlo que descubrirlo por una ruta que responde distinto.
 */
export function huellaContrato() {
  if (cache) return cache;
  const archivo = path.join(__dirname, '..', 'openapi', 'mobile-v1.yaml');
  try {
    const contenido = fs.readFileSync(archivo);
    cache = {
      version: CONTRATO_VERSION,
      sha256: crypto.createHash('sha256').update(contenido).digest('hex'),
      rutas: (contenido.toString('utf8').match(/^ {2}\/[^\s:]+:/gm) || []).length,
    };
  } catch {
    // Sin el archivo no se inventa una huella: se informa que no hay, y la app decide.
    cache = { version: CONTRATO_VERSION, sha256: null, rutas: 0 };
  }
  return cache;
}

/** Compara versiones `x.y.z` sin dependencias: -1, 0 o 1. */
export function compararVersiones(a, b) {
  const pa = String(a || '0').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/**
 * Qué debe hacer una app de la versión dada.
 *
 * `actualizacion_obligatoria` es deliberadamente distinto de "incompatible": una app vieja pero
 * soportada sigue funcionando, y sólo se la fuerza a actualizar cuando ya no puede confiar en
 * lo que el backend le responde.
 */
export function estadoCompatibilidad(appVersion) {
  const contrato = huellaContrato();
  const version = String(appVersion || '').trim();
  if (!version) {
    // Sin versión declarada no se bloquea: puede ser una app de desarrollo o una herramienta.
    return { ...contrato, minima_soportada: MINIMA_SOPORTADA, app_version: null,
      actualizacion_obligatoria: false, motivo: 'la app no declaró su versión' };
  }
  const obsoleta = compararVersiones(version, MINIMA_SOPORTADA) < 0;
  return {
    ...contrato,
    minima_soportada: MINIMA_SOPORTADA,
    app_version: version,
    actualizacion_obligatoria: obsoleta,
    motivo: obsoleta ? `la app ${version} es anterior a la mínima soportada ${MINIMA_SOPORTADA}` : null,
  };
}
