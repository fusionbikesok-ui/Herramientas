/*
 * test/catalogo/informe-taxonomia.test.ts — E2 T3 tarea 3: el informe de candidatos, solapamientos y
 * cobertura. Fixture recortado de docs/superpowers/specs/e2/woo-categorias-2026-09-20.md.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importarCategoriasCanal } from '../../src/catalogo/categorias-canal.ts';
import {
  candidatosDesdeAtributo, clasificarCategorias, coleccionesConocidas, detectarSolapamientos,
  generarInforme, marcasConocidas,
} from '../../src/catalogo/informe-taxonomia.ts';
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
  await admin.query(`TRUNCATE catalog.channel_categories, catalog.collections, catalog.brand_aliases,
    catalog.brands, catalog.model_attributes, catalog.external_representations, catalog.sellable_variants,
    catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  cuentaWoo = await cuenta('woocommerce'); cuentaMl = await cuenta('mercadolibre');
});

// Recorte del fixture real: dos ramas emparentadas (CUBIERTAS/CAMARAS bajo "Cubiertas y Cámaras",
// LIQUIDOS DE FRENOS bajo LÍQUIDOS), una marca-categoría (BICICLETAS TREK, bajo el nodo contenedor
// BICICLETAS POR MARCA), una colección (Hotsale) y un rubro de taxonomía simple (CASCOS) para tener algo
// que no caiga en marca ni colección.
const FIXTURE_WOO = [
  { id: 1477, parent: 0, name: 'Cubiertas y Cámaras', slug: 'cubiertas-y-camaras', count: 90 },
  { id: 119, parent: 1477, name: 'CUBIERTAS', slug: 'cubiertas', count: 50 },
  { id: 126, parent: 1477, name: 'CAMARAS', slug: 'camaras', count: 25 },
  { id: 59, parent: 0, name: 'LÍQUIDOS', slug: 'liquidos', count: 45 },
  { id: 715, parent: 59, name: 'LIQUIDOS DE FRENOS', slug: 'liquidos-de-frenos', count: 6 },
  { id: 205, parent: 0, name: 'CASCOS', slug: 'cascos', count: 33 },
  { id: 62, parent: 0, name: 'BICICLETAS POR MARCA', slug: 'bicicletas-por-marca', count: 102 },
  { id: 1112, parent: 62, name: 'BICICLETAS TREK', slug: 'bicicletas-trek', count: 22 },
  { id: 746, parent: 0, name: 'Hotsale', slug: 'hotsale', count: 29 },
];

async function importarFixture() {
  await importarCategoriasCanal(app, { listar: async () => FIXTURE_WOO },
    { companyId: empresa, channelAccountId: cuentaWoo, canal: 'woocommerce' });
}

/** Agrega una representación (con su variante vendible) del modelo dado en el canal dado. */
async function representacion(canal: 'woocommerce' | 'mercadolibre', modelo: string) {
  const cuenta = canal === 'woocommerce' ? cuentaWoo : cuentaMl;
  const variante = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id`,
    [empresa, modelo])).rows[0]!.id;
  return (await admin.query<{ id: string }>(
    `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, recurso, tipo, variant_id)
     VALUES ($1,$2,$3,$4,'vendible',$5) RETURNING id`,
    [empresa, cuenta, canal, randomUUID(), variante])).rows[0]!.id;
}

/** Un modelo con un valor de `categoria_canal` (y opcionalmente `marca`) capturado como atributo, en un canal dado. */
async function modeloConCategoria(
  canal: 'woocommerce' | 'mercadolibre', categoria: string | null, opts: { marca?: string } = {},
) {
  const cuenta = canal === 'woocommerce' ? cuentaWoo : cuentaMl;
  const modelo = (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, $3, $4, 'm') RETURNING id`,
    [empresa, cuenta, canal === 'woocommerce' ? 'woo_simple' : 'ml_simple', randomUUID()])).rows[0]!.id;
  const rep = await representacion(canal, modelo);
  if (categoria !== null) {
    await admin.query(
      `INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
       VALUES ($1, $2, 'categoria_canal', $3, now())`, [modelo, rep, categoria]);
  }
  if (opts.marca) {
    await admin.query(
      `INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
       VALUES ($1, $2, 'marca', $3, now())`, [modelo, rep, opts.marca]);
  }
  return modelo;
}

