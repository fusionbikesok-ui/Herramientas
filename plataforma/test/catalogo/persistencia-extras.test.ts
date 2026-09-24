/*
 * test/catalogo/persistencia-extras.test.ts — E2 T2 tarea 3: persistir atributos, imágenes y datos
 * comerciales, y abrir `atributo_divergente`. Con base real y con el rol de la app (sin DELETE).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aplicarProyeccion, type Canal } from '../../src/catalogo/aplicar.ts';
import { esRechazo } from '../../src/catalogo/intenciones.ts';
import { proyectarItemMl } from '../../src/catalogo/ml.ts';
import { proyectarProductoWoo } from '../../src/catalogo/woo.ts';
import { crearPool } from '../../src/db/pool.ts';
import { enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool;
let empresa: string; let woo: string; let ml: string; let n = 0;

beforeAll(async () => {
  base = await crearBaseDePrueba();
  app = crearPool(base.urlApp, { max: 4 }); admin = crearPool(base.urlAdmin, { max: 2 });
  return async () => { await app.end(); await admin.end(); await base.borrar(); };
});

beforeEach(async () => {
  await admin.query(`TRUNCATE catalog.identity_cases, catalog.matcher_decisions, catalog.model_attributes, catalog.model_images,
    catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  empresa = (await admin.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = async (canal: string) => (await admin.query<{ id: string }>(
    `INSERT INTO core.channel_accounts (company_id, channel, external_account) VALUES ($1, $2, $3) RETURNING id`,
    [empresa, canal, randomUUID().slice(0, 12)])).rows[0]!.id;
  woo = await cuenta('woocommerce'); ml = await cuenta('mercadolibre');
});

const wooSimple = (attrs: { name: string; option: string }[], extra: Record<string, unknown> = {}) =>
  ({ id: 100, type: 'simple', status: 'publish', name: 'Cubierta', sku: 'FB-100', attributes: attrs, ...extra });
const mlItem = (attrs: { id: string; name: string; value_name: string }[], extra: Record<string, unknown> = {}) =>
  ({ id: 'MLA1', title: 'Cubierta', status: 'active', attributes: attrs, ...extra });

async function aplicar(canal: Canal, payload: unknown, opciones: { comparar?: boolean | 'omitir'; fallar?: boolean } = {}) {
  const p = canal === 'woocommerce' ? proyectarProductoWoo(payload) : proyectarItemMl(payload);
  if (esRechazo(p)) throw new Error(p.rechazo);
  return enTransaccion(app, async (tx) => {
    const r = await aplicarProyeccion({
      tx, cuenta: canal === 'woocommerce' ? woo : ml, canal, versionRemota: `2026-01-01T00:00:${String(++n).padStart(2, '0')}Z`,
      ...(opciones.comparar === 'omitir' ? {} : { compararAtributos: opciones.comparar ?? true }),
    }, p);
    if (opciones.fallar) throw new Error('rollback pedido');
    return r;
  });
}
/** ML vinculado por decisión al SKU de Woo: comparte el modelo de esa variante. */
async function decidirMl() {
  await admin.query(`INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, sku, accion, origen, actor)
    VALUES ($1, $2, 'mercadolibre', 'MLA1', 'FB-100', 'confirmar', 'copia', 'persona')`, [empresa, ml]);
}
const attrs = async (canal?: string) => (await admin.query<{ nombre_normalizado: string; valor: string; vigente_hasta: Date | null; id: string; canal: string }>(
  `SELECT a.id::text, a.nombre_normalizado, a.valor, a.vigente_hasta, r.canal FROM catalog.model_attributes a
     JOIN catalog.external_representations r ON r.id = a.representation_id
    WHERE ($1::text IS NULL OR r.canal = $1) ORDER BY a.nombre_normalizado, a.valor`, [canal ?? null])).rows;
const casos = async () => (await admin.query<{ detalle: { atributos: { nombre: string }[] }; cerrado_en: Date | null }>(
  `SELECT detalle, cerrado_en FROM catalog.identity_cases WHERE tipo = 'atributo_divergente'`)).rows;

