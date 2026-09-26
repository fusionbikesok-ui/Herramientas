/*
 * test/identidad/replay.test.ts — E3 corte 3 tarea 7: replay auto_sku vs humano (spec §7.2).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { replay } from '../../src/identidad/replay.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E3-REP-01 replay', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string; let n = 0;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => { n = 0; await admin.query('TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.sellable_variants, catalog.product_models CASCADE'); });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  const variante = async () => {
    const m = (await admin.query<{ id: string }>(`insert into catalog.product_models(company_id,channel_account_id,origen,clave_origen,titulo) values ($1,$2,'ml_simple',$3,$3) returning id`, [empresa, ml, randomUUID()])).rows[0]!.id;
    return (await admin.query<{ id: string }>('insert into catalog.sellable_variants(company_id,model_id,sku) values ($1,$2,$3) returning id', [empresa, m, `FB-${2000 + ++n}`])).rows[0]!.id;
  };
  /** Clave con auto_sku hacia `auto` y, opcional, una humana con esa elección. */
  async function clave(recurso: string, auto: string, humana?: { eleccion: string; variante?: string }) {
    const caso = (await admin.query<{ id: string }>("insert into catalog.identity_cases(company_id,tipo,variant_id) values ($1,'sku_pendiente',$2) returning id", [empresa, await variante()])).rows[0]!.id;
    await admin.query(`insert into catalog.identity_decisions(company_id,case_id,channel_account_id,recurso,variacion_normalizada,eleccion,variant_id,origen,actor,efecto,engine_version)
      values ($1,$2,$3,$4,'','vincular',$5,'auto_sku','identidad.motor','sombra','t')`, [empresa, caso, ml, recurso, auto]);
    if (humana) await admin.query(`insert into catalog.identity_decisions(company_id,case_id,channel_account_id,recurso,variacion_normalizada,eleccion,variant_id,origen,actor,efecto)
      values ($1,$2,$3,$4,'',$5,$6,'humano','jose','aplicar')`, [empresa, caso, ml, recurso, humana.eleccion, humana.variante ?? null]);
  }
  const correr = () => replay(app, { empresa, muestra: [], catalogo: [], desde: new Date(Date.now() - 864e5), hasta: new Date(Date.now() + 864e5) });

  it('auto_sku igual a la humana vincular → coincide y es apto', async () => {
    const v = await variante(); await clave('MLA1', v, { eleccion: 'vincular', variante: v });
    const r = await correr();
    expect(r.autoSkuVsHumano).toEqual({ coinciden: 1, difieren: [] }); expect(r.veredicto).toBe('apto');
  });
  it('una distinta → difieren y no_apto', async () => {
    const a = await variante(); const b = await variante(); await clave('MLA1', a, { eleccion: 'vincular', variante: b });
    const r = await correr();
    expect(r.autoSkuVsHumano.difieren).toEqual([{ recurso: 'MLA1', autoSku: a, humano: b }]); expect(r.veredicto).toBe('no_apto');
  });
  it.each(['sin_candidato', 'omitir', 'mantener_omision'])('humana %s sobre una clave con auto_sku cuenta en difieren', async (eleccion) => {
    await clave('MLA1', await variante(), { eleccion });
    const r = await correr();
    expect(r.autoSkuVsHumano.difieren).toHaveLength(1); expect(r.veredicto).toBe('no_apto');
  });
  it('un apartado no es decisión y una auto_sku sin humana no entra al denominador', async () => {
    await clave('MLA1', await variante());
    await admin.query('UPDATE catalog.identity_cases SET apartado_en = now()');
    const r = await correr();
    expect(r.autoSkuVsHumano).toEqual({ coinciden: 0, difieren: [] }); expect(r.veredicto).toBe('apto');
  });
});
