/*
 * test/identidad/formato.test.ts — E3 corte 3 tarea 1: estructura de una publicación de ML y su hash;
 * registrarFormato (persistencia con precedencia sku>formato y candado por clave).
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizarSku } from '../../src/identidad/sku.ts';
import { ATRIBUTOS_PACK, estructuraItemMl, hashEstructura, registrarFormato, type EstructuraMl } from '../../src/identidad/formato.ts';
import { crearPool, enTransaccion } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const base = {
  id: 'MLA1', title: 'x', status: 'active', listing_type_id: 'gold_special', buying_mode: 'buy_it_now',
  catalog_listing: false, seller_custom_field: 'FB-1', attributes: [], variations: [],
};

describe('E3-FMT-01 estructuraItemMl + hashEstructura', () => {
  it('la estructura ignora precio, stock, título y fechas', () => {
    const a = estructuraItemMl({ ...base, price: 100, available_quantity: 3, title: 'x', last_updated: '2026-09-01T00:00:00Z' });
    const b = estructuraItemMl({ ...base, price: 999, available_quantity: 0, title: 'y', last_updated: '2026-09-25T00:00:00Z' });
    expect(hashEstructura(a)).toBe(hashEstructura(b));
  });

  it('cambiar el pack, el tipo de publicación o las variaciones cambia el hash', () => {
    const h = hashEstructura(estructuraItemMl(base));
    expect(hashEstructura(estructuraItemMl({ ...base, attributes: [{ id: ATRIBUTOS_PACK[0], value_name: '2' }] }))).not.toBe(h);
    expect(hashEstructura(estructuraItemMl({ ...base, listing_type_id: 'gold_pro' }))).not.toBe(h);
    expect(hashEstructura(estructuraItemMl({
      ...base,
      variations: [{ id: '1', attribute_combinations: [{ id: 'COLOR', value_name: 'rojo' }], seller_custom_field: 'FB-1' }],
    }))).not.toBe(h);
  });

  it('el orden de variaciones y de combinaciones no cambia el hash', () => {
    const conVariaciones = {
      ...base,
      variations: [
        { id: '10', attribute_combinations: [{ id: 'COLOR', value_name: 'rojo' }, { id: 'TALLE', value_name: 'M' }], seller_custom_field: 'FB-1' },
        { id: '20', attribute_combinations: [{ id: 'TALLE', value_name: 'L' }, { id: 'COLOR', value_name: 'azul' }], seller_custom_field: 'FB-2' },
      ],
    };
    const invertido = {
      ...base,
      variations: [
        { id: '20', attribute_combinations: [{ id: 'COLOR', value_name: 'azul' }, { id: 'TALLE', value_name: 'L' }], seller_custom_field: 'FB-2' },
        { id: '10', attribute_combinations: [{ id: 'TALLE', value_name: 'M' }, { id: 'COLOR', value_name: 'rojo' }], seller_custom_field: 'FB-1' },
      ],
    };
    expect(hashEstructura(estructuraItemMl(conVariaciones))).toBe(hashEstructura(estructuraItemMl(invertido)));
  });

  it('[pin] normalizarSku SÍ colapsa espacios internos (comportamiento actual, no lo cambia este corte)', () => {
    expect(normalizarSku('FB  12')).toBe(normalizarSku('FB 12'));
  });
});

describe('E3-FMT-02 registrarFormato', () => {
  let baseDb: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let cuenta: string;
  const e1: EstructuraMl = { listing_type_id: 'gold_special', catalog_listing: false, buying_mode: 'buy_it_now', sku_vendedor: 'FB-1', variaciones: [], pack: {} };
  const e2: EstructuraMl = { ...e1, listing_type_id: 'gold_pro' };

  beforeAll(async () => {
    baseDb = await crearBaseDePrueba(); app = crearPool(baseDb.urlApp, { max: 4 }); admin = crearPool(baseDb.urlAdmin, { max: 2 });
    const empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    cuenta = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => { await admin.query('TRUNCATE catalog.format_observations'); });
  afterAll(async () => { await app.end(); await admin.end(); await baseDb.borrar(); });

  it('primera vez nueva, igual no inserta, distinta con SKU distinto es cambio/sku, distinta con estructura distinta es cambio/formato', async () => {
    await enTransaccion(app, async (tx) => {
      expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: e1, versionRemota: 'v1', origen: 'barrido' })).toEqual({ resultado: 'nueva', que: null });
      expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: e1, versionRemota: 'v1', origen: 'relectura' })).toEqual({ resultado: 'igual', que: null });
      const eSkuDistinto = { ...e1, sku_vendedor: 'FB-OTRO' };
      expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: eSkuDistinto, versionRemota: 'v2', origen: 'relectura' })).toEqual({ resultado: 'cambio', que: 'sku' });
      // e2 comparte el sku_vendedor con la última observación (eSkuDistinto: 'FB-OTRO'), sólo cambia
      // listing_type_id — así este paso ejercita 'formato' sin volver a tocar el SKU.
      const eFormatoDistinto = { ...e2, sku_vendedor: 'FB-OTRO' };
      expect(await registrarFormato(tx, { cuenta, recurso: 'MLA1', estructura: eFormatoDistinto, versionRemota: 'v3', origen: 'relectura' })).toEqual({ resultado: 'cambio', que: 'formato' });
      expect((await tx.query<{ n: number }>('select count(*)::int n from catalog.format_observations')).rows[0]!.n).toBe(3);
    });
  });

  it('si SKU y formato cambian a la vez, que es "sku" (precedencia): es la señal más fuerte', async () => {
    await enTransaccion(app, async (tx) => {
      const eAmbosDistintos = { ...e2, sku_vendedor: 'FB-OTRO' };
      expect(await registrarFormato(tx, { cuenta, recurso: 'MLA3', estructura: e1, versionRemota: 'v1', origen: 'barrido' })).toEqual({ resultado: 'nueva', que: null });
      expect(await registrarFormato(tx, { cuenta, recurso: 'MLA3', estructura: eAmbosDistintos, versionRemota: 'v2', origen: 'relectura' })).toEqual({ resultado: 'cambio', que: 'sku' });
    });
  });

  it('cantidad_pack guarda el VALOR crudo del primer atributo de pack presente, no un conteo — hallazgo Bajo de Codex, corregido en T2', async () => {
    const conPack: EstructuraMl = { ...e1, pack: { UNITS_PER_PACK: '2 unidades' } };
    await enTransaccion(app, async (tx) => {
      await registrarFormato(tx, { cuenta, recurso: 'MLA5', estructura: conPack, versionRemota: 'v1', origen: 'barrido' });
    });
    const fila = (await app.query<{ cantidad_pack: string | null }>(
      "select cantidad_pack from catalog.format_observations where recurso = 'MLA5'")).rows[0]!;
    expect(fila.cantidad_pack).toBe('2 unidades');
  });

  it('sin atributos de pack, cantidad_pack es NULL', async () => {
    await enTransaccion(app, async (tx) => {
      await registrarFormato(tx, { cuenta, recurso: 'MLA6', estructura: e1, versionRemota: 'v1', origen: 'barrido' });
    });
    const fila = (await app.query<{ cantidad_pack: string | null }>(
      "select cantidad_pack from catalog.format_observations where recurso = 'MLA6'")).rows[0]!;
    expect(fila.cantidad_pack).toBeNull();
  });

  it('cambio de SKU de una variación (ítem CON variaciones, sku_vendedor propio siempre null) se detecta como cambio/sku, no formato — hallazgo Alto de la segunda opinión de Codex, 2026-09-25', async () => {
    const conVariaciones: EstructuraMl = {
      ...e1, sku_vendedor: null,
      variaciones: [{ id: '10', combinacion: ['COLOR=rojo'], sku_vendedor: 'FB-1' }, { id: '20', combinacion: ['COLOR=azul'], sku_vendedor: 'FB-2' }],
    };
    const conSkuDeVariacionCambiado: EstructuraMl = {
      ...conVariaciones,
      variaciones: [{ id: '10', combinacion: ['COLOR=rojo'], sku_vendedor: 'FB-1' }, { id: '20', combinacion: ['COLOR=azul'], sku_vendedor: 'FB-OTRO' }],
    };
    await enTransaccion(app, async (tx) => {
      expect(await registrarFormato(tx, { cuenta, recurso: 'MLA4', estructura: conVariaciones, versionRemota: 'v1', origen: 'barrido' })).toEqual({ resultado: 'nueva', que: null });
      expect(await registrarFormato(tx, { cuenta, recurso: 'MLA4', estructura: conSkuDeVariacionCambiado, versionRemota: 'v2', origen: 'relectura' })).toEqual({ resultado: 'cambio', que: 'sku' });
    });
  });

  it('dos registrarFormato concurrentes para la MISMA clave, con la misma estructura nueva: sólo uno inserta', async () => {
    const [r1, r2] = await Promise.all([
      registrarFormato(app, { cuenta, recurso: 'MLA2', estructura: e1, versionRemota: 'v1', origen: 'barrido' }),
      registrarFormato(app, { cuenta, recurso: 'MLA2', estructura: e1, versionRemota: 'v1', origen: 'barrido' }),
    ]);
    expect([r1.resultado, r2.resultado].sort()).toEqual(['igual', 'nueva']);
    expect((await app.query<{ n: number }>("select count(*)::int n from catalog.format_observations where recurso = 'MLA2'")).rows[0]!.n).toBe(1);
  });
});