describe('E2-PER-01 persistencia', () => {
  it('atributos, imágenes y comercial se escriben con la representación, y un rollback se lleva todo', async () => {
    const payload = wooSimple([{ name: 'Marca', option: 'Maxxis' }],
      { price: '1500.5', stock_quantity: 4, global_unique_id: '779', images: [{ src: 'https://x/a.jpg' }] });
    await expect(aplicar('woocommerce', payload, { fallar: true })).rejects.toThrow('rollback pedido');
    expect(await attrs()).toEqual([]);
    expect((await admin.query('SELECT 1 FROM catalog.external_representations')).rowCount).toBe(0);

    await aplicar('woocommerce', payload);
    expect((await attrs()).map((a) => [a.nombre_normalizado, a.valor])).toEqual([['marca', 'Maxxis']]);
    expect((await admin.query('SELECT url, orden FROM catalog.model_images')).rows).toEqual([{ url: 'https://x/a.jpg', orden: 0 }]);
    const r = (await admin.query(`SELECT precio, stock_canal, gtin, capturado_en, atributos_crudos IS NOT NULL AS crudo FROM catalog.external_representations`)).rows[0];
    expect(r).toMatchObject({ precio: '1500.50', stock_canal: 4, gtin: '779', crudo: true });
    expect(r.capturado_en).not.toBeNull();
  });

  it('lo que el canal deja de informar se marca con vigente_hasta (no se borra) y al reaparecer revive su fila', async () => {
    await aplicar('woocommerce', wooSimple([{ name: 'Marca', option: 'Maxxis' }, { name: 'Color', option: 'Negro' }],
      { images: [{ src: 'https://x/a.jpg' }] }));
    const antes = await attrs();
    await aplicar('woocommerce', wooSimple([{ name: 'Marca', option: 'Maxxis' }], { images: [{ src: 'https://x/b.jpg' }] }));
    const medio = await attrs();
    expect(medio).toHaveLength(2);
    expect(medio.find((a) => a.nombre_normalizado === 'color')!.vigente_hasta).not.toBeNull();
    expect(medio.find((a) => a.nombre_normalizado === 'marca')!.vigente_hasta).toBeNull();
    const imgs = (await admin.query('SELECT url, vigente_hasta FROM catalog.model_images ORDER BY url')).rows;
    expect(imgs[0].vigente_hasta).not.toBeNull(); expect(imgs[1].vigente_hasta).toBeNull();

    await aplicar('woocommerce', wooSimple([{ name: 'Marca', option: 'Maxxis' }, { name: 'Color', option: 'Negro' }],
      { images: [{ src: 'https://x/a.jpg' }] }));
    const despues = await attrs();
    expect(despues).toHaveLength(2);
    expect(despues.find((a) => a.nombre_normalizado === 'color')!.vigente_hasta).toBeNull();
    expect(despues.find((a) => a.nombre_normalizado === 'color')!.id).toBe(antes.find((a) => a.nombre_normalizado === 'color')!.id);
  });

  it('una observación sin extras no borra lo ya guardado', async () => {
    await aplicar('woocommerce', wooSimple([{ name: 'Marca', option: 'Maxxis' }], { price: '900', global_unique_id: '779' }));
    await aplicar('woocommerce', wooSimple([]));
    expect((await attrs()).map((a) => a.vigente_hasta)).toEqual([null]);
    const r = (await admin.query('SELECT precio, gtin, atributos_crudos FROM catalog.external_representations')).rows[0];
    expect(r.precio).toBe('900.00'); expect(r.gtin).toBe('779'); expect(r.atributos_crudos).not.toBeNull();
  });
});

