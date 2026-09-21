/*
 * test/catalogo/infantiles.test.ts — D16: BICICLETAS INFANTILES deja de ser nodo y pasa a la faceta `publico = infantil`.
 * Lo que importa es que sea atómico y que no se pierda el dato «es infantil».
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ARBOL_FUSIONBIKES } from '../../src/catalogo/arbol-fusionbikes.ts';
import { importarCategoriasCanal } from '../../src/catalogo/categorias-canal.ts';
import { aplicarD16 } from '../../src/catalogo/infantiles.ts';
import { crearVersion, escribirArbol, mapearCategoria, publicarVersion } from '../../src/catalogo/taxonomia.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const PUBLICAR = fileURLToPath(new URL('../../../scripts/catalogo-arbol-publicar.mjs', import.meta.url));
let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let woo: string;
let niños: string; let sinEdad: string; let adultos: string; let ambos: string; let otraCategoria: string;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});

async function modelo(titulo: string, categoria: string, edad: string[] = [], archivado = false, repArchivada = false) {
  const m = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo, archivado_en, motivo_archivo)
     VALUES ($1, $2, 'woo_simple', $3, $4, $5, $6) RETURNING id`,
    [empresa, woo, randomUUID(), titulo, archivado ? new Date() : null, archivado ? 'test' : null])).rows[0]!.id;
  const v = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id`, [empresa, m])).rows[0]!.id;
  const rep = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, recurso, tipo, variant_id)
     VALUES ($1, $2, 'woocommerce', $3, 'vendible', $4) RETURNING id`, [empresa, woo, randomUUID(), v])).rows[0]!.id;
  if (repArchivada) await admin.query(`UPDATE catalog.external_representations SET archivado_en = now(), motivo_archivo = 'test' WHERE id = $1`, [rep]);
  for (const [n, val] of [['categoria_canal', categoria], ...edad.map((e) => ['edad', e])]) {
    await admin.query(`INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
      VALUES ($1, $2, $3, $4, now())`, [m, rep, n, val]);
  }
  return m;
}

beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.model_facets, catalog.channel_categories, catalog.taxonomy_channel_map, catalog.model_categories,
    catalog.taxonomy_node_versions, catalog.taxonomy_versions, catalog.taxonomy_nodes, catalog.model_attributes,
    catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  woo = (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'woocommerce', $2) RETURNING id`,
    [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
  await importarCategoriasCanal(app, { listar: async () => [
    { id: 62, parent: 0, name: 'BICICLETAS POR MARCA' }, { id: 1538, parent: 62, name: 'BICICLETAS INFANTILES' },
  ] }, { companyId: empresa, channelAccountId: woo, canal: 'woocommerce' });
  // Estado de producción antes de D16: versión vigente con el nodo `infantiles`, y 1538 mapeada a él.
  await enTransaccion(app, async (tx) => {
    const v = await crearVersion(tx, empresa, 'v anterior');
    const c = await escribirArbol(tx, empresa, v.id, [...ARBOL_FUSIONBIKES, { clave: 'infantiles', nombre: 'BICICLETAS INFANTILES', padre: 'bicicletas' }]);
    await publicarVersion(tx, empresa, v.id);
    await mapearCategoria(tx, empresa, c.get('infantiles')!, woo, 'woocommerce', '1538', 'test');
  });
  niños = await modelo('Bici Niño', 'BICICLETAS INFANTILES', ['Niños']);
  sinEdad = await modelo('Bici sin dato', 'BICICLETAS INFANTILES');
  adultos = await modelo('Bici Twitter', 'BICICLETAS INFANTILES', ['Adultos']);
  ambos = await modelo('Bici Venzo Loki', 'BICICLETAS INFANTILES', ['Adultos', 'Niños']);
  otraCategoria = await modelo('Bici Trek', 'BICICLETAS TREK', ['Niños']);
  await modelo('Bici archivada', 'BICICLETAS INFANTILES', [], true);
  await modelo('Bici con publicación archivada', 'BICICLETAS INFANTILES', [], false, true);
});

const aplicar = (over: Partial<Parameters<typeof aplicarD16>[1]> = {}) =>
  enTransaccion(app, (tx) => aplicarD16(tx, { empresa, cuentaWoo: woo, decididoPor: 'jose', dryRun: false, ...over }));
const versiones = async () => (await admin.query<{ numero: number; estado: string }>(
  `SELECT numero, estado FROM catalog.taxonomy_versions WHERE company_id = $1 ORDER BY numero`, [empresa])).rows;
const facetas = async () => (await admin.query<{ model_id: string; valor: string; origen: string; motivo: string }>(
  `SELECT model_id, valor, origen, motivo FROM catalog.model_facets WHERE faceta = 'publico' AND vigente_hasta IS NULL`)).rows;
const nodoDe1538 = async () => (await admin.query<{ clave: string }>(
  `SELECT n.clave FROM catalog.taxonomy_channel_map m JOIN catalog.taxonomy_nodes n ON n.id = m.node_id
    WHERE m.channel_account_id = $1 AND m.id_externo = '1538' AND m.vigente_hasta IS NULL`, [woo])).rows.map((r) => r.clave);

describe('E2-D16-01 qué modelos reciben la faceta', () => {
  it('sólo los que la edad observada no contradice; los «Adultos» se devuelven para decidir a mano', async () => {
    const seco = await aplicar({ dryRun: true });
    expect(seco.modelosEnLaCategoria).toBe(4);           // el archivado y el de otra categoría no cuentan
    expect(seco.conFaceta.map((m) => m.modelo).sort()).toEqual([niños, sinEdad].sort());
    expect(seco.contradictorios.map((m) => m.titulo).sort()).toEqual(['Bici Twitter', 'Bici Venzo Loki']);
    expect(seco.contradictorios.find((m) => m.modelo === ambos)!.edad).toEqual(['Adultos', 'Niños']);
    expect(await versiones()).toEqual([{ numero: 1, estado: 'vigente' }]);   // el dry-run no escribe nada
    expect(await facetas()).toEqual([]);
    expect(await nodoDe1538()).toEqual(['infantiles']);
  });
});

describe('E2-D16-02 aplicar', () => {
  it('deja la versión nueva en borrador con el nodo ARCHIVADO (no borrado ni ausente), 1538 remapeada y la faceta escrita', async () => {
    const r = await aplicar();
    expect(r.facetasQuedaron).toBe(2);
    expect(r.remapeada).toBe(true);
    expect(r.nodosActivos).toBe(ARBOL_FUSIONBIKES.length);
    expect(r.nodosArchivados).toBe(1);
    expect(await versiones()).toEqual([{ numero: 1, estado: 'vigente' }, { numero: 2, estado: 'borrador' }]); // la vigente no cambia sola
    const nodo = (await admin.query<{ archivado: boolean; nombre: string }>(
      `SELECT nv.archivado, nv.nombre FROM catalog.taxonomy_node_versions nv JOIN catalog.taxonomy_nodes n ON n.id = nv.node_id
        JOIN catalog.taxonomy_versions v ON v.id = nv.version_id WHERE n.clave = 'infantiles' AND v.numero = 2`)).rows;
    expect(nodo).toEqual([{ archivado: true, nombre: 'BICICLETAS INFANTILES' }]);
    expect((await admin.query(`SELECT 1 FROM catalog.taxonomy_nodes WHERE clave = 'infantiles'`)).rowCount).toBe(1);
    expect(await nodoDe1538()).toEqual(['bicicletas']);
    const f = await facetas();
    expect(f.map((x) => x.model_id).sort()).toEqual([niños, sinEdad].sort());
    expect(f.every((x) => x.valor === 'infantil' && x.origen === 'regla_categoria' && x.motivo.includes('1538'))).toBe(true);
    // Ninguno de los contradictorios ni el de otra categoría tiene faceta.
    expect(f.some((x) => [adultos, ambos, otraCategoria].includes(x.model_id))).toBe(false);
  });

  it('es atómico: si falla la escritura de una faceta no queda NINGÚN cambio (ni versión, ni remapeo, ni facetas)', async () => {
    let n = 0;
    await expect(aplicar({ escribir: async () => { if (++n === 2) throw new Error('falla a propósito'); return true; } }))
      .rejects.toThrow(/falla a propósito/);
    expect(await versiones()).toEqual([{ numero: 1, estado: 'vigente' }]);
    expect(await nodoDe1538()).toEqual(['infantiles']);
    expect(await facetas()).toEqual([]);
    expect((await admin.query(`SELECT 1 FROM catalog.taxonomy_node_versions nv JOIN catalog.taxonomy_versions v ON v.id = nv.version_id WHERE v.numero = 2`)).rowCount).toBe(0);
  });

  it('una faceta que no deja rastro se detecta por lo que quedó y deshace todo', async () => {
    await expect(aplicar({ escribir: async () => true })).rejects.toThrow(/quedaron 0 facetas/);
    expect(await versiones()).toEqual([{ numero: 1, estado: 'vigente' }]);
    expect(await nodoDe1538()).toEqual(['infantiles']);
  });

  it('no se aplica dos veces', async () => {
    await aplicar();
    await expect(aplicar()).rejects.toThrow(/ya se aplicó/);
    expect(await versiones()).toHaveLength(2);
  });

  it('frena si 1538 no es la categoría esperada o la cuenta no es de Woo', async () => {
    await admin.query(`UPDATE catalog.channel_categories SET nombre = 'OTRA COSA' WHERE id_externo = '1538'`);
    await expect(aplicar()).rejects.toThrow(/no es «BICICLETAS INFANTILES»/);
    const ml = (await admin.query<{ id: string }>(
      `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'mercadolibre', 'x') RETURNING id`, [empresa])).rows[0]!.id;
    await expect(aplicar({ cuentaWoo: ml })).rejects.toThrow(/es de mercadolibre/);
  });
});

describe('E2-D16-03 el motivo de que sea una faceta y no un atributo', () => {
  it('la consulta de ingestión que cierra lo no repetido cierra el atributo observado, y la faceta sigue vigente', async () => {
    await aplicar();
    const rep = (await admin.query<{ representation_id: string }>(
      `SELECT representation_id FROM catalog.model_attributes WHERE model_id = $1 AND nombre_normalizado = 'categoria_canal'`, [niños])).rows[0]!.representation_id;
    // Es la consulta de `persistirExtras` cuando el canal ya no informa nada de esa publicación.
    await admin.query(
      `UPDATE catalog.model_attributes m SET vigente_hasta = now()
        WHERE m.representation_id = $1 AND m.vigente_hasta IS NULL
          AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS u(n, v) WHERE u.n = m.nombre_normalizado AND u.v = m.valor)`,
      [rep, [], []]);
    expect((await admin.query(`SELECT 1 FROM catalog.model_attributes WHERE model_id = $1 AND vigente_hasta IS NULL`, [niños])).rowCount).toBe(0);
    expect((await facetas()).map((x) => x.model_id)).toContain(niños);
  });
});

describe('E2-D16-04 publicar la versión nueva', () => {
  const publicar = (version: string, extra: string[] = []) => {
    const p = new URL(base.urlApp);
    return spawnSync(process.execPath, [PUBLICAR, '--empresa', empresa, '--version', version, ...extra], { encoding: 'utf8', env: {
      PATH: process.env.PATH ?? '', PG_HOST: p.hostname, PG_PORT: p.port, PG_DATABASE: p.pathname.slice(1),
      PG_USER: p.username, PG_PASSWORD: p.password } });
  };
  it('el publicador la acepta (1538 ya no apunta al nodo archivado) y la deja vigente', async () => {
    const r = await aplicar();
    expect(publicar(r.version!.id, ['--ejecutar']).status).toBe(0);
    expect(await versiones()).toEqual([{ numero: 1, estado: 'reemplazada' }, { numero: 2, estado: 'vigente' }]);
  });
  it('y la rechaza si 1538 volviera a apuntar al nodo archivado', async () => {
    const r = await aplicar();
    const infantiles = (await admin.query<{ id: string }>(`SELECT id FROM catalog.taxonomy_nodes WHERE clave = 'infantiles'`)).rows[0]!.id;
    await enTransaccion(app, (tx) => mapearCategoria(tx, empresa, infantiles, woo, 'woocommerce', '1538', 'test'));
    const p = publicar(r.version!.id);
    expect(p.status).toBe(1);
    expect(p.stderr).toMatch(/apuntan a nodos ausentes/);
  });
});
