/*
 * test/catalogo/mapeo-canal.test.ts — aplicar un mapeo «categoría del canal → nodo» verificando lo que quedó.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aplicarMapeoCategorias } from '../../src/catalogo/mapeo-canal.ts';
import { crearVersion, escribirArbol } from '../../src/catalogo/taxonomia.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let ml: string; let woo: string;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});
beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.channel_categories, catalog.taxonomy_channel_map, catalog.model_categories,
    catalog.taxonomy_node_versions, catalog.taxonomy_versions, catalog.taxonomy_nodes CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  ml = await cuenta('mercadolibre'); woo = await cuenta('woocommerce');
  await enTransaccion(app, async (tx) => {
    const v = await crearVersion(tx, empresa, 'test');
    await escribirArbol(tx, empresa, v.id, [
      { clave: 'componentes', nombre: 'COMPONENTES', padre: null },
      { clave: 'transmision', nombre: 'TRANSMISIÓN', padre: 'componentes' },
      { clave: 'bicicletas', nombre: 'BICICLETAS', padre: null },
    ]);
  });
  for (const [id, nombre] of [['MLA1', 'Piñones'], ['MLA2', 'Bicicletas Convencionales']]) {
    await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, nombre)
      VALUES ($1, $2, 'mercadolibre', $3, $4)`, [empresa, ml, id, nombre]);
  }
});

const MAPEO = { MLA1: 'transmision', MLA2: 'bicicletas' };
const aplicar = (over: Partial<Parameters<typeof aplicarMapeoCategorias>[1]> = {}) =>
  enTransaccion(app, (tx) => aplicarMapeoCategorias(tx, {
    empresa, cuenta: ml, canal: 'mercadolibre', mapeo: MAPEO, decididoPor: 'jose', dryRun: false, ...over }));
const vigentes = async () => (await admin.query(
  `SELECT m.id_externo, n.clave FROM catalog.taxonomy_channel_map m JOIN catalog.taxonomy_nodes n ON n.id = m.node_id
    WHERE m.channel_account_id = $1 AND m.vigente_hasta IS NULL ORDER BY 1`, [ml])).rows;

describe('E2-MAPCAN-01 aplicar el mapeo', () => {
  it('dry-run informa y no escribe; ejecutar escribe y cuenta lo que quedó', async () => {
    expect(await aplicar({ dryRun: true })).toEqual({ total: 2, nuevos: 2, iguales: 0, cambiados: 0, quedaron: null });
    expect(await vigentes()).toEqual([]);
    expect(await aplicar()).toEqual({ total: 2, nuevos: 2, iguales: 0, cambiados: 0, quedaron: 2 });
    expect(await vigentes()).toEqual([{ id_externo: 'MLA1', clave: 'transmision' }, { id_externo: 'MLA2', clave: 'bicicletas' }]);
  });
  it('es idempotente, y un cambio de nodo cierra el mapeo anterior en vez de duplicarlo', async () => {
    await aplicar();
    expect(await aplicar()).toMatchObject({ nuevos: 0, iguales: 2, cambiados: 0, quedaron: 2 });
    expect(await aplicar({ mapeo: { MLA1: 'componentes', MLA2: 'bicicletas' } })).toMatchObject({ iguales: 1, cambiados: 1, quedaron: 2 });
    expect(await vigentes()).toEqual([{ id_externo: 'MLA1', clave: 'componentes' }, { id_externo: 'MLA2', clave: 'bicicletas' }]);
  });
  it('varias categorías al mismo nodo entran todas (absorción muchos a uno)', async () => {
    await admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, nombre)
      VALUES ($1, $2, 'mercadolibre', 'MLA3', 'Cadenas')`, [empresa, ml]);
    expect(await aplicar({ mapeo: { MLA1: 'transmision', MLA3: 'transmision' } })).toMatchObject({ quedaron: 2 });
  });
});

describe('E2-MAPCAN-02 lo que frena', () => {
  it('una cuenta de otro canal', async () => {
    await expect(aplicar({ cuenta: woo })).rejects.toThrow(/es de woocommerce/);
  });
  it('una cuenta de otra empresa', async () => {
    const otra = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
    await expect(aplicar({ empresa: otra })).rejects.toThrow(/no es de la empresa/);
  });
  it('una categoría que no está vigente, sin escribir las otras', async () => {
    await expect(aplicar({ mapeo: { ...MAPEO, MLA999: 'transmision' } })).rejects.toThrow(/MLA999/);
    expect(await vigentes()).toEqual([]);
  });
  it('un nodo que no existe: no elige el parecido', async () => {
    await expect(aplicar({ mapeo: { MLA1: 'transmisions' } })).rejects.toThrow(/transmisions/);
    expect(await vigentes()).toEqual([]);
  });
  it('una escritura que no deja rastro se detecta por lo que quedó, no por las llamadas', async () => {
    // Es el defecto de la carga de Woo: 78 llamadas exitosas, 58 filas. Acá cada llamada «anda» y no escribe nada.
    await expect(aplicar({ mapear: async () => undefined })).rejects.toThrow(/quedaron 0 mapeos/);
  });
  it('un mapeo vacío', async () => {
    await expect(aplicar({ mapeo: {} })).rejects.toThrow(/vacío/);
  });
});