describe('E3 punto B: el título de un ítem ML sin variaciones no se pierde al vincularse a Woo (sin crear modelo)', () => {
  // Revisión de opt-16 sobre el intento anterior (commit 5cb02ef5, revertido): crear un product_models
  // `ml_simple` sólo para no perder el título tenía demasiado radio de impacto (D26/D27, conteos de catálogo,
  // hashCatalogo en medio de la ventana de aceptación de E2). Esta versión guarda el título en la propia
  // representación (`titulo_observado`), sin ningún modelo nuevo.
  it('el título del payload de ML queda en titulo_observado, y NO se crea un product_models ml_simple', async () => {
    await aplicar('woocommerce', wooSimple([]));
    await decidirMl();
    await aplicar('mercadolibre', mlItem([], { title: 'Cubierta Maxxis 29x2.1' }));

    const rep = (await admin.query<{ titulo_observado: string | null; model_id: string | null }>(
      `SELECT titulo_observado, model_id FROM catalog.external_representations WHERE canal = 'mercadolibre' AND recurso = 'MLA1'`
    )).rows[0]!;
    expect(rep.titulo_observado).toBe('Cubierta Maxxis 29x2.1');
    expect(rep.model_id).toBeNull();

    const modelos = (await admin.query<{ origen: string }>('SELECT origen FROM catalog.product_models')).rows.map((r) => r.origen);
    expect(modelos.sort()).toEqual(['woo_simple']); // ningún ml_simple nuevo
  });

  it('una segunda observación con título distinto actualiza titulo_observado en la MISMA fila (no duplica)', async () => {
    await aplicar('woocommerce', wooSimple([]));
    await decidirMl();
    await aplicar('mercadolibre', mlItem([], { title: 'Cubierta v1' }));
    const antes = (await admin.query(`SELECT id, titulo_observado FROM catalog.external_representations WHERE canal = 'mercadolibre'`)).rows[0]!;
    expect(antes.titulo_observado).toBe('Cubierta v1');

    await aplicar('mercadolibre', mlItem([], { title: 'Cubierta v2' }));
    const despues = (await admin.query(`SELECT id, titulo_observado FROM catalog.external_representations WHERE canal = 'mercadolibre'`)).rows[0]!;
    expect(despues.id).toBe(antes.id);
    expect(despues.titulo_observado).toBe('Cubierta v2');
  });

  it('una observación sin título (payload vacío) no borra el titulo_observado ya guardado', async () => {
    await aplicar('woocommerce', wooSimple([]));
    await decidirMl();
    await aplicar('mercadolibre', mlItem([], { title: 'Cubierta con título' }));
    // Reobservar con el mismo payload (proyectarItemMl siempre manda algún title no vacío en la práctica,
    // pero el upsert de todos modos preserva por COALESCE si algún día llega null).
    await aplicar('mercadolibre', mlItem([], { title: 'Cubierta con título' }));
    const rep = (await admin.query(`SELECT titulo_observado FROM catalog.external_representations WHERE canal = 'mercadolibre'`)).rows[0]!;
    expect(rep.titulo_observado).toBe('Cubierta con título');
  });

  it('hashCatalogo no cambia por titulo_observado: dos estados con distinto título pero igual sku/origen dan el mismo hash', async () => {
    const { hashCatalogo } = await import('../../src/catalogo/conciliacion.ts');
    await aplicar('woocommerce', wooSimple([]));
    await decidirMl();
    await aplicar('mercadolibre', mlItem([], { title: 'Título A' }));
    const hashA = await hashCatalogo(admin);
    await aplicar('mercadolibre', mlItem([], { title: 'Título totalmente distinto' }));
    const hashB = await hashCatalogo(admin);
    expect(hashB).toBe(hashA);
  });
});

