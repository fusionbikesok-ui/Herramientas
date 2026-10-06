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
  await admin.query(`TRUNCATE catalog.channel_categories, catalog.taxonomy_channel_map, catalog.channel_category_sin_equivalencia, catalog.model_categories,
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
    expect(await aplicar({ dryRun: true })).toMatchObject({ total: 2, nuevos: 2, iguales: 0, cambiados: 0, quedaron: null });
    expect(await vigentes()).toEqual([]);
    expect(await aplicar()).toMatchObject({ total: 2, nuevos: 2, iguales: 0, cambiados: 0, quedaron: 2 });
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

describe('E2-MAPCAN-03 categorías sin equivalencia, con motivo en la base', () => {
  const SIN = { MLA3: 'Otros: balde que no nombra una categoría' };
  const cat3 = () => admin.query(`INSERT INTO catalog.channel_categories (company_id, channel_account_id, canal, id_externo, nombre)
    VALUES ($1, $2, 'mercadolibre', 'MLA3', 'Otros Repuestos')`, [empresa, ml]);
  const decisiones = async () => (await admin.query(
    `SELECT id_externo, motivo, decidido_por FROM catalog.channel_category_sin_equivalencia
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL ORDER BY 1`, [ml])).rows;

  it('queda escrita con su motivo, y no como mapeo a ningún nodo', async () => {
    await cat3();
    expect(await aplicar({ sinEquivalencia: SIN, dryRun: true })).toMatchObject({ sinEquivalencia: { total: 1, nuevas: 1, quedaron: null } });
    expect(await decisiones()).toEqual([]);
    expect((await aplicar({ sinEquivalencia: SIN })).sinEquivalencia).toEqual({ total: 1, nuevas: 1, iguales: 0, cambiadas: 0, quedaron: 1 });
    expect(await decisiones()).toEqual([{ id_externo: 'MLA3', motivo: SIN.MLA3, decidido_por: 'jose' }]);
    expect((await vigentes()).map((v) => v.id_externo)).not.toContain('MLA3');
  });
  it('es idempotente y un motivo distinto cierra la decisión anterior y deja la historia', async () => {
    await cat3();
    await aplicar({ sinEquivalencia: SIN });
    expect((await aplicar({ sinEquivalencia: SIN })).sinEquivalencia).toMatchObject({ iguales: 1, nuevas: 0, quedaron: 1 });
    expect((await aplicar({ sinEquivalencia: { MLA3: 'Otro motivo, más claro que el anterior' } })).sinEquivalencia).toMatchObject({ cambiadas: 1, quedaron: 1 });
    expect((await decisiones()).map((d) => d.motivo)).toEqual(['Otro motivo, más claro que el anterior']);
    expect((await admin.query(`SELECT count(*)::int AS n FROM catalog.channel_category_sin_equivalencia`)).rows[0].n).toBe(2);
  });
  it('no puede estar a la vez mapeada y sin equivalencia, ni sin motivo, ni no vigente', async () => {
    await cat3();
    await expect(aplicar({ sinEquivalencia: { MLA1: 'x motivo' } })).rejects.toThrow(/en el mapeo y también sin equivalencia/);
    await expect(aplicar({ sinEquivalencia: { MLA3: '   ' } })).rejects.toThrow(/sin motivo/);
    await expect(aplicar({ sinEquivalencia: { MLA999: 'motivo' } })).rejects.toThrow(/MLA999/);
    expect(await decisiones()).toEqual([]);
  });
  it('mapeada → sin equivalencia se frena; sin equivalencia → mapeada cierra la decisión', async () => {
    await cat3();
    await aplicar({ mapeo: { ...MAPEO, MLA3: 'transmision' } });
    await expect(aplicar({ sinEquivalencia: SIN })).rejects.toThrow(/ya mapeadas/);
    await admin.query(`UPDATE catalog.taxonomy_channel_map SET vigente_hasta = now() WHERE channel_account_id = $1 AND id_externo = 'MLA3'`, [ml]);
    await aplicar({ sinEquivalencia: SIN });
    expect((await decisiones()).length).toBe(1);
    await aplicar({ mapeo: { ...MAPEO, MLA3: 'transmision' } });
    expect(await decisiones()).toEqual([]);
  });
  it('una decisión que no deja rastro se detecta por lo que quedó', async () => {
    await cat3();
    await admin.query(`CREATE OR REPLACE FUNCTION catalog.__descarta() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    await admin.query(`CREATE TRIGGER __descarta BEFORE INSERT ON catalog.channel_category_sin_equivalencia FOR EACH ROW EXECUTE FUNCTION catalog.__descarta()`);
    try {
      await expect(aplicar({ sinEquivalencia: SIN })).rejects.toThrow(/quedaron 0 decisiones/);
    } finally {
      await admin.query(`DROP TRIGGER __descarta ON catalog.channel_category_sin_equivalencia`);
      await admin.query(`DROP FUNCTION catalog.__descarta()`);
    }
  });
});
