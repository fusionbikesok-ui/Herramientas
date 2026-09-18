import { readFileSync } from 'node:fs';
import { leerSecretoProtegido } from '../seguridad/secreto.ts';
import { z } from 'zod';

export type Servicio = 'api' | 'worker' | 'scheduler';
/**
 * Barridos multi-cuenta (T3 C4): las cuentas salen de un registro en archivo, validado contra la base al
 * arrancar (`reconciliacion/registro.ts`); el worker no descubre cuentas desde la base.
 */
export interface ConfigBarridos {
  registroFile: string;
  keyringFile: string;
  /** Claves HMAC del plano de control hacia el gateway del legado. Separadas del keyring de sobres. */
  gatewayKeyringFile?: string;
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
/**
 * Informes diarios firmados (E1 T4). Todo o nada, igual que barridos y señales: sin estas variables el
 * scheduler no emite informes. Los secretos van en archivos sueltos (0600) y se leen al arrancar; nunca en
 * variables de entorno, donde quedarían visibles en `docker inspect` (diseño §9 bis).
 */
export interface ConfigInformes {
  claveFirmaFile: string;
  pendientesDir: string;
  clavePublicaUbicacion: string;
  b2: { endpoint: string; region: string; bucket: string; escritura: { id: string; clave: string }; lectura: { id: string; clave: string } };
  smtp: { host: string; puerto: number; seguro: boolean; usuario: string; clave: string; desde: string; para: string };
}
/**
 * Catálogo canónico (E2 T1). Tiene **su propio** keyring de sobres a propósito: el del worker se cargaba
 * sólo dentro de `if (config.barridos)`, así que el proyector no podía encenderse sin encender barridos,
 * que es exactamente al revés del orden de puesta en producción (primero el proyector con canario).
 *
 * Todo nace apagado. Los topes están pensados para no atropellar: el backlog son 3.490 mensajes de Woo
 * más 427 de ML, y el bootstrap comparte con los barridos el cupo del gateway del legado.
 */
export interface ConfigCatalogo {
  proyector: boolean;
  bootstrap: boolean;
  keyringFile: string;
  lote: number;
  pausaMs: number;
  /** 0 = sin límite. Con un número, el proyector se detiene ahí y deja un resumen para revisar. */
  canario: number;
  bootstrapRpm: number;
  /** Señales de ML reclamables a partir de las cuales el bootstrap cede una vuelta. */
  bootstrapCedeSenales: number;
  umbralErrorPorciento: number;
}
export interface Config {
  servicio: Servicio; instancia: string; version: string; pgUrl: string; apiPuerto: number;
  estadoPgDir: string; heartbeatMaxS: number; heartbeatIntervalMs: number;
  barridos?: ConfigBarridos;
  senales?: ConfigSenales;
  informes?: ConfigInformes;
  catalogo?: ConfigCatalogo;
}
export class ErrorConfig extends Error { override name = 'ErrorConfig'; }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CAMPOS_SENALES = ['SENALES_KEYRING_FILE', 'SENALES_CUENTAS', 'SENALES_ORIGENES'] as const;
const CAMPOS_BARRIDOS = ['BARRIDOS_REGISTRO_FILE', 'BARRIDOS_KEYRING_FILE'] as const;
const CAMPOS_INFORMES = [
  'INFORMES_CLAVE_FIRMA_FILE', 'INFORMES_PENDIENTES_DIR', 'INFORMES_CLAVE_PUBLICA_UBICACION',
  'B2_ENDPOINT', 'B2_REGION', 'B2_BUCKET',
  'B2_ESCRITURA_ID_FILE', 'B2_ESCRITURA_CLAVE_FILE', 'B2_LECTURA_ID_FILE', 'B2_LECTURA_CLAVE_FILE',
  'SMTP_HOST', 'SMTP_PUERTO', 'SMTP_USUARIO_FILE', 'SMTP_CLAVE_FILE', 'SMTP_DESDE', 'INFORMES_PARA',
] as const;

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
  BARRIDOS_GATEWAY_KEYRING_FILE: z.string().min(1).optional(),
  BARRIDOS_KEYRING_FILE: z.string().min(1).optional(),
  CATALOGO_PROYECTOR: z.string().min(1).optional(),
  CATALOGO_BOOTSTRAP: z.string().min(1).optional(),
  CATALOGO_KEYRING_FILE: z.string().min(1).optional(),
  // Los mínimos no son decoración: un lote o un rpm en 0 haría un bucle que no procesa nada y parece sano.
  CATALOGO_LOTE: z.coerce.number().int().min(1).max(500).default(20),
  CATALOGO_PAUSA_MS: z.coerce.number().int().min(0).default(1000),
  CATALOGO_CANARIO: z.coerce.number().int().min(0).default(0),
  CATALOGO_BOOTSTRAP_RPM: z.coerce.number().int().min(1).max(600).default(10),
  CATALOGO_BOOTSTRAP_CEDE_SENALES: z.coerce.number().int().min(0).default(20),
  CATALOGO_UMBRAL_ERROR: z.coerce.number().int().min(1).max(100).default(10),
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
  return {
    registroFile: env.BARRIDOS_REGISTRO_FILE!, keyringFile: env.BARRIDOS_KEYRING_FILE!,
    ...(env.BARRIDOS_GATEWAY_KEYRING_FILE ? { gatewayKeyringFile: env.BARRIDOS_GATEWAY_KEYRING_FILE } : {}),
  };
}

