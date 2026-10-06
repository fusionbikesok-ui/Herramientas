/*
 * test/catalogo/facetas.test.ts — `catalog.model_facets`: facetas decididas por nosotros, forward-only.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { escribirFaceta, facetasVigentes } from '../../src/catalogo/facetas.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let modelo: string;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});
beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.model_facets, catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'woocommerce', $2) RETURNING id`,
    [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
  modelo = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, 'woo_simple', $3, 'm') RETURNING id`, [empresa, cuenta, randomUUID()])).rows[0]!.id;
});

const f = (over: Partial<Parameters<typeof escribirFaceta>[1]> = {}) => ({
  empresa, modelo, faceta: 'publico', valor: 'infantil', origen: 'regla_categoria' as const,
  motivo: 'porque sí', decididoPor: 'jose', ...over });
const filas = async () => (await admin.query(
  `SELECT valor, vigente_hasta IS NULL AS vigente FROM catalog.model_facets ORDER BY decidido_en, id`)).rows;

describe('E2-FAC-01 escribirFaceta', () => {
  it('es idempotente; un valor distinto cierra el anterior y deja la historia', async () => {
    expect(await escribirFaceta(app, f())).toBe(true);
    expect(await escribirFaceta(app, f())).toBe(false);
    expect(await escribirFaceta(app, f({ valor: 'adulto', origen: 'persona' }))).toBe(true);
    expect(await filas()).toEqual([{ valor: 'infantil', vigente: false }, { valor: 'adulto', vigente: true }]);
    expect(await facetasVigentes(app, empresa, 'publico')).toEqual([{ modelo, valor: 'adulto', origen: 'persona' }]);
  });
  it('rechaza el modelo de otra empresa, un origen inventado, un motivo vacío y un nombre de faceta inválido', async () => {
    const otra = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
    await expect(escribirFaceta(app, f({ empresa: otra }))).rejects.toThrow(/no es de la empresa/);
    await expect(escribirFaceta(app, f({ origen: 'magia' as never }))).rejects.toThrow(/origen/);
    await expect(escribirFaceta(app, f({ motivo: '  ' }))).rejects.toThrow(/motivo/);
    await expect(escribirFaceta(app, f({ faceta: 'Público!' }))).rejects.toThrow(/faceta/);
    expect(await filas()).toEqual([]);
  });
  it('la base no deja dos vigentes para el mismo (empresa, modelo, faceta)', async () => {
    await escribirFaceta(app, f());
    await expect(admin.query(
      `INSERT INTO catalog.model_facets (company_id, model_id, faceta, valor, origen, motivo, decidido_por)
       VALUES ($1, $2, 'publico', 'otro', 'persona', 'm', 'x')`, [empresa, modelo])).rejects.toThrow(/model_facets_un_vigente/);
  });
  it('forward-only: la app no puede borrar', async () => {
    await escribirFaceta(app, f());
    await expect(app.query(`DELETE FROM catalog.model_facets`)).rejects.toThrow(/permission denied/);
  });
});
