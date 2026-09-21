/*
 * test/catalogo/publicar-arbol.test.ts — el publicador (scripts/catalogo-arbol-publicar.mjs) tiene que RECHAZAR una
 * versión si algún mapeo vigente apunta a un nodo que esa versión no tiene o tiene archivado. Es el chequeo del que
 * depende D16 (se archiva un nodo que hoy está mapeado): si no rechaza, no sirve, y esto lo prueba corriendo el
 * script de verdad contra una base de prueba.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importarCategoriasCanal } from '../../src/catalogo/categorias-canal.ts';
import { crearVersion, escribirArbol, mapearCategoria, publicarVersion } from '../../src/catalogo/taxonomia.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const SCRIPT = fileURLToPath(new URL('../../../scripts/catalogo-arbol-publicar.mjs', import.meta.url));
let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let woo: string; let claves: Map<string, string>;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});
beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.channel_categories, catalog.taxonomy_channel_map, catalog.model_categories,
    catalog.taxonomy_node_versions, catalog.taxonomy_versions, catalog.taxonomy_nodes CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  woo = (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, 'woocommerce', $2) RETURNING id`,
    [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
  await importarCategoriasCanal(app, { listar: async () => [
    { id: 62, parent: 0, name: 'BICICLETAS POR MARCA' }, { id: 1538, parent: 62, name: 'BICICLETAS INFANTILES' },
  ] }, { companyId: empresa, channelAccountId: woo, canal: 'woocommerce' });
  // Versión 2 vigente, con el nodo `infantiles`, y la categoría 1538 mapeada a él.
  claves = await enTransaccion(app, async (tx) => {
    const v = await crearVersion(tx, empresa, 'v2');
    const c = await escribirArbol(tx, empresa, v.id, [
      { clave: 'bicicletas', nombre: 'BICICLETAS POR MARCA', padre: null },
      { clave: 'infantiles', nombre: 'BICICLETAS INFANTILES', padre: 'bicicletas' },
    ]);
    await publicarVersion(tx, empresa, v.id);
    await mapearCategoria(tx, empresa, c.get('bicicletas')!, woo, 'woocommerce', '62', 'test');
    await mapearCategoria(tx, empresa, c.get('infantiles')!, woo, 'woocommerce', '1538', 'test');
    return c;
  });
});

const publicar = (version: string, extra: string[] = []) => {
  const p = new URL(base.urlApp);
  return spawnSync(process.execPath, [SCRIPT, '--empresa', empresa, '--version', version, ...extra], { encoding: 'utf8', env: {
    PATH: process.env.PATH ?? '', PG_HOST: p.hostname, PG_PORT: p.port, PG_DATABASE: p.pathname.slice(1),
    PG_USER: p.username, PG_PASSWORD: p.password } });
};
const borradorV3 = (archivarInfantiles: boolean) => enTransaccion(app, async (tx) => {
  const v = await crearVersion(tx, empresa, 'v3');
  await escribirArbol(tx, empresa, v.id, archivarInfantiles
    ? [{ clave: 'bicicletas', nombre: 'BICICLETAS POR MARCA', padre: null }, { clave: 'infantiles', nombre: 'BICICLETAS INFANTILES', padre: 'bicicletas' }]
    : [{ clave: 'bicicletas', nombre: 'BICICLETAS POR MARCA', padre: null }]);
  if (archivarInfantiles) {
    await tx.query(`UPDATE catalog.taxonomy_node_versions SET archivado = true WHERE version_id = $1 AND node_id = $2`,
      [v.id, claves.get('infantiles')]);
  }
  return v.id;
});
const vigente = async () => (await admin.query<{ numero: number }>(
  `SELECT numero FROM catalog.taxonomy_versions WHERE company_id = $1 AND estado = 'vigente'`, [empresa])).rows.map((r) => r.numero);

describe('E2-PUB-01 el publicador rechaza una versión que deja un mapeo apuntando a un nodo que ya no tiene', () => {
  it.each([false, true])('si 1538 sigue mapeada a `infantiles` (nodo %s archivado explícito), no la publica', async (archivado) => {
    const v3 = await borradorV3(archivado);
    for (const extra of [[], ['--ejecutar']]) {
      const r = publicar(v3, extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/apuntan a nodos ausentes/);
    }
    expect(await vigente()).toEqual([1]); // la v2 sigue siendo la vigente
  });

  it('con 1538 remapeada a `bicicletas` sí la acepta, y sólo con --ejecutar cambia la vigente', async () => {
    const v3 = await borradorV3(true);
    await enTransaccion(app, (tx) => mapearCategoria(tx, empresa, claves.get('bicicletas')!, woo, 'woocommerce', '1538', 'test'));
    const seco = publicar(v3);
    expect(seco.status).toBe(0);
    expect(await vigente()).toEqual([1]);
    expect(publicar(v3, ['--ejecutar']).status).toBe(0);
    expect(await vigente()).toEqual([2]);
  });
});
