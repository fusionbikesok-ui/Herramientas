import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { ValidateFunction } from 'ajv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApi } from '../src/api/app.ts';
import { RUTA_SENALES } from '../src/api/senales.ts';
import { crearLogger } from '../src/comun/logger.ts';
import { crearPool } from '../src/db/pool.ts';
import { evaluarAlertasPlataforma, guardarResumenDiario, liberarSenalesVencidas, medirPlataforma } from '../src/observabilidad/sombra.ts';
import { crearScheduler } from '../src/scheduler/scheduler.ts';
import { crearOrigenes, firmar } from '../src/seguridad/interna.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new (o: object) => { compile(s: object): ValidateFunction };
const addFormats = require('ajv-formats') as (a: unknown) => void;

describe('C8 métricas, alertas y resumen de la sombra', () => {
  let base: BaseDePrueba; let db: pg.Pool; let admin: pg.Pool; let ml: string; let woo: string;
  let validarEstado: ValidateFunction;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); db = crearPool(base.urlApp); admin = crearPool(base.urlAdmin);
    const empresa = (await db.query<{ id: string }>("insert into core.companies(legal_name) values ('OBS') returning id")).rows[0]!.id;
    ml = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','777') returning id", [empresa])).rows[0]!.id;
    woo = (await db.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'woocommerce','https://t') returning id", [empresa])).rows[0]!.id;
    const contrato = await SwaggerParser.dereference(fileURLToPath(new URL('../../openapi/platform-v2.yaml', import.meta.url))) as { components: { schemas: Record<string, object> } };
    const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
    validarEstado = ajv.compile(contrato.components.schemas.ShadowStatus!);
  });
  beforeEach(async () => {
    await admin.query(`delete from integrations.reconciliation_signals; delete from integrations.resource_observations;
      delete from integrations.sweep_runs; delete from integrations.reconciliation_cursors; delete from integrations.shadow_daily_summaries`);
  });
  afterAll(async () => { await db.end(); await admin.end(); await base.borrar(); });

  let n = 0;
  const senal = async (extra: string, valores: unknown[] = []) => {
    n++;
    await admin.query(`insert into integrations.reconciliation_signals(channel_account_id,topic,resource_id,fingerprint,source${extra ? ',' + extra.split('=')[0] : ''})
      values ($1,'ml.orders',$2,$3,'webhook_copy'${extra ? ',' + extra.split('=')[1] : ''})`, [ml, `r-${n}`, `fp-${n}`, ...valores]);
  };
  const ids = (alertas: Array<{ id: string }>) => alertas.map((a) => a.id).sort();

  it('sin actividad no hay alertas', async () => {
    expect(evaluarAlertasPlataforma(await medirPlataforma(db))).toEqual([]);
  });

  it('senal_vieja: una señal activa de más de 15 minutos', async () => {
    await senal("received_at=now()-interval '16 minutes'");
    const alertas = evaluarAlertasPlataforma(await medirPlataforma(db));
    expect(ids(alertas)).toEqual(['senal_vieja']);
    expect(alertas[0]).toMatchObject({ severidad: 'alta', responsable: 'operaciones', runbook: expect.stringContaining('sop-sombra.md#senal-vieja') });
  });

  it('barrido_vencido y corriente_incompatible', async () => {
    await db.query('select integrations.sembrar_corrientes($1)', [ml]);
    await admin.query("update integrations.reconciliation_cursors set last_success_at=now() where topic<>'ml.orders'");
    await admin.query("update integrations.reconciliation_cursors set last_success_at=now()-interval '30 minutes' where topic='ml.orders'");
    // Una corriente de Woo habilitada en una cuenta de ML (lo que la migración 0005 corrigió).
    await admin.query(`insert into integrations.reconciliation_cursors(channel_account_id,topic,cursor_kind,strategy,overlap_seconds,interval_seconds,last_success_at)
      values ($1,'woo.orders','state_sweep','enumerable',600,600,now())`, [ml]);
    const m = await medirPlataforma(db);
    expect(m.barridos.vencidos).toEqual([{ topic: 'ml.orders', cursor_kind: 'state_sweep', atraso_s: expect.any(Number) }]);
    expect(ids(evaluarAlertasPlataforma(m))).toEqual(['barrido_vencido', 'corriente_incompatible']);
  });

  it('http_429_sostenido: diez 429 en 30 minutos entre señales y barridos', async () => {
    await db.query('select integrations.sembrar_corrientes($1)', [woo]);
    await admin.query('update integrations.reconciliation_cursors set last_success_at=now()');
    for (let i = 0; i < 6; i++) await senal("status,error_detail,available_at='retryable','retryable:HTTP_429',now()");
    for (let i = 0; i < 4; i++) {
      await admin.query(`insert into integrations.sweep_runs(channel_account_id,topic,cursor_kind,strategy,status,error_detail,finished_at)
        values ($1,'woo.products','full_scan','enumerable','failed','HTTP_429 /products',now())`, [woo]);
    }
    const alertas = evaluarAlertasPlataforma(await medirPlataforma(db));
    expect(ids(alertas)).toContain('http_429_sostenido');
    expect(alertas.find((a) => a.id === 'http_429_sostenido')!.valor).toBe(10);
  });

  it('senal_sin_observacion y senal_dead_letter', async () => {
    await senal("status,error_detail,finished_at='succeeded','enqueued',now()");
    await senal("status,error_detail,finished_at='dead_lettered','terminal:ErrorCanalTerminal',now()");
    // Una resuelta sin baja no es "sin explicación".
    await senal("status,error_detail,finished_at='succeeded','not_found:sin_baja',now()");
    expect(ids(evaluarAlertasPlataforma(await medirPlataforma(db)))).toEqual(['senal_dead_letter', 'senal_sin_observacion']);
  });

  it('el scheduler libera leases vencidos de señales y guarda el resumen del día una vez por período', async () => {
    await senal("status,lease_token,lease_until,worker_id,attempts='claimed',uuidv7(),now()-interval '1 second','muerto',1");
    await senal("status,lease_token,lease_until,worker_id,attempts,max_attempts='claimed',uuidv7(),now()-interval '1 second','muerto',3,3");
    expect(await liberarSenalesVencidas(db)).toEqual({ reintentables: 1, muertas: 1 });
    const scheduler = crearScheduler({ db, cadaMs: 60_000 });
    const t = new Date('2026-09-16T12:00:00Z');
    expect(await scheduler.observar(t)).toEqual(expect.any(Array));
    expect(await scheduler.observar(new Date(t.getTime() + 10_000))).toBeNull();
    await guardarResumenDiario(db, new Date(t.getTime() + 20_000));
    const filas = (await admin.query<{ dia: string; alertas: unknown[] }>("select summary_date::text dia, payload->'alertas' alertas from integrations.shadow_daily_summaries")).rows;
    expect(filas).toHaveLength(1);
    expect(filas[0]!.dia).toBe('2026-09-16');
    expect(filas[0]!.alertas).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'senal_dead_letter' })]));
  });

  it('cada runbook citado por una alerta existe en el SOP', async () => {
    const { readFileSync } = await import('node:fs');
    const sop = readFileSync(new URL('../../docs/superpowers/specs/e1/sop-sombra.md', import.meta.url), 'utf8');
    const m = await medirPlataforma(db);
    // Todas las alertas a la vez, forzando cada condición sobre la medición.
    m.senales.edad_max_activa_s = 10_000; m.barridos.vencidos = [{ topic: 'ml.orders', cursor_kind: 'state_sweep', atraso_s: 1 }];
    m.barridos.incompatibles = 1; m.senales.reintentos_429_30min = 10; m.senales.sin_observacion_24h = 1; m.senales.ultimas_24h.muertas = 1;
    const alertas = evaluarAlertasPlataforma(m);
    expect(alertas).toHaveLength(6);
    for (const a of alertas) expect(sop, a.runbook).toContain(`<a id="${a.runbook.split('#')[1]}"></a>`);
  });

  it('GET /api/v2/shadow/status exige operations.read y cumple el contrato', async () => {
    await senal("received_at=now()-interval '20 minutes'");
    const con = (caps: string[]) => crearApi({ pool: db, logger: crearLogger('test'), estadoPgDir: '/nada', sesion: async () => (caps.length ? { userId: 'u', capabilities: caps } : null) });
    let app = con([]); expect((await app.inject('/api/v2/shadow/status')).statusCode).toBe(401); await app.close();
    app = con(['catalog.read']); expect((await app.inject('/api/v2/shadow/status')).statusCode).toBe(403); await app.close();
    app = con(['operations.read']);
    const r = await app.inject('/api/v2/shadow/status');
    expect(r.statusCode).toBe(200);
    expect(validarEstado(r.json()), JSON.stringify(validarEstado.errors)).toBe(true);
    expect(r.json().alerts.map((a: { id: string }) => a.id)).toEqual(['senal_vieja']);
    expect(r.body).not.toMatch(/fp-|r-\d/);
    await app.close();
  });

  it('E1-PGDOWN-01 importación de una pérdida: señal y auditoría encadenada una sola vez por recibo', async () => {
    const clave = randomBytes(32);
    const app = crearApi({ pool: db, logger: crearLogger('test'), estadoPgDir: '/nada',
      senales: { keyring: { activeKeyId: 'k', keys: { k: clave } }, origenes: crearOrigenes('127.0.0.1/32'), cuentas: new Map([['mercadolibre', ml]]) } });
    const enviar = async (cuerpo: object) => {
      const bytes = JSON.stringify(cuerpo); const ts = String(Math.floor(Date.now() / 1000)); const nonce = randomBytes(16).toString('base64url');
      return app.inject({ method: 'POST', url: RUTA_SENALES, payload: bytes, headers: {
        'content-type': 'application/json', 'x-fusion-key-id': 'k', 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
        'x-fusion-signature': firmar(clave, ts, nonce, 'POST', RUTA_SENALES, Buffer.from(bytes)) } });
    };
    const perdida = { channel: 'mercadolibre', topic: 'ml.orders', resource_id: '4242', fingerprint: 'ev:perdida-1', source: 'webhook_copy',
      import: { discarded_at: '2026-09-16T10:00:00.000Z', reason: 'platform_unavailable' } };
    expect((await enviar(perdida)).statusCode).toBe(202);
    // El legado no llegó a marcarla y la reimporta: ni señal ni evento duplicados.
    expect((await enviar(perdida)).json()).toMatchObject({ status: 'duplicate' });
    const eventos = (await admin.query<{ action: string; reason: string; payload: Record<string, unknown> }>(
      "select action, reason, payload from audit.audit_events where aggregate_type='shadow_receipt' and aggregate_id='ev:perdida-1'")).rows;
    expect(eventos).toEqual([{ action: 'shadow.loss_imported', reason: 'platform_unavailable', payload: expect.objectContaining({ resource_id: '4242', discarded_at: '2026-09-16T10:00:00.000Z' }) }]);
    expect(Number((await admin.query<{ n: string }>("select count(*) n from integrations.reconciliation_signals where fingerprint='ev:perdida-1'")).rows[0]!.n)).toBe(1);
    // Una importación no puede disfrazarse de missed_feed.
    expect((await enviar({ ...perdida, fingerprint: 'ev:perdida-2', source: 'ml_missed_feed' })).statusCode).toBe(409);
    expect((await enviar({ ...perdida, fingerprint: 'ev:perdida-3', import: { ...perdida.import, reason: 'queue_full' } })).statusCode).toBe(400);
    await app.close();
  });
});
