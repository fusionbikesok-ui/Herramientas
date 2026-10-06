/*
 * src/identidad/formato.ts — E3 corte 3 tarea 1: estructura de una publicación de ML y su observación.
 *
 * «Formato/pack» (D4, spec §6) son los campos ESTRUCTURALES de un ítem de ML: tipo de publicación, si es
 * catálogo, pack y variaciones — todo lo que distingue "qué se está vendiendo, empaquetado cómo" de precio,
 * stock, título o fechas, que cambian todo el tiempo sin que la publicación deje de ser la misma cosa. El
 * hash de esta estructura es lo que el canario compara entre el congelado y la relectura (Tarea 2): si
 * cambia, ya no es seguro aplicar el auto-SKU sin que un humano lo mire.
 *
 * ATRIBUTOS_PACK: PROVISIONAL. Falta el Paso 0 de la Tarea 1 del plan (verificar contra 30 payloads reales
 * de integrations.inbox_messages, en una copia descartable de la base) — no se corrió en esta entrega
 * porque requiere manejar un dump de producción y el keyring, y José no estaba disponible para autorizarlo
 * (decisión de opt-55, 2026-09-25). La lista de abajo son los nombres típicos de atributo de ML para
 * cantidad por pack / formato de venta, tomados del propio plan como ejemplo, sin confirmar contra datos
 * reales. BLOQUEANTE para la Tarea 5 (canario): no correr `congelar`/`correr` en producción hasta que
 * alguien confirme esta lista contra payloads reales y, si hace falta, la corrija.
 */
import { createHash } from 'node:crypto';
import { canonizar } from '../informes/jcs.ts';
import type { Consultable } from '../db/pool.ts';

export const ATRIBUTOS_PACK: readonly string[] = ['UNITS_PER_PACK', 'SALE_FORMAT', 'PACKAGE_UNITS'];

export interface VariacionEstructura {
  id: string;
  combinacion: string[];
  sku_vendedor: string | null;
}

export interface EstructuraMl {
  listing_type_id: string | null;
  catalog_listing: boolean;
  buying_mode: string | null;
  sku_vendedor: string | null;
  variaciones: VariacionEstructura[];
  pack: Record<string, string>;
}

type Registro = Record<string, unknown>;
const esRegistro = (x: unknown): x is Registro => typeof x === 'object' && x !== null && !Array.isArray(x);
const texto = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');

/**
 * El SKU declarado de UNA representación (ítem simple o variación): atributo SELLER_SKU o
 * `seller_custom_field`, el mismo criterio que ya usa `skuMl` (`catalogo/ml.ts`) — se reusa esa función en
 * vez de reimplementar la regla acá; ver la nota bajo el objetivo del plan.
 */
function skuVendedorDe(r: Registro): string | null {
  const atributos = Array.isArray(r.attributes) ? r.attributes.filter(esRegistro) : [];
  const atributo = atributos.find((a) => texto(a.id) === 'SELLER_SKU');
  const valor = (texto(atributo?.value_name) || texto(r.seller_custom_field)).trim();
  return valor || null;
}

function combinacionDe(v: Registro): string[] {
  const combinaciones = Array.isArray(v.attribute_combinations) ? v.attribute_combinations.filter(esRegistro) : [];
  return combinaciones
    .map((a) => `${texto(a.id)}=${texto(a.value_id) || texto(a.value_name)}`)
    .sort();
}

function packDe(r: Registro): Record<string, string> {
  const atributos = Array.isArray(r.attributes) ? r.attributes.filter(esRegistro) : [];
  const pack: Record<string, string> = {};
  for (const a of atributos) {
    const id = texto(a.id);
    if (!ATRIBUTOS_PACK.includes(id)) continue;
    pack[id] = texto(a.value_name) || texto(a.value_id);
  }
  return pack;
}

