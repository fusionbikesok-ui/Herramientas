import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adaptadorMensajesMl } from '../../src/reconciliacion/adaptadores/ml.ts';
import { rutaAOperacion } from '../../src/reconciliacion/transporte-gateway.ts';
import { crearRelectoresMl } from '../../src/reconciliacion/relectura.ts';
import type { TransporteCanal } from '../../src/reconciliacion/cliente-http.ts';
import { claveRelector, crearWorkerSenales } from '../../src/worker/senales.ts';
import type { ContextoListado } from '../../src/reconciliacion/tipos.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const AHORA = new Date('2026-10-16T12:00:00Z');
const ok = (body: unknown, status = 200) => ({ status, headers: new Headers(), body });

describe('mensajes livianos: candidatos persistidos y rutas reales', () => {
  let base: BaseDePrueba; let db: pg.Pool; let cuenta: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); db = new pg.Pool({ connectionString: base.urlAdmin });
    const empresa = (await db.query("INSERT INTO core.companies(legal_name) VALUES ('Prueba') RETURNING id")).rows[0].id;
    cuenta = (await db.query("INSERT INTO core.channel_accounts(company_id,channel,external_account) VALUES ($1,'mercadolibre','777') RETURNING id", [empresa])).rows[0].id;
    await db.query('SELECT integrations.sembrar_corrientes($1)', [cuenta]);
  });
  beforeEach(async () => { await db.query('DELETE FROM integrations.inbox_messages; DELETE FROM integrations.resource_observations; DELETE FROM integrations.reconciliation_signals; DELETE FROM integrations.resource_relations'); });
  afterAll(async () => { await db.end(); await base.borrar(); });
  const senal = (id: string, status = 'pending') => db.query(
    `INSERT INTO integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source,status,received_at)
     VALUES ($1,'ml.messages',$2,$3,'webhook_copy',$4,'2026-10-16T11:55:00.123456Z')`, [cuenta,id,randomUUID(),status]);
  const contexto = (completa = false): ContextoListado => ({ corrida: { channelAccountId: cuenta, cursorBefore: {
    last_unread_at: AHORA.toISOString(), last_light_at: '2026-10-16T11:40:00Z',
    last_full_at: completa ? '2026-10-15T10:00:00Z' : '2026-10-16T10:00:00Z',
  } }, windowFrom: null, windowTo: AHORA } as unknown as ContextoListado);
  function montar(responder?: (id: string) => ReturnType<typeof ok>) {
    const llamadas: string[] = [];
    const transporte: TransporteCanal = { async get(ruta, extra) {
      llamadas.push(ruta);
      const op = rutaAOperacion(ruta, extra?.headers ?? {}, '777');
      if (op.op === 'ml.message') return responder?.(String(op.params.id)) ?? ok({ messages: [{ id: op.params.id }] });
      if (op.op === 'ml.messages.pack') return ok({ messages: [{ id: 'control-diario' }] });
      throw new Error('operación inesperada: ' + op.op);
    } };
    const a = adaptadorMensajesMl({ db, sellerId: '777', transporte });
    const worker = crearWorkerSenales({ db, workerId: 'pr42-regresion',
      keyring: { activeKeyId: 'test', keys: { test: Buffer.alloc(32, 7) } },
      relectores: { [claveRelector(cuenta, 'ml.messages')]: crearRelectoresMl({ transporte })['ml.messages']! },
    });
    return { a, llamadas, worker };
  }
  async function cerrar(a: ReturnType<typeof montar>['a'], ctx: ContextoListado, pos: Record<string, unknown> | null = null) {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const p = await a.listar(ctx, pos); ids.push(...p.resources.map(r => r.id));
      if (!p.nextPosition) return { ids, cursor: p.cursorAfter };
      pos = p.nextPosition;
    }
    throw new Error('corrida no termina');
  }

  it('omite excluded e IDs inválidos, procesa el válido posterior y alcanza el control diario', async () => {
    await senal('excluido-valido', 'excluded');
    await senal('terminal-valido', 'dead_lettered');
    await senal('../users/me'); await senal('a'.repeat(129)); await senal('z-valido');
    await db.query(`INSERT INTO integrations.resource_relations
      (channel_account_id,relation_type,source_topic,source_id,target_topic,target_id,first_seen_at,last_seen_at)
      VALUES ($1,'order_pack','ml.orders','1','ml.messages','123','2026-10-15T11:00:00Z','2026-10-15T11:00:00Z')`, [cuenta]);
    const { a, llamadas } = montar();
    const final = await cerrar(a, contexto(true));
    expect(final.ids).toEqual(['z-valido', 'control-diario']);
    expect(llamadas).toEqual(['/messages/z-valido?tag=post_sale', '/messages/packs/123/sellers/777?tag=post_sale&mark_as_read=false']);
    expect(final.cursor.last_full_at).toBe(AHORA.toISOString());
    expect((await db.query("SELECT status FROM integrations.reconciliation_signals WHERE resource_id='excluido-valido'")).rows)
      .toEqual([{ status: 'excluded' }]);
  });

  it('un checkpoint previo con un ID inválido no impide procesar el siguiente candidato', async () => {
    const { a, llamadas } = montar();
    const final = await cerrar(a, contexto(), { pendientes: ['msg:../users/me', 'msg:z-valido'], completa: false, despuesDe: '' });
    expect(final.ids).toEqual(['z-valido']);
    expect(llamadas).toEqual(['/messages/z-valido?tag=post_sale']);
  });

  it('un lote entero de IDs inválidos avanza el cursor sin saltar el válido que quedó fuera del tope', async () => {
    await db.query(`INSERT INTO integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source,received_at)
      SELECT $1,'ml.messages','!'||lpad(n::text,3,'0'),'invalid-'||n,'webhook_copy','2026-10-16T11:55:00.123456Z'
      FROM generate_series(1,100) n`, [cuenta]);
    await senal('z-valido');
    const { a, llamadas } = montar();
    const ctx = contexto();
    const primera = await cerrar(a, ctx);
    expect(primera.ids).toEqual([]);
    expect(primera.cursor.avisos_recortados).toBe(true);
    const siguiente = { ...ctx, corrida: { ...ctx.corrida, cursorBefore: primera.cursor } };
    const segunda = await cerrar(a, siguiente);
    expect(segunda.ids).toEqual(['z-valido']);
    expect(llamadas).toEqual(['/messages/z-valido?tag=post_sale']);
    expect(segunda.cursor.avisos_recortados).toBe(false);
  });

  it('un 404 temporal sigue a cargo del consumidor: reintenta y persiste el 200 sin otra señal', async () => {
    await senal('msg-temporal');
    let disponible = false;
    const { a, worker } = montar(id => disponible ? ok({ messages: [{ id }] }) : ok(null, 404));
    expect((await cerrar(a, contexto())).ids).toEqual([]);
    expect((await db.query('SELECT status,attempts FROM integrations.reconciliation_signals')).rows)
      .toEqual([{ status: 'pending', attempts: 0 }]);
    expect((await db.query('SELECT * FROM integrations.resource_observations')).rowCount).toBe(0);
    expect(await worker.unaVuelta()).toBe(1);
    expect((await db.query('SELECT status,attempts,error_detail FROM integrations.reconciliation_signals')).rows)
      .toEqual([{ status: 'retryable', attempts: 1, error_detail: 'retryable:HTTP_404' }]);
    disponible = true;
    await db.query('UPDATE integrations.reconciliation_signals SET available_at=now()');
    expect(await worker.unaVuelta()).toBe(1);
    expect((await db.query('SELECT status,attempts FROM integrations.reconciliation_signals')).rows)
      .toEqual([{ status: 'succeeded', attempts: 2 }]);
    expect((await db.query('SELECT resource_id,lifecycle FROM integrations.resource_observations')).rows)
      .toEqual([{ resource_id: 'msg-temporal', lifecycle: 'open' }]);
  });

  it('un 404 persistente agota sólo su señal: avanzan el candidato posterior y el control, sin revivir DLQ', async () => {
    await senal('a-persistente'); await senal('z-valido');
    await db.query("UPDATE integrations.reconciliation_signals SET max_attempts=2 WHERE resource_id='a-persistente'");
    await db.query(`INSERT INTO integrations.resource_relations
      (channel_account_id,relation_type,source_topic,source_id,target_topic,target_id,first_seen_at,last_seen_at)
      VALUES ($1,'order_pack','ml.orders','1','ml.messages','123','2026-10-15T11:00:00Z','2026-10-15T11:00:00Z')`, [cuenta]);
    const { a, llamadas, worker } = montar(id => id === 'a-persistente' ? ok(null, 404) : ok({ messages: [{ id }] }));
    const primera = await cerrar(a, contexto(true));
    expect(primera.ids).toEqual(['z-valido', 'control-diario']);
    expect(primera.cursor.last_full_at).toBe(AHORA.toISOString());
    expect((await db.query('SELECT status,attempts FROM integrations.reconciliation_signals ORDER BY resource_id')).rows)
      .toEqual([{ status: 'pending', attempts: 0 }, { status: 'pending', attempts: 0 }]);
    await worker.unaVuelta();
    await db.query("UPDATE integrations.reconciliation_signals SET available_at=now() WHERE status='retryable'");
    await worker.unaVuelta();
    const terminal = (await db.query("SELECT status,attempts,error_detail,finished_at FROM integrations.reconciliation_signals WHERE resource_id='a-persistente'")).rows[0];
    expect(terminal).toMatchObject({ status: 'dead_lettered', attempts: 2, error_detail: 'retryable:HTTP_404' });
    expect(terminal.finished_at).toBeInstanceOf(Date);
    const antes = llamadas.length;
    // Reexaminar incluso la misma ventana prueba el filtro de terminales, no sólo el cursor avanzado.
    const segunda = await cerrar(a, contexto(true));
    expect(segunda.ids).toEqual(['control-diario']);
    expect(llamadas.slice(antes)).toEqual(['/messages/packs/123/sellers/777?tag=post_sale&mark_as_read=false']);
    expect(await worker.unaVuelta()).toBe(0);
    expect((await db.query("SELECT status,attempts,error_detail,finished_at FROM integrations.reconciliation_signals WHERE resource_id='a-persistente'")).rows[0]).toEqual(terminal);
    expect((await db.query("SELECT * FROM integrations.resource_observations WHERE resource_id='a-persistente'")).rowCount).toBe(0);
  });
});
