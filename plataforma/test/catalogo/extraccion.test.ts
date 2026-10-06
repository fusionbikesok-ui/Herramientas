/*
 * test/catalogo/extraccion.test.ts — E2 T2 tarea 2: atributos, imágenes y datos comerciales (funciones puras).
 */
import { describe, expect, it } from 'vitest';
import { normalizarNombre, partirValores } from '../../src/catalogo/atributos.ts';
import { esRechazo, type Proyeccion, type ResultadoProyeccion } from '../../src/catalogo/intenciones.ts';
import { proyectarItemMl } from '../../src/catalogo/ml.ts';
import { proyectarProductoWoo } from '../../src/catalogo/woo.ts';

const ok = (r: ResultadoProyeccion): Proyeccion => {
  if (esRechazo(r)) throw new Error(r.rechazo);
  return r;
};
const valores = (p: Proyeccion, i: number, nombre: string) =>
  (p.representaciones[i]!.atributos ?? []).filter((a) => a.nombre === nombre).map((a) => a.valor);

describe('E2-EXT-01 normalización y partición', () => {
  it('minúsculas, sin acentos, sin extremos, espacios a _', () => {
    expect(normalizarNombre('Marca')).toBe('marca');
    expect(normalizarNombre('  Tipo de Producto ')).toBe('tipo_de_producto');
    expect(normalizarNombre('Diámetro')).toBe('diametro');
  });
  it('no unifica sinónimos', () => {
    expect(normalizarNombre('Rodado')).not.toBe(normalizarNombre('Diámetro de rodado'));
  });
  it('parte por coma con trim y sin vacías', () => {
    expect(partirValores('talle', '41, 42 ,, 43')).toEqual(['41', '42', '43']);
  });
  it('la coma decimal no separa valores', () => {
    expect(partirValores('largo', '110, 117,5, 122,5')).toEqual(['110', '117,5', '122,5']);
    const talles = partirValores('talle', '40, 42, 42,5, 43, 45, 46');
    expect(talles).toEqual(['40', '42', '42,5', '43', '45', '46']);
    expect(talles).not.toContain('5');
    expect(partirValores('talle', 'L, M, ML, S (27,5), XL')).toEqual(['L', 'M', 'ML', 'S (27,5)', 'XL']);
    expect(partirValores('largo', '117,5')).toEqual(['117,5']);
    expect(partirValores('ancho', '2.25, 2.35, 2.4')).toEqual(['2.25', '2.35', '2.4']);
  });
  it('no parte los atributos de texto libre', () => {
    expect(partirValores('descripcion', 'Ideal para ruta, gravel')).toEqual(['Ideal para ruta, gravel']);
  });
});

describe('E2-EXT-02 Woo', () => {
  const variacion = { id: 11, type: 'variation', parent_id: 10, status: 'publish', name: 'Cubierta', sku: 'FB-11',
    attributes: [{ name: 'Talle', option: '41, 42, 43, 44, 45' }, { name: 'Color', option: 'Negro' }],
    price: '1500.50', stock_quantity: 3, image: { src: 'https://x/v.jpg' } };
  const padre = { id: 10, type: 'variable', status: 'publish', name: 'Cubierta', price: '1000',
    attributes: [{ name: 'Talle', options: ['41, 42', '43'] }],
    categories: [{ id: 5, name: 'Cubiertas' }, { id: 6, name: 'Ruedas' }],
    images: [{ src: 'https://x/a.jpg' }, { src: 'https://x/b.jpg' }] };

  it('option singular (variación) se parte en una fila por valor', () => {
    expect(valores(ok(proyectarProductoWoo(variacion)), 0, 'talle')).toEqual(['41', '42', '43', '44', '45']);
  });
  it('options[] (padre) no se parte: cada elemento es un valor', () => {
    expect(valores(ok(proyectarProductoWoo(padre)), 0, 'talle')).toEqual(['41, 42', '43']);
  });
  it('la categoría sale como categoria_canal, una por categoría', () => {
    expect(valores(ok(proyectarProductoWoo(padre)), 0, 'categoria_canal')).toEqual(['Cubiertas', 'Ruedas']);
  });
  it('imágenes con su orden, y la imagen única de una variación', () => {
    expect(ok(proyectarProductoWoo(padre)).representaciones[0]!.imagenes).toEqual([
      { url: 'https://x/a.jpg', orden: 0 }, { url: 'https://x/b.jpg', orden: 1 }]);
    expect(ok(proyectarProductoWoo(variacion)).representaciones[0]!.imagenes).toEqual([{ url: 'https://x/v.jpg', orden: 0 }]);
  });
  it('precio y stock de la vendible; el padre variable no los toma', () => {
    expect(ok(proyectarProductoWoo(variacion)).representaciones[0]!.comercial).toEqual({ precio: 1500.5, stock: 3 });
    expect(ok(proyectarProductoWoo(padre)).representaciones[0]!.comercial).toBeUndefined();
  });
  it('el GTIN se guarda como evidencia', () => {
    const p = ok(proyectarProductoWoo({ id: 1, type: 'simple', name: 'x', sku: 'FB-1', global_unique_id: '7791234567890' }));
    expect(p.representaciones[0]!.comercial?.gtin).toBe('7791234567890');
  });
  it('el crudo conserva el valor entero sin partir', () => {
    const r = ok(proyectarProductoWoo(variacion)).representaciones[0]!;
    expect((r.crudo!.atributos as { attributes: unknown }).attributes).toEqual(variacion.attributes);
  });
  it('null, undefined, vacío y las cadenas "null"/"undefined" no producen filas', () => {
    const p = ok(proyectarProductoWoo({ id: 2, type: 'simple', name: 'x', sku: 'FB-2', attributes: [
      { name: 'A', option: null }, { name: 'B' }, { name: 'C', option: '' }, { name: 'D', option: ' , ' },
      { name: 'E', option: 'null' }, { name: 'F', option: 'undefined' }, { name: 'G', options: [null, ''] }] }));
    expect(p.representaciones[0]!.atributos).toBeUndefined();
    expect(JSON.stringify(p)).not.toMatch(/"valor":"(null|undefined)"/);
  });
  it('un payload sin nada extra no agrega campos', () => {
    const r = ok(proyectarProductoWoo({ id: 3, type: 'simple', name: 'x', sku: 'FB-3' })).representaciones[0]!;
    expect(Object.keys(r).sort()).toEqual(['estadoRemoto', 'idWoo', 'recurso', 'sku', 'tipo', 'userProductId', 'variacion']);
  });
});

