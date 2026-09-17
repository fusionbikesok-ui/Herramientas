import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './base.ts';
import { limpiar, sembrar } from './fixtures.ts';

describe('fixtures', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('siembra empresa, las dos cuentas de canal y un usuario', async () => {
    const s = await sembrar(pool);
    expect(s.companyId).toMatch(/^[0-9a-f-]{36}$/);
    const cuentas = await pool.query(`SELECT channel FROM core.channel_accounts WHERE company_id = $1 ORDER BY channel`, [s.companyId]);
    expect(cuentas.rows.map((r) => r.channel)).toEqual(['mercadolibre', 'woocommerce']);
    const u = await pool.query(`SELECT company_id, username, status FROM security.users WHERE id = $1`, [s.userId]);
    expect(u.rows[0]).toMatchObject({ company_id: s.companyId, username: 'prueba' });
  });

  it('sembrar dos veces no choca con las restricciones de unicidad', async () => {
    const a = await sembrar(pool); const b = await sembrar(pool);
    expect(b.companyId).not.toBe(a.companyId);
  });

  it('limpiar vacía las tablas pedidas y deja las demás', async () => {
    const admin = crearPool(base.urlAdmin);
    const s = await sembrar(pool);
    await pool.query(`INSERT INTO integrations.reconciliation_signals
      (channel_account_id, topic, resource_id, fingerprint, source) VALUES ($1,'woo.orders','1','ev:a','webhook_copy')`, [s.cuentaWoo]);
    await limpiar(admin, ['integrations.reconciliation_signals']);
    expect((await pool.query('SELECT COUNT(*)::int n FROM integrations.reconciliation_signals')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int n FROM core.companies')).rows[0].n).toBeGreaterThan(0);
    await admin.end();
  });
});
