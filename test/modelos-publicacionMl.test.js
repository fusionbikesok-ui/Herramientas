import { describe, it, expect } from 'vitest';
import { attrValor, skuDesdeAtributosMl, aplanarItemMl } from '../lib/modelos/publicacionMl.js';

describe('attrValor', () => {
  it('devuelve el value_name del primer id que matchea', () => {
    const attrs = [{ id: 'COLOR', value_name: 'Rojo' }, { id: 'SIZE', value_name: 'M' }];
    expect(attrValor(attrs, ['SIZE', 'COLOR'])).toBe('M');
  });
  it('"" si no hay array o no matchea ninguno', () => {
    expect(attrValor(null, ['COLOR'])).toBe('');
    expect(attrValor([{ id: 'OTRO', value_name: 'x' }], ['COLOR'])).toBe('');
  });
});

describe('skuDesdeAtributosMl', () => {
  it('prioriza SELLER_SKU en attributes', () => {
    const attrs = [{ id: 'SELLER_SKU', value_name: ' ABC-1 ' }];
    expect(skuDesdeAtributosMl(attrs, 'OTRO')).toBe('ABC-1');
  });
  it('no usa seller_custom_field como identidad cuando no hay SELLER_SKU', () => {
    expect(skuDesdeAtributosMl([], ' CBX-9 ')).toBe('');
  });
  it('"" cuando no hay ninguno de los dos', () => {
    expect(skuDesdeAtributosMl([], null)).toBe('');
  });
});

describe('aplanarItemMl', () => {
  it('item simple: una fila, SKU por SELLER_SKU', () => {
    const body = {
      id: 111, title: 'Casco Bell', status: 'active', sub_status: [],
      secure_thumbnail: 'https://x/t.jpg', permalink: 'https://ml/p', catalog_listing: true,
      attributes: [{ id: 'SELLER_SKU', value_name: 'CBL' }],
    };
    const filas = aplanarItemMl(body);
    expect(filas).toEqual([{
      clave: '111|', item_id: '111', variation_id: '', titulo: 'Casco Bell', status: 'active',
      sub_status: '', es_variante: 0, color: '', talle: '', seller_sku: 'CBL',
      variations_texto: '', thumbnail: 'https://x/t.jpg', permalink: 'https://ml/p', catalogo: 1,
      precio: null, available_quantity: null,
      // 083: canal de la publicación. Sin `channels` en el payload, queda null.
      canales_json: null,
      seller_sku_presente: 1, seller_custom_field: null,
      atributos_json: JSON.stringify([{ id: 'SELLER_SKU', value_name: 'CBL' }]),
      gtin: '', catalog_product_id: null, user_product_id: null,
    }]);
  });

  it('item simple: seller_custom_field queda como evidencia pero no como SKU', () => {
    const body = { id: 112, title: 'X', status: 'active', seller_custom_field: 'FB-9', attributes: [] };
    const [fila] = aplanarItemMl(body);
    expect(fila.seller_sku).toBe('');
    expect(fila.seller_sku_presente).toBe(0);
    expect(fila.seller_custom_field).toBe('FB-9');
  });

  it('item con variaciones: color/talle y variations_texto por variación', () => {
    const body = {
      id: 200, title: 'Casco X', status: 'active', sub_status: ['out_of_stock'],
      variations: [
        {
          id: 2001,
          attribute_combinations: [{ id: 'COLOR', value_name: 'Rojo' }, { id: 'SIZE', value_name: 'M' }],
          attributes: [{ id: 'SELLER_SKU', value_name: 'FB-2001' }],
        },
        {
          id: 2002,
          attribute_combinations: [{ id: 'MAIN_COLOR', value_name: 'Azul' }, { id: 'FRAME_SIZE', value_name: 'L' }],
          seller_custom_field: 'FB-2002',
        },
      ],
    };
    const filas = aplanarItemMl(body);
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({
      clave: '200|2001', item_id: '200', variation_id: '2001', es_variante: 1,
      color: 'Rojo', talle: 'M', seller_sku: 'FB-2001', variations_texto: 'Rojo / M', sub_status: 'out_of_stock',
    });
    expect(filas[1]).toMatchObject({
      clave: '200|2002', item_id: '200', variation_id: '2002', es_variante: 1,
      color: 'Azul', talle: 'L', seller_sku: '', seller_sku_presente: 0,
      seller_custom_field: 'FB-2002', variations_texto: 'Azul / L',
    });
  });

  it('catalog_listing falsy → catalogo 0', () => {
    const [fila] = aplanarItemMl({ id: 300, title: 'Y', status: 'active', attributes: [] });
    expect(fila.catalogo).toBe(0);
  });
});

