/*
 * test/identidad/aplicar-auto-sku.test.ts — E3 corte 3 tarea 4: aplicarAutoSku, una transacción por caso.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { estructuraItemMl } from '../../src/identidad/formato.ts';
import { aplicarAutoSku } from '../../src/identidad/aplicar-auto-sku.ts';
import type { ResultadoRelecturaAutoSku } from '../../src/identidad/relectura-auto-sku.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E3-APL-01 aplicarAutoSku', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.matcher_decisions, catalog.format_observations,
      catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  const modelo = async (clave: string) => (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresa, ml, clave])).rows[0]!.id;
  const varianteConSku = async (sku: string) => (await admin.query<{ id: string }>(
    'INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id', [empresa, await modelo(randomUUID()), sku])).rows[0]!.id;

  /** Publicación de ML colgando de una variante pendiente, con su caso sku_pendiente abierto y el SKU destino único en Woo. */
  async function escenario(recurso: string, sku: string) {
    const destino = await varianteConSku(sku);
    const pendiente = (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id', [empresa, await modelo(recurso)])).rows[0]!.id;
    await admin.query(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id)
       VALUES ($1, $2, 'mercadolibre', 'vendible', $3, '', $4)`, [empresa, ml, recurso, pendiente]);
    const caso = (await admin.query<{ id: string }>(
      "INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2) RETURNING id", [empresa, pendiente])).rows[0]!.id;
    return { destino, pendiente, caso, entrada: { casoId: caso, cuenta: ml, recurso, variacion: '', skuCongelado: sku, variantIdCongelada: destino } };
  }
  const ok = (recurso: string): ResultadoRelecturaAutoSku => ({
    tipo: 'ok', hashPayload: `hash-${recurso}`, estructura: estructuraItemMl({ id: recurso, status: 'active', listing_type_id: 'gold_special' }),
  });
  const vinculo = async (recurso: string) => (await q<{ v: string | null }>(
    'SELECT variant_id AS v FROM catalog.external_representations WHERE channel_account_id = $1 AND recurso = $2', [ml, recurso]))[0]?.v;
  const decisiones = async (recurso: string) => q<{ origen: string; efecto: string; superada_en: Date | null; supersede_a: string | null }>(
    'SELECT origen, efecto, superada_en, supersede_a FROM catalog.identity_decisions WHERE recurso = $1 ORDER BY creado_en', [recurso]);
  const estadoCaso = async (id: string) => (await q<{ estado: string; version: number; cerrado_en: Date | null }>(
    'SELECT estado, version, cerrado_en FROM catalog.identity_cases WHERE id = $1', [id]))[0]!;

  it('[esc:auto-sku-unico] vincula, cierra el caso como verified y audita', async () => {
    const e = await escenario('MLA1', 'FB-100');
    expect(await aplicarAutoSku(app, e.entrada, ok('MLA1'), { bandeja: true })).toMatchObject({ resultado: 'vinculado' });
    expect(await vinculo('MLA1')).toBe(e.destino);
    expect(await estadoCaso(e.caso)).toMatchObject({ estado: 'verified', version: 2, cerrado_en: expect.any(Date) });
    expect((await q<{ n: number }>("SELECT count(*)::int n FROM audit.audit_events WHERE action = 'identidad.auto_sku_aplicado' AND aggregate_id = $1", [e.caso]))[0]!.n).toBe(1);
  });

  it('[esc:aplicar-no-supera-sombra] conviven la auto_sku/sombra vigente y la aplicar, sin supersede_a', async () => {
    const e = await escenario('MLA2', 'FB-101');
    await admin.query(
      `INSERT INTO catalog.identity_decisions (company_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto)
       VALUES ($1, $2, 'MLA2', '', 'vincular', $3, 'auto_sku', 'e3-motor', 'sombra')`, [empresa, ml, e.destino]);
    expect(await aplicarAutoSku(app, e.entrada, ok('MLA2'), { bandeja: true })).toMatchObject({ resultado: 'vinculado' });
    const d = await decisiones('MLA2');
    expect(d).toHaveLength(2);
    expect(d.find((x) => x.efecto === 'sombra')).toMatchObject({ superada_en: null });
    expect(d.find((x) => x.efecto === 'aplicar')).toMatchObject({ origen: 'auto_sku', supersede_a: null, superada_en: null });
  });

  it('un SKU que dejó de resolver a la variante congelada va a la bandeja, sin decisión ni vínculo', async () => {
    const e = await escenario('MLA3', 'FB-102');
    expect(await aplicarAutoSku(app, { ...e.entrada, skuCongelado: 'FB-6102' }, ok('MLA3'), { bandeja: true })).toMatchObject({ resultado: 'bandeja' });
    expect(await decisiones('MLA3')).toHaveLength(0);
    expect(await vinculo('MLA3')).not.toBe(e.destino);
    expect((await estadoCaso(e.caso)).estado).toBe('actionable');
  });

  it('[esc:relectura-cambio] pasa a intervention, sin vínculo ni decisión', async () => {
    const e = await escenario('MLA4', 'FB-103');
    const r = await aplicarAutoSku(app, e.entrada, { tipo: 'cambio', que: 'sku', detalle: { nuevo: 'FB-999' } }, { bandeja: true });
    expect(r).toMatchObject({ resultado: 'intervention' });
    expect((await estadoCaso(e.caso)).estado).toBe('intervention');
    expect(await decisiones('MLA4')).toHaveLength(0);
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM catalog.identity_evidence WHERE case_id = $1', [e.caso]))[0]!.n).toBe(1);
  });

  it('relectura no_disponible: caso a actionable con evidencia', async () => {
    const e = await escenario('MLA5', 'FB-104');
    expect(await aplicarAutoSku(app, e.entrada, { tipo: 'no_disponible', motivo: 'closed' }, { bandeja: true })).toMatchObject({ resultado: 'bandeja' });
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM catalog.identity_evidence WHERE case_id = $1', [e.caso]))[0]!.n).toBe(1);
  });

  it('parked y abortar no abren transacción ni escriben', async () => {
    const e = await escenario('MLA6', 'FB-105');
    expect(await aplicarAutoSku(app, e.entrada, { tipo: 'parked', motivo: 'x' }, { bandeja: true })).toMatchObject({ resultado: 'parked' });
    expect(await aplicarAutoSku(app, e.entrada, { tipo: 'abortar', status: 401 }, { bandeja: true })).toMatchObject({ resultado: 'abortar' });
    expect(await estadoCaso(e.caso)).toMatchObject({ estado: 'actionable', version: 1 });
  });

  it('un caso con decisión humana vigente es ya_resuelto, sin filas nuevas', async () => {
    const e = await escenario('MLA7', 'FB-106');
    await admin.query(
      `INSERT INTO catalog.identity_decisions (company_id, channel_account_id, recurso, variacion_normalizada, eleccion, origen, actor, efecto)
       VALUES ($1, $2, 'MLA7', '', 'omitir', 'humano', 'jose', 'aplicar')`, [empresa, ml]);
    expect(await aplicarAutoSku(app, e.entrada, ok('MLA7'), { bandeja: true })).toMatchObject({ resultado: 'ya_resuelto' });
    expect(await decisiones('MLA7')).toHaveLength(1);
  });

  it('[esc:409-dos-operadores] la bandeja y el canario a la vez: una sola decisión aplicar vigente, sin efecto parcial', async () => {
    const e = await escenario('MLA8', 'FB-107');
    const [a, b] = await Promise.all([
      aplicarAutoSku(app, e.entrada, ok('MLA8'), { bandeja: true }),
      aplicarAutoSku(app, e.entrada, ok('MLA8'), { bandeja: true }),
    ]);
    expect([a.resultado, b.resultado].sort()).toEqual(['vinculado', 'ya_resuelto']);
    expect((await decisiones('MLA8')).filter((x) => x.efecto === 'aplicar' && x.superada_en === null)).toHaveLength(1);
  });

  it('reintentar sobre una clave ya vinculada es ya_resuelto, sin segunda decisión', async () => {
    const e = await escenario('MLA9', 'FB-108');
    await aplicarAutoSku(app, e.entrada, ok('MLA9'), { bandeja: true });
    expect(await aplicarAutoSku(app, e.entrada, ok('MLA9'), { bandeja: true })).toMatchObject({ resultado: 'ya_resuelto' });
    expect(await decisiones('MLA9')).toHaveLength(1);
  });

  it('si el SKU resuelve a otra variante que la congelada: bandeja, sin decisión ni vínculo', async () => {
    const e = await escenario('MLA10', 'FB-109');
    const otra = await varianteConSku('FB-8109');
    const r = await aplicarAutoSku(app, { ...e.entrada, variantIdCongelada: otra }, ok('MLA10'), { bandeja: true });
    expect(r.resultado).toBe('bandeja');
    expect(await decisiones('MLA10')).toHaveLength(0);
    expect(await estadoCaso(e.caso)).toMatchObject({ estado: 'actionable', cerrado_en: null });
  });
});