describe('E2-PER-02 atributo_divergente', () => {
  it('dos canales con valores distintos abren UN caso; un segundo atributo lo actualiza en vez de violar el índice', async () => {
    await aplicar('woocommerce', wooSimple([{ name: 'Marca', option: 'Maxxis' }, { name: 'Color', option: 'Negro' }]));
    await decidirMl();
    await aplicar('mercadolibre', mlItem([{ id: 'BRAND', name: 'Marca', value_name: 'Shimano' }]));
    let c = await casos();
    expect(c).toHaveLength(1);
    expect(c[0]!.detalle.atributos.map((a) => a.nombre)).toEqual(['marca']);

    await aplicar('mercadolibre', mlItem([{ id: 'BRAND', name: 'Marca', value_name: 'Shimano' }, { id: 'COLOR', name: 'Color', value_name: 'Rojo' }]));
    c = await casos();
    expect(c).toHaveLength(1);
    expect(c[0]!.detalle.atributos.map((a) => a.nombre).sort()).toEqual(['color', 'marca']);
    expect(c[0]!.cerrado_en).toBeNull();
  });

  it('la ausencia, los valores que coinciden o se solapan y la categoría no abren caso', async () => {
    await aplicar('woocommerce', wooSimple([{ name: 'Marca', option: 'Maxxis' }, { name: 'Color', option: 'Negro' }, { name: 'Talle', option: '41, 42, 43' }],
      { categories: [{ id: 1, name: 'Cubiertas' }] }));
    await decidirMl();
    // ML no informa color; marca coincide sin importar mayúsculas; talle se solapa; su categoría es un id.
    await aplicar('mercadolibre', mlItem([{ id: 'BRAND', name: 'Marca', value_name: 'MAXXIS' }, { id: 'T', name: 'Talle', value_name: '42' }],
      { category_id: 'MLA3' }));
    expect(await casos()).toEqual([]);
    expect((await attrs('mercadolibre')).length).toBeGreaterThan(0);
  });

  it('con el interruptor apagado no se abre ningún caso pero los atributos se guardan igual', async () => {
    await aplicar('woocommerce', wooSimple([{ name: 'Marca', option: 'Maxxis' }]), { comparar: false });
    await decidirMl();
    await aplicar('mercadolibre', mlItem([{ id: 'BRAND', name: 'Marca', value_name: 'Shimano' }]), { comparar: false });
    expect(await casos()).toEqual([]);
    expect((await attrs('mercadolibre')).map((a) => a.valor)).toEqual(['Shimano']);
  });

  it('sin configurar el interruptor (omisión) no se abre ningún caso pero los atributos se guardan', async () => {
    await aplicar('woocommerce', wooSimple([{ name: 'Marca', option: 'Maxxis' }]), { comparar: 'omitir' });
    await decidirMl();
    await aplicar('mercadolibre', mlItem([{ id: 'BRAND', name: 'Marca', value_name: 'Shimano' }]), { comparar: 'omitir' });
    expect(await casos()).toEqual([]);
    expect((await attrs('mercadolibre')).map((a) => a.valor)).toEqual(['Shimano']);
  });

  it.each<[string, string, string, boolean]>([
    ['talle', '43', '43 eu', false], ['talle', 'm/l', 'm-l', false], ['marca', 'shimano', 'shimano tiagra', false],
    ['color', 'rojo', 'azul', true], ['color', 'amarilllo', 'amarillo', true],
  ])('%s: woo[%s] vs ml[%s] abre caso: %s', async (nombre, w, m, abre) => {
    await aplicar('woocommerce', wooSimple([{ name: nombre, option: w }]));
    await decidirMl();
    await aplicar('mercadolibre', mlItem([{ id: 'X', name: nombre, value_name: m }]));
    expect(await casos()).toHaveLength(abre ? 1 : 0);
  });

  it('el caso se cierra solo cuando los canales dejan de discrepar', async () => {
    await aplicar('woocommerce', wooSimple([{ name: 'Marca', option: 'Maxxis' }]));
    await decidirMl();
    await aplicar('mercadolibre', mlItem([{ id: 'BRAND', name: 'Marca', value_name: 'Shimano' }]));
    expect(await casos()).toHaveLength(1);
    await aplicar('mercadolibre', mlItem([{ id: 'BRAND', name: 'Marca', value_name: 'Maxxis' }]));
    expect((await casos())[0]!.cerrado_en).not.toBeNull();
  });
});
