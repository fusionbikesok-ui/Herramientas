import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

/**
 * Hallazgo de C9 (2026-09-16): con PostgreSQL reiniciado, las conexiones ociosas del pool mueren y `pg`
 * emite `error` sobre el Pool. Sin un manejador, Node lo trata como excepción no capturada y el proceso
 * (API, worker o scheduler) se cae: la API de señales nunca volvía y las pérdidas no se importaban.
 */
describe('pool de PostgreSQL ante conexiones que mueren', () => {
  let base: BaseDePrueba; let admin: pg.Client;
  beforeAll(async () => { base = await crearBaseDePrueba(); admin = new pg.Client({ connectionString: base.urlAdmin }); await admin.connect(); });
  afterAll(async () => { await admin.end(); await base.borrar(); });

  it('sobrevive a la muerte de una conexión ociosa y la siguiente consulta funciona', async () => {
    const errores: string[] = [];
    const pool = crearPool(base.urlApp, { alError: (e) => errores.push(e.message) });
    await pool.query('select 1');
    // La conexión quedó ociosa en el pool: se la mata desde el servidor, como hace un reinicio de PostgreSQL.
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and usename = 'plataforma_app'", [base.nombre]);
    await new Promise((r) => setTimeout(r, 300));
    expect(errores.length).toBeGreaterThan(0);
    expect((await pool.query<{ n: number }>('select 1 as n')).rows[0]?.n).toBe(1);
    await pool.end();
  });
});
