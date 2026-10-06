/*
 * test/identidad/sku.test.ts — E3 corte 1 tarea 4: normalizarSku + skuUnico.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizarSku, skuUnico } from '../../src/identidad/sku.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E3-SKU-01 normalizarSku', () => {
  it.each([
    [' fb-12 ', 'FB-12'],
    ['fb 12', 'FB 12'],
    ['', null],
    [null, null],
    [undefined, null],
    ['   ', null],
    ['FB-2001', 'FB-2001'],
    ['fb-2001  extra', 'FB-2001 EXTRA'],
  ])('normalizarSku(%j) === %j', (entrada, esperado) => {
    expect(normalizarSku(entrada as string | null | undefined)).toBe(esperado);
  });
});

describe('E3-SKU-02 skuUnico', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
  let empresa: string; let otraEmpresa: string; let ml: string; let mlOtra: string;

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    otraEmpresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('G') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
    mlOtra = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','2') returning id", [otraEmpresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE catalog.sellable_variants, catalog.product_models CASCADE');
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  async function modelo(empresaId: string, cuentaId: string) {
    return (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', gen_random_uuid()::text, 'M') RETURNING id`, [empresaId, cuentaId])).rows[0]!.id;
  }
  async function variante(empresaId: string, modelId: string, sku: string | null, archivada = false) {
    return (await admin.query<{ id: string }>(
      `INSERT INTO catalog.sellable_variants (company_id, model_id, sku, archivado_en, motivo_archivo)
       VALUES ($1, $2, $3, ${archivada ? 'now()' : 'NULL'}, ${archivada ? "'archivada para el test'" : 'NULL'}) RETURNING id`,
      [empresaId, modelId, sku])).rows[0]!.id;
  }

  it('0 variantes con ese sku: ninguna', async () => {
    expect(await skuUnico(app, empresa, 'FB-9001')).toBe('ninguna');
  });

  it('1 variante con ese sku: la encuentra', async () => {
    const m = await modelo(empresa, ml);
    const v = await variante(empresa, m, 'FB-9002');
    expect(await skuUnico(app, empresa, 'FB-9002')).toEqual({ variantId: v });
  });

  it('ignora variantes archivadas: si la única viva está archivada, ninguna', async () => {
    const m = await modelo(empresa, ml);
    await variante(empresa, m, 'FB-9003', true);
    expect(await skuUnico(app, empresa, 'FB-9003')).toBe('ninguna');
  });

  it('ignora variantes de otra empresa: mismo sku en otra empresa no cuenta', async () => {
    const m = await modelo(otraEmpresa, mlOtra);
    await variante(otraEmpresa, m, 'FB-9004');
    expect(await skuUnico(app, empresa, 'FB-9004')).toBe('ninguna');
  });
});
