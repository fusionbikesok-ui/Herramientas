import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Consultable } from '../db/pool.ts';

/**
 * Registro de cuentas de canal (E1 T3 §7). Sustituye la configuración de cuenta única de T2.
 *
 * Cada entrada define UUID, canal, identificador externo, URL base del transporte y metadatos del canal.
 * `transporte` vale `gateway` por defecto: en producción la plataforma lee a través del legado (C5), que
 * es dueño de las credenciales. `directo` existe sólo para el simulador del ensayo.
 * **Nunca credenciales**: el esquema es cerrado, así que un `token`, `client_secret` o `consumer_key`
 * agregado por error hace fallar el arranque en vez de viajar a la plataforma (la plataforma no recibe
 * tokens ML ni consumer keys Woo; el legado es dueño exclusivo).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CuentaMl = z.strictObject({
  id: z.string().regex(UUID),
  channel: z.literal('mercadolibre'),
  external_account: z.string().min(1).max(256),
  base_url: z.url(),
  seller_id: z.string().regex(/^\d{1,20}$/),
  transporte: z.enum(['gateway', 'directo']).default('gateway'),
});
const CuentaWoo = z.strictObject({
  id: z.string().regex(UUID),
  channel: z.literal('woocommerce'),
  external_account: z.string().min(1).max(256),
  base_url: z.url(),
  transporte: z.enum(['gateway', 'directo']).default('gateway'),
});
const Registro = z.strictObject({
  version: z.literal(1),
  cuentas: z.array(z.discriminatedUnion('channel', [CuentaMl, CuentaWoo])).min(1),
});

export type CuentaRegistrada = z.infer<typeof CuentaMl> | z.infer<typeof CuentaWoo>;
export class ErrorRegistro extends Error { override name = 'ErrorRegistro'; }

export function parsearRegistro(crudo: unknown): readonly CuentaRegistrada[] {
  const r = Registro.safeParse(crudo);
  if (!r.success) {
    // Sólo rutas de campo: un valor mal puesto podría ser justamente un secreto.
    throw new ErrorRegistro(`registro de cuentas inválido: ${r.error.issues.map((i) => i.path.join('.') || '(raíz)').join(', ')}`);
  }
  const ids = new Set<string>(); const externas = new Set<string>();
  for (const c of r.data.cuentas) {
    const id = c.id.toLowerCase();
    if (ids.has(id)) throw new ErrorRegistro(`cuenta repetida en el registro: ${id}`);
    const externa = `${c.channel}|${c.external_account}`;
    if (externas.has(externa)) throw new ErrorRegistro(`cuenta externa repetida en el registro: ${c.channel}`);
    ids.add(id); externas.add(externa);
  }
  return r.data.cuentas.map((c) => ({ ...c, id: c.id.toLowerCase() }));
}

export function cargarRegistro(ruta: string, leer: (r: string) => string = (r) => readFileSync(r, 'utf8')): readonly CuentaRegistrada[] {
  let crudo: unknown;
  try { crudo = JSON.parse(leer(ruta)); } catch { throw new ErrorRegistro(`el registro ${ruta} no es JSON válido`); }
  return parsearRegistro(crudo);
}

/**
 * Cada cuenta del registro tiene que existir en `core.channel_accounts` con el mismo canal e identificador
 * externo. Un registro que apunta una URL de Woo a una cuenta ML haría que el worker escriba observaciones
 * de un canal bajo la cuenta de otro: se frena el arranque.
 */
export async function validarRegistroContraBase(db: Consultable, cuentas: readonly CuentaRegistrada[]): Promise<void> {
  const r = await db.query<{ id: string; channel: string; external_account: string }>(
    'SELECT id::text, channel, external_account FROM core.channel_accounts WHERE id = ANY($1::uuid[])',
    [cuentas.map((c) => c.id)],
  );
  const enBase = new Map(r.rows.map((f) => [f.id, f]));
  for (const c of cuentas) {
    const fila = enBase.get(c.id);
    if (!fila) throw new ErrorRegistro(`la cuenta ${c.id} del registro no existe en la base`);
    if (fila.channel !== c.channel || fila.external_account !== c.external_account) {
      throw new ErrorRegistro(`la cuenta ${c.id} del registro no coincide con la base en canal o identificador externo`);
    }
  }
}

/**
 * Contrasta las cuentas que acepta la API de señales (`SENALES_CUENTAS`) con las que consume el worker (el
 * registro). Tienen que ser exactamente las mismas: el 2026-09-17 la cuenta de ML faltaba en la API y en el
 * registro, y la plataforma rechazó TODAS las señales de ML durante cinco horas sin que nadie lo notara. Con
 * una cuenta sólo en la API, las señales se aceptan y nadie las consume; con una sólo en el registro, se
 * rechazan con 409. Devuelve la lista de diferencias, vacía si coinciden.
 */
export function contrastarCuentas(
  senales: ReadonlyMap<string, string>, registro: readonly CuentaRegistrada[],
): string[] {
  const diferencias: string[] = [];
  const enRegistro = new Map<string, string>(registro.map((c) => [c.channel, c.id]));
  for (const [canal, id] of senales) {
    const suya = enRegistro.get(canal);
    if (!suya) diferencias.push(`${canal} está en SENALES_CUENTAS pero no en el registro del worker: sus señales se aceptan y nadie las consume`);
    else if (suya !== id) diferencias.push(`${canal} tiene un uuid distinto en SENALES_CUENTAS y en el registro del worker`);
  }
  for (const [canal] of enRegistro) {
    if (!senales.has(canal)) diferencias.push(`${canal} está en el registro del worker pero no en SENALES_CUENTAS: sus señales se rechazan con 409`);
  }
  return diferencias;
}
