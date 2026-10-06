/*
 * src/worker/identidad.ts — E3 corte 1 tarea 4: el ciclo del motor en sombra dentro del worker.
 *
 * Mismo patrón que src/worker/catalogo.ts (setTimeout recursivo, una vuelta a la vez, se espera la
 * que está en curso al apagar). Se diferencia en el candado: correrMotor recorre TODAS las empresas
 * con casos abiertos en una sola vuelta (no hay lease por cuenta como en barridos), así que lo que
 * hay que evitar es que DOS INSTANCIAS del worker corran la vuelta al mismo tiempo — de ahí
 * pg_try_advisory_lock('identidad.motor'), tomado y soltado en la MISMA conexión dentro de la misma
 * vuelta (no una exclusión de sesión de todo el proceso, como scheduler/exclusion.ts): si esta
 * instancia no consigue el lock, no es un error, sólo significa que otra instancia ya está corriendo
 * su vuelta — se reintenta en la siguiente.
 */
import pg from 'pg';
import { correrMotor, type Logger } from '../identidad/motor.ts';

const LOCK = "hashtext('identidad.motor')";
const LOTE = 500;

export interface RegistroCicloIdentidad {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface CicloIdentidad {
  detener(): Promise<void>;
}

/** Empresas con al menos un caso abierto de los tipos que el motor procesa — no tiene sentido correrlo sobre empresas sin nada pendiente. */
async function empresasConCasosAbiertos(pool: pg.Pool): Promise<string[]> {
  const filas = (await pool.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM catalog.identity_cases
      WHERE cerrado_en IS NULL AND tipo = ANY($1)`,
    [['sku_pendiente', 'omitida_revisar', 'sku_inexistente_en_woo']])).rows;
  return filas.map((f) => f.company_id);
}

async function vuelta(pool: pg.Pool, log: RegistroCicloIdentidad): Promise<void> {
  const cliente = await pool.connect();
  try {
    const { rows: [lock] } = await cliente.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(${LOCK}) AS ok`);
    if (!lock?.ok) return; // otra instancia ya está corriendo su vuelta.
    try {
      const empresas = await empresasConCasosAbiertos(pool);
      const logMotor: Logger = {
        info: (msg, meta) => log.info({ ...meta }, msg),
        warn: (msg, meta) => log.info({ ...meta, nivel: 'warn' }, msg),
        error: (msg, meta) => log.error({ ...meta }, msg),
      };
      for (const empresa of empresas) {
        try {
          const r = await correrMotor(pool, { empresa, limite: LOTE, log: logMotor });
          if (r.casos > 0) log.info({ empresa, ...r }, 'vuelta del motor de identidad');
        } catch (error) {
          log.error({ empresa, err: (error as Error).message }, 'vuelta del motor de identidad falló');
        }
      }
    } finally {
      await cliente.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => undefined);
    }
  } finally {
    cliente.release();
  }
}

export function iniciarCicloIdentidad(pool: pg.Pool, pausaMs: number, log: RegistroCicloIdentidad): CicloIdentidad {
  let apagando = false;
  let temporizador: NodeJS.Timeout | null = null;
  let enCurso: Promise<void> = Promise.resolve();

  const programar = () => {
    if (apagando) return;
    temporizador = setTimeout(() => {
      enCurso = vuelta(pool, log).catch((error) => log.error({ err: (error as Error).message }, 'vuelta del motor de identidad falló')).finally(programar);
    }, pausaMs);
  };
  programar();

  return {
    async detener() {
      apagando = true;
      if (temporizador) clearTimeout(temporizador);
      await enCurso;
    },
  };
}