describe('E2-INF-01 candidatos', () => {
  it('agrupa por nombre normalizado y cuenta modelos, con ejemplos de escritura', async () => {
    await modeloConCategoria('woocommerce', 'CUBIERTAS');
    await modeloConCategoria('woocommerce', 'Cubiertas');
    await modeloConCategoria('woocommerce', 'CASCOS');
    const c = await candidatosDesdeAtributo(app, empresa);
    const cubiertas = c.find((x) => x.ejemplos.includes('CUBIERTAS'));
    expect(cubiertas?.modelos).toBe(2);
    expect(cubiertas?.ejemplos).toEqual(expect.arrayContaining(['CUBIERTAS', 'Cubiertas']));
  });
});

describe('E2-INF-02 partición en tres grupos', () => {
  it('reproduce taxonomía / marca / colección sobre el fixture', async () => {
    await importarFixture();
    await modeloConCategoria('mercadolibre', null, { marca: 'Trek' });
    const marcas = await marcasConocidas(app, empresa);
    const colecciones = await coleccionesConocidas(app, empresa);
    const r = await generarInforme(app, empresa, cuentaWoo);

    expect(marcas.has('trek')).toBe(true);
    expect(colecciones.has('hotsale')).toBe(true);

    const grupos = Object.fromEntries(r.categoriasCanal.map((c) => [c.nombre, c.grupo]));
    expect(grupos['BICICLETAS TREK']).toBe('marca');
    expect(grupos['Hotsale']).toBe('coleccion');
    expect(grupos['CASCOS']).toBe('taxonomia');
    expect(grupos['CUBIERTAS']).toBe('taxonomia');
    expect(r.particion).toEqual({ taxonomia: 7, marca: 1, coleccion: 1 });
  });

  it('sin ninguna marca ni colección cargada, todo cae en taxonomía (default seguro)', async () => {
    await importarFixture();
    const r = await generarInforme(app, empresa, cuentaWoo);
    // Hotsale sigue cayendo en colección por la red de contención por nombre, aun sin catalog.collections.
    expect(r.particion.coleccion).toBe(1);
    expect(r.particion.marca).toBe(0);
  });
});

describe('E2-INF-03 solapamientos: emparentados vs sin emparentar', () => {
  it('CUBIERTAS/Cubiertas y Cámaras y LIQUIDOS DE FRENOS/LÍQUIDOS son padre-hijo: emparentados, nada que decidir', async () => {
    await importarFixture();
    const r = await generarInforme(app, empresa, cuentaWoo);
    const nombres = (s: { a: string; b: string }) => [s.a, s.b].sort().join(' / ');
    expect(r.solapamientos.emparentados.map(nombres)).toEqual(expect.arrayContaining([
      'CUBIERTAS / Cubiertas y Cámaras',
      'LIQUIDOS DE FRENOS / LÍQUIDOS',
    ]));
  });

  it('dos categorías parecidas pero sin relación de parentesco quedan sin emparentar', () => {
    // 'HERRAMIENTAS' y 'INFLADORES Y HERRAMIENTAS' están relacionadas por tokens (una contiene los tokens
    // de la otra), pero acá NINGUNA cuelga de la otra: son dos raíces sueltas, a diferencia del fixture real.
    const sueltas = [
      { idExterno: '122', parentExterno: null, nombre: 'HERRAMIENTAS', conteo: 49 },
      { idExterno: '900', parentExterno: null, nombre: 'INFLADORES Y HERRAMIENTAS', conteo: 3 },
    ];
    const s = detectarSolapamientos(sueltas);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ emparentado: false });
  });
});

