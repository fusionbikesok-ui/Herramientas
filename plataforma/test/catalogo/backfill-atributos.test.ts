/*
 * test/catalogo/backfill-atributos.test.ts — E2 T2 tarea 4: el backfill desde los cachés del legado.
 * Base real con el rol de la app (sin DELETE) y, para el script, un SQLite temporal y un proceso hijo.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error módulo JS sin tipos
import Database from 'better-sqlite3';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backfillAtributos, type FilaCache, type FuenteLegado } from '../../src/catalogo/backfill-atributos.ts';
import { extraerExtrasMl } from '../../src/catalogo/ml.ts';
import { extraerExtrasWoo } from '../../src/catalogo/woo.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let woo: string; let ml: string;
const SCRIPT = fileURLToPath(new URL('../../../scripts/catalogo-atributos-backfill.mjs', import.meta.url));

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});
beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.identity_cases, catalog.model_attributes, catalog.model_images,
    catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  woo = await cuenta('woocommerce'); ml = await cuenta('mercadolibre');
});

/** Una representación ya proyectada por T1, sin datos capturados. `vendible` cuelga de una variante. */
async function rep(canal: 'woocommerce' | 'mercadolibre', recurso: string, variacion = '', tipo: 'vendible' | 'contenedor' = 'vendible') {
  const cuenta = canal === 'woocommerce' ? woo : ml;
  const modelo = (await admin.query<{ id: string }>(`INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
    VALUES ($1, $2, $3, $4, 'm') RETURNING id`, [empresa, cuenta, canal === 'woocommerce' ? 'woo_simple' : 'ml_simple', `${recurso}-${variacion}-${randomUUID()}`])).rows[0]!.id;
  const variante = tipo === 'vendible' ? (await admin.query<{ id: string }>(
    `INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id`, [empresa, modelo])).rows[0]!.id : null;
  return (await admin.query<{ id: string }>(`INSERT INTO catalog.external_representations
    (company_id, channel_account_id, canal, recurso, variacion_normalizada, tipo, model_id, variant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [empresa, cuenta, canal, recurso, variacion, tipo, tipo === 'contenedor' ? modelo : null, variante])).rows[0]!.id;
}

const filaWoo = (id: number, extra: FilaCache = {}): FilaCache => ({
  id_woo: id, tipo: 'simple', stock: 4, precio: 1000, regular_price: 1500, gtin: '779',
  img: 'https://x/a.jpg', categorias_json: JSON.stringify(['Cubiertas']),
  atributos_json: JSON.stringify([{ name: 'Marca', option: 'Maxxis' }, { name: 'Talle', option: '41, 42,5, 43' }]), ...extra });
const fuente = (w: Record<number, FilaCache> = {}, m: Record<string, FilaCache> = {}): FuenteLegado => ({
  woo: (id) => w[Number(id)], ml: (c) => m[c], mlDeItem: (item) => Object.entries(m).find(([k]) => k.startsWith(`${item}|`))?.[1],
});
const contar = async (t: string) => Number((await admin.query(`SELECT count(*) AS n FROM catalog.${t}`)).rows[0].n);
const pendientes = async () => Number((await admin.query('SELECT count(*) AS n FROM catalog.external_representations WHERE capturado_en IS NULL')).rows[0].n);

describe('E2-BKF-01 el backfill', () => {
  it('los atributos salen con la misma normalización y partición que el extractor del proyector', async () => {
    await rep('woocommerce', '100');
    await backfillAtributos(app, fuente({ 100: filaWoo(100) }), { lote: 10, dryRun: false });
    const esperado = extraerExtrasWoo({
      attributes: JSON.parse(filaWoo(100).atributos_json as string), categories: [{ name: 'Cubiertas' }],
      images: [{ src: 'https://x/a.jpg' }], price: 1000, stock_quantity: 4, global_unique_id: '779' }, 'simple');
    const filas = (await admin.query('SELECT nombre_normalizado AS n, valor AS v FROM catalog.model_attributes ORDER BY 1, 2')).rows
      .map((x) => [x.n, x.v]);
    const orden = (x: string[][]) => x.map((p) => p.join('\u0000')).sort();
    expect(orden(filas)).toEqual(orden(esperado.atributos!.map((a) => [a.nombre, a.valor])));
    expect(filas).toContainEqual(['talle', '42,5']);
    expect((await admin.query('SELECT url FROM catalog.model_images')).rows).toEqual([{ url: 'https://x/a.jpg' }]);
  });

  it('guarda el precio VIGENTE, no el de lista', async () => {
    await rep('woocommerce', '100');
    await backfillAtributos(app, fuente({ 100: filaWoo(100, { precio: 1000, regular_price: 1500 }) }), { lote: 10, dryRun: false });
    expect((await admin.query('SELECT precio, stock_canal, gtin FROM catalog.external_representations')).rows[0])
      .toEqual({ precio: '1000.00', stock_canal: 4, gtin: '779' });
  });

  it('el segundo pase es idempotente: no duplica ni salta nada', async () => {
    await rep('woocommerce', '100'); await rep('woocommerce', '101');
    const f = fuente({ 100: filaWoo(100), 101: filaWoo(101) });
    const uno = await backfillAtributos(app, f, { lote: 1, dryRun: false });
    const attrs = await contar('model_attributes'); const imgs = await contar('model_images');
    const dos = await backfillAtributos(app, f, { lote: 1, dryRun: false });
    expect(uno.procesadas).toBe(2); expect(dos.procesadas).toBe(0);
    expect(await contar('model_attributes')).toBe(attrs); expect(await contar('model_images')).toBe(imgs);
    expect(await pendientes()).toBe(0);
  });

  it('una representación sin datos en el caché queda marcada y no se reintenta', async () => {
    const id = await rep('woocommerce', '999');
    const uno = await backfillAtributos(app, fuente(), { lote: 10, dryRun: false });
    expect(uno).toMatchObject({ procesadas: 1, sinDatos: 1, conDatos: 0 });
    const r = (await admin.query('SELECT capturado_en, atributos_crudos, comercial_crudo FROM catalog.external_representations WHERE id = $1', [id])).rows[0];
    expect(r.capturado_en).not.toBeNull(); expect(r.atributos_crudos).toBeNull(); expect(r.comercial_crudo).toBeNull();
    expect((await backfillAtributos(app, fuente(), { lote: 10, dryRun: false })).procesadas).toBe(0);
  });

  it('una fila del caché sin nada capturable cuenta como sin datos, no como con datos', async () => {
    const id = await rep('woocommerce', '100');
    const vacia = { id_woo: 100, tipo: 'simple', stock: null, precio: null, gtin: null, img: null, categorias_json: null, atributos_json: null };
    expect(await backfillAtributos(app, fuente({ 100: vacia }), { lote: 10, dryRun: false })).toMatchObject({ sinDatos: 1, conDatos: 0 });
    expect((await admin.query('SELECT atributos_crudos FROM catalog.external_representations WHERE id = $1', [id])).rows[0].atributos_crudos).toBeNull();
  });

  it('el dry-run informa pero no escribe ni marca nada', async () => {
    await rep('woocommerce', '100'); await rep('woocommerce', '999');
    const r = await backfillAtributos(app, fuente({ 100: filaWoo(100) }), { lote: 1, dryRun: true });
    expect(r).toMatchObject({ procesadas: 2, conDatos: 1, sinDatos: 1 });
    expect(r.atributos).toBeGreaterThan(0);
    expect(await contar('model_attributes')).toBe(0); expect(await contar('model_images')).toBe(0);
    expect(await pendientes()).toBe(2);
  });

  it('reanuda: un lote que falla no deja nada a medias y la corrida siguiente completa sin duplicar', async () => {
    await rep('woocommerce', '100'); await rep('woocommerce', '101'); await rep('woocommerce', '102');
    const filas = { 100: filaWoo(100), 101: filaWoo(101), 102: filaWoo(102) };
    let llamadas = 0;
    const rota: FuenteLegado = { ...fuente(filas), woo: (id) => { if (++llamadas === 3) throw new Error('el legado se cayó'); return filas[Number(id) as 100]; } };
    await expect(backfillAtributos(app, rota, { lote: 2, dryRun: false })).rejects.toThrow('el legado se cayó');
    expect(await pendientes()).toBe(1);     // el primer lote (2 filas) quedó confirmado; el tercero se revirtió
    const r = await backfillAtributos(app, fuente(filas), { lote: 2, dryRun: false });
    expect(r.procesadas).toBe(1);
    expect(await pendientes()).toBe(0);
    const porFila = extraerExtrasWoo({ attributes: JSON.parse(filas[100].atributos_json as string), categories: [{ name: 'Cubiertas' }] }, 'simple').atributos!.length;
    expect(await contar('model_attributes')).toBe(3 * porFila);
  });

  it('ML: la variación lleva sus atributos, y el contenedor la categoría del ítem', async () => {
    await rep('mercadolibre', 'MLA1', '', 'contenedor'); await rep('mercadolibre', 'MLA1', '55');
    const item = { category_id: 'MLA3', thumbnail: 'https://m/t.jpg' };
    const m = { 'MLA1|55': { ...item, precio: 9100, available_quantity: 2, gtin: '4550',
      atributos_json: JSON.stringify([{ id: 'COLOR', name: 'Color', value_name: 'Rojo' }]) } };
    await backfillAtributos(app, fuente({}, m), { lote: 10, dryRun: false });
    const porRep = (await admin.query(`SELECT r.variacion_normalizada AS v, a.nombre_normalizado AS n, a.valor FROM catalog.model_attributes a
      JOIN catalog.external_representations r ON r.id = a.representation_id ORDER BY 1, 2`)).rows;
    expect(porRep).toEqual([{ v: '', n: 'categoria_canal', valor: 'MLA3' }, { v: '55', n: 'color', valor: 'Rojo' }]);
    const esperado = extraerExtrasMl({ attributes: [{ id: 'COLOR', name: 'Color', value_name: 'Rojo' }], price: 9100, available_quantity: 2 },
      { pictures: [{ id: 'thumbnail', secure_url: 'https://m/t.jpg' }] }, true, false);
    expect(esperado.atributos).toEqual([{ nombre: 'color', valor: 'Rojo' }]);
    expect((await admin.query(`SELECT precio, stock_canal, gtin FROM catalog.external_representations WHERE variacion_normalizada = '55'`)).rows[0])
      .toEqual({ precio: '9100.00', stock_canal: 2, gtin: '4550' });
  });
});

describe('E2-BKF-02 el script', () => {
  let dir: string; let dbPath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bkf-')); dbPath = join(dir, 'legado.db');
    const s = new Database(dbPath);
    s.exec(`CREATE TABLE catalogo_cache (id_woo INTEGER PRIMARY KEY, tipo TEXT, stock INTEGER, precio REAL, regular_price REAL, gtin TEXT, img TEXT, categorias_json TEXT, atributos_json TEXT);
      CREATE TABLE ml_publicaciones_cache (clave TEXT PRIMARY KEY, item_id TEXT, thumbnail TEXT, precio REAL, available_quantity INTEGER, gtin TEXT, category_id TEXT, atributos_json TEXT);`);
    s.prepare('INSERT INTO catalogo_cache VALUES (?,?,?,?,?,?,?,?,?)').run(100, 'simple', 4, 1000, 1500, '779', 'https://x/a.jpg', '["Cubiertas"]', '[{"name":"Marca","option":"Maxxis"}]');
    s.close();
    return () => rmSync(dir, { recursive: true, force: true });
  });
  const correr = (args: string[], env: Record<string, string> = {}) => {
    const p = new URL(base.urlApp);
    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: {
      PATH: process.env.PATH ?? '', DB_PATH: dbPath, PG_HOST: p.hostname, PG_PORT: p.port, PG_DATABASE: p.pathname.slice(1),
      PG_USER: p.username, PG_PASSWORD: p.password, ...env } });
  };

  it('los flags inválidos salen con exit 2 antes de tocar nada', () => {
    expect(correr(['--lote', '0']).status).toBe(2);
    expect(correr(['--inventado']).status).toBe(2);
    expect(correr([], { PG_PASSWORD: '' }).status).toBe(2);
  });

  it('por omisión es dry-run; --ejecutar escribe', async () => {
    await rep('woocommerce', '100');
    const seco = correr([]);
    expect(seco.status, seco.stderr).toBe(0);
    expect(JSON.parse(seco.stdout)).toMatchObject({ dryRun: true, procesadas: 1, conDatos: 1 });
    expect(await pendientes()).toBe(1); expect(await contar('model_attributes')).toBe(0);
    const real = correr(['--ejecutar']);
    expect(real.status, real.stderr).toBe(0);
    expect(JSON.parse(real.stdout)).toMatchObject({ dryRun: false, procesadas: 1, conDatos: 1 });
    expect(await pendientes()).toBe(0); expect(await contar('model_attributes')).toBe(2); // marca + categoria_canal
  });
});
