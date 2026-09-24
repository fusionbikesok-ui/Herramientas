/*
 * test/identidad/esquema.test.ts — E3 corte 1 tarea 1: lo que la base tiene que hacer cumplir sola
 * sobre las decisiones, candidatos y evidencia de identidad. Sigue el patrón de
 * test/catalogo/esquema.test.ts: cada caso prueba una regla del esquema, no del código de aplicación.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

let base: BaseDePrueba;
const clientes: pg.Client[] = [];

beforeAll(async () => {
  base = await crearBaseDePrueba();
  return async () => { while (clientes.length) await clientes.pop()?.end(); await base.borrar(); };
});

async function admin(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: base.urlAdmin });
  await c.connect(); clientes.push(c); return c;
}

async function app(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: base.urlApp });
  await c.connect(); clientes.push(c); return c;
}

/** Empresa y cuenta de canal nuevas por caso, para que un caso no vea lo del otro. */
async function sembrar(db: pg.Client): Promise<{ empresa: string; ml: string }> {
  const empresa = (await db.query<{ id: string }>(
    `INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`,
    [`Empresa ${randomUUID().slice(0, 8)}`])).rows[0]!.id;
  const ml = (await db.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account)
     VALUES ($1, 'mercadolibre', $2) RETURNING id`,
    [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
  return { empresa, ml };
}

async function modelo(db: pg.Client, e: { empresa: string; ml: string }): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, 'ml_simple', $3, 'm') RETURNING id`,
    [e.empresa, e.ml, randomUUID().slice(0, 12)])).rows[0]!.id;
}

async function variante(db: pg.Client, empresa: string, modelId: string, sku: string | null = null): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, modelId, sku])).rows[0]!.id;
}

async function caso(db: pg.Client, e: { empresa: string }, variantId: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2) RETURNING id`,
    [e.empresa, variantId])).rows[0]!.id;
}

/** Inserta una decisión humano/vincular, lista para reusar en varios casos. */
async function decisionHumana(
  db: pg.Client, e: { empresa: string; ml: string }, caseId: string, variantId: string,
  o: { recurso?: string; variacion?: string; idempotencyKey?: string } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO catalog.identity_decisions
       (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id,
        origen, actor, efecto, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'vincular', $6, 'humano', 'test', 'aplicar', $7) RETURNING id`,
    [e.empresa, caseId, e.ml, o.recurso ?? 'MLA1', o.variacion ?? '', variantId, o.idempotencyKey ?? randomUUID()],
  );
  return r.rows[0]!.id;
}