describe('user_product_id', () => {
  // Es un campo de PRIMER NIVEL del ítem, no un atributo. El código lo buscaba entre los
  // atributos (`USER_PRODUCT_ID`) y devolvía null siempre: las 6894 filas del cache quedaron
  // en NULL, y sin ese dato el sistema no puede ver que dos publicaciones comparten una misma
  // bolsa de stock — que es lo que hace que se pisen la cantidad y una venda sin existencia.
  it('se toma del campo de primer nivel del ítem, no de los atributos', () => {
    const filas = aplanarItemMl({
      id: 'MLA2472219644', title: 'Cadena Shimano', status: 'active',
      available_quantity: 4, user_product_id: 'MLAU3210195462', attributes: [],
    });
    expect(filas).toHaveLength(1);
    expect(filas[0].user_product_id).toBe('MLAU3210195462');
  });

  it('una variación usa el suyo y, si no tiene, hereda el del ítem', () => {
    const filas = aplanarItemMl({
      id: 'MLA1', title: 'Con variaciones', status: 'active', user_product_id: 'MLAU-ITEM',
      attributes: [],
      variations: [
        { id: '11', attribute_combinations: [], attributes: [], available_quantity: 1, user_product_id: 'MLAU-VAR' },
        { id: '22', attribute_combinations: [], attributes: [], available_quantity: 2 },
      ],
    });
    expect(filas.find((f) => f.variation_id === '11').user_product_id).toBe('MLAU-VAR');
    expect(filas.find((f) => f.variation_id === '22').user_product_id).toBe('MLAU-ITEM');
  });

  it('sin user_product_id queda en null, no en undefined (el upsert usa parámetro nombrado)', () => {
    const filas = aplanarItemMl({ id: 'MLA2', title: 'Suelto', status: 'active', attributes: [] });
    expect(filas[0].user_product_id).toBeNull();
  });
});

describe('catalog_product_id', () => {
  it('mapea catalog_product_id del item a la fila (simple)', () => {
    const filas = aplanarItemMl({
      id: 'MLA1', title: 'x', status: 'active', attributes: [], variations: [],
      catalog_listing: true, catalog_product_id: 'MLA44441017',
    });
    expect(filas[0].catalog_product_id).toBe('MLA44441017');
  });

  it('catalog_product_id ausente → null, no undefined', () => {
    const filas = aplanarItemMl({
      id: 'MLA2', title: 'x', status: 'active', attributes: [], variations: [],
      catalog_listing: false,
    });
    expect(filas[0].catalog_product_id).toBeNull();
  });

  it('denormaliza catalog_product_id en cada variación', () => {
    const filas = aplanarItemMl({
      id: 'MLA3', title: 'x', status: 'active', attributes: [], catalog_listing: true,
      catalog_product_id: 'MLA999',
      variations: [{ id: 1, attribute_combinations: [], attributes: [] },
        { id: 2, attribute_combinations: [], attributes: [] }],
    });
    expect(filas.map(f => f.catalog_product_id)).toEqual(['MLA999', 'MLA999']);
  });
});