describe('E2-INF-04 cobertura', () => {
  it('cuenta sin categoría útil, con varias candidatas, sólo marca/colección y contradicciones entre canales', async () => {
    await importarFixture();
    await modeloConCategoria('woocommerce', null); // sin categoría útil
    await modeloConCategoria('woocommerce', 'CUBIERTAS'); // una candidata, taxonomía
    const varias = await modeloConCategoria('woocommerce', 'CUBIERTAS');
    const rep2 = await representacion('woocommerce', varias);
    await admin.query(
      `INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
       VALUES ($1, $2, 'categoria_canal', 'CASCOS', now())`, [varias, rep2]);
    // soloMarcaOColeccion: su única categoria_canal es 'Hotsale', que cae en colección.
    await modeloConCategoria('woocommerce', 'Hotsale');

    const r = await generarInforme(app, empresa, cuentaWoo);
    expect(r.cobertura.totalModelos).toBe(4);
    expect(r.cobertura.sinCategoriaUtil).toBe(1);
    expect(r.cobertura.variasCandidatas).toBe(1);
    expect(r.cobertura.soloMarcaOColeccion).toBe(1);
  });

  it('contradicciones entre canales: mismo modelo con categoria_canal de Woo y de ML sin relación', async () => {
    await importarFixture();
    const modelo = await modeloConCategoria('woocommerce', 'CUBIERTAS');
    const rep = await representacion('mercadolibre', modelo);
    await admin.query(
      `INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
       VALUES ($1, $2, 'categoria_canal', 'CASCOS', now())`, [modelo, rep]);

    const r = await generarInforme(app, empresa, cuentaWoo);
    expect(r.cobertura.contradictoriosEntreCanales).toBe(1);
  });

  it('sin contradicción cuando los valores de los dos canales están relacionados por tokens', async () => {
    await importarFixture();
    const modelo = await modeloConCategoria('woocommerce', 'CUBIERTAS');
    const rep = await representacion('mercadolibre', modelo);
    await admin.query(
      `INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
       VALUES ($1, $2, 'categoria_canal', 'Cubiertas', now())`, [modelo, rep]);

    const r = await generarInforme(app, empresa, cuentaWoo);
    expect(r.cobertura.contradictoriosEntreCanales).toBe(0);
  });
});

describe('E2-INF-05 clasificarCategorias', () => {
  it('reconoce el patrón "BICICLETAS <marca>" del legado', () => {
    const r = clasificarCategorias(
      [{ idExterno: '1', parentExterno: null, nombre: 'BICICLETAS TREK', conteo: 1 }],
      new Set(['trek']), new Set());
    expect(r[0]).toMatchObject({ grupo: 'marca' });
  });
});

describe('E2-INF-04 las categorías de MercadoLibre', () => {
  it('el informe no revienta con ids MLA…', async () => {
    // Regresión: `ORDER BY id_externo::int` hacía fallar el informe entero en cuanto la cuenta era de ML,
    // cuyos ids de categoría son 'MLA1234'. Ningún test lo cubría porque el fixture era sólo de Woo.
    await admin.query(
      `INSERT INTO catalog.channel_categories
         (company_id, channel_account_id, canal, id_externo, parent_externo, nombre, conteo)
       VALUES ($1, $2, 'mercadolibre', 'MLA1234', NULL, 'Cascos', 10),
              ($1, $2, 'mercadolibre', 'MLA5', 'MLA1234', 'Cascos de MTB', 4),
              ($1, $2, 'mercadolibre', 'sin-digitos', NULL, 'Raro', 0)`, [empresa, cuentaMl]);
    const informe = await generarInforme(app, empresa, cuentaMl);
    expect(informe.categoriasCanal.map((c) => c.idExterno)).toEqual(['MLA5', 'MLA1234', 'sin-digitos']);
    // Y la jerarquía de ML se lee igual que la de Woo: el par es padre e hijo, no algo que decidir.
    expect(informe.solapamientos.sinEmparentar).toEqual([]);
    expect(informe.solapamientos.emparentados.map((s) => `${s.a}|${s.b}`)).toEqual(['Cascos de MTB|Cascos']);
  });
});
