import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorLeaseVencido } from '../../src/colas/errores.ts';
import { crearPool } from '../../src/db/pool.ts';
import {
  completarCorrida, demoraReintentoSegundos, diferirCorridaPorCupo, fallarCorrida, liberarCorridasVencidas,
  materializarCorridas, reclamarCorridas, renovarLeaseCorrida, soltarCorridaPorApagado,
} from '../../src/reconciliacion/corridas.ts';
import { crearWorkerBarridos, ErrorCupoSombraAgotado } from '../../src/worker/barridos.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';



describe('programación y leases de barridos E1 T2', () => {
  let base: BaseDePrueba; let db: pg.Pool; let admin: pg.Pool; let cuenta: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba();
    db = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin);
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('Corridas') returning id")).rows[0]!.id;
    cuenta = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','corridas') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query('delete from integrations.sweep_runs; delete from integrations.reconciliation_cursors');
  });
  afterAll(async () => { await db.end(); await admin.end(); await base.borrar(); });

  async function corriente(opciones: { version?: number; maxAttempts?: number } = {}) {
    await db.query(`insert into integrations.reconciliation_cursors
      (channel_account_id,topic,strategy,cursor_value,overlap_seconds,interval_seconds,next_run_at,version)
      values ($1,'ml.orders','enumerable','{"v":1}'::jsonb,600,3600,now()-interval '3 hours',$2)`,
    [cuenta, opciones.version ?? 1]);
    await materializarCorridas(db);
    if (opciones.maxAttempts) await admin.query('update integrations.sweep_runs set max_attempts=$1', [opciones.maxAttempts]);
  }

  it('dos materializadores crean una corrida y conservan la cadencia', async () => {
    await db.query(`insert into integrations.reconciliation_cursors
      (channel_account_id,topic,strategy,overlap_seconds,interval_seconds,next_run_at)
      values ($1,'ml.orders','enumerable',600,3600,now()-interval '3 hours')`, [cuenta]);
    const [a, b] = await Promise.all([materializarCorridas(db), materializarCorridas(db)]);
    expect(a + b).toBe(1);
    expect((await db.query('select 1 from integrations.sweep_runs')).rowCount).toBe(1);
    const cursor = await db.query<{ futura: boolean }>('select next_run_at>now() as futura from integrations.reconciliation_cursors');
    expect(cursor.rows[0]?.futura).toBe(true);
  });

  it('dos workers no reclaman la misma corrida y el lease se renueva', async () => {
    await corriente();
    const [a, b] = await Promise.all([
      reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1),
      reclamarCorridas(db, 'w2', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1),
    ]);
    expect(a.length + b.length).toBe(1);
    const corrida = [...a, ...b][0]!;
    await renovarLeaseCorrida(db, corrida, 120);
    await completarCorrida(db, corrida, { v: 1, updated_at: '2026-09-15T00:00:00Z', tie_breaker: '1' });
    expect((await db.query<{ status: string }>('select status from integrations.sweep_runs')).rows[0]?.status).toBe('succeeded');
  });

  it('el worker sólo reclama corrientes con procesador registrado', async () => {
    await corriente();
    const sinAdaptadores = crearWorkerBarridos({ db, workerId: 'vacío', procesadores: {} });
    expect(await sinAdaptadores.unaVuelta()).toBe(0);
    expect((await db.query<{ status: string }>('select status from integrations.sweep_runs')).rows[0]?.status).toBe('pending');

    const worker = crearWorkerBarridos({
      db, workerId: 'w-adaptador',
      procesadores: { [`${cuenta}|ml.orders|state_sweep`]: async () => ({ cursorAfter: { v: 1, updated_at: '2026-09-15T00:00:00Z', tie_breaker: '1' } }) },
    });
    expect(await worker.unaVuelta()).toBe(1);
    expect((await db.query<{ status: string }>('select status from integrations.sweep_runs')).rows[0]?.status).toBe('succeeded');
  });

  it('un worker de la corriente incremental no reclama la vuelta completa del mismo tópico', async () => {
    await db.query(`insert into integrations.reconciliation_cursors
      (channel_account_id,topic,cursor_kind,strategy,overlap_seconds,interval_seconds,next_run_at)
      values ($1,'ml.orders','full_scan','enumerable',600,86400,now()-interval '1 hour')`, [cuenta]);
    await materializarCorridas(db);
    expect((await db.query('select 1 from integrations.sweep_runs')).rowCount).toBe(1);
    const incremental = crearWorkerBarridos({
      db, workerId: 'w-incremental',
      procesadores: { [`${cuenta}|ml.orders|state_sweep`]: async () => ({ cursorAfter: { v: 1, generation: 'x' } }) },
    });
    expect(await incremental.unaVuelta()).toBe(0);
    const completa = crearWorkerBarridos({
      db, workerId: 'w-completa',
      procesadores: { [`${cuenta}|ml.orders|full_scan`]: async () => ({ cursorAfter: { v: 1, generation: 'x' } }) },
    });
    expect(await completa.unaVuelta()).toBe(1);
    const fila = await db.query<{ cursor_kind: string; status: string }>('select cursor_kind,status from integrations.sweep_runs');
    expect(fila.rows).toEqual([{ cursor_kind: 'full_scan', status: 'succeeded' }]);
  });

  it('conflicto optimista deja partial y lease vencido no escribe', async () => {
    await corriente();
    const corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    await admin.query('update integrations.reconciliation_cursors set version=version+1');
    expect(await completarCorrida(db, corrida, { v: 1, generation: 'x' })).toBe('partial');

    await admin.query("update integrations.sweep_runs set status='pending',finished_at=null,cursor_after=null where id=$1", [corrida.id]);
    const otra = (await reclamarCorridas(db, 'w2', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    await admin.query("update integrations.sweep_runs set lease_until=now()-interval '1 second'");
    await expect(renovarLeaseCorrida(db, otra)).rejects.toBeInstanceOf(ErrorLeaseVencido);
  });

  it('reintenta, agota, recupera lease y devuelve intento al apagar', async () => {
    await corriente({ maxAttempts: 2 });
    let corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    expect(await fallarCorrida(db, corrida, 'HTTP_503', undefined, () => 0.5)).toBe('retryable');
    await admin.query('update integrations.sweep_runs set available_at=now()');
    corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    expect(await fallarCorrida(db, corrida, 'HTTP_503')).toBe('failed');

    await admin.query("update integrations.sweep_runs set status='pending',attempts=0,max_attempts=8,finished_at=null");
    corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    await soltarCorridaPorApagado(db, corrida);
    expect((await db.query<{ attempts: number }>('select attempts from integrations.sweep_runs')).rows[0]?.attempts).toBe(0);
    corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1, 1))[0]!;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await liberarCorridasVencidas(db)).toEqual({ pendientes: 1, fallidas: 0 });

    expect(demoraReintentoSegundos(1, () => 0.5)).toBe(30);
    expect(demoraReintentoSegundos(20, () => 0.5)).toBe(900);
    expect(demoraReintentoSegundos(1, () => 0, 999)).toBe(300);
  });

  it('E1-T5 §2.4: el worker de barridos difiere sin consumir intento ante ErrorCupoSombraAgotado', async () => {
    await corriente();
    const worker = crearWorkerBarridos({
      db, workerId: 'w-cupo',
      procesadores: { [`${cuenta}|ml.orders|state_sweep`]: async () => { throw new ErrorCupoSombraAgotado('CUPO_SOMBRA_AGOTADO ml.orders', 9); } },
    });
    expect(await worker.unaVuelta()).toBe(1);
    const fila = await db.query<{ status: string; attempts: number; deferred_since: Date | null }>(
      'select status,attempts,deferred_since from integrations.sweep_runs',
    );
    expect(fila.rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(fila.rows[0]?.deferred_since).not.toBeNull();
  });

  it('E1-T5 §2.4: diferirCorridaPorCupo devuelve el intento, no lo consume, y usa el retry-after real', async () => {
    await corriente();
    const corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    expect(corrida.attempts).toBe(1);
    expect(await diferirCorridaPorCupo(db, corrida, 17)).toBe('pending');
    const fila = await db.query<{ status: string; attempts: number; deferred_since: Date | null; available_at: Date }>(
      'select status,attempts,deferred_since,available_at from integrations.sweep_runs where id=$1', [corrida.id],
    );
    expect(fila.rows[0]?.status).toBe('pending');
    expect(fila.rows[0]?.attempts).toBe(0);
    expect(fila.rows[0]?.deferred_since).not.toBeNull();
    expect(fila.rows[0]!.available_at.getTime()).toBeGreaterThan(Date.now() + 15_000);
  });

  it('E1-T5 §2.4: una corrida reprogramada dos veces no reinicia el reloj de deferred_since', async () => {
    await corriente();
    let corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    await diferirCorridaPorCupo(db, corrida, 1);
    const primero = (await db.query<{ deferred_since: Date }>('select deferred_since from integrations.sweep_runs where id=$1', [corrida.id])).rows[0]!.deferred_since;
    await admin.query('update integrations.sweep_runs set available_at=now()');
    corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    await diferirCorridaPorCupo(db, corrida, 1);
    const segundo = (await db.query<{ deferred_since: Date }>('select deferred_since from integrations.sweep_runs where id=$1', [corrida.id])).rows[0]!.deferred_since;
    expect(segundo.getTime()).toBe(primero.getTime());
  });

  it('E1-T5 §2.4: pasado el tope de edad, cae a fallarCorrida con CUPO_SOMBRA_AGOTADO y limpia deferred_since', async () => {
    await corriente();
    const corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    await admin.query("update integrations.sweep_runs set deferred_since=now()-interval '31 minutes' where id=$1", [corrida.id]);
    const estado = await diferirCorridaPorCupo(db, corrida, 5, { maxDiferidoMin: 30 });
    expect(estado).toBe('retryable');
    const fila = await db.query<{ deferred_since: Date | null; error_detail: string | null }>(
      'select deferred_since,error_detail from integrations.sweep_runs where id=$1', [corrida.id],
    );
    expect(fila.rows[0]?.deferred_since).toBeNull();
    expect(fila.rows[0]?.error_detail).toBe('CUPO_SOMBRA_AGOTADO');
  });

  it('E1-T5 §2.4: a los 29 min sigue diferido, pasados los 30 cae a fallarCorrida (límite exacto)', async () => {
    await corriente({ maxAttempts: 8 });
    for (const [minutos, esperado] of [[29, 'pending'], [31, 'retryable']] as const) {
      await admin.query('delete from integrations.sweep_runs; delete from integrations.reconciliation_cursors');
      await corriente({ maxAttempts: 8 });
      const corrida = (await reclamarCorridas(db, 'w1', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
      await admin.query('update integrations.sweep_runs set deferred_since=now()-make_interval(mins=>$2) where id=$1', [corrida.id, minutos]);
      expect(await diferirCorridaPorCupo(db, corrida, 5, { maxDiferidoMin: 30 }), `${minutos} min`).toBe(esperado);
    }
  });
});
