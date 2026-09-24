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

describe('E3 punto B: el título de un ítem ML sin variaciones no se pierde al vincularse a Woo', () => {
  // Reproduce el caso de aplicar.ts vincularMl(): un ítem de ML SIN variaciones (proyectarItemMl arma UNA
  // representación 'vendible', nunca un 'contenedor') que YA está vinculado a una variante de Woo por una
  // decisión — la rama más común en producción. Antes de este fix, esa rama devolvía modelo:null sin llamar
  // obtenerModelo(), así que el título que trae el payload de ML nunca se guardaba en product_models: ni
  // model_id propio, ni contenedor (no existe uno para un ítem sin variaciones), ni la variante (que es
  // woo_*, y modeloMlSql la descarta a propósito para no fugar el título nuestro). modelo-ml.ts devolvía null
  // → sin_titulo_ml para el 52% medido en catalog.external_representations (evidencia de punto B).
  const modeloMlDeLaRepresentacion = async () => (await admin.query<{ titulo: string | null; origen: string | null }>(
    `SELECT pm.titulo, pm.origen FROM catalog.external_representations r
       LEFT JOIN catalog.product_models pm ON pm.id = COALESCE(
         (SELECT id FROM catalog.product_models WHERE id = r.model_id AND origen LIKE 'ml\\_%'),
         (SELECT pm2.id FROM catalog.sellable_variants v JOIN catalog.product_models pm2 ON pm2.id = v.model_id
           WHERE v.id = r.variant_id AND pm2.origen LIKE 'ml\\_%'))
      WHERE r.canal = 'mercadolibre' AND r.tipo = 'vendible' AND r.recurso = 'MLA1'`)).rows[0];

  it('ítem ML sin variaciones ya vinculado a Woo: el título queda en un product_models ml_simple propio', async () => {
    await aplicar('woocommerce', wooSimple([]));
    await decidirMl();
    await aplicar('mercadolibre', mlItem([], { title: 'Cubierta Maxxis 29x2.10' }));
    const m = await modeloMlDeLaRepresentacion();
    expect(m).toMatchObject({ titulo: 'Cubierta Maxxis 29x2.10', origen: 'ml_simple' });
  });

  it('una segunda observación con otro título actualiza el mismo product_models (no crea uno nuevo)', async () => {
    await aplicar('woocommerce', wooSimple([]));
    await decidirMl();
    await aplicar('mercadolibre', mlItem([], { title: 'Título viejo' }));
    const antes = await modeloMlDeLaRepresentacion();
    await aplicar('mercadolibre', mlItem([], { title: 'Título nuevo' }));
    const despues = await modeloMlDeLaRepresentacion();
    expect(despues!.titulo).toBe('Título nuevo');
    const conteo = await admin.query(`SELECT count(*)::int n FROM catalog.product_models WHERE origen = 'ml_simple' AND clave_origen = 'MLA1'`);
    expect(conteo.rows[0]!.n).toBe(1);
    void antes;
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
