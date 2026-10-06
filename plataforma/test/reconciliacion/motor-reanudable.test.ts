import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorLeaseVencido } from '../../src/colas/errores.ts';
import { crearPool } from '../../src/db/pool.ts';
import {
  completarCorrida, diferirCorridaPorCupo, fallarCorrida, liberarCorridasVencidas, materializarCorridas,
  reclamarCorridas, soltarCorridaPorApagado, type CorridaReclamada,
} from '../../src/reconciliacion/corridas.ts';
import { crearProcesadorMotor, ErrorEdadMaxima } from '../../src/reconciliacion/motor.ts';
import type { AdaptadorBarrido, PaginaRemota, RecursoRemoto } from '../../src/reconciliacion/tipos.ts';
import type { KeyringSobre } from '../../src/seguridad/sobre.ts';
import { crearWorkerBarridos } from '../../src/worker/barridos.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const keyring: KeyringSobre = { activeKeyId: 'reanudable-test', keys: { 'reanudable-test': Buffer.alloc(32, 9) } };
const reloj = () => new Date('2026-09-30T12:00:00.000Z');
const VERSION = '2026-09-30T10:00:00Z';

function recurso(id: string): RecursoRemoto {
  return { id, version: VERSION, updatedAt: VERSION, lifecycle: 'open', payload: { id }, projection: { id } };
}

/** Adaptador de N páginas de un recurso cada una; la posición es `{ page }`. `antes` corre antes de cada página. */
function adaptador(paginas: number, antes?: (page: number, posicion: Record<string, unknown> | null) => void | Promise<void>, extra: Record<string, unknown> = {}): AdaptadorBarrido & { posiciones: Array<Record<string, unknown> | null> } {
  const posiciones: Array<Record<string, unknown> | null> = [];
  return {
    topic: 'ml.orders', cursorKind: 'state_sweep', fullScan: false, versionKind: 'temporal', posiciones,
    async listar(_ctx, posicion): Promise<PaginaRemota> {
      posiciones.push(posicion);
      const page = typeof posicion?.page === 'number' ? posicion.page : 0;
      await antes?.(page, posicion);
      return {
        resources: [recurso(`o-${page}`)],
        nextPosition: page + 1 < paginas ? { page: page + 1, ...extra } : null,
        cursorAfter: { v: 1, generation: `g${page}` },
      };
    },
  };
}