/** Como decisionHumana, pero deja fijar supersede_a a mano (para forzar los casos que el trigger tiene que rechazar). */
async function decisionConSupersede(
  db: pg.Client, e: { empresa: string; ml: string }, caseId: string, variantId: string,
  o: { recurso: string; variacion?: string; supersedeA: string; idempotencyKey?: string },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO catalog.identity_decisions
       (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id,
        origen, actor, efecto, idempotency_key, supersede_a)
     VALUES ($1, $2, $3, $4, $5, 'vincular', $6, 'humano', 'test', 'aplicar', $7, $8) RETURNING id`,
    [e.empresa, caseId, e.ml, o.recurso, o.variacion ?? '', variantId, o.idempotencyKey ?? randomUUID(), o.supersedeA],
  );
  return r.rows[0]!.id;
}

afterEach(async () => {
  const db = await admin();
  // Forward-only también en los tests: se limpia el catálogo, nunca el esquema.
  await db.query(`TRUNCATE catalog.identity_decisions, catalog.identity_candidates, catalog.identity_evidence,
                           catalog.identity_cases, catalog.matcher_decisions, catalog.external_representations,
                           catalog.sellable_variants, catalog.product_models CASCADE`);
});

describe('E3-SCH-01 esquema de identity_decisions/candidates/evidence', () => {
  it('(a) una decisión humano/aplicar se acepta', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e); const v = await variante(db, e.empresa, m);
    const c = await caso(db, e, v);
    await expect(decisionHumana(db, e, c, v)).resolves.toBeTruthy();
  });

  it('(b) una decisión auto_sku/aplicar viola el CHECK', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e); const v = await variante(db, e.empresa, m);
    const c = await caso(db, e, v);
    await expect(db.query(
      `INSERT INTO catalog.identity_decisions
         (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id,
          origen, actor, efecto, idempotency_key)
       VALUES ($1, $2, $3, 'MLA1', '', 'vincular', $4, 'auto_sku', 'motor', 'aplicar', $5)`,
      [e.empresa, c, e.ml, v, randomUUID()],
    )).rejects.toThrow(/check/i);
  });

  it('(c) dos decisiones vigentes para la misma clave y efecto violan el UNIQUE', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e); const v1 = await variante(db, e.empresa, m); const v2 = await variante(db, e.empresa, m);
    const c1 = await caso(db, e, v1); const c2 = await caso(db, e, v2);
    await decisionHumana(db, e, c1, v1, { recurso: 'MLA1', variacion: '' });
    // Misma clave (channel_account_id, recurso, variacion_normalizada) y mismo efecto, sin superada_en: choca.
    await expect(decisionHumana(db, e, c2, v2, { recurso: 'MLA1', variacion: '' }))
      .rejects.toThrow(/duplicate key|unique/i);
  });

  it('(d) UPDATE o DELETE sobre identity_decisions con el rol de la app: permiso denegado', async () => {
    const admin_ = await admin(); const e = await sembrar(admin_);
    const m = await modelo(admin_, e); const v = await variante(admin_, e.empresa, m);
    const c = await caso(admin_, e, v);
    const decisionId = await decisionHumana(admin_, e, c, v);

    const appDb = await app();
    await expect(appDb.query(`UPDATE catalog.identity_decisions SET motivo = 'x' WHERE id = $1`, [decisionId]))
      .rejects.toThrow(/permission denied/i);
    await expect(appDb.query(`DELETE FROM catalog.identity_decisions WHERE id = $1`, [decisionId]))
      .rejects.toThrow(/permission denied/i);
  });

  // Guardia contra la 0013: dejó `ALTER DEFAULT PRIVILEGES ... IN SCHEMA catalog GRANT UPDATE`, así que
  // CUALQUIER tabla nueva del esquema catalog hereda UPDATE para plataforma_app sin que la migración que
  // la crea tenga que pedirlo (0014 ya confía en eso explícitamente). El REVOKE puntual de la 0020 corrige
  // esta tabla, pero nada impide que una migración futura repita un GRANT que lo vuelva a abrir en
  // silencio. Este test no revisa el texto de las migraciones: revisa el privilegio real en la base
  // migrada, así que cualquier forma de reabrirlo (un GRANT nuevo, revertir el REVOKE, un default
  // privilege distinto) rompe la suite, sea cual sea el mecanismo.
  it('has_table_privilege confirma que plataforma_app no tiene UPDATE ni DELETE sobre identity_decisions', async () => {
    const db = await admin();
    const r = await db.query<{ update: boolean; delete: boolean }>(
      `SELECT has_table_privilege('plataforma_app', 'catalog.identity_decisions', 'UPDATE') AS update,
              has_table_privilege('plataforma_app', 'catalog.identity_decisions', 'DELETE') AS delete`);
    expect(r.rows[0]!.update).toBe(false);
    expect(r.rows[0]!.delete).toBe(false);
  });

  it('(e) identity_cases.version vale 1 y estado vale actionable por omisión', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e); const v = await variante(db, e.empresa, m);
    const c = await caso(db, e, v);
    const r = await db.query<{ version: number; estado: string }>(
      `SELECT version, estado FROM catalog.identity_cases WHERE id = $1`, [c]);
    expect(r.rows[0]!.version).toBe(1);
    expect(r.rows[0]!.estado).toBe('actionable');
  });

  it('(f) la misma idempotency_key repetida viola el UNIQUE', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e); const v1 = await variante(db, e.empresa, m); const v2 = await variante(db, e.empresa, m);
    const c1 = await caso(db, e, v1); const c2 = await caso(db, e, v2);
    const clave = randomUUID();
    await decisionHumana(db, e, c1, v1, { recurso: 'MLA1', variacion: '', idempotencyKey: clave });
    // Distinta clave natural (otro recurso) para que el choque sea SOLO por idempotency_key, no por la vigente.
    await expect(decisionHumana(db, e, c2, v2, { recurso: 'MLA2', variacion: '', idempotencyKey: clave }))
      .rejects.toThrow(/duplicate key|unique/i);
  });

  it('un trigger marca superada_en en la vigente anterior al insertar una nueva decisión de la misma clave y efecto', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e); const v1 = await variante(db, e.empresa, m); const v2 = await variante(db, e.empresa, m);
    const c1 = await caso(db, e, v1); const c2 = await caso(db, e, v2);
    const d1 = await decisionHumana(db, e, c1, v1, { recurso: 'MLA1', variacion: '' });

    // Para insertar la segunda decisión de la misma clave, primero hay que superar la primera explícitamente
    // (el trigger la marca sola: acá sólo declaramos supersede_a, requisito de la app, no del trigger).
    await db.query(
      `INSERT INTO catalog.identity_decisions
         (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id,
          origen, actor, efecto, idempotency_key, supersede_a)
       VALUES ($1, $2, $3, 'MLA1', '', 'vincular', $4, 'humano', 'test', 'aplicar', $5, $6)`,
      [e.empresa, c2, e.ml, v2, randomUUID(), d1],
    );

    const r = await db.query<{ superada_en: Date | null }>(
      `SELECT superada_en FROM catalog.identity_decisions WHERE id = $1`, [d1]);
    expect(r.rows[0]!.superada_en).not.toBeNull();
  });

  it('supersede_a de OTRA clave se rechaza: la vigente ajena no queda superada (retiro encubierto vía el trigger)', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e);
    const v1 = await variante(db, e.empresa, m); const v2 = await variante(db, e.empresa, m); const v3 = await variante(db, e.empresa, m);
    const c1 = await caso(db, e, v1); const c2 = await caso(db, e, v2); const c3 = await caso(db, e, v3);
    // d1 vigente sobre MLA1; intento de insertar una decisión de OTRA clave (MLA2) declarando
    // supersede_a=d1: el trigger tiene que rechazarla, no "retirar" a d1 en silencio.
    const d1 = await decisionHumana(db, e, c1, v1, { recurso: 'MLA1', variacion: '' });
    await decisionHumana(db, e, c2, v2, { recurso: 'MLA2', variacion: '' }); // para tener un id de otra clave, sin usarlo como supersede_a acá
    await expect(decisionConSupersede(db, e, c3, v3, { recurso: 'MLA3', variacion: '', supersedeA: d1 }))
      .rejects.toThrow(/otra clave o empresa/i);

    const r = await db.query<{ superada_en: Date | null }>(
      `SELECT superada_en FROM catalog.identity_decisions WHERE id = $1`, [d1]);
    expect(r.rows[0]!.superada_en).toBeNull(); // d1 sigue vigente: el intento no tuvo ningún efecto parcial
  });

  it('supersede_a ya superada se rechaza', async () => {
    const db = await admin(); const e = await sembrar(db);
    const m = await modelo(db, e);
    const v1 = await variante(db, e.empresa, m); const v2 = await variante(db, e.empresa, m); const v3 = await variante(db, e.empresa, m);
    const c1 = await caso(db, e, v1); const c2 = await caso(db, e, v2); const c3 = await caso(db, e, v3);
    const d1 = await decisionHumana(db, e, c1, v1, { recurso: 'MLA1', variacion: '' });
    const d2 = await decisionConSupersede(db, e, c2, v2, { recurso: 'MLA1', variacion: '', supersedeA: d1 }); // supera a d1, ok
    // Ahora d1 ya está superada: un tercer INSERT que la vuelva a nombrar tiene que fallar.
    await expect(decisionConSupersede(db, e, c3, v3, { recurso: 'MLA1', variacion: '', supersedeA: d1 }))
      .rejects.toThrow(/ya estaba superada/i);
    void d2;
  });

  it('supersede_a de otra empresa se rechaza', async () => {
    const db = await admin();
    const eA = await sembrar(db); const eB = await sembrar(db);
    const mA = await modelo(db, eA); const vA = await variante(db, eA.empresa, mA); const cA = await caso(db, eA, vA);
    const mB = await modelo(db, eB); const vB = await variante(db, eB.empresa, mB); const cB = await caso(db, eB, vB);
    const dA = await decisionHumana(db, eA, cA, vA, { recurso: 'MLA1', variacion: '' });
    await expect(decisionConSupersede(db, eB, cB, vB, { recurso: 'MLA1', variacion: '', supersedeA: dA }))
      .rejects.toThrow(/otra clave o empresa/i);
  });
});
