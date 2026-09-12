import { describe, it, expect } from 'vitest';
import { detectarCambios, valorDeCampo, CAMPOS_VIGILADOS } from '../lib/vigiaFormato.js';

// Arma una fila con la forma que produce aplanarItemMl.
function fila({ clave = 'MLA1|', item_id = 'MLA1', seller_sku = 'FB-1',
                catalog_product_id = null, units = null, formato = null } = {}) {
  const attrs = [];
  if (units !== null) attrs.push({ id: 'UNITS_PER_PACK', value_name: units });
  if (formato !== null) attrs.push({ id: 'SALE_FORMAT', value_name: formato });
  return { clave, item_id, seller_sku, catalog_product_id, atributos_json: JSON.stringify(attrs) };
}

describe('vigiaFormato — qué se considera un cambio', () => {
  it('un cambio de catalog_product_id se detecta', () => {
    const previas = new Map([['MLA1|', fila({ catalog_product_id: 'MLA111' })]]);
    const r = detectarCambios(previas, [fila({ catalog_product_id: 'MLA222' })]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      clave: 'MLA1|', campo: 'catalog_product_id',
      valor_anterior: 'MLA111', valor_nuevo: 'MLA222',
    });
  });

  // El caso exacto del GP5000: no era de catálogo y pasó a serlo.
  it('pasar de null a un producto de catálogo es un cambio', () => {
    const previas = new Map([['MLA1|', fila({ catalog_product_id: null })]]);
    const r = detectarCambios(previas, [fila({ catalog_product_id: 'MLA44441017' })]);
    expect(r).toHaveLength(1);
    expect(r[0].valor_anterior).toBeNull();
    expect(r[0].valor_nuevo).toBe('MLA44441017');
  });

  it('un cambio de UNITS_PER_PACK se detecta', () => {
    const previas = new Map([['MLA1|', fila({ units: '1' })]]);
    const r = detectarCambios(previas, [fila({ units: '2' })]);
    expect(r).toHaveLength(1);
    expect(r[0].campo).toBe('UNITS_PER_PACK');
  });

  it('un cambio de SALE_FORMAT se detecta', () => {
    const previas = new Map([['MLA1|', fila({ formato: 'Unidad' })]]);
    const r = detectarCambios(previas, [fila({ formato: 'Pack' })]);
    expect(r[0].campo).toBe('SALE_FORMAT');
  });

  // La regla que evita los falsos positivos que rompieron el análisis manual del 2026-09-12.
  it('una publicación vista por primera vez NO dispara, aunque traiga UNITS_PER_PACK 2', () => {
    const r = detectarCambios(new Map(), [fila({ units: '2', formato: 'Pack' })]);
    expect(r).toEqual([]);
  });

  it('sin cambios no devuelve nada', () => {
    const previas = new Map([['MLA1|', fila({ units: '2', formato: 'Pack' })]]);
    const r = detectarCambios(previas, [fila({ units: '2', formato: 'Pack' })]);
    expect(r).toEqual([]);
  });

  it('el título NO se vigila', () => {
    expect(CAMPOS_VIGILADOS).not.toContain('titulo');
  });

  it('un atributo con value_name nulo se lee como null, no como el texto "null"', () => {
    // Es el error que produjo el falso positivo de FB-21169 el 2026-09-12.
    const f = { catalog_product_id: null,
      atributos_json: JSON.stringify([{ id: 'SALE_FORMAT', value_name: null }]) };
    expect(valorDeCampo(f, 'SALE_FORMAT')).toBeNull();
  });

  it('atributos_json inválido no rompe: se lee como sin atributos', () => {
    const previas = new Map([['MLA1|', { clave: 'MLA1|', item_id: 'MLA1', catalog_product_id: null, atributos_json: '{no json' }]]);
    expect(() => detectarCambios(previas, [fila()])).not.toThrow();
  });

  it('dos campos que cambian a la vez dan dos filas', () => {
    const previas = new Map([['MLA1|', fila({ units: '1', formato: 'Unidad' })]]);
    const r = detectarCambios(previas, [fila({ units: '2', formato: 'Pack' })]);
    expect(r).toHaveLength(2);
    expect(r.map(x => x.campo).sort()).toEqual(['SALE_FORMAT', 'UNITS_PER_PACK']);
  });
});
