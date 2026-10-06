/*
 * test/identidad/apartar.test.ts — Tarea 1 del rediseño de la bandeja: «No estoy seguro» aparta un caso sin
 * decidirlo. Mismo setup de base que decidir.test.ts (Postgres real, TRUNCATE por test).
 *
 * Foco de revisión del plan (docs/superpowers/plans/2026-09-25-bandeja-rediseno-escritorio.md):
 *  1. Apartar con versión vieja da version_conflict, no aparta a ciegas.
 *  2. Decidir (vincular) un caso apartado lo decide y limpia la marca.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { decidirCaso } from '../../src/identidad/decidir.ts';
import { apartarCaso, desapartarCaso } from '../../src/identidad/apartar.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E3-APT-01 apartarCaso/desapartarCaso', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string;

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_case_marks, catalog.identity_cases, catalog.identity_decisions,
      catalog.matcher_decisions, catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  /** Un caso sku_pendiente abierto y su representación de ML, igual que casoPendiente() de decidir.test.ts. */
  async function casoAbierto(recurso = `MLA${randomUUID().slice(0, 8)}`) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresa, ml, recurso])).rows[0]!.id;
    const variante = (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id', [empresa, modelo])).rows[0]!.id;
    await admin.query(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id)
       VALUES ($1, $2, 'mercadolibre', 'vendible', $3, '', $4)`, [empresa, ml, recurso, variante]);
    const fila = (await admin.query<{ id: string; version: number }>(
      `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2) RETURNING id, version`,
      [empresa, variante])).rows[0]!;
    return { id: fila.id, version: fila.version, variante };
  }
  const repDe = async (caso: { variante: string }) => (await admin.query<{ variant_id: string | null; omitida_por_decision: boolean }>(
    'SELECT variant_id, omitida_por_decision FROM catalog.external_representations WHERE variant_id = $1', [caso.variante])).rows[0];

  it('aparta sin escribir decisiones ni tocar el vínculo', async () => {
    const caso = await casoAbierto();
    const antesRep = await repDe(caso);
    const r = await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
    expect(r).toEqual({ ok: true, version: caso.version + 1 });
    expect((await app.query('select count(*)::int n from catalog.identity_decisions')).rows[0].n).toBe(0);
    expect(await repDe(caso)).toEqual(antesRep);
  });

  it('con una versión vieja da version_conflict y no aparta', async () => {
    const caso = await casoAbierto();
    const r = await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version - 1, actor: 'jose', idempotencyKey: 'k1' });
    expect(r).toEqual({ ok: false, code: 'version_conflict' });
    expect((await app.query('select apartado_en from catalog.identity_cases where id=$1', [caso.id])).rows[0].apartado_en).toBeNull();
  });

  it('desapartar limpia la marca y sube la versión', async () => {
    const caso = await casoAbierto();
    await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
    const r = await desapartarCaso(app, { caseId: caso.id, expectedVersion: caso.version + 1, actor: 'jose', idempotencyKey: 'k2' });
    expect(r).toEqual({ ok: true, version: caso.version + 2 });
    expect((await app.query('select apartado_en, apartado_por, apartado_motivo from catalog.identity_cases where id=$1', [caso.id])).rows[0])
      .toEqual({ apartado_en: null, apartado_por: null, apartado_motivo: null });
  });

  it('desapartar un caso que nunca se apartó da no_apartado', async () => {
    const caso = await casoAbierto();
    const r = await desapartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
    expect(r).toEqual({ ok: false, code: 'no_apartado' });
  });

  it('un deshacer con versión vieja no borra un apartado más nuevo', async () => {
    const caso = await casoAbierto();
    await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
    const r = await desapartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k2' });
    expect(r).toEqual({ ok: false, code: 'version_conflict' });
    expect((await app.query('select apartado_en from catalog.identity_cases where id=$1', [caso.id])).rows[0].apartado_en).not.toBeNull();
  });

  it('reintentar apartar con la misma clave devuelve lo mismo sin subir la versión', async () => {
    const caso = await casoAbierto();
    const a = await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
    const b = await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
    expect(b).toEqual(a);
    expect((await app.query('select version from catalog.identity_cases where id=$1', [caso.id])).rows[0].version).toBe(caso.version + 1);
  });

  it('apartar un caso cerrado da caso_cerrado', async () => {
    const caso = await casoAbierto();
    await admin.query("UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = 'test' WHERE id = $1", [caso.id]);
    const r = await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
    expect(r).toEqual({ ok: false, code: 'caso_cerrado' });
  });

  it('apartar un caso inexistente da caso_inexistente', async () => {
    const r = await apartarCaso(app, { caseId: randomUUID(), expectedVersion: 1, actor: 'jose', idempotencyKey: 'k1' });
    expect(r).toEqual({ ok: false, code: 'caso_inexistente' });
  });

  it('decidir un caso apartado lo decide y limpia la marca', async () => {
    const caso = await casoAbierto();
    await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k1' });
    const d = await decidirCaso(app, {
      caseId: caso.id, expectedVersion: caso.version + 1, eleccion: 'sin_candidato', actor: 'jose', esAdmin: true, idempotencyKey: randomUUID(),
    }, { bandeja: true });
    expect(d.ok).toBe(true);
    expect((await app.query('select apartado_en from catalog.identity_cases where id=$1', [caso.id])).rows[0].apartado_en).toBeNull();
  });

  it('la misma clave usada para apartar OTRO caso no devuelve un resultado ajeno (clave por caso+acción)', async () => {
    const c1 = await casoAbierto(); const c2 = await casoAbierto();
    const clave = 'misma-clave';
    const r1 = await apartarCaso(app, { caseId: c1.id, expectedVersion: c1.version, actor: 'jose', idempotencyKey: clave });
    const r2 = await apartarCaso(app, { caseId: c2.id, expectedVersion: c2.version, actor: 'jose', idempotencyKey: clave });
    expect(r1).toEqual({ ok: true, version: c1.version + 1 });
    expect(r2).toEqual({ ok: true, version: c2.version + 1 }); // no repitió r1: c2 se apartó de verdad
  });

  it('la misma clave usada para apartar y luego desapartar no colisiona (clave por acción)', async () => {
    const caso = await casoAbierto();
    const clave = 'k-compartida';
    const r1 = await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: clave });
    const r2 = await desapartarCaso(app, { caseId: caso.id, expectedVersion: caso.version + 1, actor: 'jose', idempotencyKey: clave });
    expect(r1).toEqual({ ok: true, version: caso.version + 1 });
    expect(r2).toEqual({ ok: true, version: caso.version + 2 });
  });

  it('dos apartar concurrentes con la misma clave: uno gana, el otro repite su resultado (no 500 por choque de PK)', async () => {
    const caso = await casoAbierto();
    const [a, b] = await Promise.all([
      apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'concurrente' }),
      apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'concurrente' }),
    ]);
    expect(a).toEqual({ ok: true, version: caso.version + 1 });
    expect(b).toEqual(a);
  });

  it('audita exactamente un evento identidad.caso_apartado, y otro identidad.caso_desapartado al desapartar', async () => {
    const caso = await casoAbierto();
    await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k-aud-1' });
    await apartarCaso(app, { caseId: caso.id, expectedVersion: caso.version, actor: 'jose', idempotencyKey: 'k-aud-1' }); // reintento: no debe auditar de nuevo
    await desapartarCaso(app, { caseId: caso.id, expectedVersion: caso.version + 1, actor: 'jose', idempotencyKey: 'k-aud-2' });
    const eventos = (await admin.query<{ action: string; company_id: string; aggregate_id: string }>(
      `select action, company_id, aggregate_id from audit.audit_events where aggregate_id = $1 order by chain_seq`, [caso.id])).rows;
    expect(eventos.map((e) => e.action)).toEqual(['identidad.caso_apartado', 'identidad.caso_desapartado']);
    expect(eventos.every((e) => e.company_id === empresa)).toBe(true);
  });
});
