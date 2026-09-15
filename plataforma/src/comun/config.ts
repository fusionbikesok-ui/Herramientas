import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type Servicio = 'api' | 'worker' | 'scheduler';
export interface Config { servicio: Servicio; instancia: string; version: string; pgUrl: string; apiPuerto: number; estadoPgDir: string }
export class ErrorConfig extends Error { override name = 'ErrorConfig'; }

const Esquema = z.object({
  SERVICIO: z.enum(['api', 'worker', 'scheduler', 'migrate']),
  INSTANCIA: z.string().min(1),
  VERSION: z.string().min(1),
  PG_HOST: z.string().min(1),
  PG_PORT: z.coerce.number().int().positive(),
  PG_DATABASE: z.string().min(1),
  PG_USER: z.string().min(1),
  PG_PASSWORD_FILE: z.string().min(1),
  API_PUERTO: z.coerce.number().int().positive().default(3201),
  ESTADO_PG_DIR: z.string().min(1).default('/estado-pg'),
});

export function cargarConfig(env: NodeJS.ProcessEnv, leerArchivo: (ruta: string) => string = (r) => readFileSync(r, 'utf8')): Config {
  const r = Esquema.safeParse(env);
  if (!r.success) {
    const campos = r.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ErrorConfig(`configuración inválida o incompleta: ${campos}`);
  }
  const e = r.data;
  if (e.SERVICIO === 'migrate') throw new ErrorConfig('SERVICIO=migrate usa src/db/cli-migrar.ts');
  const clave = leerArchivo(e.PG_PASSWORD_FILE).trim();
  if (!clave) throw new ErrorConfig('PG_PASSWORD_FILE está vacío');
  return {
    servicio: e.SERVICIO, instancia: e.INSTANCIA, version: e.VERSION,
    pgUrl: `postgres://${encodeURIComponent(e.PG_USER)}:${encodeURIComponent(clave)}@${e.PG_HOST}:${e.PG_PORT}/${e.PG_DATABASE}`,
    apiPuerto: e.API_PUERTO, estadoPgDir: e.ESTADO_PG_DIR,
  };
}
