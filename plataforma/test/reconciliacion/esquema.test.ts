import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('0004 siembra el calendario y 0005 deshabilita lo que no corresponde al canal', async () => {
    // La cuenta tiene que existir antes de 0004: se migra hasta 0003, se crea la cuenta y se sigue.
    // 0005 y 0006 también se apartan, porque quitar sólo 0004 dejaría un hueco de numeración.
    const base = await crearBaseVacia(); bases.push(base);
    const dir = mkdtempSync(join(tmpdir(), 'migr-corrientes-'));
    cpSync(DIR_MIGRACIONES, dir, { recursive: true });
    for (const m of ['0004_corrientes.sql', '0005_senales.sql', '0006_nonces_senales.sql']) rmSync(join(dir, m));
    await migrar(base.urlMigrador, dir);
    const db = new pg.Client({ connectionString: base.urlApp }); await db.connect();
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('Corrientes') returning id")).rows[0]!.id;
    await db.query("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','c1')", [empresa]);
    for (const m of ['0004_corrientes.sql', '0005_senales.sql', '0006_nonces_senales.sql']) cpSync(join(DIR_MIGRACIONES, m), join(dir, m));
    expect(await migrar(base.urlMigrador, dir)).toEqual(['0004_corrientes.sql', '0005_senales.sql', '0006_nonces_senales.sql']);

    const filas = await db.query<{ topic: string; cursor_kind: string; enabled: boolean; interval_seconds: number; hora: string; dow: number }>(
      `select topic,cursor_kind,enabled,interval_seconds,
              to_char(next_run_at AT TIME ZONE 'America/Argentina/Buenos_Aires','HH24:MI') AS hora,
              extract(dow from next_run_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::int AS dow
         from integrations.reconciliation_cursors order by topic,cursor_kind`);
    expect(filas.rows.map((f) => `${f.topic}|${f.cursor_kind}`)).toEqual([
      'ml.claims|state_sweep', 'ml.items|full_scan', 'ml.messages|state_sweep', 'ml.orders|state_sweep',
      'ml.questions|state_sweep', 'ml.shipments|state_sweep', 'woo.orders|full_scan', 'woo.orders|state_sweep',
      'woo.products|full_scan', 'woo.products|state_sweep',
    ]);
    // 0004 sembraba sin mirar el canal; 0005 deja apagadas las corrientes de Woo en una cuenta de ML,
    // sin borrarlas y sólo porque no tienen éxito previo ni corrida activa (forward-only).
    expect(filas.rows.filter((f) => f.topic.startsWith('ml.')).every((f) => f.enabled)).toBe(true);
    expect(filas.rows.filter((f) => f.topic.startsWith('woo.')).every((f) => !f.enabled)).toBe(true);

    const completas = Object.fromEntries(filas.rows.filter((f) => f.cursor_kind === 'full_scan').map((f) => [f.topic, f]));
    expect(completas['ml.items']).toMatchObject({ interval_seconds: 86400, hora: '04:00' });
    expect(completas['woo.products']).toMatchObject({ interval_seconds: 86400, hora: '04:15' });
    expect(completas['woo.orders']).toMatchObject({ interval_seconds: 604800, hora: '04:30', dow: 0 });
    const incrementales = Object.fromEntries(filas.rows.filter((f) => f.cursor_kind === 'state_sweep').map((f) => [f.topic, f.interval_seconds]));
    expect(incrementales).toEqual({
      'ml.orders': 600, 'ml.shipments': 900, 'ml.questions': 1200, 'ml.messages': 1200,
      'ml.claims': 1200, 'woo.orders': 600, 'woo.products': 600,
    });

    // Reaplicar no duplica corrientes ni reabre una deshabilitada a mano.
    await db.query("update integrations.reconciliation_cursors set enabled=false where topic='ml.orders'");
    expect(await migrar(base.urlMigrador, dir)).toEqual([]);
    expect(await migrar(base.urlMigrador, DIR_MIGRACIONES)).toEqual([]);
    const despues = await db.query<{ n: string; apagadas: string }>(
      "select count(*) n, count(*) filter (where not enabled) apagadas from integrations.reconciliation_cursors");
    expect(despues.rows[0]).toEqual({ n: '10', apagadas: '5' });

    // Una cuenta que nace después se siembra con la misma función, y sólo con lo de su canal.
    const nueva = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'woocommerce','https://c2') returning id", [empresa])).rows[0]!.id;
    expect((await db.query<{ sembrar_corrientes: number }>('select integrations.sembrar_corrientes($1)', [nueva])).rows[0]?.sembrar_corrientes).toBe(4);
    expect((await db.query<{ sembrar_corrientes: number }>('select integrations.sembrar_corrientes($1)', [nueva])).rows[0]?.sembrar_corrientes).toBe(0);
    expect(await db.query<{ n: string }>('select count(*) n from integrations.reconciliation_cursors').then((r) => r.rows[0]?.n)).toBe('14');
    await db.end();
    rmSync(dir, { recursive: true, force: true });
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