/** Estructura de un ítem de ML, tal como lo guardó el inbox (el payload crudo, no ya proyectado). */
export function estructuraItemMl(payload: unknown): EstructuraMl {
  const p = esRegistro(payload) ? payload : {};
  const variacionesRaw = Array.isArray(p.variations) ? p.variations.filter(esRegistro) : [];
  const variaciones: VariacionEstructura[] = variacionesRaw
    .map((v) => ({ id: texto(v.id), combinacion: combinacionDe(v), sku_vendedor: skuVendedorDe(v) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    listing_type_id: texto(p.listing_type_id) || null,
    catalog_listing: p.catalog_listing === true,
    buying_mode: texto(p.buying_mode) || null,
    sku_vendedor: variaciones.length ? null : skuVendedorDe(p),
    variaciones,
    pack: packDe(p),
  };
}

export function hashEstructura(e: EstructuraMl): string {
  return createHash('sha256').update(canonizar(e), 'utf8').digest('hex');
}

export type ResultadoRegistrarFormato = { resultado: 'nueva' | 'igual'; que: null } | { resultado: 'cambio'; que: 'sku' | 'formato' };

interface FilaUltimaObservacion {
  hash_estructura: string;
  seller_sku: string | null;
  variaciones: VariacionEstructura[] | null;
}

/**
 * La "firma" de SKU declarado de una estructura completa: el del ítem cuando no tiene variaciones, o el de
 * CADA variación (id + su sku_vendedor) cuando sí las tiene — un ítem con variaciones no trae SKU propio
 * (ver estructuraItemMl), así que comparar sólo `sku_vendedor` (que ahí siempre es null) no detecta que
 * cambió el SKU de una variación (hallazgo Alto de la segunda opinión de Codex, 2026-09-25).
 */
function firmaSku(e: { sku_vendedor: string | null; variaciones: VariacionEstructura[] }): string {
  if (!e.variaciones.length) return e.sku_vendedor ?? '';
  return e.variaciones.map((v) => `${v.id}=${v.sku_vendedor ?? ''}`).join('|');
}

/**
 * Registra una observación de formato si difiere de la última (la tabla es historia de CAMBIOS, no un log
 * por lectura). El advisory lock por clave (cuenta+recurso) serializa dos llamadas concurrentes para la
 * MISMA clave (un barrido y una relectura del canario solapados, por ejemplo): sin él, las dos podrían leer
 * la misma "última" fila antes de que ninguna inserte, y las dos se verían a sí mismas como la primera en
 * detectar el cambio. Se toma con `pg_advisory_xact_lock` (se libera solo al cierre de la transacción, sin
 * unlock explícito) — mismo patrón que `aplicar.ts`/`decisiones.ts`.
 */
export async function registrarFormato(
  tx: Consultable,
  o: { cuenta: string; recurso: string; estructura: EstructuraMl; versionRemota: string | null; origen: 'barrido' | 'relectura' },
): Promise<ResultadoRegistrarFormato> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('identidad.formato:' || $1 || ':' || $2, 0))", [o.cuenta, o.recurso]);

  const hash = hashEstructura(o.estructura);
  const previa = (await tx.query<FilaUltimaObservacion>(
    `SELECT hash_estructura, seller_sku, variaciones FROM catalog.format_observations
      WHERE channel_account_id = $1 AND recurso = $2
      ORDER BY observado_en DESC, id DESC LIMIT 1`,
    [o.cuenta, o.recurso])).rows[0];

  let resultado: ResultadoRegistrarFormato;
  if (!previa) {
    resultado = { resultado: 'nueva', que: null };
  } else if (previa.hash_estructura === hash) {
    resultado = { resultado: 'igual', que: null };
  } else {
    // Precedencia si cambiaron SKU y formato a la vez (hallazgo de la segunda opinión de Codex, 2026-09-25):
    // 'sku' gana — un SKU declarado distinto es la señal más fuerte de que la publicación cambió de qué está
    // vendiendo, y es la que la Tarea 6 necesita para decidir si reabre por 'sku_cambiado' en vez de pausar.
    // La comparación usa firmaSku (ítem sin variaciones: su propio SKU; con variaciones: el de CADA una),
    // no sólo `seller_sku` (que siempre es null en un ítem con variaciones — ver el comentario de firmaSku).
    const firmaPrevia = firmaSku({ sku_vendedor: previa.seller_sku, variaciones: previa.variaciones ?? [] });
    const cambioSku = firmaPrevia !== firmaSku(o.estructura);
    resultado = { resultado: 'cambio', que: cambioSku ? 'sku' : 'formato' };
  }

  if (resultado.resultado !== 'igual') {
    await tx.query(
      `INSERT INTO catalog.format_observations
         (channel_account_id, recurso, hash_estructura, estructura, version_remota, variaciones, cantidad_pack,
          listing_type, catalog_listing, seller_sku, origen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        o.cuenta, o.recurso, hash, JSON.stringify(o.estructura), o.versionRemota,
        JSON.stringify(o.estructura.variaciones),
        // Valor CRUDO del primer atributo de pack presente (p.ej. '2', '2 unidades'), o NULL si no es un
        // pack — columna informativa (spec §4), no de decisión: no participa del hash ni de ninguna
        // comparación. Corrección sobre la primera versión de esta entrega (hallazgo Bajo de la segunda
        // opinión de Codex, aceptado por opt-55, 2026-09-25): antes guardaba la CANTIDAD de atributos de
        // pack (0/1/2...), que un nombre de columna "cantidad_pack" induce a leer como la cantidad por pack
        // del propio atributo — engañoso. No se parsea a número: el plan no define esa conversión.
        Object.values(o.estructura.pack)[0] ?? null,
        o.estructura.listing_type_id, o.estructura.catalog_listing, o.estructura.sku_vendedor, o.origen,
      ]);
  }
  return resultado;
}
