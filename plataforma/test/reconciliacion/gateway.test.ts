import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearAdaptadoresMl } from '../../src/reconciliacion/adaptadores/ml.ts';
import { crearAdaptadoresWoo } from '../../src/reconciliacion/adaptadores/woo.ts';
import { ErrorCanalTerminal, ErrorDestinoProhibido } from '../../src/reconciliacion/cliente-http.ts';
import type { CorridaReclamada } from '../../src/reconciliacion/corridas.ts';
import { crearTransporteGateway, RUTA_GATEWAY, rutaAOperacion } from '../../src/reconciliacion/transporte-gateway.ts';
import { firmar } from '../../src/seguridad/interna.ts';
import { ErrorBarridoReintentable, ErrorCupoSombraAgotado } from '../../src/worker/barridos.ts';
import { crearSimulador, type FixtureCanales } from '../../../scripts/qa/simulador-canales.mjs';
// El otro lado del contrato: el legado. Si las dos mitades divergen, este archivo falla.
// @ts-expect-error módulo JS del legado sin tipos
import { construirOperacion, CORRIENTES_ML, crearGatewayCanal, TOPIC_A_CORRIENTE } from '../../../lib/gatewayCanal.js';
import { TOPICOS_CONSULTADOS } from '../../src/reconciliacion/missed-feeds.ts';
// @ts-expect-error módulo JS del legado sin tipos
import { firmarInterno } from '../../../lib/internoHmac.js';

const SELLER = '777';
const WINDOW_TO = new Date('2026-09-15T12:00:00.000Z');
const hace = (h: number) => new Date(WINDOW_TO.getTime() - h * 3_600_000).toISOString();
const keyring = { activeKeyId: 'gw', keys: { gw: randomBytes(32) } };

function normalizar(ruta: string): string {
  const u = new URL(ruta, 'http://x');
  // `app_id` y `site_id` los inyecta el legado desde su configuración: no forman parte de la ruta del adaptador.
  const pares = [...u.searchParams.entries()].filter(([k]) => k !== 'app_id' && k !== 'site_id').map(([k, v]) => `${k}=${v}`).sort();
  return `${u.pathname}?${pares.join('&')}`;
}