describe('E2-EXT-03 ML', () => {
  const item = { id: 'MLA1', title: 'Cubierta', status: 'active', category_id: 'MLA3', currency_id: 'ARS', price: 9000,
    available_quantity: 7,
    attributes: [{ id: 'BRAND', name: 'Marca', value_name: 'Maxxis' }, { id: 'GTIN', name: 'Código universal de producto', value_name: '779123' },
      { id: 'SELLER_SKU', name: 'SKU', value_name: 'FB-9' }, { id: 'X', name: 'Vacío', value_name: null }],
    pictures: [{ id: 'p1', secure_url: 'https://m/1.jpg' }, { id: 'p2', secure_url: 'https://m/2.jpg' }] };
  const conVariaciones = { ...item, variations: [
    { id: 1, price: 9100, available_quantity: 2, picture_ids: ['p2'], attribute_combinations: [{ id: 'COLOR', name: 'Color', value_name: 'Rojo' }] },
    { id: 2, price: 9200, available_quantity: 5, picture_ids: ['p1'], attribute_combinations: [{ id: 'COLOR', name: 'Color', value_name: 'Azul' }] }] };

  it('ítem simple: atributos, categoría, fotos, comercial y GTIN', () => {
    const r = ok(proyectarItemMl(item)).representaciones[0]!;
    expect(r.atributos).toEqual([{ nombre: 'marca', valor: 'Maxxis' }, { nombre: 'codigo_universal_de_producto', valor: '779123' },
      { nombre: 'categoria_canal', valor: 'MLA3' }]);
    expect(r.imagenes).toEqual([{ url: 'https://m/1.jpg', orden: 0 }, { url: 'https://m/2.jpg', orden: 1 }]);
    expect(r.comercial).toEqual({ precio: 9000, moneda: 'ARS', stock: 7, gtin: '779123' });
  });
  it('SELLER_SKU y los atributos sin valor no salen como atributos', () => {
    const n = (ok(proyectarItemMl(item)).representaciones[0]!.atributos ?? []).map((a) => a.nombre);
    expect(n).not.toContain('sku'); expect(n).not.toContain('vacio');
  });
  it('los atributos de una variación van en la representación de ESA variación, no en el padre', () => {
    const p = ok(proyectarItemMl(conVariaciones));
    expect(p.representaciones.map((r) => r.variacion)).toEqual(['', '1', '2']);
    expect(valores(p, 0, 'color')).toEqual([]);
    expect(valores(p, 1, 'color')).toEqual(['Rojo']);
    expect(valores(p, 2, 'color')).toEqual(['Azul']);
    expect(valores(p, 1, 'marca')).toEqual([]);
  });
  it('cada variación trae su precio, stock y sus fotos; el contenedor no toma precio', () => {
    const p = ok(proyectarItemMl(conVariaciones));
    expect(p.representaciones[1]!.comercial).toEqual({ precio: 9100, moneda: 'ARS', stock: 2 });
    expect(p.representaciones[1]!.imagenes).toEqual([{ url: 'https://m/2.jpg', orden: 1 }]);
    expect(p.representaciones[0]!.comercial?.precio).toBeUndefined();
    expect(valores(p, 0, 'categoria_canal')).toEqual(['MLA3']);
  });
  it('el crudo de la variación conserva sus combinaciones', () => {
    const r = ok(proyectarItemMl(conVariaciones)).representaciones[1]!;
    expect((r.crudo!.atributos as { attribute_combinations: unknown }).attribute_combinations).toEqual(conVariaciones.variations[0]!.attribute_combinations);
  });
});
