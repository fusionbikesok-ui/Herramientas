import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type Servicio = 'api' | 'worker' | 'scheduler';
/**
 * Barridos de una única cuenta de ensayo (T2): el worker no descubre cuentas ni credenciales desde la
 * base. El multi-cuenta con credenciales reales pertenece al tramo 3.
 */
export interface ConfigBarridos {
  cuenta: string;
  mlUrl: string;
  wooUrl: string;
  mlSeller: string;
  keyringFile: string;
}
export interface Config {
  servicio: Servicio; instancia: string; version: string; pgUrl: string; apiPuerto: number;
  estadoPgDir: string; heartbeatMaxS: number; heartbeatIntervalMs: number;
  barridos?: ConfigBarridos;
}
export class ErrorConfig extends Error { override name = 'ErrorConfig'; }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CAMPOS_BARRIDOS = ['BARRIDOS_CUENTA', 'BARRIDOS_ML_URL', 'BARRIDOS_WOO_URL', 'BARRIDOS_ML_SELLER', 'BARRIDOS_KEYRING_FILE'] as const;

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
  BARRIDOS_CUENTA: z.string().min(1).optional(),
  BARRIDOS_ML_URL: z.string().min(1).optional(),
  BARRIDOS_WOO_URL: z.string().min(1).optional(),
  BARRIDOS_ML_SELLER: z.string().min(1).optional(),
  BARRIDOS_KEYRING_FILE: z.string().min(1).optional(),
});

/** Todo o nada: media configuración de barridos haría arrancar un worker que no barre nada. */
function leerBarridos(env: Record<string, string | undefined>): ConfigBarridos | undefined {
  const presentes = CAMPOS_BARRIDOS.filter((c) => env[c]);
  if (presentes.length === 0) return undefined;
  const faltantes = CAMPOS_BARRIDOS.filter((c) => !env[c]);
  if (faltantes.length) throw new ErrorConfig(`configuración de barridos incompleta: ${faltantes.join(', ')}`);
  const cuenta = env.BARRIDOS_CUENTA!;
  if (!UUID.test(cuenta)) throw new ErrorConfig('BARRIDOS_CUENTA no es un uuid');
  return {
    cuenta, mlUrl: env.BARRIDOS_ML_URL!, wooUrl: env.BARRIDOS_WOO_URL!,
    mlSeller: env.BARRIDOS_ML_SELLER!, keyringFile: env.BARRIDOS_KEYRING_FILE!,
  };
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
  return {
    servicio: e.SERVICIO, instancia: e.INSTANCIA, version: e.VERSION,
    pgUrl: `postgres://${encodeURIComponent(e.PG_USER)}:${encodeURIComponent(clave)}@${e.PG_HOST}:${e.PG_PORT}/${e.PG_DATABASE}`,
    apiPuerto: e.API_PUERTO, estadoPgDir: e.ESTADO_PG_DIR, heartbeatMaxS: e.HEARTBEAT_MAX_S, heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    ...(barridos ? { barridos } : {}),
  };
}
