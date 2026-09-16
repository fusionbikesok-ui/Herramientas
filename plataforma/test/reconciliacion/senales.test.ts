import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { migrar } from '../../src/db/migrar.ts';
import { crearBaseVacia, DIR_MIGRACIONES, type BaseDePrueba } from '../soporte/base.ts';

const bases: BaseDePrueba[] = [];
afterEach(async () => { while (bases.length) await bases.pop()?.borrar(); });

async function baseMigrada(): Promise<{ db: pg.Client; empresa: string; cuentaMl: string; cuentaWoo: string }> {
  const base = await crearBaseVacia(); bases.push(base);
  await migrar(base.urlMigrador, DIR_MIGRACIONES);
  const db = new pg.Client({ connectionString: base.urlApp }); await db.connect();
  const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('Señales') returning id")).rows[0]!.id;
  const cuentaMl = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','senales-ml') returning id", [empresa])).rows[0]!.id;
  const cuentaWoo = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'woocommerce','https://senales-woo') returning id", [empresa])).rows[0]!.id;
  return { db, empresa, cuentaMl, cuentaWoo };
}

const señal = (cuenta: string) => `insert into integrations.reconciliation_signals
  (channel_account_id,topic,resource_id,fingerprint,source)
  values ('${cuenta}','ml.orders','o-1','fp-1','webhook_copy')`;

describe('E1-SIG-01 contrato de señales de reconciliación', () => {
  it('acepta una señal válida y rechaza tópico, fuente, estado y recurso inválidos', async () => {
    const { db, cuentaMl } = await baseMigrada();
    await expect(db.query(señal(cuentaMl))).resolves.toBeDefined();
    for (const [nombre, sql] of [
      ['tópico fuera de los ocho de E1', `insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source) values ('${cuentaMl}','ml.inventado','o-2','fp-2','webhook_copy')`],
      ['fuente inventada', `insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source) values ('${cuentaMl}','ml.orders','o-3','fp-3','telepatia')`],
      ['estado inventado', `insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source,status) values ('${cuentaMl}','ml.orders','o-4','fp-4','webhook_copy','inventado')`],
      ['recurso vacío', `insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source) values ('${cuentaMl}','ml.orders','','fp-5','webhook_copy')`],
      ['claimed sin lease', `insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source,status) values ('${cuentaMl}','ml.orders','o-6','fp-6','webhook_copy','claimed')`],
      ['cuenta inexistente', `insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source) values ('11111111-1111-1111-1111-111111111111','ml.orders','o-7','fp-7','webhook_copy')`],
    ] as const) {
      await expect(db.query(sql), nombre).rejects.toThrow();
    }
    await db.end();
  });

  it('deduplica por aviso y coalesce una sola señal activa por recurso', async () => {
    const { db, cuentaMl } = await baseMigrada();
    await db.query(señal(cuentaMl));
    // Mismo aviso: unicidad por cuenta+tópico+fingerprint.
    await expect(db.query(señal(cuentaMl))).rejects.toThrow();
    // Otro aviso del mismo recurso: la coalescencia lo impide mientras la primera siga activa.
    await expect(db.query(`insert into integrations.reconciliation_signals
      (channel_account_id,topic,resource_id,fingerprint,source)
      values ('${cuentaMl}','ml.orders','o-1','fp-otro','ml_missed_feed')`)).rejects.toThrow();
    // Cerrada la primera, el recurso vuelve a admitir una señal activa.
    await db.query("update integrations.reconciliation_signals set status='succeeded',finished_at=now()");
    await expect(db.query(`insert into integrations.reconciliation_signals
      (channel_account_id,topic,resource_id,fingerprint,source)
      values ('${cuentaMl}','ml.orders','o-1','fp-otro','ml_missed_feed')`)).resolves.toBeDefined();
    await db.end();
  });

  it('una señal no es una observación: no toca inbox ni observaciones', async () => {
    const { db, cuentaMl } = await baseMigrada();
    await db.query(señal(cuentaMl));
    expect((await db.query<{ n: string }>('select count(*) n from integrations.inbox_messages')).rows[0]?.n).toBe('0');
    expect((await db.query<{ n: string }>('select count(*) n from integrations.resource_observations')).rows[0]?.n).toBe('0');
    await db.end();
  });
});

describe('E1-ACC-01 siembra de corrientes por canal', () => {
  it('siembra sólo las corrientes del canal de la cuenta', async () => {
    const { db, cuentaMl, cuentaWoo } = await baseMigrada();
    expect((await db.query<{ sembrar_corrientes: number }>('select integrations.sembrar_corrientes($1)', [cuentaMl])).rows[0]?.sembrar_corrientes).toBe(6);
    expect((await db.query<{ sembrar_corrientes: number }>('select integrations.sembrar_corrientes($1)', [cuentaWoo])).rows[0]?.sembrar_corrientes).toBe(4);
    const ml = await db.query<{ clave: string }>("select topic||'|'||cursor_kind clave from integrations.reconciliation_cursors where channel_account_id=$1 order by 1", [cuentaMl]);
    expect(ml.rows.map((f) => f.clave)).toEqual([
      'ml.claims|state_sweep', 'ml.items|full_scan', 'ml.messages|state_sweep',
      'ml.orders|state_sweep', 'ml.questions|state_sweep', 'ml.shipments|state_sweep',
    ]);
    const woo = await db.query<{ clave: string }>("select topic||'|'||cursor_kind clave from integrations.reconciliation_cursors where channel_account_id=$1 order by 1", [cuentaWoo]);
    expect(woo.rows.map((f) => f.clave)).toEqual([
      'woo.orders|full_scan', 'woo.orders|state_sweep', 'woo.products|full_scan', 'woo.products|state_sweep',
    ]);
    // Idempotente y sin cruce: repetir no crea nada.
    expect((await db.query<{ sembrar_corrientes: number }>('select integrations.sembrar_corrientes($1)', [cuentaMl])).rows[0]?.sembrar_corrientes).toBe(0);
    await db.end();
  });

  it('falla ante una cuenta inexistente en vez de sembrar a ciegas', async () => {
    const { db } = await baseMigrada();
    await expect(db.query("select integrations.sembrar_corrientes('11111111-1111-1111-1111-111111111111')")).rejects.toThrow(/inexistente/);
    await db.end();
  });
});
