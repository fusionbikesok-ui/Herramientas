/*
 * test/catalogo/bootstrap.test.ts — E2 T1 tarea 12: la lectura completa inicial, con un canal falso.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearBootstrap, prepararBootstrap, type CuentaBootstrap, type OpcionesBootstrap } from '../../src/catalogo/bootstrap.ts';
import { crearPool } from '../../src/db/pool.ts';
import { ErrorCanalTerminal, type RespuestaCanal, type TransporteCanal } from '../../src/reconciliacion/cliente-http.ts';
import type { KeyringSobre } from '../../src/seguridad/sobre.ts';
import { ErrorBarridoReintentable } from '../../src/worker/barridos.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const keyring: KeyringSobre = { activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 5) } };
const resp = (body: unknown, headers: Record<string, string> = {}): RespuestaCanal => ({ status: 200, headers: new Headers(headers), body });
const item = (id: string) => ({ id, title: id, status: 'active', last_updated: '2026-09-18T10:00:00.000Z' });

/** ML falso: `paginas` listas de ids; el scroll_id de la página n es `s{n}`. Registra cada ruta pedida. */
function mlFalso(paginas: string[][], opciones: { fallar?: (ruta: string) => Error | null } = {}) {
  const rutas: string[] = [];
  const transporte: TransporteCanal = {
    async get(ruta) {
      rutas.push(ruta);
      const f = opciones.fallar?.(ruta); if (f) throw f;
      if (ruta.includes('/items/search')) {
        const scroll = new URLSearchParams(ruta.split('?')[1]).get('scroll_id');
        const n = scroll ? Number(scroll.slice(1)) : 0;
        const ids = paginas[n] ?? [];
        return resp({ results: ids, scroll_id: `s${n + 1}` });
      }
      const ids = new URLSearchParams(ruta.split('?')[1]).get('ids')!.split(',');
      return resp(ids.map((id) => ({ id, status_code: 200, body: item(id) })));
    },
  };
  return { transporte, rutas };
}

