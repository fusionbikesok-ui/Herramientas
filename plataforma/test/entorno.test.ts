import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearPool, enTransaccion } from '../src/db/pool.ts';
import { crearBaseVacia, type BaseDePrueba } from './soporte/base.ts';

describe('entorno de pruebas', () => {
  let base: BaseDePrueba;
  beforeAll(async () => { base = await crearBaseVacia(); });
  afterAll(async () => { await base.borrar(); });

  it('conecta como migrador a PostgreSQL 18', async () => {
    const pool = crearPool(base.urlMigrador);
    const r = await pool.query<{ v: string }>("select current_setting('server_version_num') as v");
    expect(Number(r.rows[0]?.v)).toBeGreaterThanOrEqual(180000);
    await pool.end();
  });

  it('enTransaccion hace rollback ante error', async () => {
    const pool = crearPool(base.urlMigrador);
    await pool.query('create table tx_prueba(x int)');
    await expect(enTransaccion(pool, async (tx) => { await tx.query('insert into tx_prueba values (1)'); throw new Error('falla'); })).rejects.toThrow('falla');
    const r = await pool.query<{ n: string }>('select count(*) as n from tx_prueba');
    expect(r.rows[0]?.n).toBe('0');
    await pool.end();
  });
});