describe('motor reanudable: posición en curso en cursor_after (E1 barridos reanudables, Tarea 1)', () => {
  let base: BaseDePrueba; let db: pg.Pool; let admin: pg.Pool; let cuenta: string;
  const corriente = () => [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }];
  beforeAll(async () => {
    base = await crearBaseDePrueba(); db = crearPool(base.urlApp, { max: 6 }); admin = crearPool(base.urlAdmin);
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('Reanudable') returning id")).rows[0]!.id;
    cuenta = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','reanudable') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`delete from integrations.inbox_messages; delete from integrations.resource_relations;
      delete from integrations.resource_observations; delete from integrations.sweep_runs;
      delete from integrations.reconciliation_cursors`);
  });
  afterAll(async () => { await db.end(); await admin.end(); await base.borrar(); });

  async function nuevaCorrida(): Promise<CorridaReclamada> {
    await db.query(`insert into integrations.reconciliation_cursors
      (channel_account_id,topic,strategy,overlap_seconds,interval_seconds,next_run_at)
      values ($1,'ml.orders','enumerable',600,3600,now()-interval '1 hour')`, [cuenta]);
    await materializarCorridas(db);
    return (await reclamarCorridas(db, 'w-reanudable', corriente(), 1))[0]!;
  }
  async function reclamar(): Promise<CorridaReclamada> {
    await admin.query('update integrations.sweep_runs set available_at=now()');
    return (await reclamarCorridas(db, 'w-reanudable', corriente(), 1))[0]!;
  }
  async function fila() {
    return (await db.query<{
      cursor_after: Record<string, unknown> | null; enumerated: number | null; duplicates: number | null;
      status: string; attempts: number; deferred_since: Date | null; error_detail: string | null;
    }>('select cursor_after,enumerated,duplicates,status,attempts,deferred_since,error_detail from integrations.sweep_runs')).rows[0]!;
  }
  const motor = (a: AdaptadorBarrido, extra: { relojMonotonoMs?: () => number } = {}) =>
    crearProcesadorMotor({ db, adaptador: a, keyring, reloj, ...extra });

  it('guarda la posición tras cada página y la reclamación siguiente continúa desde ahí, acumulando contadores', async () => {
    const corrida = await nuevaCorrida();
    let falla = true;
    const a = adaptador(3, (page) => { if (page === 1 && falla) throw new Error('HTTP_503'); });
    await expect(motor(a)(corrida)).rejects.toThrow('HTTP_503');
    expect((await fila()).cursor_after).toEqual({ enCurso: 1, paginas: 1, posicion: { page: 1 } });
    expect((await fila()).enumerated).toBe(1);
    await fallarCorrida(db, corrida, 'HTTP_503', undefined, () => 0.5, true);

    falla = false;
    const reintento = await reclamar();
    expect(reintento.id).toBe(corrida.id);
    const resultado = await motor(a)(reintento);
    // 1.er intento: páginas 0 y falla en 1; 2.º intento: no repite la 0, sólo pide 1 y 2.
    expect(a.posiciones.map((p) => p?.page ?? null)).toEqual([null, 1, 1, 2]);
    expect(await completarCorrida(db, reintento, resultado.cursorAfter)).toBe('succeeded');
    const f = await fila();
    expect(f.enumerated).toBe(3);
    expect(f.duplicates).toBe(0);
  });

  it('al completar, cursor_after es el cursor final y no la posición; reconciliation_cursors lo refleja', async () => {
    const corrida = await nuevaCorrida();
    const resultado = await motor(adaptador(2))(corrida);
    expect((await fila()).cursor_after).toBeNull(); // la última página limpia la posición
    await completarCorrida(db, corrida, resultado.cursorAfter);
    expect((await fila()).cursor_after).toEqual({ v: 1, generation: 'g1' });
    expect((await db.query<{ cursor_value: unknown }>('select cursor_value from integrations.reconciliation_cursors')).rows[0]?.cursor_value)
      .toEqual({ v: 1, generation: 'g1' });
  });

  it('con cursor_version cambiado (partial) también queda el cursor final y no la posición', async () => {
    const corrida = await nuevaCorrida();
    const resultado = await motor(adaptador(2))(corrida);
    await admin.query('update integrations.reconciliation_cursors set version=version+1');
    expect(await completarCorrida(db, corrida, resultado.cursorAfter)).toBe('partial');
    expect((await fila()).cursor_after).toEqual({ v: 1, generation: 'g1' });
  });

  it('una corrida terminada en fallo deja cursor_after en NULL (fallarCorrida y liberarCorridasVencidas)', async () => {
    const corrida = await nuevaCorrida();
    await expect(motor(adaptador(3, (p) => { if (p === 1) throw new Error('x'); }))(corrida)).rejects.toThrow('x');
    expect((await fila()).cursor_after).not.toBeNull();
    expect(await fallarCorrida(db, corrida, 'x', undefined, () => 0.5, false)).toBe('failed');
    expect((await fila()).cursor_after).toBeNull();

    await admin.query('delete from integrations.sweep_runs');
    await db.query("update integrations.reconciliation_cursors set next_run_at=now()-interval '1 hour'");
    await materializarCorridas(db);
    const otra = (await reclamarCorridas(db, 'w-reanudable', corriente(), 1))[0]!;
    await expect(motor(adaptador(3, (p) => { if (p === 1) throw new Error('y'); }))(otra)).rejects.toThrow('y');
    await admin.query("update integrations.sweep_runs set attempts=max_attempts, lease_until=now()-interval '1 second'");
    expect(await liberarCorridasVencidas(db)).toEqual({ pendientes: 0, fallidas: 1 });
    expect((await fila()).cursor_after).toBeNull();
  });

  it('un cursor_after sin marcador enCurso (cursor final viejo) no se toma como reanudación', async () => {
    const corrida = await nuevaCorrida();
    await admin.query(`update integrations.sweep_runs set cursor_after='{"v":1,"generation":"vieja","page":2}'::jsonb where id=$1`, [corrida.id]);
    const a = adaptador(2);
    await motor(a)(corrida);
    expect(a.posiciones[0]).toBeNull();
  });

  it('la ventana congelada no cambia entre intentos', async () => {
    const corrida = await nuevaCorrida();
    const ventanas: string[] = [];
    let falla = true;
    const a: AdaptadorBarrido = {
      ...adaptador(1),
      async listar(ctx) {
        ventanas.push(ctx.windowTo.toISOString());
        if (falla) throw new Error('HTTP_503');
        return { resources: [], nextPosition: null, cursorAfter: { v: 1 } };
      },
    };
    await expect(motor(a)(corrida)).rejects.toThrow();
    falla = false;
    await fallarCorrida(db, corrida, 'HTTP_503', undefined, () => 0.5, true);
    const reintento = await reclamar();
    await crearProcesadorMotor({ db, adaptador: a, keyring, reloj: () => new Date('2026-09-30T18:00:00Z') })(reintento);
    expect(new Set(ventanas).size).toBe(1);
  });

  it('D2: una página con progreso limpia deferred_since y un diferimiento posterior no cae a CUPO_SOMBRA_AGOTADO', async () => {
    const corrida = await nuevaCorrida();
    await admin.query("update integrations.sweep_runs set deferred_since=now()-interval '40 minutes'");
    await expect(motor(adaptador(3, (p) => { if (p === 1) throw new Error('corte'); }))(corrida)).rejects.toThrow('corte');
    expect((await fila()).deferred_since).toBeNull();
    expect(await diferirCorridaPorCupo(db, corrida, 30)).toBe('pending');
    expect((await fila()).status).toBe('pending');
  });

  it('D2 (control): sin páginas confirmadas por más de 30 min sigue cayendo a fallarCorrida', async () => {
    const corrida = await nuevaCorrida();
    await admin.query("update integrations.sweep_runs set deferred_since=now()-interval '40 minutes'");
    expect(await diferirCorridaPorCupo(db, corrida, 30, { azar: () => 0.5 })).toBe('retryable');
    expect((await fila()).error_detail).toBe('CUPO_SOMBRA_AGOTADO');
  });

  it('D2b: una página confirmada devuelve attempts a 1; un fallo sin progreso sigue consumiéndolos', async () => {
    const corrida = await nuevaCorrida();
    await admin.query('update integrations.sweep_runs set attempts=7');
    await expect(motor(adaptador(3, (p) => { if (p === 1) throw new Error('corte'); }))(corrida)).rejects.toThrow('corte');
    expect((await fila()).attempts).toBe(1);

    await admin.query('update integrations.sweep_runs set attempts=7');
    // Sin ninguna página confirmada (falla en la primera): attempts no se toca.
    await admin.query('update integrations.sweep_runs set cursor_after=null');
    await expect(motor(adaptador(3, () => { throw new Error('ya'); }))(corrida)).rejects.toThrow('ya');
    expect((await fila()).attempts).toBe(7);
  });

  it('D2b: fallarCorrida usa los intentos de la base: tras progreso una corrida que llegó al máximo sigue reintentable', async () => {
    const corrida = await nuevaCorrida();
    await admin.query('update integrations.sweep_runs set attempts=max_attempts');
    await expect(motor(adaptador(3, (p) => { if (p === 1) throw new Error('corte'); }))(corrida)).rejects.toThrow('corte');
    expect(await fallarCorrida(db, corrida, 'corte', undefined, () => 0.5, true)).toBe('retryable');
    expect((await fila()).cursor_after).not.toBeNull();
  });

  it('tope de edad: una corrida de más de 6 h termina failed con EDAD_MAXIMA sin llamar a listar', async () => {
    const corrida = await nuevaCorrida();
    await admin.query("update integrations.sweep_runs set started_at=now()-interval '6 hours 1 minute'");
    const a = adaptador(2);
    await expect(motor(a)(corrida)).rejects.toBeInstanceOf(ErrorEdadMaxima);
    expect(a.posiciones).toHaveLength(0);

    // Por el worker real: no es un ErrorBarridoReintentable, así que la corrida queda failed en el acto.
    const worker = crearWorkerBarridos({ db, workerId: 'w-edad', procesadores: { [`${cuenta}|ml.orders|state_sweep`]: motor(a) } });
    await admin.query("update integrations.sweep_runs set status='pending',lease_token=null,lease_until=null,worker_id=null,available_at=now()");
    await worker.unaVuelta();
    const f = await fila();
    expect(f.status).toBe('failed');
    expect(f.error_detail).toContain('EDAD_MAXIMA');
    expect(f.cursor_after).toBeNull();
  });

  it('tope de edad: a 5 h 59 min sigue normal', async () => {
    const corrida = await nuevaCorrida();
    await admin.query("update integrations.sweep_runs set started_at=now()-interval '5 hours 59 minutes'");
    const a = adaptador(2);
    await motor(a)(corrida);
    expect(a.posiciones).toHaveLength(2);
  });

  it('tope de edad: una corrida que avanza cada minuto pero supera las 6 h también muere', async () => {
    const corrida = await nuevaCorrida();
    let ahora = 0;
    const a = adaptador(400);
    await expect(motor(a, { relojMonotonoMs: () => (ahora += 60_000) })(corrida)).rejects.toBeInstanceOf(ErrorEdadMaxima);
    const enCurso = (await fila()).cursor_after as { paginas: number };
    expect(enCurso.paginas).toBeGreaterThan(50);
    expect(enCurso.paginas).toBeLessThan(400);
  });

  it('lease perdido antes de la transacción de página: rollback completo, sin posición ni observaciones', async () => {
    const corrida = await nuevaCorrida();
    const a = adaptador(2, async () => {
      await admin.query("update integrations.sweep_runs set lease_until=now()-interval '1 second'");
    });
    await expect(motor(a)(corrida)).rejects.toBeInstanceOf(ErrorLeaseVencido);
    expect((await fila()).cursor_after).toBeNull();
    expect(Number((await db.query<{ n: string }>('select count(*) n from integrations.resource_observations')).rows[0]!.n)).toBe(0);
  });

  it('soltarCorridaPorApagado y diferirCorridaPorCupo conservan la posición en curso', async () => {
    const corrida = await nuevaCorrida();
    await expect(motor(adaptador(3, (p) => { if (p === 1) throw new Error('corte'); }))(corrida)).rejects.toThrow('corte');
    await diferirCorridaPorCupo(db, corrida, 5);
    expect((await fila()).cursor_after).toEqual({ enCurso: 1, paginas: 1, posicion: { page: 1 } });
    const otra = await reclamar();
    await soltarCorridaPorApagado(db, otra);
    expect((await fila()).cursor_after).toEqual({ enCurso: 1, paginas: 1, posicion: { page: 1 } });
  });

  it('una posición de ~70 KB (4,3 mil ids) sobrevive al viaje por la columna', async () => {
    const corrida = await nuevaCorrida();
    const ids = Array.from({ length: 4300 }, (_, i) => `MLA${String(1_000_000_000 + i)}`);
    const a = adaptador(3, (p) => { if (p === 1) throw new Error('corte'); }, { ids });
    await expect(motor(a)(corrida)).rejects.toThrow('corte');
    await fallarCorrida(db, corrida, 'corte', undefined, () => 0.5, true);
    const reintento = await reclamar();
    const b = adaptador(3, undefined, { ids });
    await motor(b)(reintento);
    expect((b.posiciones[0] as { ids: string[] }).ids).toEqual(ids);
  });
});
