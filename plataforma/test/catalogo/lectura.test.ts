/*
 * test/catalogo/lectura.test.ts — E2 T1 tarea 13: lectura del catálogo, conciliación y contrato OpenAPI.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { ValidateFunction } from 'ajv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApi } from '../../src/api/app.ts';
import { conciliarCatalogo, hashCatalogo, seccionCatalogo } from '../../src/catalogo/conciliacion.ts';
import { crearLogger } from '../../src/comun/logger.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new (o: object) => { compile(s: object): ValidateFunction };
const addFormats = require('ajv-formats') as (a: unknown) => void;
const CONTRATO = fileURLToPath(new URL('../../../openapi/platform-v2.yaml', import.meta.url));

describe('E2-LEC-01 lectura y conciliación del catálogo', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let woo: string; let ml: string;
  let validar: Record<string, ValidateFunction>;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;
  const api = (caps: string[]) => crearApi({ pool: app, logger: crearLogger('test'), estadoPgDir: '/nada',
    sesion: async () => (caps.length ? { userId: 'u', capabilities: caps } : null) });

  /** Arma un escenario chico con cada uno de los cuatro cruces en regla. */
  async function escenario() {
    const modelo = async (cuenta: string, origen: string, clave: string) => (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo) VALUES ($1,$2,$3,$4,$4) RETURNING id`,
      [empresa, cuenta, origen, clave])).rows[0]!.id;
    const variante = async (m: string, sku: string | null) => (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1,$2,$3) RETURNING id', [empresa, m, sku])).rows[0]!.id;
    const rep = async (cuenta: string, canal: string, recurso: string, v: string | null, omitida = false) => (await admin.query<{ id: string }>(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, recurso, tipo, variant_id, omitida_por_decision, estado_remoto)
       VALUES ($1,$2,$3,$4,'vendible',$5,$6,'active') RETURNING id`, [empresa, cuenta, canal, recurso, v, omitida])).rows[0]!.id;
    const decision = (recurso: string, accion: string, sku: string | null) => admin.query(
      `INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, sku, accion, origen, actor) VALUES ($1,$2,'mercadolibre',$3,$4,$5,'copia','persona')`,
      [empresa, ml, recurso, sku, accion]);
    const caso = (tipo: string, o: { v?: string; r?: string }) => admin.query(
      'INSERT INTO catalog.identity_cases (company_id, tipo, variant_id, representation_id) VALUES ($1,$2,$3,$4)', [empresa, tipo, o.v ?? null, o.r ?? null]);

    const vWoo = await variante(await modelo(woo, 'woo_simple', '1'), 'FB-1');
    await rep(woo, 'woocommerce', '1', vWoo);
    // 1. decisión vinculada
    await rep(ml, 'mercadolibre', 'MLA1', vWoo); await decision('MLA1', 'confirmar', 'FB-1');
    // 2. sin decisión, pendiente con su caso
    const vPend = await variante(await modelo(ml, 'ml_simple', 'MLA2'), null);
    await rep(ml, 'mercadolibre', 'MLA2', vPend); await caso('sku_pendiente', { v: vPend });
    // 3. omitida con su caso
    const rOm = await rep(ml, 'mercadolibre', 'MLA3', null, true); await decision('MLA3', 'omitir', null); await caso('omitida_revisar', { r: rOm });
    // 4. decisión a un SKU que no está, con su caso
    const vInex = await variante(await modelo(ml, 'ml_simple', 'MLA4'), null);
    await rep(ml, 'mercadolibre', 'MLA4', vInex); await decision('MLA4', 'asignar', 'FB-99'); await caso('sku_inexistente_en_woo', { v: vInex });
    return { vPend };
  }

  beforeAll(async () => {
    const contrato = await SwaggerParser.dereference(CONTRATO) as { components: { schemas: Record<string, object> } };
    const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
    validar = Object.fromEntries(['CatalogModelPage', 'CatalogVariantPage', 'CatalogReconciliation', 'Error']
      .map((n) => [n, ajv.compile(contrato.components.schemas[n]!)]));
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
    empresa = (await app.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    const cuenta = async (canal: string) => (await app.query<{ id: string }>('insert into core.channel_accounts(company_id,channel,external_account) values ($1,$2,$3) returning id', [empresa, canal, randomUUID()])).rows[0]!.id;
    woo = await cuenta('woocommerce'); ml = await cuenta('mercadolibre');
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.matcher_decisions, catalog.copias_lotes, catalog.copias,
      catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  it('el documento OpenAPI entero es válido (antes no se validaba y tenía tres errores de E1)', async () => {
    await expect(SwaggerParser.validate(CONTRATO)).resolves.toBeTruthy();
  });

  it('las tres rutas exigen sesión y catalog.read', async () => {
    for (const ruta of ['/api/v2/catalog/models', '/api/v2/catalog/variants', '/api/v2/catalog/reconciliation']) {
      const sin = await api([]).inject(ruta); expect(sin.statusCode).toBe(401); expect(validar.Error!(sin.json())).toBe(true);
      expect((await api(['operations.read']).inject(ruta)).statusCode).toBe(403);
    }
  });

  it('con los cuatro cruces en regla, ninguno discrepa, y la respuesta cumple el contrato', async () => {
    await escenario();
    const r = await api(['catalog.read']).inject('/api/v2/catalog/reconciliation');
    expect(r.statusCode).toBe(200);
    expect(validar.CatalogReconciliation!(r.json()), JSON.stringify(validar.CatalogReconciliation!.errors)).toBe(true);
    expect(r.json().cruces).toEqual({
      decisiones_vinculadas: { total: 1, discrepan: 0 }, sin_decision_pendientes: { total: 1, discrepan: 0 },
      omitidas: { total: 1, discrepan: 0 }, sku_inexistente: { total: 1, discrepan: 0 },
    });
    expect(r.json().variantes).toEqual({ con_sku: 1, pendientes: 2, archivadas: 0 });
  });

  it('una discrepancia aparece en su cruce: un pendiente sin su caso', async () => {
    const { vPend } = await escenario();
    await admin.query("UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = 'x' WHERE variant_id = $1", [vPend]);
    const c = await conciliarCatalogo(app, new Date());
    expect(c.cruces.sin_decision_pendientes).toEqual({ total: 1, discrepan: 1 });
  });

  it('el hash no cambia con marcas de tiempo, y sí con el estado', async () => {
    await escenario();
    const h1 = await hashCatalogo(app);
    await admin.query("UPDATE catalog.external_representations SET observado_en = now() + interval '1 day'");
    expect(await hashCatalogo(app)).toBe(h1);
    await admin.query("UPDATE catalog.matcher_decisions SET vigente_hasta = now(), motivo_cierre = 'x' WHERE recurso = 'MLA1'");
    expect(await hashCatalogo(app)).not.toBe(h1);
  });

  it('la sección del reporte es la del CORTE: un caso cerrado después sigue contando como abierto ese día', async () => {
    const { vPend } = await escenario();
    await admin.query("UPDATE catalog.identity_cases SET abierto_en = '2026-09-18T12:00:00Z'");
    const desde = new Date('2026-09-18T03:00:00Z'); const hasta = new Date('2026-09-19T03:00:00Z'); const corte = new Date('2026-09-19T09:00:00Z');
    const antes = await seccionCatalogo(app, desde, hasta, corte);
    expect(antes.casos_nuevos.reduce((a, c) => a + c.n, 0)).toBe(3);
    // Después del corte se resuelve el pendiente: rearmar el día tiene que dar exactamente lo mismo.
    await admin.query("UPDATE catalog.identity_cases SET cerrado_en = '2026-09-19T15:00:00Z', motivo_cierre = 'x' WHERE variant_id = $1", [vPend]);
    expect(await seccionCatalogo(app, desde, hasta, corte)).toEqual(antes);
  });

  it('modelos y variantes se paginan por cursor y cumplen el contrato; pending filtra las que esperan SKU', async () => {
    await escenario();
    const a = api(['catalog.read']);
    const p1 = (await a.inject('/api/v2/catalog/models?limit=2')).json();
    expect(validar.CatalogModelPage!(p1), JSON.stringify(validar.CatalogModelPage!.errors)).toBe(true);
    expect(p1.items).toHaveLength(2);
    const p2 = (await a.inject(`/api/v2/catalog/models?limit=2&cursor=${p1.next_cursor}`)).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    const pend = (await a.inject('/api/v2/catalog/variants?pending=true')).json();
    expect(validar.CatalogVariantPage!(pend), JSON.stringify(validar.CatalogVariantPage!.errors)).toBe(true);
    expect(pend.items.map((v: { sku: string | null }) => v.sku)).toEqual([null, null]);
    expect((await a.inject('/api/v2/catalog/models?limit=0')).statusCode).toBe(422);
    expect((await a.inject('/api/v2/catalog/models?cursor=no-es-uuid')).statusCode).toBe(422);
  });
});
