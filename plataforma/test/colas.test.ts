import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verificarCadena } from '../src/audit/auditoria.ts';
import { backoffSegundos, completar, encolarInbox, fallar, liberarVencidos, reclamar, soltarPorApagado } from '../src/colas/colas.ts';
import { ErrorIncierto, ErrorLeaseVencido, ErrorTransitorio } from '../src/colas/errores.ts';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

describe('colas', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let cuenta: string;
  const msg = (resourceId: string, remoteVersion = 'v1', maxAttempts?: number) => ({
    channelAccountId: cuenta, topic: 'ml.orders', resourceId, remoteVersion, source: 'sweep' as const, correlationId: randomUUID(),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
  const estado = async (id: string) => (await admin.query<{ status: string; attempts: number; lease_token: string | null }>('select status, attempts, lease_token from integrations.inbox_messages where id=$1', [id])).rows[0]!;

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    app = crearPool(base.urlApp, { max: 6 });
    admin = crearPool(base.urlAdmin, { max: 2 });
    const empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
    cuenta = (await app.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => { await admin.query('delete from integrations.dead_letters; delete from integrations.inbox_messages'); });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('E1-DUP-01 la misma señal 5 veces crea un solo mensaje por versión', async () => {
    const creados = [];
    for (let i = 0; i < 5; i++) creados.push(await encolarInbox(app, msg('r1', 'v1')));
    expect(creados.filter((c) => c.creado)).toHaveLength(1);
    expect((await encolarInbox(app, msg('r1', 'v2'))).creado).toBe(true);
    const r = await app.query<{ n: string }>("select count(*) as n from integrations.inbox_messages where resource_id='r1'");
    expect(r.rows[0]?.n).toBe('2');
  });

  it('E1-Q-01 reclamar toma el mensaje con lease y cuenta el intento', async () => {
    const { id } = await encolarInbox(app, msg('q1'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 10);
    expect(r?.id).toBe(id);
    expect(await estado(id!)).toMatchObject({ status: 'claimed', attempts: 1 });
  });

  it('E1-Q-01 reclamar ignora tópicos no pedidos', async () => {
    await encolarInbox(app, msg('q1b'));
    expect(await reclamar(app, 'inbox', ['woo.orders'], 10)).toEqual([]);
  });

  it('E1-Q-02 completar con lease vigente; con lease vencido no escribe', async () => {
    await encolarInbox(app, msg('q2a')); await encolarInbox(app, msg('q2b'));
    const [a, b] = await reclamar(app, 'inbox', ['ml.orders'], 2);
    await completar(app, a!);
    expect((await estado(a!.id)).status).toBe('succeeded');
    expect((await app.query("select 1 from audit.audit_events where action='cola.succeeded' and aggregate_id=$1", [a!.id])).rowCount).toBe(1);
    await admin.query("update integrations.inbox_messages set lease_until = now() - interval '1 second' where id=$1", [b!.id]);
    await expect(completar(app, b!)).rejects.toBeInstanceOf(ErrorLeaseVencido);
    expect((await estado(b!.id)).status).toBe('claimed');
  });

  it('E1-Q-03 un resultado incierto queda uncertain, auditado y visible como incidente', async () => {
    await encolarInbox(app, msg('q3'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(await fallar(app, r!, new ErrorIncierto('respuesta cortada'))).toBe('uncertain');
    expect((await estado(r!.id)).status).toBe('uncertain');
    expect(await reclamar(app, 'inbox', ['ml.orders'], 10)).toEqual([]);
    const inc = await app.query("select 1 from integrations.incidents where source_type='inbox' and status='uncertain'");
    expect(inc.rowCount).toBe(1);
    const aud = await app.query("select 1 from audit.audit_events where action='cola.uncertain' and aggregate_id=$1", [r!.id]);
    expect(aud.rowCount).toBe(1);
    expect(await verificarCadena(app)).toBeNull();
  });

  it('E1-Q-04 transitorio reintenta con backoff y al agotar intentos va a DLQ', async () => {
    await encolarInbox(app, msg('q4', 'v1', 2));
    let [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(await fallar(app, r!, new ErrorTransitorio('503'))).toBe('retryable');
    await admin.query('update integrations.inbox_messages set available_at = now() where id=$1', [r!.id]);
    [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(await fallar(app, r!, new ErrorTransitorio('503'))).toBe('dead_lettered');
    const dl = await app.query("select reason_code from integrations.dead_letters where source_type='inbox' and source_id=$1", [r!.id]);
    expect(dl.rows).toEqual([{ reason_code: 'intentos_agotados' }]);
  });

  it('E1-Q-04 un error terminal va directo a DLQ', async () => {
    await encolarInbox(app, msg('q4b'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(await fallar(app, r!, new Error('403 prohibido'))).toBe('dead_lettered');
  });

  it('E1-Q-05 dos workers sobre 1.000 mensajes: cada uno procesado exactamente una vez', async () => {
    for (let i = 0; i < 1000; i++) await encolarInbox(app, msg(`q5-${i}`));
    const vistos: string[] = [];
    const trabajar = async () => {
      for (;;) {
        const lote = await reclamar(app, 'inbox', ['ml.orders'], 25);
        if (!lote.length) return;
        for (const r of lote) { vistos.push(r.id); await completar(app, r); }
      }
    };
    await Promise.all([trabajar(), trabajar()]);
    expect(vistos).toHaveLength(1000);
    expect(new Set(vistos).size).toBe(1000);
  });

  it('E1-Q-06 un lease vencido vuelve a pending y se procesa una vez', async () => {
    await encolarInbox(app, msg('q6'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    await admin.query("update integrations.inbox_messages set lease_until = now() - interval '1 second' where id=$1", [r!.id]);
    expect(await liberarVencidos(app, 'inbox')).toEqual({ pendientes: 1, muertos: 0 });
    const [otra] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    expect(otra?.id).toBe(r!.id);
    expect(otra?.attempts).toBe(2);
    await completar(app, otra!);
    await expect(completar(app, r!)).rejects.toBeInstanceOf(ErrorLeaseVencido);
  });

  it('E1-Q-06 soltar por apagado devuelve el intento', async () => {
    await encolarInbox(app, msg('q6b'));
    const [r] = await reclamar(app, 'inbox', ['ml.orders'], 1);
    await soltarPorApagado(app, r!);
    expect(await estado(r!.id)).toMatchObject({ status: 'pending', attempts: 0, lease_token: null });
  });

  it('backoff exponencial con tope y jitter acotado', () => {
    expect(backoffSegundos(1, () => 0.5)).toBe(10);
    expect(backoffSegundos(3, () => 0.5)).toBe(40);
    expect(backoffSegundos(20, () => 0.5)).toBe(900);
    expect(backoffSegundos(3, () => 0)).toBe(32);
    expect(backoffSegundos(3, () => 1)).toBe(48);
  });
});
