import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { migrar } from '../../src/db/migrar.ts';
import { crearBaseVacia, DIR_MIGRACIONES, type BaseDePrueba } from '../soporte/base.ts';

const bases: BaseDePrueba[] = [];
afterEach(async () => { while (bases.length) await bases.pop()?.borrar(); });

async function baseMigrada(): Promise<{ base: BaseDePrueba; db: pg.Client; cuenta: string }> {
  const base = await crearBaseVacia(); bases.push(base);
  await migrar(base.urlMigrador, DIR_MIGRACIONES);
  const db = new pg.Client({ connectionString: base.urlApp }); await db.connect();
  const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('T2') returning id")).rows[0]!.id;
  const cuenta = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','t2') returning id", [empresa])).rows[0]!.id;
  return { base, db, cuenta };
}

describe('contrato relacional E1 T2', () => {
  it('acepta cursor v1 y exige corriente antes de crear una corrida', async () => {
    const { db, cuenta } = await baseMigrada();
    await expect(db.query(`insert into integrations.reconciliation_cursors
      (channel_account_id,topic,cursor_kind,strategy,cursor_value,overlap_seconds,interval_seconds)
      values ($1,'ml.orders','state_sweep','enumerable','{"v":1}'::jsonb,600,3600)`, [cuenta])).resolves.toBeDefined();
    await expect(db.query(`insert into integrations.sweep_runs
      (channel_account_id,topic,cursor_kind,strategy) values ($1,'ml.orders','state_sweep','enumerable')`, [cuenta])).resolves.toBeDefined();
    await expect(db.query(`insert into integrations.sweep_runs
      (channel_account_id,topic,cursor_kind,strategy,status) values ($1,'ml.orders','state_sweep','enumerable','claimed')`, [cuenta])).rejects.toThrow();
    await db.end();
  });

  it('rechaza cursor sin versión y dos corridas activas para la misma corriente', async () => {
    const { db, cuenta } = await baseMigrada();
    await expect(db.query(`insert into integrations.reconciliation_cursors
      (channel_account_id,topic,strategy,cursor_value,overlap_seconds,interval_seconds)
      values ($1,'ml.orders','enumerable','{}'::jsonb,600,3600)`, [cuenta])).rejects.toThrow();
    await db.query(`insert into integrations.reconciliation_cursors
      (channel_account_id,topic,strategy,overlap_seconds,interval_seconds)
      values ($1,'ml.orders','enumerable',600,3600)`, [cuenta]);
    await db.query(`insert into integrations.sweep_runs(channel_account_id,topic,strategy)
      values ($1,'ml.orders','enumerable')`, [cuenta]);
    await expect(db.query(`insert into integrations.sweep_runs(channel_account_id,topic,strategy)
      values ($1,'ml.orders','enumerable')`, [cuenta])).rejects.toThrow();
    await db.end();
  });

  it('valida hashes, lifecycle, relaciones y sobre completo', async () => {
    const { db, cuenta } = await baseMigrada();
    await expect(db.query(`insert into integrations.resource_observations
      (channel_account_id,topic,resource_id,remote_version,remote_hash,projection_hash,lifecycle)
      values ($1,'ml.orders','1','v1',$2,$2,'open')`, [cuenta, Buffer.alloc(32)])).resolves.toBeDefined();
    await expect(db.query(`insert into integrations.resource_relations
      (channel_account_id,relation_type,source_topic,source_id,target_topic,target_id)
      values ($1,'inventada','ml.orders','1','ml.shipments','2')`, [cuenta])).rejects.toThrow();
    await expect(db.query(`insert into integrations.inbox_messages
      (channel_account_id,topic,resource_id,remote_version,source,correlation_id,payload_ciphertext)
      values ($1,'ml.orders','1','v1','sweep',uuidv7(),$2)`, [cuenta, Buffer.from('plano')])).rejects.toThrow();
    await db.end();
  });
});