describe('E2-BOO-01 bootstrap del catálogo', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let ml: string; let woo: string;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;
  const inbox = () => q<{ resource_id: string; source: string }>("SELECT resource_id, source FROM integrations.inbox_messages ORDER BY resource_id");
  const corrida = (cuenta: string) => q<{ estado: string; pagina_confirmada: number; cursor: string | null; encolados: number }>(
    'SELECT estado, pagina_confirmada, cursor, encolados FROM catalog.bootstrap_runs WHERE channel_account_id = $1', [cuenta]).then((r) => r[0]!);
  const sinEspera = { dormir: async () => {} };
  const boot = (extra: Partial<OpcionesBootstrap> = {}) =>
    crearBootstrap({ pool: app, keyring, rpm: 600, cedeSenales: 20, workerId: 'w1', ...sinEspera, ...extra });
  const cuentaMl = (t: TransporteCanal): CuentaBootstrap => ({ id: ml, topic: 'ml.items', transporte: t, sellerId: '123' });

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 6 }); admin = crearPool(base.urlAdmin, { max: 2 });
    const empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    const cuenta = async (canal: string) => (await app.query<{ id: string }>('insert into core.channel_accounts(company_id,channel,external_account) values ($1,$2,$3) returning id', [empresa, canal, randomUUID()])).rows[0]!.id;
    ml = await cuenta('mercadolibre'); woo = await cuenta('woocommerce');
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE catalog.bootstrap_runs; DELETE FROM integrations.inbox_messages; DELETE FROM integrations.reconciliation_signals;');
    await prepararBootstrap(app, ml, 'ml.items');
    await prepararBootstrap(app, woo, 'woo.products');
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('lee todas las páginas y encola todo con source=bootstrap, hasta terminar', async () => {
    const { transporte } = mlFalso([['MLA1', 'MLA2'], ['MLA3'], []]);
    const b = boot();
    const r = [];
    for (let i = 0; i < 5; i++) r.push((await b.unaPagina(cuentaMl(transporte))).estado);
    expect(r).toEqual(['avanzo', 'avanzo', 'terminada', 'terminada', 'terminada']);
    expect(await inbox()).toEqual(['MLA1', 'MLA2', 'MLA3'].map((resource_id) => ({ resource_id, source: 'bootstrap' })));
    expect(await corrida(ml)).toMatchObject({ estado: 'terminada', pagina_confirmada: 3, encolados: 3 });
  });

  it('un recurso sin cambios desde antes del bootstrap (E1 ya lo observó y nunca lo encoló) igual se encola', async () => {
    // Es la razón de ser del bootstrap: la corriente de E1 sólo encola lo que cambió.
    await admin.query(`INSERT INTO integrations.resource_observations
      (channel_account_id, topic, resource_id, remote_version, remote_hash, projection_hash, lifecycle)
      VALUES ($1, 'ml.items', 'MLA1', '2026-09-18T10:00:00.000Z', decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), 'open')`, [ml]);
    const { transporte } = mlFalso([['MLA1'], []]);
    await boot().unaPagina(cuentaMl(transporte));
    expect(await inbox()).toEqual([{ resource_id: 'MLA1', source: 'bootstrap' }]);
  });

  it('RETOMA: un proceso muere en la página 2 y el que arranca sigue desde ahí, según PostgreSQL', async () => {
    const primero = mlFalso([['MLA1'], ['MLA2'], ['MLA3'], []]);
    const a = boot();
    await a.unaPagina(cuentaMl(primero.transporte));
    await a.unaPagina(cuentaMl(primero.transporte));
    // "Muere": se descarta el objeto. El checkpoint vive sólo en la base.
    expect(await corrida(ml)).toMatchObject({ pagina_confirmada: 2, cursor: 's2' });
    const segundo = mlFalso([['MLA1'], ['MLA2'], ['MLA3'], []]);
    const b = boot();
    await b.unaPagina(cuentaMl(segundo.transporte));
    // El nuevo proceso pidió directamente la página del cursor guardado, no volvió a empezar.
    expect(segundo.rutas[0]).toContain('scroll_id=s2');
    expect(await corrida(ml)).toMatchObject({ pagina_confirmada: 3 });
  });

  it('si la página no se llega a confirmar, ni sus mensajes ni el checkpoint quedan', async () => {
    const { transporte } = mlFalso([['MLA1'], []]);
    const roto: KeyringSobre = { activeKeyId: 'falta', keys: {} };
    await expect(boot({ keyring: roto }).unaPagina(cuentaMl(transporte))).rejects.toThrow();
    expect(await inbox()).toEqual([]);
    expect(await corrida(ml)).toMatchObject({ pagina_confirmada: 0 });
  });

  it('respeta el ritmo: con 10 por minuto, 6 segundos entre llamadas, y en serie', async () => {
    let t = 0; const esperas: number[] = [];
    const { transporte, rutas } = mlFalso([['MLA1', 'MLA2'], []]);
    const b = boot({ rpm: 10, ahora: () => new Date(t), dormir: async (ms) => { esperas.push(ms); t += ms; } });
    await b.unaPagina(cuentaMl(transporte));
    // Una búsqueda y un multiget: la segunda llamada esperó 6 s.
    expect(rutas).toHaveLength(2);
    expect(esperas).toEqual([6000]);
  });

  it('cede si hay señales de ML esperando, sin llamar al canal', async () => {
    for (let i = 0; i < 3; i++) {
      await admin.query("INSERT INTO integrations.reconciliation_signals (channel_account_id, topic, resource_id, fingerprint, source) VALUES ($1, 'ml.orders', $2, $2, 'webhook_copy')", [ml, `o${i}`]);
    }
    const { transporte, rutas } = mlFalso([['MLA1'], []]);
    expect(await boot({ cedeSenales: 2 }).unaPagina(cuentaMl(transporte))).toMatchObject({ estado: 'cedio_senales' });
    expect(rutas).toEqual([]);
    expect(await corrida(ml)).toMatchObject({ estado: 'pausada', pagina_confirmada: 0 });
  });

  it('ante un 429 se pausa sin avanzar ni perder la página', async () => {
    const { transporte } = mlFalso([['MLA1'], []], { fallar: (r) => (r.includes('/items/bulk') ? new ErrorBarridoReintentable('HTTP_429 /items/bulk') : null) });
    expect(await boot().unaPagina(cuentaMl(transporte))).toMatchObject({ estado: 'cedio_429' });
    expect(await corrida(ml)).toMatchObject({ estado: 'pausada', pagina_confirmada: 0 });
    expect(await inbox()).toEqual([]);
  });

  it('un scroll vencido de ML hace volver a empezar el scan, sin duplicar lo ya encolado', async () => {
    const a = mlFalso([['MLA1'], ['MLA2'], []]);
    await boot().unaPagina(cuentaMl(a.transporte));
    const vencido = mlFalso([['MLA1'], ['MLA2'], []], { fallar: (r) => (r.includes('scroll_id=') ? new ErrorCanalTerminal('HTTP_400 scroll', 400) : null) });
    expect(await boot().unaPagina(cuentaMl(vencido.transporte))).toMatchObject({ estado: 'reinicio_scan' });
    expect(await corrida(ml)).toMatchObject({ cursor: null });
    const b = boot(); const t = mlFalso([['MLA1'], ['MLA2'], []]).transporte;
    for (let i = 0; i < 4; i++) await b.unaPagina(cuentaMl(t));
    expect((await inbox()).map((m) => m.resource_id)).toEqual(['MLA1', 'MLA2']);
  });

  it('dos workers no leen la misma cuenta a la vez', async () => {
    let soltar!: () => void;
    const lento: TransporteCanal = { get: () => new Promise((ok) => { soltar = () => ok(resp({ results: [], scroll_id: null })); }) };
    const p = boot().unaPagina(cuentaMl(lento));
    await new Promise((ok) => setTimeout(ok, 50));
    expect(await boot({ workerId: 'w2' }).unaPagina(cuentaMl(mlFalso([[]]).transporte))).toMatchObject({ estado: 'ocupada' });
    soltar();
    await p;
  });

  it('Woo: pide las variaciones de cada padre variable y pagina por x-wp-totalpages', async () => {
    const rutas: string[] = [];
    const producto = (id: number, type: string) => ({ id, type, status: 'publish', date_modified_gmt: '2026-09-18T10:00:00' });
    const t: TransporteCanal = {
      async get(ruta) {
        rutas.push(ruta);
        if (ruta.includes('/variations')) return resp([{ ...producto(21, 'variation'), parent_id: 20 }, { ...producto(22, 'variation'), parent_id: 20 }]);
        const page = Number(new URLSearchParams(ruta.split('?')[1]).get('page'));
        return resp(page === 1 ? [producto(10, 'simple'), producto(20, 'variable')] : [producto(30, 'simple')], { 'x-wp-totalpages': '2' });
      },
    };
    const b = boot(); const c: CuentaBootstrap = { id: woo, topic: 'woo.products', transporte: t };
    expect((await b.unaPagina(c)).estado).toBe('avanzo');
    expect((await b.unaPagina(c)).estado).toBe('terminada');
    expect((await q<{ resource_id: string }>("SELECT resource_id FROM integrations.inbox_messages WHERE topic = 'woo.products' ORDER BY resource_id::int")).map((r) => r.resource_id))
      .toEqual(['10', '20', '21', '22', '30']);
  });
});
