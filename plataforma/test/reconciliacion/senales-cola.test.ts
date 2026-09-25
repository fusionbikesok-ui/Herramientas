import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { diferirSenalPorCupo, fallarSenal, reclamarSenales } from '../../src/reconciliacion/senales-cola.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E1-T5 §2.4: diferimiento de señales por cupo sombra agotado', () => {
  let base: BaseDePrueba; let db: pg.Pool; let admin: pg.Pool; let cuenta: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba();
    db = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin);
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('SenalesCupo') returning id")).rows[0]!.id;
    cuenta = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','senales-cupo') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => { await admin.query('delete from integrations.reconciliation_signals'); });
  afterAll(async () => { await db.end(); await admin.end(); await base.borrar(); });

  async function nuevaSenal(resourceId: string, maxAttempts = 8) {
    await db.query(
      `insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source,max_attempts)
       values ($1,'ml.orders',$2,$2,'webhook_copy',$3)`,
      [cuenta, resourceId, maxAttempts],
    );
    return (await reclamarSenales(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders' }], 1))[0]!;
  }

  it('devuelve el intento, queda retryable y marca deferred_since sólo la primera vez', async () => {
    let s = await nuevaSenal('o-1');
    expect(s.attempts).toBe(1);
    expect(await diferirSenalPorCupo(db, s, 12)).toBe('retryable');
    let fila = await db.query<{ status: string; attempts: number; deferred_since: Date | null }>(
      'select status,attempts,deferred_since from integrations.reconciliation_signals where id=$1', [s.id],
    );
    expect(fila.rows[0]).toMatchObject({ status: 'retryable', attempts: 0 });
    const primero = fila.rows[0]!.deferred_since!;
    expect(primero).not.toBeNull();

    await admin.query('update integrations.reconciliation_signals set available_at=now()');
    s = (await reclamarSenales(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders' }], 1))[0]!;
    await diferirSenalPorCupo(db, s, 12);
    fila = await db.query('select deferred_since from integrations.reconciliation_signals where id=$1', [s.id]);
    expect(fila.rows[0]!.deferred_since!.getTime()).toBe(primero.getTime());
  });

  it('pasado el tope de edad cae a dead_lettered con CUPO_SOMBRA_AGOTADO y limpia deferred_since', async () => {
    const s = await nuevaSenal('o-2', 1);
    await admin.query("update integrations.reconciliation_signals set deferred_since=now()-interval '31 minutes' where id=$1", [s.id]);
    expect(await diferirSenalPorCupo(db, s, 5, { maxDiferidoMin: 30 })).toBe('dead_lettered');
    const fila = await db.query<{ deferred_since: Date | null; error_detail: string | null; status: string }>(
      'select deferred_since,error_detail,status from integrations.reconciliation_signals where id=$1', [s.id],
    );
    expect(fila.rows[0]).toMatchObject({ deferred_since: null, error_detail: 'CUPO_SOMBRA_AGOTADO', status: 'dead_lettered' });
  });

  it('un 429 real (fallarSenal normal) no toca deferred_since ni el código de cupo', async () => {
    const s = await nuevaSenal('o-3');
    expect(await fallarSenal(db, s, 'HTTP_429')).toBe('retryable');
    const fila = await db.query<{ error_detail: string }>('select error_detail from integrations.reconciliation_signals where id=$1', [s.id]);
    expect(fila.rows[0]!.error_detail).toBe('HTTP_429');
  });
});
