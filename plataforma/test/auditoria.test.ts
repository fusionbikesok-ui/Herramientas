import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registrarEvento, verificarCadena, type EventoAuditoria } from '../src/audit/auditoria.ts';
import { crearPool } from '../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';

describe('auditoría', () => {
  let base: BaseDePrueba; let app: pg.Pool; let empresa: string;
  const evento = (i: number | string, actor = 'test'): EventoAuditoria => ({
    companyId: empresa, actorType: 'system', actorId: actor, action: 'prueba.evento',
    aggregateType: 'prueba', aggregateId: String(i), correlationId: randomUUID(),
  });

  beforeAll(async () => {
    base = await crearBaseDePrueba();
    app = crearPool(base.urlApp);
    empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
  });
  afterAll(async () => { await app.end(); await base.borrar(); });

  it('E1-AUD-01 1.000 eventos forman una cadena íntegra y continua', async () => {
    for (let i = 0; i < 1000; i++) await registrarEvento(app, evento(i));
    expect(await verificarCadena(app)).toBeNull();
    const r = await app.query<{ n: string; max: string }>('select count(*) as n, max(chain_seq) as max from audit.audit_events');
    expect(r.rows[0]).toEqual({ n: '1000', max: '1000' });
  });

  it('E1-AUD-02 plataforma_app no puede modificar, borrar ni vaciar la auditoría', async () => {
    await expect(app.query("update audit.audit_events set reason='x'")).rejects.toThrow(/permission denied/);
    await expect(app.query('delete from audit.audit_events')).rejects.toThrow(/permission denied/);
    await expect(app.query('truncate audit.audit_events')).rejects.toThrow(/permission denied/);
    await expect(app.query('alter table audit.audit_events disable trigger audit_events_no_update')).rejects.toThrow(/must be owner/);
    await expect(app.query('set session_replication_role = replica')).rejects.toThrow(/permission denied/);
  });

  it('E1-AUD-02 el trigger reemplaza hash y chain_seq enviados por la app', async () => {
    const r = await app.query<{ ok: boolean }>(`insert into audit.audit_events(company_id,actor_type,actor_id,action,aggregate_type,aggregate_id,correlation_id,prev_hash,hash,chain_seq)
      values ($1,'user','u','prueba.falsa','x','1',uuidv7(),'\\x00','\\x00',999999) returning (length(hash)=32 and chain_seq < 999999) as ok`, [empresa]);
    expect(r.rows[0]?.ok).toBe(true);
    expect(await verificarCadena(app)).toBeNull();
  });

  it('E1-AUD-02 una alteración directa como superusuario se detecta en la posición exacta', async () => {
    const admin = new pg.Client({ connectionString: base.urlAdmin }); await admin.connect();
    await admin.query('alter table audit.audit_events disable trigger audit_events_no_update');
    await admin.query("update audit.audit_events set reason='manipulado' where chain_seq = 500");
    expect(await verificarCadena(app)).toBe(500);
    await admin.query('update audit.audit_events set reason = null where chain_seq = 500');
    expect(await verificarCadena(app)).toBeNull();
    await admin.query('delete from audit.audit_events where chain_seq = 700');
    expect(await verificarCadena(app)).toBe(700);
    // Sin el evento 700, verificar desde 701 no tiene contra qué validar: el hueco es la evidencia del borrado.
    expect(await verificarCadena(app, 701)).toBe(701);
    expect(await verificarCadena(app, 702)).toBeNull();
    await admin.end();
  });
});

describe('auditoría concurrente', () => {
  let base: BaseDePrueba; let empresa: string;
  beforeAll(async () => {
    base = await crearBaseDePrueba();
    const c = new pg.Client({ connectionString: base.urlApp }); await c.connect();
    empresa = (await c.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
    await c.end();
  });
  afterAll(async () => { await base.borrar(); });

  it('E1-AUD-03 4 conexiones × 500 eventos: cadena íntegra y hashes únicos', async () => {
    const pools = Array.from({ length: 4 }, () => crearPool(base.urlApp, { max: 1 }));
    await Promise.all(pools.map(async (p, w) => {
      for (let i = 0; i < 500; i++) {
        await registrarEvento(p, { companyId: empresa, actorType: 'system', actorId: `w${w}`, action: 'prueba.concurrente', aggregateType: 'x', aggregateId: String(i), correlationId: randomUUID() });
      }
    }));
    const r = await pools[0]!.query<{ n: string; u: string }>('select count(*) as n, count(distinct hash) as u from audit.audit_events');
    expect(r.rows[0]).toEqual({ n: '2000', u: '2000' });
    expect(await verificarCadena(pools[0]!)).toBeNull();
    await Promise.all(pools.map((p) => p.end()));
  });

  it('E1-AUD-03 carrera forzada: un id menor que se encadena después no rompe la cadena', async () => {
    const admin = new pg.Client({ connectionString: base.urlAdmin }); await admin.connect();
    await admin.query(`create function audit.demora_test() returns trigger language plpgsql as $$
      begin if new.actor_id = 'lento' then perform pg_sleep(1.5); end if; return new; end $$`);
    await admin.query('create trigger aaa_demora before insert on audit.audit_events for each row execute function audit.demora_test()');
    const p = crearPool(base.urlApp, { max: 2 });
    const base0 = { companyId: empresa, actorType: 'system' as const, action: 'prueba.carrera', aggregateType: 'x', aggregateId: '1' };
    const lento = registrarEvento(p, { ...base0, actorId: 'lento', correlationId: randomUUID() });
    await new Promise((r) => setTimeout(r, 400));
    const rapido = await registrarEvento(p, { ...base0, actorId: 'rapido', correlationId: randomUUID() });
    const lentoR = await lento;
    expect(BigInt(lentoR.id)).toBeLessThan(BigInt(rapido.id));
    expect(BigInt(lentoR.chainSeq)).toBeGreaterThan(BigInt(rapido.chainSeq));
    expect(await verificarCadena(p)).toBeNull();
    await admin.query('drop trigger aaa_demora on audit.audit_events');
    await admin.end(); await p.end();
  });
});
