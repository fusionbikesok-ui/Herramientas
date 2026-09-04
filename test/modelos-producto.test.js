import { describe, it, expect } from 'vitest';
import {
  parseCategorias,
  normalizarProductoWc,
  normalizarVariacionWc,
  filaCatalogo,
  productoDesdeFilaCatalogo,
} from '../lib/modelos/producto.js';

describe('parseCategorias', () => {
  it('acepta array directo', () => {
    expect(parseCategorias(['Bicicletas'])).toEqual(['Bicicletas']);
  });
  it('parsea string JSON', () => {
    expect(parseCategorias('["Bicicletas","Cascos"]')).toEqual(['Bicicletas', 'Cascos']);
  });
  it('tolera JSON inválido, null o vacío', () => {
    expect(parseCategorias('{no-json')).toEqual([]);
    expect(parseCategorias(null)).toEqual([]);
    expect(parseCategorias('')).toEqual([]);
  });
});

describe('normalizarProductoWc', () => {
  it('mapea un producto simple completo', () => {
    const raw = {
      id: 10, name: 'Casco Bell L', sku: 'CBL', type: 'simple', parent_id: 0,
      stock_quantity: 4, categories: [{ id: 1, name: 'Cascos' }],
      images: [{ src: 'https://x/img.jpg' }], price: '15000.50',
      brands: [{ id: 5, name: 'Bell', slug: 'bell' }],
    };
    expect(normalizarProductoWc(raw)).toEqual({
      id_woo: 10, nombre: 'Casco Bell L', sku: 'CBL', tipo: 'simple', id_padre: null,
      stock: 4, categorias: ['Cascos'], atributos: [], img: 'https://x/img.jpg', precio: 15000.5,
      precioLista: null, marca: 'Bell', gtin: '',
    });
  });

  it('sin categorías/img/precio/sku produce nulls y defaults', () => {
    const raw = { id: 11, name: 'Sin datos', type: 'simple' };
    const p = normalizarProductoWc(raw);
    expect(p.sku).toBe('');
    expect(p.categorias).toEqual([]);
    expect(p.img).toBeNull();
    expect(p.precio).toBeNull();
    expect(p.stock).toBe(0);
    expect(p.id_padre).toBeNull();
    expect(p.marca).toBe('');
  });

  it('precio cae a regular_price cuando no hay price', () => {
    const p = normalizarProductoWc({ id: 12, name: 'X', type: 'simple', regular_price: '1234.50' });
    expect(p.precio).toBe(1234.5);
  });

  // precioLista (regular_price) es siempre el de LISTA, independiente de price — no cae a
  // price como fallback (a diferencia de `precio`, que sí puede caer a regular_price).
  it('producto en oferta: precio queda con el vigente (sale_price) y precioLista con regular_price', () => {
    const p = normalizarProductoWc({
      id: 14, name: 'Oferta', type: 'simple', price: '800000', regular_price: '1000000',
    });
    expect(p.precio).toBe(800000);
    expect(p.precioLista).toBe(1000000);
  });

  it('sin regular_price → precioLista queda null (no cae a price)', () => {
    const p = normalizarProductoWc({ id: 15, name: 'Sin lista', type: 'simple', price: '500' });
    expect(p.precio).toBe(500);
    expect(p.precioLista).toBeNull();
  });

  it('usa image singular (variaciones) cuando no hay images[]', () => {
    const p = normalizarProductoWc({ id: 13, name: 'X', type: 'variation', image: { src: 'https://x/v.jpg' } });
    expect(p.img).toBe('https://x/v.jpg');
  });
});

describe('normalizarProductoWc: atributos (producto simple/variable)', () => {
  it('producto variable con options de varios valores: se unen con ", " en un solo atributo', () => {
    const raw = {
      id: 40, name: 'Suspensión X', type: 'variable',
      attributes: [{ name: 'Largo del eje', options: ['110mm', '122.5mm', '123mm'] }],
    };
    const p = normalizarProductoWc(raw);
    expect(p.atributos).toEqual([{ name: 'Largo del eje', option: '110mm, 122.5mm, 123mm' }]);
  });

  it('producto simple con un atributo de un solo valor', () => {
    const raw = {
      id: 41, name: 'Casco Único', type: 'simple',
      attributes: [{ name: 'Color', options: ['Rojo'] }],
    };
    const p = normalizarProductoWc(raw);
    expect(p.atributos).toEqual([{ name: 'Color', option: 'Rojo' }]);
  });

  it('sin attributes → atributos queda en [] (no rompe ni devuelve undefined)', () => {
    const p = normalizarProductoWc({ id: 42, name: 'Sin attrs', type: 'simple' });
    expect(p.atributos).toEqual([]);
  });

  it('attributes con options: [] se descarta → atributos queda []', () => {
    const raw = { id: 43, name: 'Attr vacío', type: 'variable', attributes: [{ name: 'Color', options: [] }] };
    const p = normalizarProductoWc(raw);
    expect(p.atributos).toEqual([]);
  });

  it('attributes con name vacío se descarta', () => {
    const raw = { id: 44, name: 'Sin nombre', type: 'variable', attributes: [{ name: '', options: ['Rojo'] }] };
    const p = normalizarProductoWc(raw);
    expect(p.atributos).toEqual([]);
  });

  it('options con valores vacíos/null mezclados: se filtran antes de unir, sin ", " colgando', () => {
    const raw = {
      id: 45, name: 'Eje mixto', type: 'variable',
      attributes: [{ name: 'Largo del eje', options: ['110mm', '', null, '123mm'] }],
    };
    const p = normalizarProductoWc(raw);
    expect(p.atributos).toEqual([{ name: 'Largo del eje', option: '110mm, 123mm' }]);
  });

  it('varios attributes: cada uno se mapea a un atributo, mezclando descartados y válidos', () => {
    const raw = {
      id: 46, name: 'Multi', type: 'variable',
      attributes: [
        { name: 'Color', options: ['Rojo', 'Azul'] },
        { name: 'Talle', options: [] },
        { name: '', options: ['X'] },
      ],
    };
    const p = normalizarProductoWc(raw);
    expect(p.atributos).toEqual([{ name: 'Color', option: 'Rojo, Azul' }]);
  });
});

