import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inject } from 'vitest';
import { migrar } from '../../src/db/migrar.ts';

export interface BaseDePrueba {
  nombre: string;
  urlAdmin: string;
  urlMigrador: string;
  urlApp: string;
  borrar(): Promise<void>;
}

export async function crearBaseVacia(): Promise<BaseDePrueba> {
  const hostPort = inject('pgHostPort');
  const nombre = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${nombre} OWNER plataforma_migrador`);
  await admin.query(`REVOKE ALL ON DATABASE ${nombre} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${nombre} TO plataforma_app`);
  await admin.end();
  return {
    nombre,
    urlAdmin: `postgres://postgres:admin@${hostPort}/${nombre}`,
    urlMigrador: `postgres://plataforma_migrador:migrador@${hostPort}/${nombre}`,
    urlApp: `postgres://plataforma_app:app@${hostPort}/${nombre}`,
    async borrar() {
      const c = new pg.Client({ connectionString: inject('pgAdminUrl') });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`);
      await c.end();
    },
  };
}

export const DIR_MIGRACIONES = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function crearBaseDePrueba(): Promise<BaseDePrueba> {
  const base = await crearBaseVacia();
  await migrar(base.urlMigrador, DIR_MIGRACIONES);
  return base;
}
