/*
 * test/catalogo/informe-nodos.test.ts — comparación EXACTA entre canales por nodo del árbol propio (versión
 * vigente). Datos armados a mano. Woo guarda el NOMBRE de la categoría y ML su id, como el canal.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importarCategoriasCanal } from '../../src/catalogo/categorias-canal.ts';
import { generarInforme } from '../../src/catalogo/informe-taxonomia.ts';
import { crearVersion, escribirArbol, mapearCategoria, publicarVersion } from '../../src/catalogo/taxonomia.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let cuentaWoo: string; let cuentaMl: string;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});
beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.channel_categories, catalog.model_attributes, catalog.external_representations,
    catalog.sellable_variants, catalog.product_models, catalog.taxonomy_channel_map, catalog.model_categories,
    catalog.taxonomy_node_versions, catalog.taxonomy_versions, catalog.taxonomy_nodes CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  cuentaWoo = await cuenta('woocommerce'); cuentaMl = await cuenta('mercadolibre');
  await importarCategoriasCanal(app, { listar: async () => [
    { id: 62, parent: 0, name: 'BICICLETAS POR MARCA' }, { id: 142, parent: 62, name: 'BICICLETAS VOLTA' },
    { id: 114, parent: 0, name: 'LUBRICANTES' }, { id: 115, parent: 0, name: 'GRASAS' },
    { id: 300, parent: 0, name: 'OTRAS' }, { id: 301, parent: 0, name: 'ARCHIVADA' },
    { id: 302, parent: 0, name: 'HIJO' }, { id: 303, parent: 0, name: 'CASCOS' },
  ] }, { companyId: empresa, channelAccountId: cuentaWoo, canal: 'woocommerce' });
  await importarCategoriasCanal(app, { listar: async () => [
    { id: 'MLA1', parent: 0, name: 'Bicicletas Convencionales' }, { id: 'MLA2', parent: 0, name: 'Lubricantes' },
    { id: 'MLA3', parent: 0, name: 'Cascos' }, { id: 'MLA5', parent: 0, name: 'Bici Volta' },
  ] }, { companyId: empresa, channelAccountId: cuentaMl, canal: 'mercadolibre' });
});

/** Publica un árbol: bicicletas > volta; taller > lubricantes, grasas; y un nodo ARCHIVADO con un hijo colgando. */
async function publicarArbol(publicar = true) {
  return enTransaccion(app, async (tx) => {
    const v = await crearVersion(tx, empresa, 'test');
    const claves = await escribirArbol(tx, empresa, v.id, [
      { clave: 'bicicletas', nombre: 'BICICLETAS POR MARCA', padre: null },
      { clave: 'volta', nombre: 'VOLTA', padre: 'bicicletas' },
      { clave: 'taller', nombre: 'TALLER', padre: null },
      { clave: 'lubricantes', nombre: 'LUBRICANTES', padre: 'taller' },
      { clave: 'grasas', nombre: 'GRASAS', padre: 'taller' },
      { clave: 'obsoleto', nombre: 'OBSOLETO', padre: 'bicicletas' },
      { clave: 'hijo', nombre: 'HIJO DE OBSOLETO', padre: 'obsoleto' },
    ]);
    if (publicar) {
      await tx.query(`UPDATE catalog.taxonomy_node_versions SET archivado = true WHERE version_id = $1 AND node_id = $2`,
        [v.id, claves.get('obsoleto')]);
      await publicarVersion(tx, empresa, v.id);
    }
    const mapa = async (cuenta: string, canal: 'woocommerce' | 'mercadolibre', ids: Record<string, string>) => {
      for (const [id, clave] of Object.entries(ids)) await mapearCategoria(tx, empresa, claves.get(clave)!, cuenta, canal, id, 'test');
    };
    await mapa(cuentaWoo, 'woocommerce', { 62: 'bicicletas', 142: 'volta', 114: 'lubricantes', 115: 'grasas', 301: 'obsoleto', 302: 'hijo' });
    await mapa(cuentaMl, 'mercadolibre', { MLA1: 'bicicletas', MLA2: 'lubricantes', MLA5: 'volta' });
  });
}

