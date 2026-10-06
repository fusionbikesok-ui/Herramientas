import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { ValidateFunction } from 'ajv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApi } from '../../src/api/app.ts';
import { RUTA_SENALES, type Canal } from '../../src/api/senales.ts';
import { crearLogger } from '../../src/comun/logger.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearOrigenes, firmar } from '../../src/seguridad/interna.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
// El emisor real del legado: prueba de punta a punta del contrato de firma y envelope.
// @ts-expect-error módulo JS del legado sin tipos
import { crearEmisorSombra } from '../../../lib/emisorSombra.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new (o: object) => { compile(s: object): ValidateFunction };
const addFormats = require('ajv-formats') as (a: unknown) => void;

const claveVieja = randomBytes(32);
const claveNueva = randomBytes(32);
const keyring = { activeKeyId: 'k2', keys: { k1: claveVieja, k2: claveNueva } };

describe('E1-SIG-02 API interna de señales', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>;
  let cuentas: Map<Canal, string>;
  let validarAceptada: ValidateFunction; let validarError: ValidateFunction;
  beforeAll(async () => {
    const contrato = await SwaggerParser.dereference(fileURLToPath(new URL('../../../openapi/platform-v2.yaml', import.meta.url))) as { components: { schemas: Record<string, object> } };
    const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
    validarAceptada = ajv.compile(contrato.components.schemas.SignalAccepted!);
    validarError = ajv.compile(contrato.components.schemas.Error!);
    base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
    const empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('Señales API') returning id")).rows[0]!.id;
    const ml = (await admin.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','api-ml') returning id", [empresa])).rows[0]!.id;
    cuentas = new Map([['mercadolibre', ml]]);
  });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });

  const api = (p = pool, c: ReadonlyMap<Canal, string> = cuentas) => crearApi({
    pool: p, logger: crearLogger('test'), estadoPgDir: '/nada',
    senales: { keyring, origenes: crearOrigenes('127.0.0.1/32'), cuentas: c },
  });
  let secuencia = 0;
  const envelope = (extra: Record<string, unknown> = {}) => ({
    channel: 'mercadolibre', topic: 'ml.orders', resource_id: `o-${++secuencia}`, fingerprint: `fp-${secuencia}`, source: 'webhook_copy', ...extra,
  });
  const firmado = (cuerpo: string, o: { keyId?: string; clave?: Buffer; ts?: number; nonce?: string } = {}) => {
    const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
    const nonce = o.nonce ?? randomBytes(16).toString('base64url');
    return {
      'content-type': 'application/json',
      'x-fusion-key-id': o.keyId ?? 'k2', 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
      'x-fusion-signature': firmar(o.clave ?? claveNueva, ts, nonce, 'POST', RUTA_SENALES, Buffer.from(cuerpo)),
    };
  };
  const cantidad = async () => Number((await admin.query<{ n: string }>('select count(*) n from integrations.reconciliation_signals')).rows[0]!.n);

  it('202 acepta una señal válida con cualquiera de las dos claves de rotación', async () => {
    const app = api();
    for (const [keyId, clave] of [['k2', claveNueva], ['k1', claveVieja]] as const) {
      const cuerpo = JSON.stringify(envelope());
      const r = await app.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers: firmado(cuerpo, { keyId, clave }) });
      expect(r.statusCode).toBe(202); expect(r.json()).toMatchObject({ status: 'accepted' });
      expect(validarAceptada(r.json()), JSON.stringify(validarAceptada.errors)).toBe(true);
    }
    await app.close();
  });

  it('la cuenta la decide el servidor, no el cliente', async () => {
    const app = api();
    const cuerpo = JSON.stringify(envelope({ channel_account_id: '11111111-1111-1111-1111-111111111111' }));
    const r = await app.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers: firmado(cuerpo) });
    expect(r.statusCode).toBe(400);
    const ok = JSON.stringify(envelope());
    await app.inject({ method: 'POST', url: RUTA_SENALES, payload: ok, headers: firmado(ok) });
    const cuentasUsadas = await admin.query<{ c: string }>('select distinct channel_account_id::text c from integrations.reconciliation_signals');
    expect(cuentasUsadas.rows.map((f) => f.c)).toEqual([cuentas.get('mercadolibre')]);
    await app.close();
  });

  it('400 envelope inválido: tópico fuera de E1, recurso vacío, fuente inventada, JSON roto', async () => {
    const app = api();
    for (const cuerpo of [
      JSON.stringify(envelope({ topic: 'ml.payments' })), JSON.stringify(envelope({ resource_id: '' })),
      JSON.stringify(envelope({ source: 'telepatia' })), '{no es json',
    ]) {
      const r = await app.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers: firmado(cuerpo) });
      expect(r.statusCode, cuerpo).toBe(400); expect(r.json().code).toBe('invalid_envelope');
    }
    await app.close();
  });

  it('401 sin firma, firma alterada, clave desconocida, HMAC vencido y origen externo', async () => {
    const app = api(); const antes = await cantidad();
    const cuerpo = JSON.stringify(envelope());
    const casos: Array<[string, Record<string, string>, string?]> = [
      ['sin firma', { 'content-type': 'application/json' }],
      ['cuerpo alterado tras firmar', firmado(JSON.stringify(envelope()))],
      ['clave desconocida', firmado(cuerpo, { keyId: 'k9' })],
      ['firmada con otra clave', firmado(cuerpo, { clave: randomBytes(32) })],
      ['vencida', firmado(cuerpo, { ts: Math.floor(Date.now() / 1000) - 301 })],
      ['del futuro', firmado(cuerpo, { ts: Math.floor(Date.now() / 1000) + 301 })],
      ['origen externo', firmado(cuerpo), '203.0.113.9'],
    ];
    for (const [nombre, headers, origen] of casos) {
      const r = await app.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers, ...(origen ? { remoteAddress: origen } : {}) });
      expect(r.statusCode, nombre).toBe(401); expect(r.json().code, nombre).toBe('unauthorized');
      expect(validarError(r.json()), nombre).toBe(true);
      expect(r.body, nombre).not.toContain(claveNueva.toString('hex'));
    }
    expect(await cantidad()).toBe(antes);
    await app.close();
  });

  it('replay: el mismo nonce firmado es 401 y no crea una segunda señal; el aviso repetido es 202 duplicate', async () => {
    const app = api();
    const cuerpo = JSON.stringify(envelope());
    const headers = firmado(cuerpo);
    expect((await app.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers })).statusCode).toBe(202);
    const antes = await cantidad();
    const replay = await app.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers });
    expect(replay.statusCode).toBe(401);
    // Un reinicio de la API no reabre la ventana: el nonce vive en PostgreSQL.
    await app.close(); const otra = api();
    expect((await otra.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers })).statusCode).toBe(401);
    // Reentrega legítima del mismo aviso, con nonce nuevo: aceptada como duplicada, sin fila nueva.
    const dup = await otra.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers: firmado(cuerpo) });
    expect(dup.statusCode).toBe(202); expect(dup.json()).toMatchObject({ status: 'duplicate' });
    expect(await cantidad()).toBe(antes);
    await otra.close();
  });

  it('413 cuerpo mayor a 16 KiB antes de verificar nada', async () => {
    const app = api();
    const cuerpo = JSON.stringify(envelope({ resource_id: 'x'.repeat(17 * 1024) }));
    const r = await app.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers: firmado(cuerpo) });
    expect(r.statusCode).toBe(413); expect(r.json().code).toBe('payload_too_large');
    await app.close();
  });

  it('409 canal/tópico: tópico de otro canal, canal sin cuenta y missed_feed de Woo', async () => {
    const app = api(); const antes = await cantidad();
    for (const cuerpo of [
      JSON.stringify(envelope({ topic: 'woo.orders' })),
      JSON.stringify(envelope({ channel: 'woocommerce', topic: 'woo.orders' })),
      JSON.stringify(envelope({ channel: 'woocommerce', topic: 'woo.products', source: 'ml_missed_feed' })),
    ]) {
      const r = await app.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers: firmado(cuerpo) });
      expect(r.statusCode, cuerpo).toBe(409); expect(r.json().code).toBe('channel_topic_mismatch');
    }
    expect(await cantidad()).toBe(antes);
    await app.close();
  });

  it('503 con PostgreSQL caído, sin filtrar el error', async () => {
    const caido = crearPool('postgres://nadie:nada@127.0.0.1:1/nada');
    const app = api(caido);
    const cuerpo = JSON.stringify(envelope());
    const r = await app.inject({ method: 'POST', url: RUTA_SENALES, payload: cuerpo, headers: firmado(cuerpo) });
    expect(r.statusCode).toBe(503); expect(r.json()).toMatchObject({ code: 'platform_unavailable' });
    expect(r.body).not.toContain('ECONNREFUSED');
    await app.close(); await caido.end();
  });

  it('el emisor del legado habla con esta API: firma aceptada, señal creada y reentrega deduplicada', async () => {
    const app = api();
    const eventos: Record<string, { event_id: string; channel: string; resource_id: string; metadata_json: string }> = {
      e1: { event_id: 'ml-webhook-e1', channel: 'ml', resource_id: '/orders/7777', metadata_json: '{"topic":"orders_v2","notification_id":"n-7777"}' },
      e2: { event_id: 'woo-webhook-e2', channel: 'woo', resource_id: '/products/15', metadata_json: '{"topic":"product.updated"}' },
    };
    const db = { prepare: () => ({ get: (id: string) => eventos[id] }) };
    const fetchInyectado = async (url: URL, init: { headers: Record<string, string>; body: Buffer }) => {
      const r = await app.inject({ method: 'POST', url: url.pathname, headers: init.headers, payload: init.body });
      return new Response(r.body, { status: r.statusCode });
    };
    const enviar = crearEmisorSombra({ db, url: 'http://127.0.0.1:3201', keyring, fetch: fetchInyectado });
    await enviar({ eventId: 'e1' });
    await enviar({ eventId: 'e1' });
    // Woo no tiene cuenta configurada en este test: la API responde 409 y el emisor lo normaliza como
    // `cuenta_no_configurada`, que es lo que distingue un problema de configuración de un dato inválido.
    await expect(enviar({ eventId: 'e2' })).rejects.toThrow('cuenta_no_configurada');
    const filas = await admin.query<{ topic: string; resource_id: string; notification_id: string; source: string }>(
      "select topic,resource_id,notification_id,source from integrations.reconciliation_signals where resource_id='7777'");
    expect(filas.rows).toEqual([{ topic: 'ml.orders', resource_id: '7777', notification_id: 'n-7777', source: 'webhook_copy' }]);
    await app.close();
  });

  it('sin configuración la ruta interna no existe', async () => {
    const app = crearApi({ pool, logger: crearLogger('test'), estadoPgDir: '/nada' });
    const r = await app.inject({ method: 'POST', url: RUTA_SENALES, payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});
