import { describe, it, expect } from 'vitest';
import { normalizarAtributo, atributosWc, senalesDeVinculo, UMBRAL_DESVIO_PRECIO } from '../lib/vinculosSenales.js';

const base = {
  clave: 'MLA1|10', sku: 'FB-6411', seller_sku: 'FB-6411',
  color: 'Negro/Rojo', talle: 'M', precio: 218700, titulo: 'Casco Giro Syntax',
  wc_nombre: 'Casco Giro Syntax Matte — Negro/Rojo / M (55-59cm)',
  atributos_json: '[{"name":"Color","option":"Negro/Rojo"},{"name":"Talle","option":"M (55-59cm)"}]',
  precio_wc: 218700,
};

describe('normalizarAtributo', () => {
  it('baja a minúsculas, saca acentos y espacios de más', () => {
    expect(normalizarAtributo('  Ámbar Metálico ')).toBe('ambar metalico');
  });
  it('devuelve cadena vacía para nulos', () => {
    expect(normalizarAtributo(null)).toBe('');
  });
});

describe('atributosWc', () => {
  it('extrae color y talle del JSON de atributos de WC', () => {
    expect(atributosWc(base.atributos_json)).toEqual({ color: 'Negro/Rojo', talle: 'M (55-59cm)' });
  });
  it('tolera JSON inválido o vacío', () => {
    expect(atributosWc('no-json')).toEqual({ color: '', talle: '' });
    expect(atributosWc(null)).toEqual({ color: '', talle: '' });
  });
});

describe('senalesDeVinculo', () => {
  it('no marca nada cuando todo coincide', () => {
    expect(senalesDeVinculo(base)).toEqual([]);
  });

  it('marca seller_sku distinto del SKU mapeado', () => {
    const s = senalesDeVinculo({ ...base, seller_sku: 'FB-9999' });
    expect(s.map(x => x.senal)).toContain('seller_sku');
    expect(s.find(x => x.senal === 'seller_sku').peso).toBe('alta');
  });

  it('ignora seller_sku cuando ML no lo tiene cargado', () => {
    expect(senalesDeVinculo({ ...base, seller_sku: '' })).toEqual([]);
  });

  it('compara seller_sku ignorando caso y espacios', () => {
    expect(senalesDeVinculo({ ...base, seller_sku: ' fb-6411 ' })).toEqual([]);
  });

  it('marca color discrepante', () => {
    const s = senalesDeVinculo({ ...base, color: 'Azul' });
    expect(s.map(x => x.senal)).toContain('atributos');
  });

  it('acepta el talle de ML como prefijo del de WC (M vs M (55-59cm))', () => {
    expect(senalesDeVinculo({ ...base, talle: 'M' })).toEqual([]);
  });

  it('marca talle discrepante de verdad', () => {
    const s = senalesDeVinculo({ ...base, talle: 'XL' });
    expect(s.map(x => x.senal)).toContain('atributos');
  });

  it('ignora atributos cuando falta el dato de un lado', () => {
    expect(senalesDeVinculo({ ...base, color: '', talle: '' })).toEqual([]);
    expect(senalesDeVinculo({ ...base, atributos_json: null })).toEqual([]);
  });

  it('marca desvío de precio por encima del umbral', () => {
    const s = senalesDeVinculo({ ...base, precio: 80000 });
    expect(s.map(x => x.senal)).toContain('precio');
    expect(s.find(x => x.senal === 'precio').peso).toBe('media');
  });

  it('no marca desvíos por debajo del umbral', () => {
    const dentro = base.precio_wc * (1 + UMBRAL_DESVIO_PRECIO - 0.01);
    expect(senalesDeVinculo({ ...base, precio: dentro })).toEqual([]);
  });

  it('no marca precio si falta el dato de ML o de WC (fail-closed, sin falso positivo)', () => {
    expect(senalesDeVinculo({ ...base, precio: null })).toEqual([]);
    expect(senalesDeVinculo({ ...base, precio_wc: 0 })).toEqual([]);
  });

  it('el valor de la señal cambia cuando cambia el dato (invalida el descarte)', () => {
    const a = senalesDeVinculo({ ...base, precio: 80000 }).find(x => x.senal === 'precio').valor;
    const b = senalesDeVinculo({ ...base, precio: 70000 }).find(x => x.senal === 'precio').valor;
    expect(a).not.toBe(b);
  });

  it('ordena las señales de peso alta antes que las de peso media', () => {
    const s = senalesDeVinculo({ ...base, seller_sku: 'FB-9999', precio: 80000 });
    expect(s[0].peso).toBe('alta');
  });
});