describe('E1-GW-01 contrato plataforma ↔ gateway del legado', () => {
  let servidor: Server; let url: string;
  const rutasVistas: string[] = [];
  beforeAll(async () => {
    const fixture: FixtureCanales = {
      ml: {
        orders: Array.from({ length: 3 }, (_, i) => ({ id: 5000 + i, status: 'paid', date_last_updated: hace(1 + i), shipping: { id: 9000 + i }, pack_id: null })),
        shipments: [], questions: [{ id: 1, status: 'UNANSWERED', date_created: hace(3) }],
        claims: [{ id: 31, status: 'opened', stage: 'claim', last_updated: hace(5) }],
        unread: [{ resource: `/packs/8001/sellers/${SELLER}`, count: 1 }],
        packs: { '8001': [{ id: 'm-1', status: 'available', message_date: { created: hace(1), available: hace(1) } }] },
        items: Array.from({ length: 25 }, (_, i) => ({ id: `MLA${100000 + i}`, status: 'active', sub_status: [], last_updated: hace(10), variations: [] })),
      },
      woo: {
        orders: [{ id: 300, status: 'processing', date_modified_gmt: hace(1).slice(0, 19) }],
        products: [
          { id: 10, parent_id: 0, type: 'variable', status: 'publish', date_modified_gmt: hace(2).slice(0, 19) },
          { id: 900, parent_id: 10, type: 'variation', status: 'publish', date_modified_gmt: hace(2).slice(0, 19) },
        ],
      },
    };
    await new Promise<void>((r) => { servidor = crearSimulador({ fixture }); servidor.listen(0, '127.0.0.1', r); });
    url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });
  afterAll(() => { servidor.close(); });

  /** fetch falso que hace de legado: verifica la firma con el módulo JS y ejecuta el catálogo JS contra el simulador. */
  const legado: typeof fetch = async (destino, init) => {
    expect(String(destino)).toBe(`http://host.docker.internal:3001${RUTA_GATEWAY}`);
    const h = init!.headers as Record<string, string>;
    const cuerpo = Buffer.from(init!.body as Uint8Array);
    const esperada = firmarInterno(keyring.keys.gw, h['x-fusion-timestamp'], h['x-fusion-nonce'], 'POST', RUTA_GATEWAY, cuerpo);
    expect(h['x-fusion-signature']).toBe(esperada);
    const gw = crearGatewayCanal({
      mlUserId: SELLER, mlAppId: '998877', mlSiteId: 'MLA', presupuestoMl: () => true,
      ejecutarMl: async (ruta: string, headers: Record<string, string>) => {
        rutasVistas.push(ruta);
        const r = await fetch(`${url}${ruta}`, { headers });
        return { status: r.status, headers: Object.fromEntries(r.headers), data: r.status < 300 ? await r.json() : null };
      },
      ejecutarWoo: async (ruta: string) => {
        rutasVistas.push(`/wp-json/wc/v3${ruta}`);
        const r = await fetch(`${url}/wp-json/wc/v3${ruta}`);
        if (r.status >= 300) throw Object.assign(new Error('woo'), { status: r.status });
        return { status: r.status, headers: Object.fromEntries(r.headers), data: await r.json() };
      },
    });
    return new Response(JSON.stringify(await gw(JSON.parse(cuerpo.toString('utf8')))), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  it('la firma TS y la verificación JS son el mismo algoritmo', () => {
    const cuerpo = Buffer.from('{"op":"ml.messages.unread","params":{}}');
    expect(firmar(keyring.keys.gw, '1', 'n'.repeat(16), 'POST', RUTA_GATEWAY, cuerpo))
      .toBe(firmarInterno(keyring.keys.gw, '1', 'n'.repeat(16), 'POST', RUTA_GATEWAY, cuerpo));
  });

  it('cada ruta que piden los adaptadores se traduce a una operación que el legado reconstruye idéntica', async () => {
    // Recorre los adaptadores reales a través del gateway, sin base: la espía compara cada ida y vuelta.
    const espia = crearTransporteGateway({ url: 'http://host.docker.internal:3001', keyring, sellerId: SELLER, fetch: legado });
    const traducidas: string[] = [];
    const transporte = {
      async get(ruta: string, o?: { headers?: Readonly<Record<string, string>> }) {
        const op = rutaAOperacion(ruta, o?.headers ?? {}, SELLER);
        const construida = construirOperacion(op, { mlUserId: SELLER, mlAppId: '998877', mlSiteId: 'MLA' }) as { canal: string; ruta: string };
        const legadoRuta = construida.canal === 'woo' ? `/wp-json/wc/v3${construida.ruta}` : construida.ruta;
        expect(normalizar(legadoRuta), ruta).toBe(normalizar(ruta));
        traducidas.push(op.op);
        return espia.get(ruta, o);
      },
    };
    const sinBase = { query: async () => ({ rows: [] }) } as never;
    const corrida = { channelAccountId: '00000000-0000-0000-0000-000000000000' } as CorridaReclamada;
    const todos = { ...crearAdaptadoresMl({ transporte, db: sinBase, sellerId: SELLER }), ...crearAdaptadoresWoo({ transporte }) };
    for (const adaptador of Object.values(todos)) {
      let posicion: Record<string, unknown> | null = null;
      for (let vuelta = 0; vuelta < 20; vuelta++) {
        const pagina = await adaptador.listar({ corrida, windowFrom: new Date(WINDOW_TO.getTime() - 24 * 3_600_000), windowTo: WINDOW_TO }, posicion);
        posicion = pagina.nextPosition;
        if (!posicion) break;
      }
    }
    // Individuales que sólo aparecen con relaciones en base: se prueban directo.
    for (const [ruta, headers] of [
      ['/shipments/9000', { 'x-format-new': 'true' }], ['/questions/1', {}], ['/post-purchase/v1/claims/31', {}],
      [`/messages/packs/8001/sellers/${SELLER}?tag=post_sale&mark_as_read=false`, {}],
      ['/orders/5000', {}], ['/wp-json/wc/v3/orders/300', {}], ['/wp-json/wc/v3/products/10', {}],
      ['/missed_feeds?topic=items&offset=0&limit=50', {}],
    ] as const) await transporte.get(ruta, { headers });
    expect(new Set(traducidas)).toEqual(new Set([
      'ml.orders.search', 'ml.missed_feeds', 'ml.order', 'woo.order', 'woo.product', 'ml.shipment', 'ml.questions.search', 'ml.question', 'ml.claims.search', 'ml.claim',
      'ml.messages.unread', 'ml.messages.pack', 'ml.items.scan', 'ml.items.multiget',
      'woo.orders.list', 'woo.products.list', 'woo.variations.list', 'woo.presence.list',
    ]));
    expect(rutasVistas.length).toBeGreaterThan(10);
  });

  it('rutas libres, encabezados extra, otro vendedor o parámetros de más fallan antes de red', async () => {
    let llamadas = 0;
    const t = crearTransporteGateway({ url: 'http://127.0.0.1:3001', keyring, sellerId: SELLER, fetch: async () => { llamadas++; return new Response('{}'); } });
    const casos: Array<[string, Record<string, string>?]> = [
      ['https://api.mercadolibre.com/users/me'], ['//evil.example/orders'], ['/users/me'], ['/orders/5000/billing_info'], ['/orders/5000?attributes=buyer'], ['/wp-json/wc/v3/orders/1/notes'],
      ['/shipments/1'], ['/shipments/1', { 'x-format-new': 'true', authorization: 'Bearer x' }],
      ['/questions/1', { 'x-format-new': 'true' }],
      [`/orders/search?seller=999&order.date_last_updated.from=${hace(1)}&order.date_last_updated.to=${hace(0)}&sort=date_asc&limit=50&offset=0`],
      [`/orders/search?seller=${SELLER}&order.date_last_updated.from=${hace(1)}&order.date_last_updated.to=${hace(0)}&sort=date_asc&limit=5000&offset=0`],
      [`/orders/search?seller=${SELLER}&order.date_last_updated.from=${hace(1)}&order.date_last_updated.to=${hace(0)}&sort=date_asc&limit=50&offset=0&access_token=x`],
      ['/messages/packs/1/sellers/777?tag=post_sale&mark_as_read=true'],
      ['/messages/unread?role=seller&tag=post_sale&tag=otro'],
      ['/wp-json/wc/v3/customers?per_page=100&page=1'],
      ['/wp-json/wc/v3/orders?per_page=100&page=1&orderby=id&order=asc&status=any&_fields=id,billing'],
      ['/wp-json/wc/v3/products/1/variations/2'],
    ];
    for (const [ruta, headers] of casos) {
      await expect(t.get(ruta, headers ? { headers } : undefined), ruta).rejects.toBeInstanceOf(ErrorDestinoProhibido);
    }
    expect(llamadas).toBe(0);
    for (const destino of ['http://api.mercadolibre.com', 'http://user:pw@127.0.0.1:3001', 'http://10.0.0.5:3001', 'http://127.0.0.1:3001/otro']) {
      expect(() => crearTransporteGateway({ url: destino, keyring }), destino).toThrow(ErrorDestinoProhibido);
    }
  });

  it('mapea los estados del gateway y del canal igual que el cliente T2', async () => {
    const con = (status: number, sobre: unknown) => crearTransporteGateway({
      url: 'http://127.0.0.1:3001', keyring,
      fetch: async () => new Response(JSON.stringify(sobre), { status }),
    });
    await expect(con(200, { status: 429, headers: { 'retry-after': '30' }, body: null }).get('/questions/1')).rejects.toBeInstanceOf(ErrorBarridoReintentable);
    await expect(con(200, { status: 503, headers: {}, body: null }).get('/questions/1')).rejects.toBeInstanceOf(ErrorBarridoReintentable);
    await expect(con(200, { status: 403, headers: {}, body: null }).get('/questions/1')).rejects.toBeInstanceOf(ErrorCanalTerminal);
    expect((await con(200, { status: 404, headers: {}, body: null }).get('/questions/1')).status).toBe(404);
    await expect(con(401, { code: 'unauthorized' }).get('/questions/1')).rejects.toBeInstanceOf(ErrorCanalTerminal);
    await expect(con(502, { code: 'channel_unavailable' }).get('/questions/1')).rejects.toBeInstanceOf(ErrorBarridoReintentable);
    const ok = await con(200, { status: 200, headers: { 'x-wp-totalpages': '3' }, body: [{ id: 1 }] }).get('/wp-json/wc/v3/products/1/variations?per_page=100&page=1');
    expect(ok.headers.get('x-wp-totalpages')).toBe('3');
  });

  it('E1-T5 §2.3: un 429 con x-fusion-cupo es ErrorCupoSombraAgotado, distinto de un 429 real', async () => {
    const con = (status: number, sobre: unknown) => crearTransporteGateway({
      url: 'http://127.0.0.1:3001', keyring,
      fetch: async () => new Response(JSON.stringify(sobre), { status }),
    });
    const sombra = con(200, { status: 429, headers: { 'retry-after': '17', 'x-fusion-cupo': 'sombra-agotado' }, body: null });
    await expect(sombra.get('/questions/1')).rejects.toBeInstanceOf(ErrorCupoSombraAgotado);
    try { await sombra.get('/questions/1'); } catch (e) { expect((e as ErrorCupoSombraAgotado).retryAfter).toBe(17); }
    // Un 429 real (sin el header sintético) sigue siendo HTTP_429 reintentable normal, no cupo agotado.
    const real = con(200, { status: 429, headers: { 'retry-after': '30' }, body: null });
    await expect(real.get('/questions/1')).rejects.toBeInstanceOf(ErrorBarridoReintentable);
  });

  it('E1-T5 §2.1: fuente única de tópicos — gateway, plataforma y missed-feeds aceptan exactamente el mismo conjunto', () => {
    const delGateway = new Set(Object.keys(TOPIC_A_CORRIENTE));
    expect(new Set(TOPICOS_CONSULTADOS)).toEqual(delGateway);
    expect(new Set(CORRIENTES_ML)).toEqual(new Set(Object.values(TOPIC_A_CORRIENTE)));
  });

  it('E1-T5 §2.8: el consumidor se fija por instancia de transporte y viaja en la petición', async () => {
    const vistas: Array<{ op: string; consumidor?: string }> = [];
    const fetchEspia: typeof fetch = async (_destino, init) => {
      vistas.push(JSON.parse(Buffer.from(init!.body as Uint8Array).toString('utf8')));
      return new Response(JSON.stringify({ status: 200, headers: {}, body: {} }), { status: 200 });
    };
    await crearTransporteGateway({ url: 'http://127.0.0.1:3001', keyring, fetch: fetchEspia }).get('/questions/1');
    await crearTransporteGateway({ url: 'http://127.0.0.1:3001', keyring, fetch: fetchEspia, consumidor: 'catalogo' }).get('/questions/1');
    expect(vistas[0]!.consumidor).toBeUndefined();
    expect(vistas[1]!.consumidor).toBe('catalogo');
  });
});