/**
 * El keyring es obligatorio en cuanto se enciende cualquiera de los dos: sin él no se descifra ningún
 * payload, y descubrirlo mensaje por mensaje manda todo el backlog a la DLQ.
 */
function leerCatalogo(v: z.infer<typeof Esquema>): ConfigCatalogo | undefined {
  const proyector = v.CATALOGO_PROYECTOR === '1';
  const bootstrap = v.CATALOGO_BOOTSTRAP === '1';
  if (!proyector && !bootstrap) return undefined;
  if (!v.CATALOGO_KEYRING_FILE) throw new ErrorConfig('el catálogo está encendido y falta CATALOGO_KEYRING_FILE');
  return {
    proyector, bootstrap, keyringFile: v.CATALOGO_KEYRING_FILE,
    lote: v.CATALOGO_LOTE, pausaMs: v.CATALOGO_PAUSA_MS, canario: v.CATALOGO_CANARIO,
    bootstrapRpm: v.CATALOGO_BOOTSTRAP_RPM, bootstrapCedeSenales: v.CATALOGO_BOOTSTRAP_CEDE_SENALES,
    umbralErrorPorciento: v.CATALOGO_UMBRAL_ERROR,
  };
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

function leerInformes(env: Record<string, string | undefined>, leerArchivo: (ruta: string) => string): ConfigInformes | undefined {
  const presentes = CAMPOS_INFORMES.filter((c) => env[c]);
  if (presentes.length === 0) return undefined;
  const faltantes = CAMPOS_INFORMES.filter((c) => !env[c]);
  if (faltantes.length) throw new ErrorConfig(`configuración de informes incompleta: ${faltantes.join(', ')}`);
  // Los secretos de B2 y SMTP se leen con las mismas guardas que la clave de firma (dueño, permisos, archivo
  // regular, directorio no escribible por otros): antes bastaba un readFileSync y un archivo montado con
  // permisos abiertos pasaba en silencio.
  const secreto = (campo: typeof CAMPOS_INFORMES[number]) => {
    const valor = leerArchivo(env[campo]!).trim();
    if (!valor) throw new ErrorConfig(`${campo} está vacío`);
    return valor;
  };
  const puerto = Number(env.SMTP_PUERTO);
  if (!Number.isInteger(puerto) || puerto <= 0) throw new ErrorConfig('SMTP_PUERTO inválido');
  return {
    claveFirmaFile: env.INFORMES_CLAVE_FIRMA_FILE!, pendientesDir: env.INFORMES_PENDIENTES_DIR!,
    clavePublicaUbicacion: env.INFORMES_CLAVE_PUBLICA_UBICACION!,
    b2: {
      endpoint: env.B2_ENDPOINT!, region: env.B2_REGION!, bucket: env.B2_BUCKET!,
      escritura: { id: secreto('B2_ESCRITURA_ID_FILE'), clave: secreto('B2_ESCRITURA_CLAVE_FILE') },
      lectura: { id: secreto('B2_LECTURA_ID_FILE'), clave: secreto('B2_LECTURA_CLAVE_FILE') },
    },
    smtp: {
      host: env.SMTP_HOST!, puerto, seguro: env.SMTP_SEGURO === 'true',
      usuario: secreto('SMTP_USUARIO_FILE'), clave: secreto('SMTP_CLAVE_FILE'),
      desde: env.SMTP_DESDE!, para: env.INFORMES_PARA!,
    },
  };
}

export function cargarConfig(env: NodeJS.ProcessEnv, leerArchivo: (ruta: string) => string = leerSecretoProtegido): Config {
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
  const informes = leerInformes(env, leerArchivo);
  const catalogo = leerCatalogo(e);
  return {
    servicio: e.SERVICIO, instancia: e.INSTANCIA, version: e.VERSION,
    pgUrl: `postgres://${encodeURIComponent(e.PG_USER)}:${encodeURIComponent(clave)}@${e.PG_HOST}:${e.PG_PORT}/${e.PG_DATABASE}`,
    apiPuerto: e.API_PUERTO, estadoPgDir: e.ESTADO_PG_DIR, heartbeatMaxS: e.HEARTBEAT_MAX_S, heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    ...(barridos ? { barridos } : {}),
    ...(senales ? { senales } : {}),
    ...(informes ? { informes } : {}),
    ...(catalogo ? { catalogo } : {}),
  };
}
