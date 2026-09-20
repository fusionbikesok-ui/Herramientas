/*
 * test/catalogo/informe-granularidad.test.ts — el desglose de los modelos publicados en ambos canales en
 * tres clases: relacionados por nombre, compatibles por granularidad (ancestros) y contradicción real.
 * Datos armados a mano. Es un criterio PUENTE hasta que ambas jerarquías mapeen al árbol propio.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importarCategoriasCanal } from '../../src/catalogo/categorias-canal.ts';
import { ancestrosDe, generarInforme } from '../../src/catalogo/informe-taxonomia.ts';
import { crearPool } from '../../src/db/pool.ts';
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
    catalog.sellable_variants, catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  cuentaWoo = await cuenta('woocommerce'); cuentaMl = await cuenta('mercadolibre');
});

const WOO = [
  { id: 1472, parent: 0, name: 'TRANSMISIÓN' }, { id: 135, parent: 1472, name: 'SHIFTERS' },
  { id: 1477, parent: 0, name: 'Cubiertas y Cámaras' }, { id: 119, parent: 1477, name: 'CUBIERTAS' },
  { id: 900, parent: 0, name: 'ACCESORIOS DE SEGURIDAD' }, { id: 205, parent: 900, name: 'CASCOS' },
];
const ML = [
  { id: 'MLA20', parent: 0, name: 'Transmisión y Cambios' }, { id: 'MLA21', parent: 'MLA20', name: 'Cadenas' },
  { id: 'MLA22', parent: 0, name: 'Transmisión' }, { id: 'MLA30', parent: 0, name: 'Cubiertas' },
  { id: 'MLA40', parent: 0, name: 'Accesorios de Seguridad' }, { id: 'MLA41', parent: 'MLA40', name: 'Luces' },
  // Ciclo de datos del canal: no puede colgar el informe.
  { id: 'MLA50', parent: 'MLA51', name: 'Ciclo Uno' }, { id: 'MLA51', parent: 'MLA50', name: 'Ciclo Dos' },
];

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

describe('E2-GRAN-01 tres clases sobre los modelos en ambos canales', () => {
  it('cada clase con su caso, la suma cierra y la muestra sale ordenada', async () => {
    await importarCategoriasCanal(app, { listar: async () => WOO }, { companyId: empresa, channelAccountId: cuentaWoo, canal: 'woocommerce' });
    await importarCategoriasCanal(app, { listar: async () => ML }, { companyId: empresa, channelAccountId: cuentaMl, canal: 'mercadolibre' });

    await modelo(['119'], ['MLA30']);           // clase 2: CUBIERTAS ~ Cubiertas, por nombre
    await modelo(['1472'], ['MLA21']);          // clase 1: TRANSMISIÓN vs Cadenas, cuyo ancestro es «Transmisión y Cambios»
    await modelo(['135'], ['MLA22']);           // clase 1 al revés: el ancestro (TRANSMISIÓN) es del lado de Woo
    await modelo(['205', '1472'], ['MLA21']);   // clase 1 con VARIAS categorías: basta que UNA contra UNA cumpla
    await modelo(['205'], ['MLA41']);           // clase 3: ancestros «Accesorios de Seguridad» en ambos lados, pero ninguna categoría contra cadena
    await modelo(['205'], ['MLA41']);           // clase 3 (mismo par: cuenta 2)
    await modelo(['205'], ['MLA21']);           // clase 3
    await modelo(['205'], ['MLA50']);           // clase 3, con cadena cíclica: termina y se marca incompleta
    await modelo(['205'], []);                  // sólo Woo: no entra en ninguna clase

    const c = (await generarInforme(app, empresa, cuentaWoo)).cobertura;
    expect(c.entreCanales).toBe(8);
    expect(c.relacionadosPorNombre).toBe(1);
    expect(c.compatiblesPorGranularidad).toBe(3);
    expect(c.contradiccionesReales).toBe(4);
    // La aritmética: las tres clases son excluyentes y suman exacto los modelos en ambos canales.
    expect(c.relacionadosPorNombre + c.compatiblesPorGranularidad + c.contradiccionesReales).toBe(c.entreCanales);
    // Y el campo que ya existía conserva su significado: todo lo que NO se relaciona por nombre.
    expect(c.contradictoriosEntreCanales).toBe(7);
    expect(c.cadenasIncompletas).toBeGreaterThanOrEqual(1);
    expect(c.muestraContradicciones).toEqual([
      { woo: 'CASCOS', ml: 'Luces', modelos: 2 },
      { woo: 'CASCOS', ml: 'Cadenas', modelos: 1 },
      { woo: 'CASCOS', ml: 'Ciclo Uno', modelos: 1 },
    ]);
  });
});

describe('E2-GRAN-02 ancestrosDe: los datos del canal no son de fiar', () => {
  const t = (filas: Array<[string, string | null, string]>) =>
    new Map(filas.map(([id, parent, nombre]) => [id, { parent, nombre }]));
  it('sube hasta la raíz y no incluye a la propia categoría', () => {
    expect(ancestrosDe('c', t([['a', null, 'A'], ['b', 'a', 'B'], ['c', 'b', 'C']]))).toEqual({ nombres: ['B', 'A'], incompleta: false });
  });
  it('un ciclo termina y se marca incompleto', () => {
    expect(ancestrosDe('a', t([['a', 'b', 'A'], ['b', 'a', 'B']]))).toEqual({ nombres: ['B'], incompleta: true });
  });
  it('un padre inexistente corta la cadena y se marca incompleta', () => {
    expect(ancestrosDe('b', t([['b', 'zzz', 'B']]))).toEqual({ nombres: [], incompleta: true });
  });
  it('respeta el tope de saltos', () => {
    const filas: Array<[string, string | null, string]> = [['n0', null, 'N0']];
    for (let i = 1; i <= 40; i++) filas.push([`n${i}`, `n${i - 1}`, `N${i}`]);
    const r = ancestrosDe('n40', t(filas), 5);
    expect(r.nombres.length).toBe(5);
    expect(r.incompleta).toBe(true);
  });
});