async function modelo(woo: string[], ml: string[]) {
  const m = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, 'woo_simple', $3, 'm') RETURNING id`, [empresa, cuentaWoo, randomUUID()])).rows[0]!.id;
  for (const [canal, cuenta, valores] of [['woocommerce', cuentaWoo, woo], ['mercadolibre', cuentaMl, ml]] as const) {
    for (const valor of valores) {
      const v = (await admin.query<{ id: string }>(
        `INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id`, [empresa, m])).rows[0]!.id;
      const rep = (await admin.query<{ id: string }>(
        `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, recurso, tipo, variant_id)
         VALUES ($1,$2,$3,$4,'vendible',$5) RETURNING id`, [empresa, cuenta, canal, randomUUID(), v])).rows[0]!.id;
      await admin.query(
        `INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
         VALUES ($1, $2, 'categoria_canal', $3, now())`, [m, rep, valor]);
    }
  }
}

async function poblar() {
  await modelo(['BICICLETAS VOLTA'], ['MLA1']);              // ML (raíz) es ANCESTRO del nodo de Woo: acuerdo
  await modelo(['BICICLETAS POR MARCA'], ['MLA5']);          // Woo (raíz) es ancestro del nodo de ML: acuerdo, al revés
  await modelo(['LUBRICANTES'], ['MLA2']);                   // mismo nodo
  await modelo(['GRASAS'], ['MLA2']);                        // HERMANOS bajo taller: NO es acuerdo
  await modelo(['GRASAS'], ['MLA2']);
  await modelo(['OTRAS'], ['MLA2']);                         // Woo sin mapear: sin nodo → puente (contradicción)
  await modelo(['LUBRICANTES'], ['MLA3']);                   // ML sin mapear: sin nodo → puente (contradicción)
  await modelo(['CASCOS'], ['MLA3']);                        // sin nodo en ambos: el puente sí los relaciona por nombre
  await modelo(['ARCHIVADA'], ['MLA1']);                     // mapeada a un nodo ARCHIVADO: no tiene nodo → puente
  await modelo(['HIJO'], ['MLA1']);                          // el padre del nodo está archivado: no es ancestro de nada
  await modelo(['OTRAS', 'LUBRICANTES'], ['MLA2']);          // varias categorías: alguna contra alguna → mismo nodo
  await modelo(['LUBRICANTES'], []);                         // sólo Woo: no cuenta
}

describe('E2-NODO-01 comparación exacta por nodo', () => {
  it('cada clase con su caso, hermanos no es acuerdo, y todo suma entreCanales', async () => {
    await publicarArbol();
    await poblar();
    const c = (await generarInforme(app, empresa, cuentaWoo)).cobertura;
    expect(c.versionTaxonomia).not.toBeNull();
    expect(c.entreCanales).toBe(11);
    expect(c.mismoNodo).toBe(2);
    expect(c.unoAncestroDelOtro).toBe(2);
    expect(c.nodosDistintos).toBe(3);        // GRASAS×2 (hermanos) + HIJO (padre archivado)
    expect(c.sinNodoEnAlgunCanal).toBe(4);
    expect(c.mismoNodo + c.unoAncestroDelOtro + c.nodosDistintos + c.sinNodoEnAlgunCanal).toBe(c.entreCanales);
    expect(c.muestraNodosDistintos).toEqual([
      { woo: 'GRASAS', ml: 'LUBRICANTES', modelos: 2 },
      { woo: 'HIJO DE OBSOLETO', ml: 'BICICLETAS POR MARCA', modelos: 1 },
    ]);
  });

  it('el puente de nombres se usa SÓLO para los modelos sin nodo en algún canal', async () => {
    await publicarArbol();
    await poblar();
    const c = (await generarInforme(app, empresa, cuentaWoo)).cobertura;
    // Los 4 sin nodo: CASCOS~Cascos por nombre; los otros tres, sin relación. Los 7 con nodo ya no pasan por acá
    // (GRASAS~Lubricantes NO se re-evalúa por nombre: es una diferencia real y no debe rescatarla el puente).
    expect(c.puente.relacionadosPorNombre).toBe(1);
    expect(c.puente.contradiccionesReales).toBe(3);
    expect(c.puente.compatiblesPorGranularidad).toBe(0);
    expect(c.puente.relacionadosPorNombre + c.puente.compatiblesPorGranularidad + c.puente.contradiccionesReales).toBe(c.sinNodoEnAlgunCanal);
    expect('contradictoriosEntreCanales' in c).toBe(false); // el campo ambiguo ya no existe
  });

  it('sin versión vigente no inventa nada: las clases por nodo en 0 y todo va al puente', async () => {
    await publicarArbol(false); // queda en borrador
    await poblar();
    const c = (await generarInforme(app, empresa, cuentaWoo)).cobertura;
    expect(c.versionTaxonomia).toBeNull();
    expect([c.mismoNodo, c.unoAncestroDelOtro, c.nodosDistintos]).toEqual([0, 0, 0]);
    expect(c.sinNodoEnAlgunCanal).toBe(c.entreCanales);
    expect(c.puente.relacionadosPorNombre + c.puente.compatiblesPorGranularidad + c.puente.contradiccionesReales).toBe(c.entreCanales);
  });
});
