import { describe, it, expect } from 'vitest';
import { aplanarItemMl } from '../lib/modelos/publicacionMl.js';

describe('aplanarItemMl: precio y stock', () => {
  it('toma precio y available_quantity del ítem en publicaciones simples', () => {
    const filas = aplanarItemMl({
      id: 'MLA111', title: 'Casco', status: 'active', price: 218700, available_quantity: 4,
      attributes: [{ id: 'SELLER_SKU', value_name: 'FB-6411' }],
    });
    expect(filas).toHaveLength(1);
    expect(filas[0].precio).toBe(218700);
    expect(filas[0].available_quantity).toBe(4);
  });

  it('prefiere el precio de la variación sobre el del ítem', () => {
    const filas = aplanarItemMl({
      id: 'MLA222', title: 'Bici', status: 'active', price: 1000000, available_quantity: 0,
      variations: [
        { id: 1, price: 2767707, available_quantity: 2, attribute_combinations: [{ id: 'COLOR', value_name: 'Negro/Rojo' }], attributes: [] },
        { id: 2, attribute_combinations: [{ id: 'COLOR', value_name: 'Azul' }], attributes: [] },
      ],
    });
    expect(filas[0].precio).toBe(2767707);
    expect(filas[0].available_quantity).toBe(2);
    // La variación sin precio propio hereda el del ítem.
    expect(filas[1].precio).toBe(1000000);
  });

  it('deja precio en null cuando ML no lo trae', () => {
    const filas = aplanarItemMl({ id: 'MLA333', title: 'X', status: 'active', attributes: [] });
    expect(filas[0].precio).toBeNull();
    expect(filas[0].available_quantity).toBeNull();
  });
});
