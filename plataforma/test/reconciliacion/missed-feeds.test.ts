import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearClienteCanal } from '../../src/reconciliacion/cliente-http.ts';
import { enumerarMissedFeeds } from '../../src/reconciliacion/missed-feeds.ts';
import { crearSimulador, type FixtureCanales, type LlamadaSimulador } from '../../../scripts/qa/simulador-canales.mjs';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const SELLER = '777';

describe('E1-MFD-01 missed_feeds', () => {
  let base: BaseDePrueba; let db: pg.Pool; let admin: pg.Pool; let cuenta: string;
  let servidor: Server | undefined; let url: string; let fixture: FixtureCanales;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); db = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('MFD') returning id")).rows[0]!.id;
    cuenta = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','777') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query('delete from integrations.reconciliation_signals; delete from integrations.inbox_messages; delete from integrations.resource_observations');
    const hace = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    fixture = {
      ml: {
        missedFeeds: [
          // 120 avisos de pedidos repartidos en dos días: tres páginas de 50.
          ...Array.from({ length: 120 }, (_, i) => ({ _id: `n-orden-${i}`, topic: 'orders_v2', resource: `/orders/${6000 + i}`, user_id: 777, sent: hace(i * 0.4) })),
          // Mismo pedido avisado dos veces con distinto id: coalesce en una sola señal activa.
          { _id: 'n-orden-repetida', topic: 'orders_v2', resource: '/orders/6000', user_id: 777, sent: hace(1) },
          { _id: 'n-envio', topic: 'shipments', resource: '/shipments/9100', user_id: 777, sent: hace(2) },
          { _id: 'n-pregunta', topic: 'questions', resource: '/questions/55', user_id: 777, sent: hace(3) },
          { _id: 'n-reclamo', topic: 'claims', resource: '/post-purchase/v1/claims/77', user_id: 777, sent: hace(3) },
          { _id: 'n-mensaje', topic: 'messages', resource: 'a1b2c3d4e5', user_id: 777, sent: hace(3) },
          { _id: 'n-item', topic: 'items', resource: '/items/MLA123', user_id: 777, sent: hace(4) },
          // Excluidos: cuenta ajena, recurso ilegible y aviso sin id de notificación.
          { _id: 'n-ajena', topic: 'shipments', resource: '/shipments/1', user_id: 999, sent: hace(1) },
          { _id: 'n-rara', topic: 'questions', resource: '/questions/../users/me', user_id: 777, sent: hace(1) },
          { topic: 'questions', resource: '/questions/56', user_id: 777, sent: hace(1) },
        ],
      },
    };
    await new Promise<void>((r) => { servidor?.close(); servidor = crearSimulador({ fixture }); servidor.listen(0, '127.0.0.1', r); });
    url = `http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`;
  });
  afterAll(async () => { servidor?.close(); await db.end(); await admin.end(); await base.borrar(); });

  const enumerar = () => enumerarMissedFeeds({ db, transporte: crearClienteCanal({ baseUrl: url }), channelAccountId: cuenta, sellerId: SELLER });
  const llamadas = async () => ((await (await fetch(`${url}/__qa/llamadas`)).json()) as LlamadaSimulador[]).map((l) => l.ruta).filter((r) => r.startsWith('/missed_feeds'));
  const contar = async (sql: string) => Number((await admin.query<{ n: string }>(sql)).rows[0]!.n);

  it('enumera desde offset cero sin cursor, deduplica por notificación y crea señales, nunca observaciones', async () => {
    const primera = await enumerar();
    const pedidos = primera.find((c) => c.topic === 'orders_v2')!;
    expect(pedidos).toMatchObject({ total: 121, enumerados: 121, nuevas: 120, duplicadas: 1, excluidos: 0 });
    expect(primera.find((c) => c.topic === 'shipments')).toMatchObject({ nuevas: 1, excluidos: 1 });
    expect(primera.find((c) => c.topic === 'questions')).toMatchObject({ nuevas: 1, excluidos: 2 });
    expect(await contar("select count(*) n from integrations.reconciliation_signals where source='ml_missed_feed'")).toBe(125);
    const porTopico = (await admin.query<{ topic: string; resource_id: string }>(
      "select topic, resource_id from integrations.reconciliation_signals where topic <> 'ml.orders' order by topic")).rows;
    expect(porTopico).toEqual([
      { topic: 'ml.claims', resource_id: '77' }, { topic: 'ml.items', resource_id: 'MLA123' },
      { topic: 'ml.messages', resource_id: 'a1b2c3d4e5' }, { topic: 'ml.questions', resource_id: '55' },
      { topic: 'ml.shipments', resource_id: '9100' },
    ]);
    expect(await contar('select count(*) n from integrations.resource_observations')).toBe(0);
    expect(await contar('select count(*) n from integrations.inbox_messages')).toBe(0);

    // Media hora después: repite desde offset cero y no crea nada nuevo.
    const segunda = await enumerar();
    expect(segunda.reduce((s, c) => s + c.nuevas, 0)).toBe(0);
    expect(await contar('select count(*) n from integrations.reconciliation_signals')).toBe(125);
    const rutas = await llamadas();
    const primerasDePedidos = rutas.filter((r) => r.includes('topic=orders_v2') && r.includes('offset=0'));
    expect(primerasDePedidos).toHaveLength(2);
    expect(rutas.filter((r) => r.includes('topic=orders_v2'))).toHaveLength(6);
  });

  it('forma real verificada por sonda: messages null sin total es vacío, y sin total pagina hasta página vacía', async () => {
    fixture.ml!.missedFeedsForma = 'real';
    const cobertura = await enumerar();
    expect(cobertura.every((c) => !c.error)).toBe(true);
    expect(cobertura.find((c) => c.topic === 'orders_v2')).toMatchObject({ total: 121, nuevas: 120, duplicadas: 1 });
    // Sin avisos: `{"messages": null}` no es error.
    fixture.ml!.missedFeeds = [];
    const vacia = await enumerar();
    expect(vacia.every((c) => !c.error && c.enumerados === 0)).toBe(true);
  });

  it('una forma inesperada falla cerrado por tópico y un tópico caído no frena a los demás', async () => {
    fixture.ml!.missedFeedsForma = 'rota';
    const rota = await enumerar();
    expect(rota.every((c) => c.error === 'FORMA_MISSED_FEEDS')).toBe(true);
    expect(await contar('select count(*) n from integrations.reconciliation_signals')).toBe(0);
    delete fixture.ml!.missedFeedsForma;
    fixture.ml!.missedFeedsExigeSitio = true;
    const sinSitio = await enumerar();
    expect(sinSitio.find((c) => c.topic === 'items')!.error).toBe('HTTP_400');
    expect(sinSitio.find((c) => c.topic === 'orders_v2')!.nuevas).toBe(120);
  });
});
