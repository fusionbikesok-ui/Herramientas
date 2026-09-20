import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { migrar } from '../../src/db/migrar.ts';
import { revivirSenalesMuertas } from '../../src/reconciliacion/revivir-senales.ts';
import { crearBaseVacia, DIR_MIGRACIONES, type BaseDePrueba } from '../soporte/base.ts';

const bases: BaseDePrueba[] = [];
afterEach(async () => { while (bases.length) await bases.pop()?.borrar(); });

async function baseMigrada(): Promise<{ pool: pg.Pool; db: pg.Client; empresa: string; cuentaMl: string }> {
  const base = await crearBaseVacia(); bases.push(base);
  await migrar(base.urlMigrador, DIR_MIGRACIONES);
  const pool = new pg.Pool({ connectionString: base.urlApp });
  const db = new pg.Client({ connectionString: base.urlApp }); await db.connect();
  const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('Revivir') returning id")).rows[0]!.id;
  const cuentaMl = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','revivir-ml') returning id", [empresa])).rows[0]!.id;
  return { pool, db, empresa, cuentaMl };
}

async function senalMuerta(
  db: pg.Client, cuenta: string, resourceId: string, fingerprint: string, errorDetail: string, topic = 'ml.orders',
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into integrations.reconciliation_signals
       (channel_account_id,topic,resource_id,fingerprint,source,status,attempts,error_detail,finished_at)
     values ($1,$5,$2,$3,'webhook_copy','dead_lettered',8,$4,now())
     returning id`,
    [cuenta, resourceId, fingerprint, errorDetail, topic],
  );
  return r.rows[0]!.id;
}

describe('revivirSenalesMuertas', () => {
  it('revive sólo una señal por recurso cuando hay dos muertas del mismo recurso (la trampa del índice único)', async () => {
    const { pool, db, cuentaMl } = await baseMigrada();
    const vieja = await senalMuerta(db, cuentaMl, 'o-dup', 'fp-1', 'ErrorPaginaInvalida: campo inesperado');
    const nueva = await senalMuerta(db, cuentaMl, 'o-dup', 'fp-2', 'ErrorPaginaInvalida: campo inesperado');

    const revividas = await revivirSenalesMuertas(pool, {
      causaLike: '%PaginaInvalida%', limite: 100, offsetBaseS: 6, dryRun: false,
    });

    expect(revividas).toHaveLength(1);
    expect([vieja, nueva]).toContain(revividas[0]!.id);

    const activas = await db.query<{ n: string }>(
      "select count(*) n from integrations.reconciliation_signals where resource_id='o-dup' and status='pending'",
    );
    expect(activas.rows[0]!.n).toBe('1');
    const muertas = await db.query<{ n: string }>(
      "select count(*) n from integrations.reconciliation_signals where resource_id='o-dup' and status='dead_lettered'",
    );
    expect(muertas.rows[0]!.n).toBe('1');

    await pool.end(); await db.end();
  });

  it('no toca una señal muerta cuyo recurso ya tiene una señal activa', async () => {
    const { pool, db, cuentaMl } = await baseMigrada();
    const muerta = await senalMuerta(db, cuentaMl, 'o-activo', 'fp-muerta', 'ErrorPaginaInvalida: x');
    await db.query(
      `insert into integrations.reconciliation_signals
         (channel_account_id,topic,resource_id,fingerprint,source,status)
       values ($1,'ml.orders','o-activo','fp-activa','ml_missed_feed','retryable')`,
      [cuentaMl],
    );

    const revividas = await revivirSenalesMuertas(pool, {
      causaLike: '%PaginaInvalida%', limite: 100, offsetBaseS: 6, dryRun: false,
    });

    expect(revividas).toHaveLength(0);
    const estado = await db.query<{ status: string }>('select status from integrations.reconciliation_signals where id=$1', [muerta]);
    expect(estado.rows[0]!.status).toBe('dead_lettered');

    await pool.end(); await db.end();
  });

  it('dry-run reporta candidatas sin escribir nada', async () => {
    const { pool, db, cuentaMl } = await baseMigrada();
    await senalMuerta(db, cuentaMl, 'o-dry', 'fp-dry', 'ErrorPaginaInvalida: y');

    const revividas = await revivirSenalesMuertas(pool, {
      causaLike: '%PaginaInvalida%', limite: 100, offsetBaseS: 6, dryRun: true,
    });

    expect(revividas).toHaveLength(1);
    const estado = await db.query<{ status: string; attempts: number }>(
      'select status, attempts from integrations.reconciliation_signals where resource_id=$1', ['o-dry'],
    );
    expect(estado.rows[0]).toEqual({ status: 'dead_lettered', attempts: 8 });

    await pool.end(); await db.end();
  });

  it('escalona available_at según offsetBaseS y resetea attempts y error_detail', async () => {
    const { pool, db, cuentaMl } = await baseMigrada();
    await senalMuerta(db, cuentaMl, 'o-uno', 'fp-uno', 'ErrorPaginaInvalida: a');
    await senalMuerta(db, cuentaMl, 'o-dos', 'fp-dos', 'ErrorPaginaInvalida: b');

    await revivirSenalesMuertas(pool, { causaLike: '%PaginaInvalida%', limite: 100, offsetBaseS: 6, dryRun: false });

    const filas = await db.query<{ resource_id: string; attempts: number; error_detail: string | null; offset_s: string }>(
      `select resource_id, attempts, error_detail,
              extract(epoch from (available_at - now()))::int as offset_s
         from integrations.reconciliation_signals where status='pending' order by resource_id`,
    );
    expect(filas.rows).toHaveLength(2);
    for (const f of filas.rows) {
      expect(f.attempts).toBe(0);
      expect(f.error_detail).toBeNull();
    }
    // No se afirma un offset exacto (jitter del reloj de test), sólo que están escalonados y no negativos.
    const offsets = filas.rows.map((f) => Number(f.offset_s)).sort((a, b) => a - b);
    expect(offsets[0]).toBeGreaterThanOrEqual(-1);
    expect(offsets[1]).toBeGreaterThan(offsets[0]!);

    await pool.end(); await db.end();
  });

  it('filtra por causa: no revive señales dead_lettered de otro error', async () => {
    const { pool, db, cuentaMl } = await baseMigrada();
    await senalMuerta(db, cuentaMl, 'o-otra-causa', 'fp-otra', 'ErrorCanalTerminal: rechazado');

    const revividas = await revivirSenalesMuertas(pool, {
      causaLike: '%PaginaInvalida%', limite: 100, offsetBaseS: 6, dryRun: false,
    });

    expect(revividas).toHaveLength(0);
    const estado = await db.query<{ status: string }>(
      "select status from integrations.reconciliation_signals where resource_id='o-otra-causa'",
    );
    expect(estado.rows[0]!.status).toBe('dead_lettered');

    await pool.end(); await db.end();
  });

  it('con --topic revive sólo las señales de ese tópico y no toca las de otro', async () => {
    const { pool, db, cuentaMl } = await baseMigrada();
    const deOrders = await senalMuerta(db, cuentaMl, 'o-orders', 'fp-orders', 'HTTP_429', 'ml.orders');
    const deItems = await senalMuerta(db, cuentaMl, 'o-items', 'fp-items', 'HTTP_429', 'ml.items');

    const revividas = await revivirSenalesMuertas(pool, {
      causaLike: '%429%', topic: 'ml.orders', limite: 100, offsetBaseS: 6, dryRun: false,
    });

    expect(revividas).toHaveLength(1);
    expect(revividas[0]!.id).toBe(deOrders);
    const items = await db.query<{ status: string }>('select status from integrations.reconciliation_signals where id=$1', [deItems]);
    expect(items.rows[0]!.status).toBe('dead_lettered');

    await pool.end(); await db.end();
  });

  it('sin --topic el comportamiento es el de antes: revive de todos los tópicos que matcheen la causa', async () => {
    const { pool, db, cuentaMl } = await baseMigrada();
    await senalMuerta(db, cuentaMl, 'o-orders', 'fp-orders', 'HTTP_429', 'ml.orders');
    await senalMuerta(db, cuentaMl, 'o-items', 'fp-items', 'HTTP_429', 'ml.items');

    const revividas = await revivirSenalesMuertas(pool, {
      causaLike: '%429%', limite: 100, offsetBaseS: 6, dryRun: false,
    });

    expect(revividas.map((r) => r.topic).sort()).toEqual(['ml.items', 'ml.orders']);

    await pool.end(); await db.end();
  });

  it('con --topic, el NOT EXISTS sigue protegiendo: una muerta de ese tópico cuyo recurso tiene una activa del mismo tópico no se revive', async () => {
    const { pool, db, cuentaMl } = await baseMigrada();
    const muerta = await senalMuerta(db, cuentaMl, 'o-activo-orders', 'fp-muerta', 'HTTP_429', 'ml.orders');
    await db.query(
      `insert into integrations.reconciliation_signals
         (channel_account_id,topic,resource_id,fingerprint,source,status)
       values ($1,'ml.orders','o-activo-orders','fp-activa','ml_missed_feed','retryable')`,
      [cuentaMl],
    );

    const revividas = await revivirSenalesMuertas(pool, {
      causaLike: '%429%', topic: 'ml.orders', limite: 100, offsetBaseS: 6, dryRun: false,
    });

    expect(revividas).toHaveLength(0);
    const estado = await db.query<{ status: string }>('select status from integrations.reconciliation_signals where id=$1', [muerta]);
    expect(estado.rows[0]!.status).toBe('dead_lettered');

    await pool.end(); await db.end();
  });
});
