import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { aplicarProyeccion } from '../../src/catalogo/aplicar.ts';
import type { Proyeccion } from '../../src/catalogo/intenciones.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E3-INT-01 intervention', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string; let destino: string;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;
  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => { await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.format_observations, catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`); });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });
  const escenario = async (sku = 'FB-100') => {
    const modelo = (await q<{ id: string }>(`insert into catalog.product_models(company_id,channel_account_id,origen,clave_origen,titulo) values ($1,$2,'ml_simple',$3,$3) returning id`, [empresa, ml, randomUUID()]))[0]!.id;
    destino = (await q<{ id: string }>('insert into catalog.sellable_variants(company_id,model_id,sku) values ($1,$2,$3) returning id', [empresa, modelo, sku]))[0]!.id;
    const caso = (await q<{ id: string }>("insert into catalog.identity_cases(company_id,tipo,variant_id) values ($1,'sku_pendiente',$2) returning id", [empresa, destino]))[0]!.id;
    await admin.query(`insert into catalog.identity_decisions(company_id,case_id,channel_account_id,recurso,variacion_normalizada,eleccion,variant_id,origen,actor,efecto) values ($1,$2,$3,'MLA1','','vincular',$4,'humano','jose','aplicar')`, [empresa, caso, ml, destino]);
    return caso;
  };
  const proyeccion = (sku: string): Proyeccion => ({ modelo: { origen: 'ml_simple', claveOrigen: 'MLA1', titulo: 'x' }, archivar: null, representaciones: [{ recurso: 'MLA1', variacion: '', tipo: 'vendible', sku: { estado: 'otro', valor: sku }, estadoRemoto: 'activo', userProductId: null, idWoo: null, atributos: [], imagenes: [] }] });
  const ctx = (intervencion: boolean) => ({ tx: app, cuenta: ml, canal: 'mercadolibre' as const, versionRemota: 'v1', bandeja: true, intervencion, payloadMl: { id: 'MLA1', seller_custom_field: 'FB-100', listing_type_id: 'gold_special' } });
  const ctxCon = (intervencion: boolean, listing: string, extra: object = {}) => ({ ...ctx(intervencion), payloadMl: { id: 'MLA1', seller_custom_field: 'FB-100', listing_type_id: listing }, ...extra });
  const casosIntervention = async () => q<{ tipo: string; estado: string; variant_id: string }>("select tipo, estado, variant_id from catalog.identity_cases where estado='intervention'");
  const comandos = async () => (await q<{ n: number }>("select count(*)::int n from catalog.identity_commands where tipo='pausar_publicacion' and estado='parked'"))[0]!.n;
  const vinculo = async () => (await q<{ variant_id: string }>("select variant_id from catalog.external_representations where recurso='MLA1'"))[0]!.variant_id;
  const eventos = async () => (await q<{ n: number }>("select count(*)::int n from audit.audit_events where action='identidad.intervention'"))[0]!.n;
  it('cambio de SKU abre intervention (sku_cambiado) sin tocar variant_id', async () => {
    await escenario(); await aplicarProyeccion(ctx(true), proyeccion('FB-999'));
    expect(await casosIntervention()).toEqual([expect.objectContaining({ tipo: 'sku_cambiado', variant_id: destino })]);
    expect(await vinculo()).toBe(destino); expect(await eventos()).toBe(1);
  });
  it('un cambio solo de SKU no inserta pausar_publicacion', async () => {
    await escenario(); await aplicarProyeccion(ctx(true), proyeccion('FB-999'));
    expect(await casosIntervention()).toEqual([expect.objectContaining({ tipo: 'sku_cambiado' })]);
    expect(await comandos()).toBe(0);
  });
  it('cambio de formato abre intervention y deja UN comando parked', async () => {
    await escenario();
    await aplicarProyeccion(ctxCon(true, 'gold_special'), proyeccion('FB-100'));
    await aplicarProyeccion(ctxCon(true, 'gold_pro'), proyeccion('FB-100'));
    expect(await casosIntervention()).toEqual([expect.objectContaining({ tipo: 'formato_cambiado' })]);
    expect(await comandos()).toBe(1); expect(await vinculo()).toBe(destino);
  });
  it('un cambio de SKU en una variación abre intervention solo para esa variación', async () => {
    const modelo = (await q<{ id: string }>(`insert into catalog.product_models(company_id,channel_account_id,origen,clave_origen,titulo) values ($1,$2,'ml_clasico',$3,$3) returning id`, [empresa, ml, randomUUID()]))[0]!.id;
    const variantes = await Promise.all(['FB-101', 'FB-102'].map(async (sku, i) => {
      const id = (await q<{ id: string }>('insert into catalog.sellable_variants(company_id,model_id,sku) values ($1,$2,$3) returning id', [empresa, modelo, sku]))[0]!.id;
      const caso = (await q<{ id: string }>("insert into catalog.identity_cases(company_id,tipo,variant_id) values ($1,'sku_pendiente',$2) returning id", [empresa, id]))[0]!.id;
      const variacion = String(i + 1);
      await admin.query(`insert into catalog.identity_decisions(company_id,case_id,channel_account_id,recurso,variacion_normalizada,eleccion,variant_id,origen,actor,efecto) values ($1,$2,$3,'MLA-V',$4,'vincular',$5,'humano','jose','aplicar')`, [empresa, caso, ml, variacion, id]);
      await admin.query(`insert into catalog.external_representations(company_id,channel_account_id,canal,tipo,recurso,variacion_normalizada,variant_id) values ($1,$2,'mercadolibre','vendible','MLA-V',$3,$4)`, [empresa, ml, variacion, id]);
      return { id, sku, variacion };
    }));
    const proyeccion = (sku1: string): Proyeccion => ({ modelo: { origen: 'ml_clasico', claveOrigen: 'MLA-V', titulo: 'x' }, archivar: null, representaciones: [
      { recurso: 'MLA-V', variacion: '', tipo: 'contenedor', sku: { estado: 'no_informado' }, estadoRemoto: 'activo', userProductId: null, idWoo: null, atributos: [], imagenes: [] },
      ...variantes.map((v) => ({ recurso: 'MLA-V', variacion: v.variacion, tipo: 'vendible' as const, sku: { estado: 'otro' as const, valor: v.variacion === '1' ? sku1 : v.sku }, estadoRemoto: 'activo' as const, userProductId: null, idWoo: null, atributos: [], imagenes: [] })),
    ] });
    const contexto = (version: string) => ({ tx: app, cuenta: ml, canal: 'mercadolibre' as const, versionRemota: version, bandeja: true, intervencion: true, payloadMl: { id: 'MLA-V', listing_type_id: 'gold_special', variations: variantes.map((v) => ({ id: v.variacion, attributes: [{ id: 'SELLER_SKU', value_name: v.variacion === '1' && version === 'v2' ? 'FB-999' : v.sku }] })) } });
    await aplicarProyeccion(contexto('v1'), proyeccion('FB-101'));
    await aplicarProyeccion(contexto('v2'), proyeccion('FB-999'));
    expect(await casosIntervention()).toEqual([expect.objectContaining({ tipo: 'sku_cambiado', variant_id: variantes[0]!.id })]);
  });
  it('un cambio de formato del contenedor abre intervention para todas las variaciones vinculadas', async () => {
    const modelo = (await q<{ id: string }>(`insert into catalog.product_models(company_id,channel_account_id,origen,clave_origen,titulo) values ($1,$2,'ml_clasico',$3,$3) returning id`, [empresa, ml, randomUUID()]))[0]!.id;
    const variantes = await Promise.all(['FB-201', 'FB-202'].map(async (sku, i) => {
      const id = (await q<{ id: string }>('insert into catalog.sellable_variants(company_id,model_id,sku) values ($1,$2,$3) returning id', [empresa, modelo, sku]))[0]!.id;
      const caso = (await q<{ id: string }>("insert into catalog.identity_cases(company_id,tipo,variant_id) values ($1,'sku_pendiente',$2) returning id", [empresa, id]))[0]!.id;
      const variacion = String(i + 1);
      await admin.query(`insert into catalog.identity_decisions(company_id,case_id,channel_account_id,recurso,variacion_normalizada,eleccion,variant_id,origen,actor,efecto) values ($1,$2,$3,'MLA-F',$4,'vincular',$5,'humano','jose','aplicar')`, [empresa, caso, ml, variacion, id]);
      await admin.query(`insert into catalog.external_representations(company_id,channel_account_id,canal,tipo,recurso,variacion_normalizada,variant_id) values ($1,$2,'mercadolibre','vendible','MLA-F',$3,$4)`, [empresa, ml, variacion, id]);
      return { id, sku, variacion };
    }));
    const proyeccion: Proyeccion = { modelo: { origen: 'ml_clasico', claveOrigen: 'MLA-F', titulo: 'x' }, archivar: null, representaciones: [
      { recurso: 'MLA-F', variacion: '', tipo: 'contenedor', sku: { estado: 'no_informado' }, estadoRemoto: 'activo', userProductId: null, idWoo: null, atributos: [], imagenes: [] },
      ...variantes.map((v) => ({ recurso: 'MLA-F', variacion: v.variacion, tipo: 'vendible' as const, sku: { estado: 'otro' as const, valor: v.sku }, estadoRemoto: 'activo' as const, userProductId: null, idWoo: null, atributos: [], imagenes: [] })),
    ] };
    let version = 0;
    const contexto = (listing: string) => ({ tx: app, cuenta: ml, canal: 'mercadolibre' as const, versionRemota: `2026-01-01T00:00:0${++version}Z`, bandeja: true, intervencion: true, payloadMl: { id: 'MLA-F', listing_type_id: listing, variations: variantes.map((v) => ({ id: v.variacion, attributes: [{ id: 'SELLER_SKU', value_name: v.sku }] })) } });
    await aplicarProyeccion(contexto('gold_special'), proyeccion);
    await aplicarProyeccion(contexto('gold_pro'), proyeccion);
    expect(await casosIntervention()).toHaveLength(2);
    expect((await casosIntervention()).map((x) => x.variant_id).sort()).toEqual(variantes.map((v) => v.id).sort());
  });
  it('sin decisión vigente no abre nada', async () => {
    await aplicarProyeccion(ctx(true), proyeccion('FB-999'));
    expect(await casosIntervention()).toEqual([]); expect(await comandos()).toBe(0);
  });
  it('E3_INTERVENTION=1 con E3_CANARIO=0 y E3_AUTO_SKU=0 abre igual (sombra)', async () => {
    await escenario(); await aplicarProyeccion(ctx(true), proyeccion('FB-999'));
    expect((await casosIntervention()).length).toBe(1);
  });
  it('flag apagado observa pero no abre intervention', async () => { await escenario(); await aplicarProyeccion(ctx(false), proyeccion('FB-999')); expect((await q("select count(*)::int n from catalog.identity_cases where estado='intervention'"))[0]?.n ?? 0).toBe(0); // Captura en sombra deliberada, pendiente de decisión de José.
    expect((await q('select count(*)::int n from catalog.format_observations'))[0]!.n).toBe(1); });
  it('es idempotente para la misma observación', async () => { await escenario(); await aplicarProyeccion(ctx(true), proyeccion('FB-999')); await aplicarProyeccion(ctx(true), proyeccion('FB-999')); expect((await q("select count(*)::int n from catalog.identity_cases where tipo='sku_cambiado'"))[0]!.n).toBe(1); expect((await q("select count(*)::int n from catalog.identity_commands where tipo='pausar_publicacion'"))[0]!.n).toBe(0); });
});
