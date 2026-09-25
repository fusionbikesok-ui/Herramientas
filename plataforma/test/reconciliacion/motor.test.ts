import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { completarCorrida, fallarCorrida, materializarCorridas, reclamarCorridas } from '../../src/reconciliacion/corridas.ts';
import { hashCanonico, jsonCanonico } from '../../src/reconciliacion/canonico.ts';
import { ErrorLeaseVencido } from '../../src/colas/errores.ts';
import { crearProcesadorMotor, ErrorPaginaInvalida } from '../../src/reconciliacion/motor.ts';
import type { AdaptadorBarrido, PaginaRemota, RecursoRemoto, TipoVersion } from '../../src/reconciliacion/tipos.ts';
import { descifrarSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const keyring: KeyringSobre = { activeKeyId: 'motor-test', keys: { 'motor-test': Buffer.alloc(32, 7) } };
const reloj = () => new Date('2026-09-15T12:00:00.000Z');

function recurso(id: string, version: string, status = 'paid'): RecursoRemoto {
  return {
    id, version, updatedAt: version, lifecycle: 'open',
    payload: { buyer: { email: `${id}@example.invalid` }, id, status },
    projection: { id, status, date_last_updated: version, shipping: { id: `s-${id}` }, pack_id: `p-${id}` },
    relations: [{ type: 'order_shipment', targetTopic: 'ml.shipments', targetId: `s-${id}` }],
  };
}

function adaptador(paginas: readonly PaginaRemota[], fullScan = false, versionKind: TipoVersion = 'temporal'): AdaptadorBarrido {
  return {
    topic: 'ml.orders', cursorKind: 'state_sweep', fullScan, versionKind,
    async listar(_contexto, posicion) {
      const indice = typeof posicion?.page === 'number' ? posicion.page : 0;
      const pagina = paginas[indice];
      if (!pagina) throw new Error(`página ${indice} inexistente`);
      return pagina;
    },
  };
}

describe('motor transaccional de reconciliación E1 T2', () => {
  let base: BaseDePrueba; let db: pg.Pool; let admin: pg.Pool; let cuenta: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); db = crearPool(base.urlApp, { max: 6 }); admin = crearPool(base.urlAdmin);
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('Motor') returning id")).rows[0]!.id;
    cuenta = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','motor') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`delete from integrations.inbox_messages; delete from integrations.resource_relations;
      delete from integrations.resource_observations; delete from integrations.sweep_runs;
      delete from integrations.reconciliation_cursors`);
  });
  afterAll(async () => { await db.end(); await admin.end(); await base.borrar(); });

  async function nuevaCorrida() {
    const existe = await db.query('select 1 from integrations.reconciliation_cursors');
    if (!existe.rowCount) {
      await db.query(`insert into integrations.reconciliation_cursors
        (channel_account_id,topic,strategy,overlap_seconds,interval_seconds,next_run_at)
        values ($1,'ml.orders','enumerable',600,3600,now()-interval '1 hour')`, [cuenta]);
    } else {
      await db.query('update integrations.reconciliation_cursors set next_run_at=now()-interval \'1 second\'');
    }
    await materializarCorridas(db);
    return (await reclamarCorridas(db, 'motor-worker', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
  }

  it('canoniza claves, arrays por id y valores ausentes de forma estable', () => {
    expect(jsonCanonico({ z: 1, a: [{ id: 2, x: undefined }, { id: 1, x: 'a' }] }))
      .toBe('{"a":[{"id":1,"x":"a"},{"id":2,"x":null}],"z":1}');
    expect(hashCanonico({ b: 2, a: 1 })).toEqual(hashCanonico({ a: 1, b: 2 }));
    expect(() => jsonCanonico({ n: Number.NaN })).toThrow(/no finitos/);
  });

  it('persiste observación, relación e inbox cifrado y avanza el cursor', async () => {
    const corrida = await nuevaCorrida();
    const r = recurso('o-1', '2026-09-15T10:00:00Z');
    const procesar = crearProcesadorMotor({ db, adaptador: adaptador([{ resources: [r], nextPosition: null, cursorAfter: { v: 1, updated_at: r.version, tie_breaker: r.id } }]), keyring, reloj });
    const resultado = await procesar(corrida);
    expect(await completarCorrida(db, corrida, resultado.cursorAfter, resultado.antesDeCerrar)).toBe('succeeded');

    const inbox = await db.query<{ payload_ciphertext: Buffer; payload_nonce: Buffer; payload_tag: Buffer; payload_key_id: string }>('select payload_ciphertext,payload_nonce,payload_tag,payload_key_id from integrations.inbox_messages');
    const fila = inbox.rows[0]!;
    expect(fila.payload_ciphertext.includes(Buffer.from('@example.invalid'))).toBe(false);
    const plano = descifrarSobre({ keyId: fila.payload_key_id, nonce: fila.payload_nonce, tag: fila.payload_tag, ciphertext: fila.payload_ciphertext },
      { account: cuenta, topic: 'ml.orders', resource: r.id, remoteVersion: r.version }, keyring);
    expect(JSON.parse(plano.toString())).toMatchObject({ id: 'o-1', status: 'paid' });
    expect((await db.query('select 1 from integrations.resource_relations')).rowCount).toBe(1);
  });

  it('replay no duplica y una versión atrasada no hace retroceder la observación', async () => {
    const nueva = recurso('o-2', '2026-09-15T10:00:00Z');
    for (const r of [nueva, nueva, recurso('o-2', '2026-09-14T10:00:00Z', 'cancelled')]) {
      const corrida = await nuevaCorrida();
      const resultado = await crearProcesadorMotor({ db, adaptador: adaptador([{ resources: [r], nextPosition: null, cursorAfter: { v: 1, updated_at: r.version, tie_breaker: r.id } }]), keyring, reloj })(corrida);
      await completarCorrida(db, corrida, resultado.cursorAfter);
    }
    expect((await db.query<{ n: string }>('select count(*) n from integrations.inbox_messages')).rows[0]?.n).toBe('1');
    expect((await db.query<{ remote_version: string }>('select remote_version from integrations.resource_observations')).rows[0]?.remote_version).toBe(nueva.version);
  });

  async function contar(sql: string): Promise<number> {
    return Number((await db.query<{ n: string }>(sql)).rows[0]!.n);
  }

  it('E1-SWP-09 una falla en página 3 conserva cursor y el reintento repite la ventana congelada sin duplicar', async () => {
    const corrida = await nuevaCorrida();
    const recursos = ['o-1', 'o-2', 'o-3'].map((id) => recurso(id, '2026-09-15T10:00:00Z'));
    let falla = true;
    const ventanas: Date[] = [];
    const conCaida: AdaptadorBarrido = {
      ...adaptador([]),
      async listar(ctx, posicion) {
        ventanas.push(ctx.windowTo);
        const page = typeof posicion?.page === 'number' ? posicion.page : 0;
        if (page === 2 && falla) throw new Error('HTTP_503');
        return {
          resources: [recursos[page]!], nextPosition: page < 2 ? { page: page + 1 } : null,
          cursorAfter: { v: 1, updated_at: '2026-09-15T10:00:00Z', tie_breaker: recursos[page]!.id },
        };
      },
    };
    await expect(crearProcesadorMotor({ db, adaptador: conCaida, keyring, reloj })(corrida)).rejects.toThrow('HTTP_503');
    expect(await fallarCorrida(db, corrida, 'HTTP_503', undefined, () => 0.5, true)).toBe('retryable');
    expect((await db.query<{ cursor_value: object | null }>('select cursor_value from integrations.reconciliation_cursors')).rows[0]?.cursor_value).toBeNull();
    expect(await contar('select count(*) n from integrations.inbox_messages')).toBe(2);

    falla = false;
    await admin.query('update integrations.sweep_runs set available_at=now()');
    const reintento = (await reclamarCorridas(db, 'motor-worker', [{ channelAccountId: cuenta, topic: 'ml.orders', cursorKind: 'state_sweep' }], 1))[0]!;
    expect(reintento.id).toBe(corrida.id);
    const relojPosterior = () => new Date('2026-09-15T13:00:00.000Z');
    const resultado = await crearProcesadorMotor({ db, adaptador: conCaida, keyring, reloj: relojPosterior })(reintento);
    expect(await completarCorrida(db, reintento, resultado.cursorAfter)).toBe('succeeded');
    expect(new Set(ventanas.map((v) => v.toISOString()))).toEqual(new Set([reloj().toISOString()]));
    expect(await contar('select count(*) n from integrations.inbox_messages')).toBe(3);
    expect((await db.query<{ cursor_value: { tie_breaker: string } }>('select cursor_value from integrations.reconciliation_cursors')).rows[0]?.cursor_value.tie_breaker).toBe('o-3');
  });

  it('rechaza la página completa si un recurso no tiene versión válida', async () => {
    const corrida = await nuevaCorrida();
    const pagina = { resources: [recurso('o-ok', '2026-09-15T10:00:00Z'), recurso('o-mal', 'ayer')], nextPosition: null, cursorAfter: { v: 1 } };
    await expect(crearProcesadorMotor({ db, adaptador: adaptador([pagina]), keyring, reloj })(corrida)).rejects.toBeInstanceOf(ErrorPaginaInvalida);
    expect(await contar('select count(*) n from integrations.resource_observations')).toBe(0);
    expect(await contar('select count(*) n from integrations.inbox_messages')).toBe(0);
  });

  it('un lease robado por otro worker entre páginas hace fallar la transacción de la página con ErrorLeaseVencido y no escribe nada', async () => {
    const corrida = await nuevaCorrida();
    const r1 = recurso('o-lease-1', '2026-09-15T10:00:00Z');
    const r2 = recurso('o-lease-2', '2026-09-15T10:00:00Z');
    const conRobo: AdaptadorBarrido = {
      ...adaptador([]),
      async listar(_ctx, posicion) {
        const page = typeof posicion?.page === 'number' ? posicion.page : 0;
        if (page === 1) {
          // Simula el heartbeat de este worker fallando: el lease vence, otro worker lo reclama con
          // otro lease_token/worker_id ANTES de que la página 2 llegue a persistir.
          await admin.query(
            `update integrations.sweep_runs set lease_token=gen_random_uuid(), worker_id='otro-worker',
               lease_until=now()+interval '1 minute' where id=$1`, [corrida.id]);
        }
        return {
          resources: [page === 0 ? r1 : r2], nextPosition: page === 0 ? { page: 1 } : null,
          cursorAfter: { v: 1, updated_at: '2026-09-15T10:00:00Z', tie_breaker: page === 0 ? r1.id : r2.id },
        };
      },
    };
    await expect(crearProcesadorMotor({ db, adaptador: conRobo, keyring, reloj })(corrida)).rejects.toBeInstanceOf(ErrorLeaseVencido);
    // La página 1 (o-lease-1) sí alcanzó a persistir antes del robo; la 2 (o-lease-2) no: su transacción
    // completa (persistirRecurso + el UPDATE de contadores) abortó entera al fallar la verificación de lease.
    expect(await contar('select count(*) n from integrations.inbox_messages')).toBe(1);
    expect((await db.query('select 1 from integrations.inbox_messages where resource_id=$1', ['o-lease-2'])).rowCount).toBe(0);
  });

  it('versión hash: igual no encola; distinta reemplaza aunque no sea ordenable', async () => {
    const correr = async (r: RecursoRemoto) => {
      const corrida = await nuevaCorrida();
      const resultado = await crearProcesadorMotor({ db, adaptador: adaptador([{ resources: [r], nextPosition: null, cursorAfter: { v: 1, generation: r.version } }], false, 'hash'), keyring, reloj })(corrida);
      await completarCorrida(db, corrida, resultado.cursorAfter);
    };
    const v1 = { ...recurso('q-1', 'x'), version: 'hash-b', updatedAt: null };
    await correr(v1);
    await correr(v1);
    expect(await contar('select count(*) n from integrations.inbox_messages')).toBe(1);
    await correr({ ...v1, version: 'hash-a', payload: { id: 'q-1', status: 'answered' } });
    expect(await contar('select count(*) n from integrations.inbox_messages')).toBe(2);
    expect((await db.query<{ remote_version: string }>('select remote_version from integrations.resource_observations')).rows[0]?.remote_version).toBe('hash-a');
  });

  it('una versión atrasada no cambia el ciclo de vida observado', async () => {
    const correr = async (r: RecursoRemoto) => {
      const corrida = await nuevaCorrida();
      const resultado = await crearProcesadorMotor({ db, adaptador: adaptador([{ resources: [r], nextPosition: null, cursorAfter: { v: 1, updated_at: r.version } }]), keyring, reloj })(corrida);
      await completarCorrida(db, corrida, resultado.cursorAfter);
    };
    await correr({ ...recurso('o-3', '2026-09-15T10:00:00Z'), lifecycle: 'closed' });
    await correr({ ...recurso('o-3', '2026-09-14T10:00:00Z'), lifecycle: 'open' });
    expect((await db.query<{ lifecycle: string }>('select lifecycle from integrations.resource_observations')).rows[0]?.lifecycle).toBe('closed');
  });

  it('renueva el lease entre páginas largas', async () => {
    const corrida = await nuevaCorrida();
    const antes = (await db.query<{ lease_until: Date }>('select lease_until from integrations.sweep_runs')).rows[0]!.lease_until;
    let ms = 0;
    const lento: AdaptadorBarrido = {
      ...adaptador([]),
      async listar(_ctx, posicion) {
        ms += 26_000;
        await new Promise((r) => setTimeout(r, 20));
        const page = typeof posicion?.page === 'number' ? posicion.page : 0;
        return { resources: [], nextPosition: page < 1 ? { page: 1 } : null, cursorAfter: { v: 1 } };
      },
    };
    await crearProcesadorMotor({ db, adaptador: lento, keyring, reloj, relojMonotonoMs: () => ms })(corrida);
    const despues = (await db.query<{ lease_until: Date }>('select lease_until from integrations.sweep_runs')).rows[0]!.lease_until;
    expect(despues.getTime()).toBeGreaterThan(antes.getTime());
  });

  it('renueva el lease mientras una misma página tarda (latido), no sólo entre páginas', async () => {
    const corrida = await nuevaCorrida();
    const leer = async () => (await db.query<{ lease_until: Date }>('select lease_until from integrations.sweep_runs')).rows[0]!.lease_until.getTime();
    const antes = await leer();
    let durante = 0;
    const lento: AdaptadorBarrido = {
      ...adaptador([]),
      async listar() {
        await new Promise((r) => setTimeout(r, 1200));
        durante = await leer();
        return { resources: [], nextPosition: null, cursorAfter: { v: 1 } };
      },
    };
    await crearProcesadorMotor({ db, adaptador: lento, keyring, reloj, latidoMs: 100 })(corrida);
    expect(durante).toBeGreaterThan(antes);
  });

  it('una vuelta completa declara bajas sólo si puede confirmar el cursor', async () => {
    const inicial = await nuevaCorrida();
    const a = recurso('o-a', '2026-09-15T09:00:00Z'); const b = recurso('o-b', '2026-09-15T09:00:00Z');
    let resultado = await crearProcesadorMotor({ db, adaptador: adaptador([{ resources: [a, b], nextPosition: null, cursorAfter: { v: 1, generation: 'g1' } }], true), keyring, reloj })(inicial);
    await completarCorrida(db, inicial, resultado.cursorAfter, resultado.antesDeCerrar);

    const conflicto = await nuevaCorrida();
    resultado = await crearProcesadorMotor({ db, adaptador: adaptador([{ resources: [a], nextPosition: null, cursorAfter: { v: 1, generation: 'g2' } }], true), keyring, reloj })(conflicto);
    await admin.query('update integrations.reconciliation_cursors set version=version+1');
    expect(await completarCorrida(db, conflicto, resultado.cursorAfter, resultado.antesDeCerrar)).toBe('partial');
    expect((await db.query<{ lifecycle: string }>("select lifecycle from integrations.resource_observations where resource_id='o-b'")).rows[0]?.lifecycle).toBe('open');

    const final = await nuevaCorrida();
    resultado = await crearProcesadorMotor({ db, adaptador: adaptador([{ resources: [a], nextPosition: null, cursorAfter: { v: 1, generation: 'g3' } }], true), keyring, reloj })(final);
    await completarCorrida(db, final, resultado.cursorAfter, resultado.antesDeCerrar);
    expect((await db.query<{ lifecycle: string }>("select lifecycle from integrations.resource_observations where resource_id='o-b'")).rows[0]?.lifecycle).toBe('deleted');
    expect((await db.query<{ n: string }>("select count(*) n from integrations.inbox_messages where remote_version like 'deleted:%'")).rows[0]?.n).toBe('1');

    const reaparece = await nuevaCorrida();
    const b2 = recurso('o-b', '2026-09-15T11:00:00Z');
    resultado = await crearProcesadorMotor({ db, adaptador: adaptador([{ resources: [a, b2], nextPosition: null, cursorAfter: { v: 1, generation: 'g4' } }], true), keyring, reloj })(reaparece);
    await completarCorrida(db, reaparece, resultado.cursorAfter, resultado.antesDeCerrar);
    expect((await db.query<{ lifecycle: string; remote_version: string }>("select lifecycle,remote_version from integrations.resource_observations where resource_id='o-b'")).rows[0])
      .toEqual({ lifecycle: 'open', remote_version: b2.version });
    expect((await db.query<{ n: string }>("select count(*) n from integrations.inbox_messages where resource_id='o-b'")).rows[0]?.n).toBe('3');
  });
});
