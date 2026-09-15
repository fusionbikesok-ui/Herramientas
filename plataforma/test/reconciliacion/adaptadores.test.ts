import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearAdaptadoresMl } from '../../src/reconciliacion/adaptadores/ml.ts';
import { crearAdaptadoresWoo } from '../../src/reconciliacion/adaptadores/woo.ts';
import {
  crearClienteCanal, ErrorCanalTerminal, ErrorDestinoProhibido, ErrorMetodoProhibido, parsearRetryAfter,
} from '../../src/reconciliacion/cliente-http.ts';
import { completarCorrida, fallarCorrida, materializarCorridas, reclamarCorridas } from '../../src/reconciliacion/corridas.ts';
import { crearProcesadorMotor } from '../../src/reconciliacion/motor.ts';
import type { AdaptadorBarrido } from '../../src/reconciliacion/tipos.ts';
import { descifrarSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';
import { ErrorBarridoReintentable } from '../../src/worker/barridos.ts';
import { crearSimulador, type DatosSimulador, type FixtureCanales, type LlamadaSimulador, type RegistroSim } from '../../../scripts/qa/simulador-canales.mjs';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const SELLER = '777';
const PII = '@fixture.invalid';
const keyring: KeyringSobre = { activeKeyId: 'adaptadores', keys: { adaptadores: Buffer.alloc(32, 9) } };
const WINDOW_TO = new Date('2026-09-15T12:00:00.000Z');
const reloj = () => WINDOW_TO;
const hace = (horas: number) => new Date(WINDOW_TO.getTime() - horas * 3_600_000).toISOString();

function fixtureBase(): FixtureCanales {
  const orders: RegistroSim[] = Array.from({ length: 60 }, (_, i) => ({
    id: 5000 + i, status: i === 0 ? 'cancelled' : 'paid', date_last_updated: hace(1 + i),
    shipping: { id: 9000 + i }, pack_id: i % 3 === 0 ? 7000 + i : null, buyer: { email: `b${i}${PII}` },
  }));
  const shipments = orders.slice(0, 20).map((o) => ({
    id: (o.shipping as { id: number }).id, status: 'ready_to_ship', substatus: 'printed', last_updated: hace(2),
    receiver_address: { street_name: 'Calle Falsa 123' },
  }));
  return {
    ml: {
      orders, shipments,
      questions: [
        { id: 1, status: 'UNANSWERED', date_created: hace(3), text: `hola${PII}` },
        { id: 2, status: 'UNANSWERED', date_created: hace(4), text: 'precio?' },
      ],
      claims: [{ id: 31, status: 'opened', stage: 'claim', last_updated: hace(5) }],
      unread: [{ resource: `/packs/8001/sellers/${SELLER}`, count: 1 }],
      packs: {
        '8001': [{ id: 'm-1', status: 'available', message_date: { created: hace(1), available: hace(1) }, text: `dato${PII}` }],
        '7000': [{ id: 'm-2', status: 'available', message_date: { created: hace(6), available: hace(6) }, text: 'ok' }],
      },
      items: Array.from({ length: 130 }, (_, i) => ({
        id: `MLA${100000 + i}`, status: 'active', sub_status: [], last_updated: hace(10),
        variations: i % 50 === 0 ? [{ id: 2, available_quantity: 3 }, { id: 1, available_quantity: 1 }] : [],
      })),
    },
    woo: {
      orders: Array.from({ length: 150 }, (_, i) => ({ id: 300 + i, status: 'processing', date_modified_gmt: hace(1 + i / 100).slice(0, 19), billing: { email: `w${i}${PII}` } })),
      products: [
        ...Array.from({ length: 120 }, (_, i) => ({ id: 10 + i, parent_id: 0, type: i === 0 ? 'variable' : 'simple', status: 'publish', date_modified_gmt: hace(20).slice(0, 19) })),
        { id: 900, parent_id: 10, type: 'variation', status: 'publish', date_modified_gmt: hace(20).slice(0, 19) },
        { id: 901, parent_id: 10, type: 'variation', status: 'publish', date_modified_gmt: hace(20).slice(0, 19) },
      ],
    },
  };
}

describe('adaptadores y cliente de barridos E1 T2', () => {
  let base: BaseDePrueba; let db: pg.Pool; let admin: pg.Pool; let cuenta: string;
  let servidor: Server; let url: string; let fixture: FixtureCanales; let datos: DatosSimulador | undefined;

  beforeAll(async () => {
    base = await crearBaseDePrueba(); db = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin);
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('Adaptadores') returning id")).rows[0]!.id;
    cuenta = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','adaptadores') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`delete from integrations.inbox_messages; delete from integrations.resource_relations;
      delete from integrations.resource_observations; delete from integrations.sweep_runs;
      delete from integrations.reconciliation_cursors`);
    fixture = fixtureBase();
    datos = undefined;
    fixture.alLlamar = (_llamada, vivos) => { datos = vivos; };
    await new Promise<void>((r) => { servidor?.close(); servidor = crearSimulador({ fixture }); servidor.listen(0, '127.0.0.1', r); });
    url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });
  afterAll(async () => { servidor?.close(); await db.end(); await admin.end(); await base.borrar(); });

  const cliente = (o: Partial<Parameters<typeof crearClienteCanal>[0]> = {}) => crearClienteCanal({ baseUrl: url, ...o });
  const adaptadores = (): Record<string, AdaptadorBarrido> => ({
    ...crearAdaptadoresMl({ transporte: cliente(), db, sellerId: SELLER }),
    ...crearAdaptadoresWoo({ transporte: cliente() }),
  });
  const llamadas = async (): Promise<LlamadaSimulador[]> => (await fetch(`${url}/__qa/llamadas`)).json() as Promise<LlamadaSimulador[]>;
  const qa = (cuerpo: object) => fetch(`${url}/__qa/fallas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) });
  const contar = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
  const inbox = (topic: string) => contar('select count(*) n from integrations.inbox_messages where topic=$1', [topic]);

  async function barrer(topic: string, opciones: { reloj?: () => Date } = {}) {
    const estrategia = ['ml.shipments'].includes(topic) ? 'convergence' : 'enumerable';
    await db.query(`insert into integrations.reconciliation_cursors
        (channel_account_id,topic,strategy,overlap_seconds,interval_seconds,next_run_at)
      values ($1,$2,$3,600,600,now()-interval '1 hour')
      on conflict (channel_account_id,topic,cursor_kind) do update set next_run_at=now()-interval '1 second'`,
    [cuenta, topic, estrategia]);
    await materializarCorridas(db);
    const corrida = (await reclamarCorridas(db, 'w-adaptadores', [topic], 1))[0]!;
    const procesar = crearProcesadorMotor({ db, adaptador: adaptadores()[topic]!, keyring, reloj: opciones.reloj ?? reloj });
    try {
      const r = await procesar(corrida);
      return { corrida, estado: await completarCorrida(db, corrida, r.cursorAfter, r.antesDeCerrar) };
    } catch (error) {
      await fallarCorrida(db, corrida, (error as Error).name, undefined, () => 0.5, error instanceof ErrorBarridoReintentable);
      throw error;
    }
  }

  describe('cliente HTTP de lectura', () => {
    it('rechaza métodos no GET, destinos externos y rutas que cambian el origen antes de la red', async () => {
      let llamados = 0;
      const espia = (async () => { llamados++; return new Response('{}'); }) as typeof fetch;
      const c = cliente({ fetch: espia });
      for (const metodo of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(c.solicitar(metodo, '/items')).rejects.toBeInstanceOf(ErrorMetodoProhibido);
      await expect(c.get('//evil.example/x')).rejects.toBeInstanceOf(ErrorDestinoProhibido);
      expect(llamados).toBe(0);
      expect(() => crearClienteCanal({ baseUrl: 'https://api.mercadolibre.com' })).toThrow(ErrorDestinoProhibido);
      expect(() => crearClienteCanal({ baseUrl: 'http://user:pw@127.0.0.1:1' })).toThrow(ErrorDestinoProhibido);
      expect(() => crearClienteCanal({ baseUrl: 'http://simulator:8443' })).not.toThrow();
    });

    it('clasifica 401/403/redirección como terminales y 408/429/5xx como reintentables con Retry-After acotado', async () => {
      const c = cliente({ token: 'APP_USR-SECRETO' });
      for (const status of [401, 403]) {
        await qa({ ruta: '^/items/MLA1', status });
        const error = await c.get('/items/MLA1?access_token=SECRETO').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ErrorCanalTerminal);
        expect(String((error as Error).message)).not.toMatch(/SECRETO/);
      }
      for (const status of [408, 500, 503]) {
        await qa({ ruta: '^/items/MLA1', status });
        await expect(c.get('/items/MLA1')).rejects.toBeInstanceOf(ErrorBarridoReintentable);
      }
      await qa({ ruta: '^/items/MLA1', status: 429, retryAfter: 9999 });
      expect(((await c.get('/items/MLA1').catch((e: unknown) => e)) as ErrorBarridoReintentable).retryAfter).toBe(300);
      expect(parsearRetryAfter('Wed, 15 Sep 2026 12:01:00 GMT', WINDOW_TO)).toBe(60);
      const redirige = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } })) as typeof fetch;
      await expect(cliente({ fetch: redirige }).get('/x')).rejects.toBeInstanceOf(ErrorCanalTerminal);
    });

    it('timeout, corte antes y después de responder son reintentables; cuerpo excedido es terminal', async () => {
      await qa({ ruta: '^/items\\?ids=A', demoraMs: 300 });
      await expect(cliente({ timeoutMs: 50 }).get('/items?ids=A')).rejects.toThrow(/TIMEOUT/);
      await qa({ ruta: '^/items\\?ids=B', modo: 'cortar' });
      await expect(cliente().get('/items?ids=B')).rejects.toBeInstanceOf(ErrorBarridoReintentable);
      await qa({ ruta: '^/items\\?ids=C', modo: 'cortar-despues' });
      await expect(cliente().get('/items?ids=C')).rejects.toBeInstanceOf(ErrorBarridoReintentable);
      await expect(cliente({ maxBytes: 10 }).get('/users/777/items/search?search_type=scan')).rejects.toThrow(/CUERPO_EXCEDIDO/);
      expect((await llamadas()).every((l) => l.headers['x-fusion-plano'] === 'canal')).toBe(true);
    });
  });

  it('E1-SWP ml.orders: bootstrap en ventanas ≤6 h, 0 faltantes, relaciones y payload cifrado', async () => {
    expect((await barrer('ml.orders')).estado).toBe('succeeded');
    expect(await inbox('ml.orders')).toBe(60);
    const rutas = (await llamadas()).map((l) => new URL(l.ruta, url).searchParams);
    for (const q of rutas) {
      const desde = Date.parse(q.get('order.date_last_updated.from')!); const hasta = Date.parse(q.get('order.date_last_updated.to')!);
      expect(hasta - desde).toBeLessThanOrEqual(6 * 3_600_000);
      expect(hasta).toBeLessThanOrEqual(WINDOW_TO.getTime());
    }
    expect(await contar("select count(*) n from integrations.resource_relations where relation_type='order_shipment'")).toBe(60);
    expect(await contar("select count(*) n from integrations.resource_relations where relation_type='order_pack'")).toBe(60);
    const filas = await db.query<{ payload_ciphertext: Buffer }>('select payload_ciphertext from integrations.inbox_messages');
    expect(filas.rows.every((f) => !f.payload_ciphertext.includes(Buffer.from(PII)))).toBe(true);
    const cursor = await db.query<{ cursor_value: { updated_at: string } }>("select cursor_value from integrations.reconciliation_cursors where topic='ml.orders'");
    expect(cursor.rows[0]?.cursor_value.updated_at).toBe(WINDOW_TO.toISOString());
  });

  it('E1-CONV-01 ml.shipments: 20 relaciones, 5 cambian y sólo esas se encolan, siempre con x-format-new', async () => {
    // El simulador comparte el array vivo: se recorta en el lugar para que el barrido de órdenes lo vea.
    fixture.ml!.orders!.splice(20);
    await barrer('ml.orders');
    expect((await barrer('ml.shipments')).estado).toBe('succeeded');
    expect(await inbox('ml.shipments')).toBe(20);
    for (const s of [...datos!.envios.values()].slice(0, 5)) { s.last_updated = hace(0.5); s.status = 'shipped'; }
    await barrer('ml.shipments', { reloj: () => new Date(WINDOW_TO.getTime() + 60_000) });
    expect(await inbox('ml.shipments')).toBe(25);
    const ultima = await db.query<{ enumerated: number; missing_enqueued: number }>(
      "select enumerated,missing_enqueued from integrations.sweep_runs where topic='ml.shipments' order by id desc limit 1");
    expect(ultima.rows[0]).toEqual({ enumerated: 20, missing_enqueued: 5 });
    const envios = (await llamadas()).filter((l) => l.ruta.startsWith('/shipments/'));
    expect(envios).toHaveLength(40);
    expect(envios.every((l) => l.headers['x-format-new'] === 'true')).toBe(true);
  });

  it('E1-SWP ml.questions y ml.claims: abiertas enumeradas y conocidas convergen al cerrarse o desaparecer', async () => {
    await barrer('ml.questions'); await barrer('ml.claims');
    expect(await inbox('ml.questions')).toBe(2);
    expect(await inbox('ml.claims')).toBe(1);
    datos!.preguntas.get('1')!.status = 'ANSWERED';
    datos!.preguntas.delete('2');
    datos!.reclamos.get('31')!.status = 'closed';
    await barrer('ml.questions'); await barrer('ml.claims');
    const estados = await db.query<{ topic: string; resource_id: string; lifecycle: string }>(
      "select topic,resource_id,lifecycle from integrations.resource_observations where topic in ('ml.questions','ml.claims') order by 1,2");
    expect(estados.rows).toEqual([
      { topic: 'ml.claims', resource_id: '31', lifecycle: 'closed' },
      { topic: 'ml.questions', resource_id: '1', lifecycle: 'closed' },
      { topic: 'ml.questions', resource_id: '2', lifecycle: 'deleted' },
    ]);
    expect((await llamadas()).some((l) => l.ruta === '/questions/1')).toBe(true);
  });

  it('E1-SWP ml.messages: no leídos + packs de órdenes, siempre mark_as_read=false', async () => {
    await barrer('ml.orders');
    expect((await barrer('ml.messages')).estado).toBe('succeeded');
    expect(await inbox('ml.messages')).toBe(2);
    const packs = (await llamadas()).filter((l) => l.ruta.startsWith('/messages/packs/'));
    expect(packs.length).toBeGreaterThan(2);
    expect(packs.every((l) => new URL(l.ruta, url).searchParams.get('mark_as_read') === 'false')).toBe(true);
  });

  it('E1-SWP ml.items: scan paginado + multiget de 20 y baja sólo tras una vuelta completa', async () => {
    await barrer('ml.items');
    expect(await inbox('ml.items')).toBe(130);
    expect((await llamadas()).filter((l) => l.ruta.startsWith('/items?ids=')).every((l) => l.ruta.split('=')[1]!.split(',').length <= 20)).toBe(true);
    datos!.items.delete('MLA100005');
    await qa({ ruta: 'scroll_id=100', status: 503 });
    await expect(barrer('ml.items', { reloj: () => new Date(WINDOW_TO.getTime() + 60_000) })).rejects.toBeInstanceOf(ErrorBarridoReintentable);
    expect(await contar("select count(*) n from integrations.resource_observations where lifecycle='deleted'")).toBe(0);
    await admin.query("update integrations.sweep_runs set available_at=now() where status='retryable'");
    const corrida = (await reclamarCorridas(db, 'w-adaptadores', ['ml.items'], 1))[0]!;
    const r = await crearProcesadorMotor({ db, adaptador: adaptadores()['ml.items']!, keyring, reloj })(corrida);
    expect(await completarCorrida(db, corrida, r.cursorAfter, r.antesDeCerrar)).toBe('succeeded');
    expect((await db.query<{ resource_id: string }>("select resource_id from integrations.resource_observations where lifecycle='deleted'")).rows).toEqual([{ resource_id: 'MLA100005' }]);
  });

  it('E1-SWP woo.orders: GMT explícito, ventanas congeladas y 100 por página', async () => {
    await barrer('woo.orders');
    expect(await inbox('woo.orders')).toBe(150);
    const qs = (await llamadas()).map((l) => new URL(l.ruta, url).searchParams);
    expect(qs.every((q) => q.get('dates_are_gmt') === 'true' && q.get('per_page') === '100')).toBe(true);
    expect(qs.some((q) => q.get('page') === '2')).toBe(true);
    const fila = await db.query<{ remote_version: string }>("select remote_version from integrations.resource_observations where topic='woo.orders' and resource_id='300'");
    expect(fila.rows[0]?.remote_version.endsWith('Z')).toBe(true);
  });

  it('E1-DEL-01 woo.products: padres + variaciones y producto borrado sin webhook detectado en la vuelta', async () => {
    await barrer('woo.products');
    expect(await inbox('woo.products')).toBe(122);
    expect(await contar("select count(*) n from integrations.resource_relations where relation_type='product_variation'")).toBe(2);
    datos!.productos.delete(15);
    await barrer('woo.products', { reloj: () => new Date(WINDOW_TO.getTime() + 60_000) });
    const bajas = await db.query<{ resource_id: string; payload_ciphertext: Buffer; payload_nonce: Buffer; payload_tag: Buffer; payload_key_id: string; remote_version: string }>(
      "select resource_id,payload_ciphertext,payload_nonce,payload_tag,payload_key_id,remote_version from integrations.inbox_messages where remote_version like 'deleted:%'");
    expect(bajas.rows.map((f) => f.resource_id)).toEqual(['15']);
    const b = bajas.rows[0]!;
    const plano = descifrarSobre({ keyId: b.payload_key_id, nonce: b.payload_nonce, tag: b.payload_tag, ciphertext: b.payload_ciphertext },
      { account: cuenta, topic: 'woo.products', resource: '15', remoteVersion: b.remote_version }, keyring);
    expect(JSON.parse(plano.toString())).toEqual({ id: '15', lifecycle: 'deleted' });
  });

  it('ninguna llamada de canal usa un método distinto de GET', async () => {
    await barrer('ml.orders'); await barrer('woo.products'); await barrer('ml.messages');
    const canal = (await llamadas()).filter((l) => l.headers['x-fusion-plano'] === 'canal');
    expect(canal.length).toBeGreaterThan(0);
    expect(canal.every((l) => l.metodo === 'GET')).toBe(true);
  });
});
