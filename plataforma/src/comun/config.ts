import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type Servicio = 'api' | 'worker' | 'scheduler';
/**
 * Barridos multi-cuenta (T3 C4): las cuentas salen de un registro en archivo, validado contra la base al
 * arrancar (`reconciliacion/registro.ts`); el worker no descubre cuentas desde la base.
 */
export interface ConfigBarridos {
  registroFile: string;
  keyringFile: string;
}
/**
 * API interna de señales (T3 C3). Todo o nada, igual que barridos: sin estas tres variables la ruta no
 * existe. `cuentas` es "mercadolibre=<uuid>,woocommerce=<uuid>": la cuenta la decide el servidor.
 */
export interface ConfigSenales {
  keyringFile: string;
  cuentas: ReadonlyMap<'mercadolibre' | 'woocommerce', string>;
  origenes: string;
}
export interface Config {
  servicio: Servicio; instancia: string; version: string; pgUrl: string; apiPuerto: number;
  estadoPgDir: string; heartbeatMaxS: number; heartbeatIntervalMs: number;
  barridos?: ConfigBarridos;
  senales?: ConfigSenales;
}
export class ErrorConfig extends Error { override name = 'ErrorConfig'; }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CAMPOS_SENALES = ['SENALES_KEYRING_FILE', 'SENALES_CUENTAS', 'SENALES_ORIGENES'] as const;
const CAMPOS_BARRIDOS = ['BARRIDOS_REGISTRO_FILE', 'BARRIDOS_KEYRING_FILE'] as const;

const Esquema = z.object({
  SERVICIO: z.enum(['api', 'worker', 'scheduler', 'migrate']),
  INSTANCIA: z.string().min(1),
  VERSION: z.string().min(1),
  PG_HOST: z.string().min(1),
  PG_PORT: z.coerce.number().int().positive(),
  PG_DATABASE: z.string().min(1),
  PG_USER: z.string().min(1),
  PG_PASSWORD: z.string().min(1).optional(),
  PG_PASSWORD_FILE: z.string().min(1).optional(),
  API_PUERTO: z.coerce.number().int().positive().default(3201),
  ESTADO_PG_DIR: z.string().min(1).default('/estado-pg'),
  HEARTBEAT_MAX_S: z.coerce.number().int().min(1).default(120),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(100).default(30_000),
  BARRIDOS_REGISTRO_FILE: z.string().min(1).optional(),
  BARRIDOS_KEYRING_FILE: z.string().min(1).optional(),
});

/** Todo o nada: media configuración de barridos haría arrancar un worker que no barre nada. */
function leerBarridos(env: Record<string, string | undefined>): ConfigBarridos | undefined {
  const presentes = CAMPOS_BARRIDOS.filter((c) => env[c]);
  if (presentes.length === 0) return undefined;
  const faltantes = CAMPOS_BARRIDOS.filter((c) => !env[c]);
  if (faltantes.length) throw new ErrorConfig(`configuración de barridos incompleta: ${faltantes.join(', ')}`);
  // Las variables T2 de cuenta única ya no existen: dejarlas puestas indica una configuración vieja.
  const viejas = ['BARRIDOS_CUENTA', 'BARRIDOS_ML_URL', 'BARRIDOS_WOO_URL', 'BARRIDOS_ML_SELLER'].filter((c) => env[c]);
  if (viejas.length) throw new ErrorConfig(`variables de cuenta única de T2 ya no soportadas: ${viejas.join(', ')}`);
  return { registroFile: env.BARRIDOS_REGISTRO_FILE!, keyringFile: env.BARRIDOS_KEYRING_FILE! };
}

function leerSenales(env: Record<string, string | undefined>): ConfigSenales | undefined {
  const presentes = CAMPOS_SENALES.filter((c) => env[c]);
  if (presentes.length === 0) return undefined;
  const faltantes = CAMPOS_SENALES.filter((c) => !env[c]);
  if (faltantes.length) throw new ErrorConfig(`configuración de señales incompleta: ${faltantes.join(', ')}`);
  const cuentas = new Map<'mercadolibre' | 'woocommerce', string>();
  for (const par of env.SENALES_CUENTAS!.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [canal, uuid] = par.split('=');
    if ((canal !== 'mercadolibre' && canal !== 'woocommerce') || !uuid || !UUID.test(uuid) || cuentas.has(canal)) {
      throw new ErrorConfig('SENALES_CUENTAS inválida: se espera canal=uuid sin repetir canal');
    }
    cuentas.set(canal, uuid);
  }
  if (!cuentas.size) throw new ErrorConfig('SENALES_CUENTAS vacía');
  return { keyringFile: env.SENALES_KEYRING_FILE!, cuentas, origenes: env.SENALES_ORIGENES! };
}

export function cargarConfig(env: NodeJS.ProcessEnv, leerArchivo: (ruta: string) => string = (r) => readFileSync(r, 'utf8')): Config {
  const r = Esquema.safeParse(env);
  if (!r.success) {
    const campos = r.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ErrorConfig(`configuración inválida o incompleta: ${campos}`);
  }
  const e = r.data;
  if (e.SERVICIO === 'migrate') throw new ErrorConfig('SERVICIO=migrate usa src/db/cli-migrar.ts');
  if (!e.PG_PASSWORD && !e.PG_PASSWORD_FILE) throw new ErrorConfig('configuración inválida o incompleta: PG_PASSWORD_FILE');
  const clave = e.PG_PASSWORD ?? leerArchivo(e.PG_PASSWORD_FILE ?? '').trim();
  if (!clave) throw new ErrorConfig('PG_PASSWORD_FILE está vacío');
  const barridos = leerBarridos(env);
  const senales = leerSenales(env);
  return {
    servicio: e.SERVICIO, instancia: e.INSTANCIA, version: e.VERSION,
    pgUrl: `postgres://${encodeURIComponent(e.PG_USER)}:${encodeURIComponent(clave)}@${e.PG_HOST}:${e.PG_PORT}/${e.PG_DATABASE}`,
    apiPuerto: e.API_PUERTO, estadoPgDir: e.ESTADO_PG_DIR, heartbeatMaxS: e.HEARTBEAT_MAX_S, heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    ...(barridos ? { barridos } : {}),
    ...(senales ? { senales } : {}),
  };
}
