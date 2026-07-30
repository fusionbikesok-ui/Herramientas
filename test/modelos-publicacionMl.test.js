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
  it('cae a seller_custom_field cuando no hay SELLER_SKU', () => {
    expect(skuDesdeAtributosMl([], ' CBX-9 ')).toBe('CBX-9');
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
    }]);
  });

  it('item simple: SKU por fallback seller_custom_field', () => {
    const body = { id: 112, title: 'X', status: 'active', seller_custom_field: 'FB-9', attributes: [] };
    const [fila] = aplanarItemMl(body);
    expect(fila.seller_sku).toBe('FB-9');
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
      color: 'Azul', talle: 'L', seller_sku: 'FB-2002', variations_texto: 'Azul / L',
    });
  });

  it('catalog_listing falsy → catalogo 0', () => {
    const [fila] = aplanarItemMl({ id: 300, title: 'Y', status: 'active', attributes: [] });
    expect(fila.catalogo).toBe(0);
  });
});
