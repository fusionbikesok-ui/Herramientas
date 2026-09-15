import type pino from 'pino';
import type { Consultable } from '../db/pool.ts';
import type { Servicio } from './config.ts';

export async function registrarLatido(db: Consultable, servicio: Servicio, instancia: string, version: string): Promise<void> {
  await db.query(
    `INSERT INTO core.service_heartbeats (servicio, instancia, version, visto_en) VALUES ($1, $2, $3, now())
     ON CONFLICT (servicio) DO UPDATE SET instancia = EXCLUDED.instancia, version = EXCLUDED.version, visto_en = now()`,
    [servicio, instancia, version],
  );
}

export function iniciarLatidos(db: Consultable, servicio: Servicio, instancia: string, version: string, logger: pino.Logger, cadaMs = 30_000): () => void {
  let fallando = false;
  const latir = async () => {
    try {
      await registrarLatido(db, servicio, instancia, version);
      if (fallando) { logger.info('base de datos recuperada'); fallando = false; }
    } catch (error) {
      if (!fallando) { logger.error({ err: (error as Error).message }, 'no se pudo registrar el latido: base de datos caída'); fallando = true; }
    }
  };
  void latir();
  const timer = setInterval(() => void latir(), cadaMs);
  return () => clearInterval(timer);
}
