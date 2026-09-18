import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, inject } from 'vitest';
import { ErrorMigracion, migrar } from '../src/db/migrar.ts';
import { crearBaseVacia, DIR_MIGRACIONES, type BaseDePrueba } from './soporte/base.ts';

const bases: BaseDePrueba[] = [];
async function nueva(): Promise<BaseDePrueba> { const b = await crearBaseVacia(); bases.push(b); return b; }
afterEach(async () => { while (bases.length) await bases.pop()?.borrar(); });

function esquemaDe(nombre: string): string {
  const salida = execFileSync('docker', ['exec', inject('pgContenedor'), 'pg_dump', '-U', 'postgres', '--schema-only', '--no-owner', '--no-privileges', nombre], { encoding: 'utf8' });
  return salida.split('\n').filter((l) => !l.startsWith('--') && !l.startsWith('\\restrict') && !l.startsWith('\\unrestrict')).join('\n');
}

async function valor<T>(url: string, sql: string): Promise<T> {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { return (await c.query(sql)).rows[0] as T; } finally { await c.end(); }
}

describe('migraciones', () => {
  it('E1-SCH-02 migrar dos bases vacías da el mismo esquema', async () => {
    const a = await nueva(); const b = await nueva();
    expect(await migrar(a.urlMigrador, DIR_MIGRACIONES)).toEqual(['0001_esquema_base.sql', '0002_permisos.sql', '0003_reconciliacion.sql', '0004_corrientes.sql', '0005_senales.sql', '0006_nonces_senales.sql', '0007_relectura_senales.sql', '0008_resumen_sombra.sql', '0009_informes_entregas.sql', '0010_webauthn_desafios.sql', '0011_intentos_recuperacion.sql', '0012_entregas_oculto.sql']);
    await migrar(b.urlMigrador, DIR_MIGRACIONES);
    expect(esquemaDe(a.nombre)).toBe(esquemaDe(b.nombre));
  });

  it('E1-SCH-02 reaplicar no cambia nada', async () => {
    const a = await nueva();
    await migrar(a.urlMigrador, DIR_MIGRACIONES);
    const antes = esquemaDe(a.nombre);
    expect(await migrar(a.urlMigrador, DIR_MIGRACIONES)).toEqual([]);
    expect(esquemaDe(a.nombre)).toBe(antes);
  });

  it('E1-SCH-02 una migración aplicada alterada frena el arranque', async () => {
    const a = await nueva();
    const dir = mkdtempSync(join(tmpdir(), 'migr-'));
    cpSync(DIR_MIGRACIONES, dir, { recursive: true });
    await migrar(a.urlMigrador, dir);
    writeFileSync(join(dir, '0002_permisos.sql'), readFileSync(join(dir, '0002_permisos.sql'), 'utf8') + '\n-- cambio\n');
    await expect(migrar(a.urlMigrador, dir)).rejects.toBeInstanceOf(ErrorMigracion);
    rmSync(dir, { recursive: true, force: true });
  });

  it('E1-SCH-02 un hueco en la numeración frena el arranque', async () => {
    const a = await nueva();
    const dir = mkdtempSync(join(tmpdir(), 'migr-'));
    cpSync(DIR_MIGRACIONES, dir, { recursive: true });
    writeFileSync(join(dir, '0099_salto.sql'), 'select 1;');
    await expect(migrar(a.urlMigrador, dir)).rejects.toThrow(/numeración/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('E1-SCH-02 dos migradores concurrentes aplican una sola vez', async () => {
    const a = await nueva();
    const [r1, r2] = await Promise.all([migrar(a.urlMigrador, DIR_MIGRACIONES), migrar(a.urlMigrador, DIR_MIGRACIONES)]);
    expect([...r1, ...r2].sort()).toEqual(['0001_esquema_base.sql', '0002_permisos.sql', '0003_reconciliacion.sql', '0004_corrientes.sql', '0005_senales.sql', '0006_nonces_senales.sql', '0007_relectura_senales.sql', '0008_resumen_sombra.sql', '0009_informes_entregas.sql', '0010_webauthn_desafios.sql', '0011_intentos_recuperacion.sql', '0012_entregas_oculto.sql']);
  });

  it('el esquema migrado coincide con la referencia schema.sql', async () => {
    const a = await nueva(); const ref = await nueva();
    await migrar(a.urlMigrador, DIR_MIGRACIONES);
    const c = new pg.Client({ connectionString: ref.urlMigrador }); await c.connect();
    await c.query(readFileSync(new URL('../../docs/superpowers/specs/e1/schema.sql', import.meta.url), 'utf8'));
    await c.end();
    // Filtra el bloque de core.schema_migrations (sólo existe en la base migrada) y colapsa las
    // líneas en blanco resultantes: son ruido de formateo de pg_dump, no una diferencia de esquema.
    const sinRegistro = (s: string) => s.split('\n\n').filter((b) => !b.includes('schema_migrations')).join('\n\n').replace(/\n{3,}/g, '\n\n');
    expect(sinRegistro(esquemaDe(a.nombre))).toBe(sinRegistro(esquemaDe(ref.nombre)));
  });

  it('E1-SCH-01 restricciones del esquema rechazan datos inválidos', async () => {
    const a = await nueva();
    await migrar(a.urlMigrador, DIR_MIGRACIONES);
    const c = new pg.Client({ connectionString: a.urlApp }); await c.connect();
    const empresa = (await c.query<{ id: string }>("insert into core.companies(legal_name) values ('X') returning id")).rows[0]!.id;
    const cuenta = (await c.query<{ id: string }>("insert into core.channel_accounts(company_id, channel, external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
    const invalidos: Array<[string, string, unknown[]]> = [
      ['topic fuera de lista', "insert into integrations.inbox_messages(channel_account_id,topic,resource_id,remote_version,source,correlation_id) values ($1,'ml.inventado','r','v','sweep',uuidv7())", [cuenta]],
      ['claimed sin lease', "insert into integrations.inbox_messages(channel_account_id,topic,resource_id,remote_version,source,correlation_id,status) values ($1,'ml.orders','r','v','sweep',uuidv7(),'claimed')", [cuenta]],
      ['parked sin motivo', "insert into integrations.inbox_messages(channel_account_id,topic,resource_id,remote_version,source,correlation_id,status) values ($1,'ml.orders','r2','v','sweep',uuidv7(),'parked')", [cuenta]],
      ['email sin índice ciego', "insert into security.users(company_id,username,email_ciphertext) values ($1,'ana','\\x01')", [empresa]],
    ];
    await c.query("insert into core.channel_accounts(company_id, channel, external_account, is_primary) values ($1,'woocommerce','https://a',true)", [empresa]);
    invalidos.push(['segundo Woo primario', "insert into core.channel_accounts(company_id, channel, external_account, is_primary) values ($1,'woocommerce','https://b',true)", [empresa]]);
    for (const [nombre, sql, params] of invalidos) {
      await expect(c.query(sql, params), nombre).rejects.toThrow();
    }
    await c.end();
  });

  it('plataforma_app no puede crear objetos ni leer el registro de migraciones', async () => {
    const a = await nueva();
    await migrar(a.urlMigrador, DIR_MIGRACIONES);
    const c = new pg.Client({ connectionString: a.urlApp }); await c.connect();
    await expect(c.query('create table core.intrusa(x int)')).rejects.toThrow(/permission denied/);
    await expect(c.query('create table public.intrusa(x int)')).rejects.toThrow(/permission denied/);
    await expect(c.query('select * from core.schema_migrations')).rejects.toThrow(/permission denied/);
    await c.end();
    expect(await valor<{ p: string }>(a.urlAdmin, "select relpersistence as p from pg_class where oid='core.service_heartbeats'::regclass")).toEqual({ p: 'u' });
  });
});
