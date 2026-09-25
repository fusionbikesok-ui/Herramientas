import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import type { RespuestaCanal, TransporteCanal } from '../../src/reconciliacion/cliente-http.ts';
import { crearRelectoresMl, crearRelectoresWoo } from '../../src/reconciliacion/relectura.ts';
import { descifrarSobre, type KeyringSobre } from '../../src/seguridad/sobre.ts';
import { ErrorBarridoReintentable, ErrorCupoSombraAgotado } from '../../src/worker/barridos.ts';
import { claveRelector, crearWorkerSenales } from '../../src/worker/senales.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const keyring: KeyringSobre = { activeKeyId: 'rer', keys: { rer: Buffer.alloc(32, 5) } };

type Respuesta = { status: number; body?: unknown; headers?: Record<string, string> } | (() => never);

/** Transporte falso: registra cada GET y responde desde un mapa ruta → respuesta. */
function transporteFalso(rutas: Record<string, Respuesta>) {
  const llamadas: string[] = [];
  const t: TransporteCanal = {
    async get(ruta, o) {
      llamadas.push(`${ruta}${o?.headers?.['x-format-new'] ? ' [x-format-new]' : ''}`);
      const r = rutas[ruta];
      if (!r) return { status: 404, headers: new Headers(), body: null };
      if (typeof r === 'function') return r();
      return { status: r.status, headers: new Headers(r.headers ?? {}), body: r.body ?? null } satisfies RespuestaCanal;
    },
  };
  return { t, llamadas };
}