describe('normalizarVariacionWc', () => {
  const padre = normalizarProductoWc({
    id: 20, name: 'Casco X', type: 'variable', categories: [{ name: 'Cascos' }],
    brands: [{ name: 'Giro' }],
  });

  it('compone nombre "Padre — attrs" y hereda categorías del padre', () => {
    const rawVar = {
      id: 21, sku: 'FB-21', stock_quantity: 3,
      attributes: [{ name: 'Color', option: 'Rojo' }, { name: 'Talle', option: 'M' }],
    };
    const v = normalizarVariacionWc(rawVar, padre);
    expect(v.nombre).toBe('Casco X — Rojo / M');
    expect(v.categorias).toEqual(['Cascos']);
    expect(v.marca).toBe('Giro');
    expect(v.id_padre).toBe(20);
    expect(v.atributos).toEqual([{ name: 'Color', option: 'Rojo' }, { name: 'Talle', option: 'M' }]);
  });

  it('sin atributos con option, el nombre queda igual al del padre', () => {
    const v = normalizarVariacionWc({ id: 22, sku: 'FB-22', stock_quantity: 1, attributes: [] }, padre);
    expect(v.nombre).toBe('Casco X');
    expect(v.atributos).toEqual([]);
  });

  it('filtra atributos sin option (mismo criterio que el texto compuesto)', () => {
    const rawVar = {
      id: 23, sku: 'FB-23', stock_quantity: 1,
      attributes: [{ name: 'Color', option: 'Azul' }, { name: 'Talle', option: '' }],
    };
    const v = normalizarVariacionWc(rawVar, padre);
    expect(v.nombre).toBe('Casco X — Azul');
    expect(v.atributos).toEqual([{ name: 'Color', option: 'Azul' }]);
  });

  it('captura su propio global_unique_id (gtin), no el del padre', () => {
    // El padre variable no tiene gtin propio (viene vacío de Woo); la variación sí.
    expect(padre.gtin).toBe('');
    const rawVar = {
      id: 24, sku: 'FB-24', stock_quantity: 2,
      attributes: [{ name: 'Color', option: 'Verde' }],
      global_unique_id: '7791234500009',
    };
    const v = normalizarVariacionWc(rawVar, padre);
    expect(v.gtin).toBe('7791234500009');
  });

  it('sin global_unique_id propio, la variación queda con gtin vacío', () => {
    const rawVar = { id: 25, sku: 'FB-25', stock_quantity: 1, attributes: [] };
    const v = normalizarVariacionWc(rawVar, padre);
    expect(v.gtin).toBe('');
  });
});

describe('filaCatalogo / productoDesdeFilaCatalogo (round-trip)', () => {
  it('serializa y deserializa preservando la forma canónica', () => {
    const producto = {
      id_woo: 30, nombre: 'Producto Full', sku: 'PF-1', tipo: 'simple', id_padre: null,
      stock: 7, categorias: ['Bicicletas', 'Rodado 29'],
      atributos: [{ name: 'Color', option: 'Negro' }], img: 'https://x/full.jpg', precio: 99999.99,
      precioLista: 119999.99, marca: 'Shimano', gtin: '7791234567890',
    };
    const fila = filaCatalogo(producto, '2026-07-20T00:00:00.000Z');
    expect(fila.categorias_json).toBe(JSON.stringify(producto.categorias));
    expect(fila.atributos_json).toBe(JSON.stringify(producto.atributos));
    expect(fila.actualizado_en).toBe('2026-07-20T00:00:00.000Z');

    const vueltaAProducto = productoDesdeFilaCatalogo(fila);
    expect(vueltaAProducto).toEqual(producto);
  });

  it('sin categorías/atributos, guarda null y round-trip da arrays vacíos', () => {
    const producto = {
      id_woo: 31, nombre: 'Sin extras', sku: '', tipo: 'variable', id_padre: null,
      stock: 0, categorias: [], atributos: [], img: null, precio: null, precioLista: null,
      marca: '', gtin: '',
    };
    const fila = filaCatalogo(producto, 'now');
    expect(fila.categorias_json).toBeNull();
    expect(fila.atributos_json).toBeNull();
    expect(productoDesdeFilaCatalogo(fila)).toEqual(producto);
  });
});
