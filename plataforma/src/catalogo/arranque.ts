/*
 * src/catalogo/arranque.ts — qué keyring de sobres usa cada parte del worker.
 *
 * El defecto que esto arregla: `worker/main.ts` cargaba el keyring de sobres **dentro** de
 * `if (config.barridos)`, y de ahí salían el worker de señales y (ahora) el del catálogo. Consecuencia:
 * el proyector del catálogo no podía encenderse sin encender barridos, justo al revés del orden de puesta
 * en producción, donde el proyector va primero y con canario.
 *
 * Vive acá, como función pura, porque `worker/main.ts` tiene efectos al importarse (abre el pool, arranca
 * los latidos) y no se puede probar. La decisión sí, y es la que se equivocaba.
 */
import type { ConfigBarridos, ConfigCatalogo } from '../comun/config.ts';

export class ErrorArranqueCatalogo extends Error { override name = 'ErrorArranqueCatalogo'; }

export interface PlanDeKeyrings {
  /** Archivos a cargar, sin repetir: dos componentes que comparten archivo comparten keyring. */
  archivos: string[];
  /** Archivo del keyring con el que se descifran los payloads del inbox, o null si nadie lo necesita. */
  sobresFile: string | null;
  /** Archivo del keyring del catálogo, o null si el catálogo está apagado. */
  catalogoFile: string | null;
}

/**
 * Decide qué keyrings hay que cargar. Dos reglas:
 *
 *   1. El catálogo tiene el suyo y no depende de barridos. Puede ser el mismo archivo —hoy en producción
 *      lo será— pero eso es una decisión de configuración, no una dependencia del código.
 *   2. Si el catálogo está encendido sin keyring, se levanta acá y el worker no arranca. Un proyector sin
 *      keyring manda todo el backlog a la DLQ de a un mensaje, y eso se descubre tarde.
 */
export function planDeKeyrings(
  barridos: ConfigBarridos | undefined, catalogo: ConfigCatalogo | undefined,
): PlanDeKeyrings {
  const sobresFile = barridos?.keyringFile ?? null;
  const encendido = catalogo?.proyector === true || catalogo?.bootstrap === true;
  if (encendido && !catalogo?.keyringFile) {
    throw new ErrorArranqueCatalogo('el catálogo está encendido y no tiene keyring de sobres');
  }
  const catalogoFile = encendido ? catalogo!.keyringFile : null;
  const archivos = [...new Set([sobresFile, catalogoFile].filter((x): x is string => x !== null))];
  return { archivos, sobresFile, catalogoFile };
}