describe('E1-RER-01 relectura puntual por señal', () => {
  let base: BaseDePrueba; let db: pg.Pool; let admin: pg.Pool; let ml: string; let woo: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); db = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('RER') returning id")).rows[0]!.id;
    ml = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','777') returning id", [empresa])).rows[0]!.id;
    woo = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'woocommerce','https://t') returning id", [empresa])).rows[0]!.id;
    await db.query('select integrations.sembrar_corrientes($1)', [ml]);
    await db.query('select integrations.sembrar_corrientes($1)', [woo]);
  });
  beforeEach(async () => {
    await admin.query(`delete from integrations.inbox_messages; delete from integrations.resource_relations;
      delete from integrations.resource_observations; delete from integrations.reconciliation_signals; delete from integrations.sweep_runs;`);
  });
  afterAll(async () => { await db.end(); await admin.end(); await base.borrar(); });

  let n = 0;
  const senal = async (cuenta: string, topic: string, resource: string) => {
    n++;
    return (await db.query<{ id: string }>(`insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source)
      values ($1,$2,$3,$4,'webhook_copy') returning id`, [cuenta, topic, resource, `fp-${n}`])).rows[0]!.id;
  };
  const estado = async (id: string) => (await admin.query<{ status: string; error_detail: string | null; attempts: number; lease_token: string | null; available_at: Date }>(
    'select status,error_detail,attempts,lease_token,available_at from integrations.reconciliation_signals where id=$1', [id])).rows[0]!;
  const worker = (rutasMl: Record<string, Respuesta>, rutasWoo: Record<string, Respuesta> = {}) => {
    const fm = transporteFalso(rutasMl); const fw = transporteFalso(rutasWoo);
    const relectores = {
      ...Object.fromEntries(Object.values(crearRelectoresMl({ transporte: fm.t })).map((r) => [claveRelector(ml, r.topic), r])),
      ...Object.fromEntries(Object.values(crearRelectoresWoo({ transporte: fw.t })).map((r) => [claveRelector(woo, r.topic), r])),
    };
    return { w: crearWorkerSenales({ db, workerId: 'rer', keyring, relectores }), llamadasMl: fm.llamadas, llamadasWoo: fw.llamadas };
  };
  const contar = async (sql: string, p: unknown[] = []) => Number((await admin.query<{ n: string }>(sql, p)).rows[0]!.n);

  it('orden: el GET observa, relaciona y encola cifrado como relectura; la señal nunca llega al inbox por sí misma', async () => {
    const orden = { id: 5000, status: 'paid', date_last_updated: '2026-09-16T10:00:00.000-03:00', shipping: { id: 9000 }, pack_id: null, buyer: { email: 'x@fixture.invalid' } };
    const id = await senal(ml, 'ml.orders', '5000');
    const { w, llamadasMl } = worker({ '/orders/5000': { status: 200, body: orden } });
    expect(await w.unaVuelta()).toBe(1);
    expect(llamadasMl).toEqual(['/orders/5000']);
    expect(await estado(id)).toMatchObject({ status: 'succeeded', error_detail: 'enqueued', lease_token: null });
    const fila = (await admin.query<{ source: string; remote_version: string; payload_ciphertext: Buffer; payload_nonce: Buffer; payload_tag: Buffer; payload_key_id: string }>(
      "select source,remote_version,payload_ciphertext,payload_nonce,payload_tag,payload_key_id from integrations.inbox_messages where topic='ml.orders'")).rows;
    expect(fila).toHaveLength(1);
    expect(fila[0]!.source).toBe('signal_reread');
    expect(fila[0]!.payload_ciphertext.includes(Buffer.from('@fixture.invalid'))).toBe(false);
    const plano = descifrarSobre({ keyId: fila[0]!.payload_key_id, nonce: fila[0]!.payload_nonce, tag: fila[0]!.payload_tag, ciphertext: fila[0]!.payload_ciphertext },
      { account: ml, topic: 'ml.orders', resource: '5000', remoteVersion: fila[0]!.remote_version }, keyring);
    expect(JSON.parse(plano.toString()).status).toBe('paid');
    expect(await contar("select count(*) n from integrations.resource_relations where source_id='5000'")).toBe(2);
  });

  it('una versión vieja no reemplaza a la nueva y una relectura no borra la marca de la corrida en curso', async () => {
    await admin.query(`insert into integrations.sweep_runs(channel_account_id,topic,cursor_kind,strategy,status,lease_token,lease_until,worker_id)
      values ($1,'ml.orders','state_sweep','enumerable','claimed',uuidv7(),now()+interval '1 minute','otro')`, [ml]);
    const run = (await admin.query<{ id: string }>('select id from integrations.sweep_runs')).rows[0]!.id;
    const nueva = { id: 5001, status: 'cancelled', date_last_updated: '2026-09-16T12:00:00.000Z', shipping: null, pack_id: null };
    const vieja = { ...nueva, status: 'paid', date_last_updated: '2026-09-16T11:00:00.000Z' };
    const s1 = await senal(ml, 'ml.orders', '5001');
    await worker({ '/orders/5001': { status: 200, body: nueva } }).w.unaVuelta();
    await admin.query('update integrations.resource_observations set last_seen_run_id=$1', [run]);
    expect((await estado(s1)).status).toBe('succeeded');
    const s2 = await senal(ml, 'ml.orders', '5001');
    await worker({ '/orders/5001': { status: 200, body: vieja } }).w.unaVuelta();
    expect(await estado(s2)).toMatchObject({ status: 'succeeded', error_detail: 'stale' });
    const obs = (await admin.query<{ remote_version: string; lifecycle: string; last_seen_run_id: string }>('select remote_version,lifecycle,last_seen_run_id from integrations.resource_observations')).rows[0]!;
    expect(obs).toMatchObject({ remote_version: '2026-09-16T12:00:00.000Z', lifecycle: 'closed', last_seen_run_id: run });
    expect(await contar('select count(*) n from integrations.inbox_messages')).toBe(1);
    // Una versión más nueva sí actualiza, y tampoco pisa la marca de la corrida.
    const s3 = await senal(ml, 'ml.orders', '5001');
    await worker({ '/orders/5001': { status: 200, body: { ...nueva, date_last_updated: '2026-09-16T13:00:00.000Z' } } }).w.unaVuelta();
    expect((await estado(s3)).error_detail).toBe('enqueued');
    expect((await admin.query<{ last_seen_run_id: string }>('select last_seen_run_id from integrations.resource_observations')).rows[0]!.last_seen_run_id).toBe(run);
  });

  it('404: sin baja en orden, envío, ítem y pedido Woo; baja en pregunta y reclamo conocidos', async () => {
    const ids = {
      orden: await senal(ml, 'ml.orders', '1'), envio: await senal(ml, 'ml.shipments', '2'),
      item: await senal(ml, 'ml.items', 'MLA3'), pedido: await senal(woo, 'woo.orders', '4'),
      pregunta: await senal(ml, 'ml.questions', '5'), reclamo: await senal(ml, 'ml.claims', '6'),
    };
    const { w, llamadasMl } = worker({ '/items/bulk?ids=MLA3': { status: 200, body: [{ id: 'MLA3', status_code: 404, body: null }] } });
    expect(await w.unaVuelta(20)).toBe(6);
    for (const k of ['orden', 'envio', 'item', 'pedido'] as const) {
      expect(await estado(ids[k]), k).toMatchObject({ status: 'succeeded', error_detail: 'not_found:sin_baja' });
    }
    expect(llamadasMl).toContain('/shipments/2 [x-format-new]');
    const bajas = (await admin.query<{ topic: string; lifecycle: string }>('select topic,lifecycle from integrations.resource_observations order by topic')).rows;
    expect(bajas).toEqual([{ topic: 'ml.claims', lifecycle: 'deleted' }, { topic: 'ml.questions', lifecycle: 'deleted' }]);
  });

  it('producto Woo variable: padre y variaciones con relación, igual que el barrido', async () => {
    const id = await senal(woo, 'woo.products', '10');
    const { w, llamadasWoo } = worker({}, {
      '/wp-json/wc/v3/products/10': { status: 200, body: { id: 10, parent_id: 0, type: 'variable', status: 'publish', date_modified_gmt: '2026-09-16T10:00:00' } },
      '/wp-json/wc/v3/products/10/variations?per_page=100&page=1': { status: 200, headers: { 'x-wp-totalpages': '1' }, body: [
        { id: 900, parent_id: 10, type: 'variation', status: 'publish', date_modified_gmt: '2026-09-16T10:00:00' },
      ] },
    });
    await w.unaVuelta();
    expect(llamadasWoo).toHaveLength(2);
    expect(await estado(id)).toMatchObject({ status: 'succeeded', error_detail: 'enqueued' });
    expect(await contar("select count(*) n from integrations.resource_observations where topic='woo.products'")).toBe(2);
    expect(await contar("select count(*) n from integrations.resource_relations where relation_type='product_variation'")).toBe(1);
  });

  it('mensajes no resuelven el id del aviso: adelantan el barrido de la cuenta sin GET', async () => {
    await admin.query("update integrations.reconciliation_cursors set next_run_at=now()+interval '1 hour'");
    const id = await senal(ml, 'ml.messages', 'a8f3e2c1b0');
    const { w, llamadasMl } = worker({});
    await w.unaVuelta();
    expect(llamadasMl).toEqual([]);
    expect(await estado(id)).toMatchObject({ status: 'succeeded', error_detail: 'sweep_triggered' });
    const cursores = (await admin.query<{ cuenta: string; adelantado: boolean }>(
      "select channel_account_id::text cuenta, next_run_at<=now() adelantado from integrations.reconciliation_cursors where topic='ml.messages'")).rows;
    expect(cursores).toEqual([{ cuenta: ml, adelantado: true }]);
    expect(await contar('select count(*) n from integrations.inbox_messages')).toBe(0);
  });

  it('429 reintenta con Retry-After, una respuesta incomprensible reintenta y un id inválido se excluye sin red', async () => {
    const lenta = await senal(ml, 'ml.orders', '7');
    const prohibida = await senal(ml, 'ml.claims', '8');
    const invalida = await senal(ml, 'ml.orders', '../users/me');
    const { w, llamadasMl } = worker({
      '/orders/7': () => { throw new ErrorBarridoReintentable('HTTP_429 /orders/7', 120); },
      '/post-purchase/v1/claims/8': { status: 200, body: { sin: 'id' } },
    });
    await w.unaVuelta(10);
    const e1 = await estado(lenta);
    expect(e1).toMatchObject({ status: 'retryable', attempts: 1, lease_token: null });
    expect(e1.available_at.getTime()).toBeGreaterThan(Date.now() + 100_000);
    // Un reclamo que vuelve sin `id` no se entiende, y desde el 2026-09-19 eso REINTENTA en vez de morir
    // al primer intento: el mismo camino por el que se enterraron 35 órdenes por un defecto nuestro.
    // Sigue muriendo al agotar los intentos, como se comprueba abajo con `lenta`.
    expect(await estado(prohibida)).toMatchObject({ status: 'retryable' });
    expect(await estado(invalida)).toMatchObject({ status: 'excluded', error_detail: 'invalid_resource' });
    expect(llamadasMl.some((l) => l.includes('users'))).toBe(false);
    // Agotados los intentos, un reintentable también termina en dead letter.
    await admin.query("update integrations.reconciliation_signals set available_at=now(), attempts=max_attempts-1 where id=$1", [lenta]);
    await w.unaVuelta();
    expect((await estado(lenta)).status).toBe('dead_lettered');
  });

  it('E1-T5 §2.4: un ErrorCupoSombraAgotado difiere la señal sin consumir intento, distinto de un 429 real', async () => {
    const s = await senal(ml, 'ml.orders', '77');
    const { w } = worker({ '/orders/77': () => { throw new ErrorCupoSombraAgotado('CUPO_SOMBRA_AGOTADO /orders/77', 8); } });
    await w.unaVuelta();
    const fila = await estado(s);
    expect(fila).toMatchObject({ status: 'retryable', attempts: 0 });
    expect(fila.available_at.getTime()).toBeGreaterThan(Date.now() + 5_000);
  });

  it('un worker sólo toma señales de las cuentas y tópicos que sabe releer', async () => {
    const s = await senal(woo, 'woo.orders', '9');
    const soloMl = crearWorkerSenales({ db, workerId: 'solo-ml', keyring, relectores: Object.fromEntries(
      Object.values(crearRelectoresMl({ transporte: transporteFalso({}).t })).map((r) => [claveRelector(ml, r.topic), r])) });
    expect(await soloMl.unaVuelta()).toBe(0);
    expect((await estado(s)).status).toBe('pending');
  });

  /*
   * Los dos casos que dejaron 35 señales de `ml.orders` muertas el 2026-09-19, con el registro de
   * órdenes de la copia clavado desde el 12/09. La operación del negocio nunca se vio afectada: el
   * legado procesa las ventas por su propio camino.
   */
  it('una orden sin date_last_updated se observa igual, usando la fecha de creación', async () => {
    // El caso real de producción: ML no mandó date_last_updated. Antes esto lanzaba
    // ErrorPaginaInvalida, el worker lo daba por TERMINAL y la orden no entraba nunca a la copia.
    const orden = { id: 2000018533891264, status: 'paid', date_created: '2026-09-18T13:59:02.000-03:00', shipping: { id: 44556677 }, pack_id: null };
    const id = await senal(ml, 'ml.orders', '2000018533891264');
    const { w } = worker({ '/orders/2000018533891264': { status: 200, body: orden } });
    expect(await w.unaVuelta()).toBe(1);
    expect(await estado(id)).toMatchObject({ status: 'succeeded', error_detail: 'enqueued' });
    const fila = (await admin.query<{ remote_version: string }>(
      "select remote_version from integrations.inbox_messages where topic='ml.orders'")).rows;
    expect(fila[0]!.remote_version).toBe('2026-09-18T16:59:02.000Z');
  });

  it('un recurso que no se entiende reintenta en vez de morir sin rastro', async () => {
    // Sin NINGUNA fecha no hay versión posible, así que el recurso es inválido de verdad. Pero eso no
    // es un "terminal" como un 404 o un destino prohibido: puede ser un campo nuevo de ML, un dato
    // transitorio o un defecto nuestro —como fue éste—. Enterrarlo al primer intento deja un hueco
    // silencioso en la copia; reintentar da tiempo a que lo veamos y lo arreglemos.
    const orden = { id: 7777, status: 'paid', shipping: { id: 1 }, pack_id: null };
    const id = await senal(ml, 'ml.orders', '7777');
    const { w } = worker({ '/orders/7777': { status: 200, body: orden } });
    expect(await w.unaVuelta()).toBe(1);
    const e = await estado(id);
    expect(e.status).toBe('retryable');
    expect(e.error_detail).toMatch(/ErrorPaginaInvalida/);
    // Y al agotar los intentos sí muere, con la causa escrita: no se reintenta para siempre.
    await admin.query('update integrations.reconciliation_signals set attempts=max_attempts where id=$1', [id]);
    await admin.query("update integrations.reconciliation_signals set status='pending', available_at=now(), lease_token=null, lease_until=null, worker_id=null where id=$1", [id]);
    expect(await w.unaVuelta()).toBe(1);
    expect(await estado(id)).toMatchObject({ status: 'dead_lettered' });
  });

});
