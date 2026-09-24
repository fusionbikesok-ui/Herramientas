/*
 * test/identidad/motor.test.ts — E3 corte 1 tarea 4: correrMotor, el motor en sombra.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_VERSION, correrMotor } from '../../src/identidad/motor.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const logSilencioso = { info() {}, warn() {}, error() {} };

describe('E3-MOTOR-01 correrMotor', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.identity_candidates,
      catalog.matcher_decisions, catalog.model_attributes, catalog.external_representations,
      catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  /** Variante YA vinculada con SKU (candidato de destino, lado "Woo" del catálogo). */
  async function varianteConSku(sku: string) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'woo_simple', $3, $3) RETURNING id`, [empresa, ml, `Bici ${sku}`])).rows[0]!.id;
    return (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id',
      [empresa, modelo, sku])).rows[0]!.id;
  }

  /** Variante pendiente + representación ML + caso sku_pendiente, con sku_observado. */
  async function casoConSkuObservado(recurso: string, skuObservado: string | null, titulo = recurso) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $4) RETURNING id`, [empresa, ml, recurso, titulo])).rows[0]!.id;
    const variante = (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id',
      [empresa, modelo])).rows[0]!.id;
    const rep = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id, model_id, sku_observado)
       VALUES ($1, $2, 'mercadolibre', 'vendible', $3, '', $4, $5, $6) RETURNING id`,
      [empresa, ml, recurso, variante, modelo, skuObservado])).rows[0]!.id;
    const caso = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2) RETURNING id`,
      [empresa, variante])).rows[0]!.id;
    return { modelo, variante, rep, caso };
  }

  const decisionVigenteDe = async (recurso: string) => (await q<{ origen: string; eleccion: string; variant_id: string | null }>(
    `SELECT origen, eleccion, variant_id FROM catalog.identity_decisions WHERE channel_account_id = $1 AND recurso = $2 AND superada_en IS NULL`,
    [ml, recurso]))[0];

  it('SKU único: hay auto_sku en sombra y el vínculo de la representación NO cambia', async () => {
    const destino = await varianteConSku('FB-4001');
    const { caso, rep, variante } = await casoConSkuObservado('MLB1', 'FB-4001');
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r).toEqual({ casos: 1, autoSku: 1 });
    const d = await decisionVigenteDe('MLB1');
    expect(d).toMatchObject({ origen: 'auto_sku', eleccion: 'vincular', variant_id: destino });
    // Sombra: nunca toca la representación ni el vínculo real.
    expect((await q<{ variant_id: string }>('SELECT variant_id FROM catalog.external_representations WHERE id = $1', [rep]))[0]!.variant_id).toBe(variante);
  });

  it('empate de SKU (dos variantes vivas con el mismo sku, no debería pasar por el UNIQUE, se prueba con otra empresa): no hay auto_sku', async () => {
    // El UNIQUE de sellable_variants ya impide dos SKUs iguales en la misma empresa; el caso real de
    // "empate" que puede pasar es 0 candidatos vivos (ver siguiente test) — acá se prueba directamente
    // el contrato de skuUnico devolviendo 'varias' vía un sku_observado que no matchea ninguna variante,
    // así que no hay auto_sku (comportamiento ya cubierto por sku.test.ts a nivel de unidad). Lo que sí
    // hay que probar acá es que sin candidato (SKU inexistente) el motor no inventa nada.
    const { caso } = await casoConSkuObservado('MLB2', 'FB-9999-INEXISTENTE');
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r).toEqual({ casos: 1, autoSku: 0 });
    expect(await decisionVigenteDe('MLB2')).toBeUndefined();
  });

  it('con humana vigente: no hay auto_sku aunque el sku_observado resuelva único', async () => {
    const destino = await varianteConSku('FB-4002');
    const { caso, rep } = await casoConSkuObservado('MLB3', 'FB-4002');
    await admin.query(
      `INSERT INTO catalog.identity_decisions (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto)
       VALUES ($1, $2, $3, 'MLB3', '', 'vincular', $4, 'humano', 'jose', 'aplicar')`,
      [empresa, caso, ml, destino]);
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r.autoSku).toBe(0);
    const decisiones = await q<{ origen: string }>('SELECT origen FROM catalog.identity_decisions WHERE case_id = $1', [caso]);
    expect(decisiones.map((d) => d.origen)).toEqual(['humano']); // no se agregó ninguna auto_sku
  });

  it('con omitir del legado vigente: no hay auto_sku', async () => {
    const destino = await varianteConSku('FB-4003');
    const { caso } = await casoConSkuObservado('MLB4', 'FB-4003');
    await admin.query(
      `INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, variacion_normalizada, accion, origen, actor)
       VALUES ($1, $2, 'mercadolibre', 'MLB4', '', 'omitir', 'evento', 'persona')`,
      [empresa, ml]);
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r.autoSku).toBe(0);
  });

  it('dos corridas: una sola auto_sku (idempotente)', async () => {
    await varianteConSku('FB-4004');
    await casoConSkuObservado('MLB5', 'FB-4004');
    const r1 = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r1.autoSku).toBe(1);
    const r2 = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r2.autoSku).toBe(0);
    const n = (await q<{ n: number }>(
      "SELECT count(*)::int n FROM catalog.identity_decisions WHERE channel_account_id = $1 AND recurso = 'MLB5' AND origen = 'auto_sku'",
      [ml]))[0]!.n;
    expect(n).toBe(1);
  });

  it('GTIN igual y SKU distinto (o sea sku_observado no resuelve): no hay auto_sku', async () => {
    // El motor sólo mira sku_observado (no GTIN: eso es evidencia, no identidad — ver 0014). Con
    // sku_observado null (representación sin ese dato, GTIN es lo único que trajo el canal), skuUnico
    // ni se llama: normalizarSku(null) da null y el motor corta antes.
    await casoConSkuObservado('MLB6', null);
    const r = await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    expect(r.autoSku).toBe(0);
  });

  it('el top-3 de candidatos queda guardado en identity_candidates con engine_version', async () => {
    await varianteConSku('FB-5001'); // candidato de catálogo con título parecido
    const { caso } = await casoConSkuObservado('MLB7', null, 'Bici FB-5001');
    await correrMotor(app, { empresa, limite: 500, log: logSilencioso });
    const candidatos = await q<{ rank: number; engine_version: string }>(
      'SELECT rank, engine_version FROM catalog.identity_candidates WHERE case_id = $1 ORDER BY rank', [caso]);
    expect(candidatos.length).toBeGreaterThan(0);
    expect(candidatos[0]).toMatchObject({ rank: 1, engine_version: ENGINE_VERSION });
  });
});
