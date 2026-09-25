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
import { claveCorriente, type AdaptadorBarrido } from '../../src/reconciliacion/tipos.ts';
import { descifrarSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';
import { ErrorBarridoReintentable } from '../../src/worker/barridos.ts';
import { crearSimulador, type DatosSimulador, type FixtureCanales, type LlamadaSimulador, type RegistroSim } from '../../../scripts/qa/simulador-canales.mjs';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const SELLER = '777';
const PII = '@fixture.invalid';
const keyring: KeyringSobre = { activeKeyId: 'adaptadores', keys: { adaptadores: Buffer.alloc(32, 9) } };
const WINDOW_TO = new Date('2026-09-15T12:00:00.000Z');
const reloj = () => WINDOW_TO;
const despues = (minutos: number) => () => new Date(WINDOW_TO.getTime() + minutos * 60_000);
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
      orders: [
        ...Array.from({ length: 150 }, (_, i) => ({ id: 300 + i, status: 'processing', date_modified_gmt: hace(1 + i / 100).slice(0, 19), billing: { email: `w${i}${PII}` } })),
        // Cancelado y papelereado dentro de la ventana: `any` trae el primero y excluye el segundo.
        { id: 450, status: 'cancelled', date_modified_gmt: hace(1).slice(0, 19), billing: { email: `cancel${PII}` } },
        { id: 451, status: 'trash', date_modified_gmt: hace(1).slice(0, 19), billing: { email: `papelera${PII}` } },
      ],
      products: [
        ...Array.from({ length: 120 }, (_, i) => ({ id: 10 + i, parent_id: 0, type: i === 0 ? 'variable' : 'simple', status: 'publish', date_modified_gmt: hace(20).slice(0, 19) })),
        { id: 900, parent_id: 10, type: 'variation', status: 'publish', date_modified_gmt: hace(20).slice(0, 19) },
        { id: 901, parent_id: 10, type: 'variation', status: 'publish', date_modified_gmt: hace(20).slice(0, 19) },
        // Fuera de la ventana de arranque de 30 días: el barrido incremental no debe traerlo.
        { id: 500, parent_id: 0, type: 'simple', status: 'publish', date_modified_gmt: hace(24 * 40).slice(0, 19) },
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
    ...crearAdaptadoresMl({ transporte: cliente(), db, sellerId: SELLER, esperar: async () => {} }),
    ...crearAdaptadoresWoo({ transporte: cliente() }),
  });
  const llamadas = async (): Promise<LlamadaSimulador[]> => (await fetch(`${url}/__qa/llamadas`)).json() as Promise<LlamadaSimulador[]>;
  const qa = (cuerpo: object) => fetch(`${url}/__qa/fallas`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) });
  const contar = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
  const inbox = (topic: string) => contar('select count(*) n from integrations.inbox_messages where topic=$1', [topic]);

  /** Programa y ejecuta una corrida de la corriente pedida, tal como lo haría scheduler + worker. */
  async function barrer(topic: string, cursorKind = 'state_sweep', opciones: { reloj?: () => Date } = {}) {
    const estrategia = topic === 'ml.shipments' ? 'convergence' : 'enumerable';
    await db.query(`insert into integrations.reconciliation_cursors
        (channel_account_id,topic,cursor_kind,strategy,overlap_seconds,interval_seconds,next_run_at)
      values ($1,$2,$3,$4,600,600,now()-interval '1 hour')
      on conflict (channel_account_id,topic,cursor_kind) do update set next_run_at=now()-interval '1 second'`,
    [cuenta, topic, cursorKind, estrategia]);
    await materializarCorridas(db);
    const corrida = (await reclamarCorridas(db, 'w-adaptadores', [{ channelAccountId: cuenta, topic, cursorKind }], 1))[0]!;
    const adaptador = adaptadores()[claveCorriente(topic, cursorKind)]!;
    const procesar = crearProcesadorMotor({ db, adaptador, keyring, reloj: opciones.reloj ?? reloj });
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

  it('E1-SWP-01 ml.orders: bootstrap en ventanas ≤6 h, 0 faltantes, relaciones y payload cifrado', async () => {
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

  /** Órdenes dentro de la última hora: caen en un solo segmento de 6 h y fuerzan dos páginas. */
  function soloOrdenes(cantidad: number): RegistroSim[] {
    const nuevas: RegistroSim[] = Array.from({ length: cantidad }, (_, i) => ({
      id: 6000 + i, status: 'paid',
      date_last_updated: new Date(WINDOW_TO.getTime() - (cantidad - i) * 60_000).toISOString(),
      shipping: { id: 9500 + i }, pack_id: null, buyer: { email: `o${i}${PII}` },
    }));
    fixture.ml!.orders!.splice(0, Number.POSITIVE_INFINITY, ...nuevas);
    return nuevas;
  }

  it('relee el segmento de ml.orders si el total cambia durante el paginado', async () => {
    const ultima = soloOrdenes(60).at(-1)!;
    fixture.alLlamar = (llamada, vivos) => {
      datos = vivos;
      // Al pedir la segunda página, la orden más nueva se modifica y sale de la ventana congelada.
      if (llamada.ruta.includes('offset=50') && vivos.ordenesMl.length === 60) {
        vivos.ordenesMl.splice(vivos.ordenesMl.findIndex((o) => o.id === ultima.id), 1);
      }
    };
    expect((await barrer('ml.orders')).estado).toBe('succeeded');
    expect(await inbox('ml.orders')).toBe(59);
    const observadas = (await db.query<{ resource_id: string }>(
      "select resource_id from integrations.resource_observations where topic='ml.orders'")).rows.map((f) => f.resource_id);
    expect(observadas.sort()).toEqual(datos!.ordenesMl.map((o) => String(o.id)).sort());
    const inicios = new Map<string, number>();
    for (const l of await llamadas()) {
      const q = new URL(l.ruta, url).searchParams;
      if (q.get('offset') === '0') {
        const desde = q.get('order.date_last_updated.from')!;
        inicios.set(desde, (inicios.get(desde) ?? 0) + 1);
      }
    }
    expect([...inicios.values()].some((n) => n >= 2)).toBe(true);
  });

  it('un segmento de ml.orders que nunca se estabiliza deja la corrida reintentable y el cursor quieto', async () => {
    soloOrdenes(60);
    let quitadas = 0;
    fixture.alLlamar = (llamada, vivos) => {
      datos = vivos;
      if (llamada.ruta.includes('offset=50')) { vivos.ordenesMl.pop(); quitadas++; }
    };
    await expect(barrer('ml.orders')).rejects.toThrow(/SEGMENTO_INESTABLE/);
    expect(quitadas).toBeGreaterThanOrEqual(3);
    expect((await db.query<{ status: string }>("select status from integrations.sweep_runs where topic='ml.orders'")).rows[0]?.status).toBe('retryable');
    expect((await db.query<{ cursor_value: unknown }>("select cursor_value from integrations.reconciliation_cursors where topic='ml.orders'")).rows[0]?.cursor_value).toBeNull();
  });

  it('E1-SWP-02 y E1-CONV-01 ml.shipments: 20 relaciones, 5 cambian y sólo esas se encolan, siempre con x-format-new', async () => {
    // El simulador comparte el array vivo: se recorta en el lugar para que el barrido de órdenes lo vea.
    fixture.ml!.orders!.splice(20);
    await barrer('ml.orders');
    expect((await barrer('ml.shipments')).estado).toBe('succeeded');
    expect(await inbox('ml.shipments')).toBe(20);
    for (const s of [...datos!.envios.values()].slice(0, 5)) { s.last_updated = hace(0.5); s.status = 'shipped'; }
    await barrer('ml.shipments', 'state_sweep', { reloj: despues(1) });
    expect(await inbox('ml.shipments')).toBe(25);
    const ultima = await db.query<{ enumerated: number; missing_enqueued: number }>(
      "select enumerated,missing_enqueued from integrations.sweep_runs where topic='ml.shipments' order by id desc limit 1");
    expect(ultima.rows[0]).toEqual({ enumerated: 20, missing_enqueued: 5 });
    const envios = (await llamadas()).filter((l) => l.ruta.startsWith('/shipments/'));
    expect(envios).toHaveLength(40);
    expect(envios.every((l) => l.headers['x-format-new'] === 'true')).toBe(true);
  });

  it('E1-SWP-03 y E1-SWP-05 ml.questions y ml.claims: abiertas enumeradas y conocidas convergen al cerrarse o desaparecer', async () => {
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

  it('E1-SWP-04 ml.messages: no leídos + packs de órdenes, siempre mark_as_read=false', async () => {
    await barrer('ml.orders');
    expect((await barrer('ml.messages')).estado).toBe('succeeded');
    expect(await inbox('ml.messages')).toBe(2);
    const packs = (await llamadas()).filter((l) => l.ruta.startsWith('/messages/packs/'));
    expect(packs.length).toBeGreaterThan(2);
    expect(packs.every((l) => new URL(l.ruta, url).searchParams.get('mark_as_read') === 'false')).toBe(true);
  });

  it('E1-SWP-06 ml.items: scan paginado + multiget de 20 y baja sólo tras una vuelta completa', async () => {
    await barrer('ml.items', 'full_scan');
    expect(await inbox('ml.items')).toBe(130);
    const bulk = (await llamadas()).filter((l) => l.ruta.startsWith('/items/bulk?ids='));
    expect(bulk.length).toBe(7);
    expect(bulk.every((l) => l.ruta.split('=')[1]!.split(',').length <= 20)).toBe(true);
    datos!.items.delete('MLA100005');
    // 7 = el pedido original + los 6 reintentos del adaptador: sólo un 503 persistente tira la vuelta.
    await qa({ ruta: 'scroll_id=100', status: 503, veces: 7 });
    await expect(barrer('ml.items', 'full_scan', { reloj: despues(1) })).rejects.toBeInstanceOf(ErrorBarridoReintentable);
    expect(await contar("select count(*) n from integrations.resource_observations where lifecycle='deleted'")).toBe(0);
    await admin.query("update integrations.sweep_runs set available_at=now() where status='retryable'");
    const corrida = (await reclamarCorridas(db, 'w-adaptadores', [{ channelAccountId: cuenta, topic: 'ml.items', cursorKind: 'full_scan' }], 1))[0]!;
    const r = await crearProcesadorMotor({ db, adaptador: adaptadores()[claveCorriente('ml.items', 'full_scan')]!, keyring, reloj })(corrida);
    expect(await completarCorrida(db, corrida, r.cursorAfter, r.antesDeCerrar)).toBe('succeeded');
    expect((await db.query<{ resource_id: string }>("select resource_id from integrations.resource_observations where lifecycle='deleted'")).rows).toEqual([{ resource_id: 'MLA100005' }]);
  });

  it('E1-BLK-01 bulk parcial: cada elemento informa su estado y un fallo no tira el lote ni provoca una baja', async () => {
    await barrer('ml.items', 'full_scan');
    expect(await inbox('ml.items')).toBe(130);
    // En la vuelta siguiente cambian dos ítems y a uno de ellos el bulk le responde 500 sólo a él.
    for (const id of ['MLA100001', 'MLA100002']) datos!.items.get(id)!.last_updated = hace(0);
    fixture.ml!.fallosBulk = { MLA100002: 500 };
    const { estado } = await barrer('ml.items', 'full_scan', { reloj: despues(1) });
    expect(estado).toBe('succeeded');
    // El sano se encoló; el fallido no se observó con contenido nuevo, pero tampoco quedó dado de baja.
    expect(await inbox('ml.items')).toBe(131);
    const fallido = (await db.query<{ lifecycle: string; remote_version: string }>(
      "select lifecycle, remote_version from integrations.resource_observations where resource_id='MLA100002'")).rows[0]!;
    expect(fallido.lifecycle).toBe('open');
    expect(fallido.remote_version).toBe(hace(10));
    expect(await contar("select count(*) n from integrations.resource_observations where lifecycle='deleted'")).toBe(0);
  });

  it('E1-SWP-07 woo.orders: GMT explícito, ventana única, 100 por página y cierres capturados', async () => {
    const { corrida } = await barrer('woo.orders');
    expect(await inbox('woo.orders')).toBe(152);
    expect((await db.query<{ enumerated: number }>('select enumerated from integrations.sweep_runs where id=$1', [corrida.id])).rows[0]?.enumerated).toBe(152);
    const qs = (await llamadas()).map((l) => new URL(l.ruta, url).searchParams);
    expect(qs.every((q) => q.get('dates_are_gmt') === 'true' && q.get('per_page') === '100')).toBe(true);
    expect(qs.some((q) => q.get('page') === '2')).toBe(true);
    // Woo no se parte en segmentos de 6 h: una sola ventana, 2 páginas de `any` y 1 de `trash`.
    expect(new Set(qs.map((q) => q.get('modified_after'))).size).toBe(1);
    expect(qs).toHaveLength(3);
    expect(qs.filter((q) => q.get('status') === 'trash')).toHaveLength(1);
    // Un cancelado y un papelereado se observan como cierre en la misma corrida, no como ausencia.
    const cierres = await db.query<{ resource_id: string; lifecycle: string }>(
      "select resource_id,lifecycle from integrations.resource_observations where topic='woo.orders' and resource_id in ('450','451') order by 1");
    expect(cierres.rows).toEqual([
      { resource_id: '450', lifecycle: 'closed' },
      { resource_id: '451', lifecycle: 'closed' },
    ]);
    const fila = await db.query<{ remote_version: string }>("select remote_version from integrations.resource_observations where topic='woo.orders' and resource_id='300'");
    expect(fila.rows[0]?.remote_version.endsWith('Z')).toBe(true);
  });

  it('la vuelta semanal de IDs de pedidos Woo declara un borrado duro sin releer contenido', async () => {
    await barrer('woo.orders');
    datos!.ordenesWoo.splice(datos!.ordenesWoo.findIndex((o) => Number(o.id) === 305), 1);
    await fetch(`${url}/__qa/fallas`, { method: 'DELETE' });
    await barrer('woo.orders', 'full_scan', { reloj: despues(1) });
    const bajas = await db.query<{ resource_id: string }>(
      "select resource_id from integrations.resource_observations where topic='woo.orders' and lifecycle='deleted'");
    // Sólo el borrado definitivo: el pedido en la papelera sigue siendo un cierre, no una ausencia.
    expect(bajas.rows).toEqual([{ resource_id: '305' }]);
    expect((await db.query<{ lifecycle: string }>("select lifecycle from integrations.resource_observations where topic='woo.orders' and resource_id='451'")).rows[0]?.lifecycle).toBe('closed');
    // Sólo presencia: la vuelta pide únicamente el id y no reescribe versiones ni encola contenido.
    const vuelta = (await llamadas()).filter((l) => l.ruta.includes('/orders?'));
    expect(vuelta.length).toBeGreaterThan(0);
    expect(vuelta.every((l) => new URL(l.ruta, url).searchParams.get('_fields') === 'id')).toBe(true);
    // 152 observados por el incremental más el mensaje de baja del pedido borrado definitivamente.
    expect(await inbox('woo.orders')).toBe(153);
  });

  it('E1-SWP-08 y E1-DEL-01 woo.products: incremental trae padres y variaciones; la vuelta de IDs declara la baja del padre', async () => {
    const { corrida } = await barrer('woo.products');
    expect(await inbox('woo.products')).toBe(122);
    // Ni una consulta ni un recurso de más: 2 páginas de padres, 1 de variaciones y 122 enumerados.
    expect((await db.query<{ enumerated: number }>('select enumerated from integrations.sweep_runs where id=$1', [corrida.id])).rows[0]?.enumerated).toBe(122);
    const rutas = (await llamadas()).map((l) => l.ruta);
    expect(rutas.filter((r) => r.includes('/products?'))).toHaveLength(2);
    expect(rutas.filter((r) => r.includes('/variations?'))).toHaveLength(1);
    // El producto modificado hace 40 días queda fuera de la ventana de arranque.
    expect(await contar("select count(*) n from integrations.resource_observations where topic='woo.products' and resource_id='500'")).toBe(0);
    expect(await contar("select count(*) n from integrations.resource_relations where relation_type='product_variation'")).toBe(2);
    datos!.productos.delete(15);
    await barrer('woo.products', 'full_scan', { reloj: despues(1) });
    const bajas = await db.query<{ resource_id: string; payload_ciphertext: Buffer; payload_nonce: Buffer; payload_tag: Buffer; payload_key_id: string; remote_version: string }>(
      "select resource_id,payload_ciphertext,payload_nonce,payload_tag,payload_key_id,remote_version from integrations.inbox_messages where remote_version like 'deleted:%'");
    expect(bajas.rows.map((f) => f.resource_id)).toEqual(['15']);
    const b = bajas.rows[0]!;
    const plano = descifrarSobre({ keyId: b.payload_key_id, nonce: b.payload_nonce, tag: b.payload_tag, ciphertext: b.payload_ciphertext },
      { account: cuenta, topic: 'woo.products', resource: '15', remoteVersion: b.remote_version }, keyring);
    expect(JSON.parse(plano.toString())).toEqual({ id: '15', lifecycle: 'deleted' });
    // La vuelta enumera padres: no puede declarar ausentes a las variaciones que no lista.
    const variaciones = await db.query<{ resource_id: string; lifecycle: string }>(
      "select resource_id,lifecycle from integrations.resource_observations where resource_id in ('900','901') order by 1");
    expect(variaciones.rows).toEqual([{ resource_id: '900', lifecycle: 'open' }, { resource_id: '901', lifecycle: 'open' }]);
  });

  it('ninguna llamada de canal usa un método distinto de GET', async () => {
    await barrer('ml.orders'); await barrer('woo.products'); await barrer('ml.messages');
    const canal = (await llamadas()).filter((l) => l.headers['x-fusion-plano'] === 'canal');
    expect(canal.length).toBeGreaterThan(0);
    expect(canal.every((l) => l.metodo === 'GET')).toBe(true);
  });
});
