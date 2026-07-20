import { describe, it, expect } from 'vitest';
import { normalizarOrdenMl, normalizarPedidoWc, billingWcDesdeOrdenMl } from '../lib/modelos/ordenVenta.js';

describe('normalizarOrdenMl', () => {
  it('normaliza una orden con item simple y variación con sufijo .0', () => {
    const orden = {
      id: 'ORD-1', date_created: '2026-07-01T00:00:00Z', status: 'paid',
      buyer: { first_name: 'Ana', last_name: 'Gomez', nickname: 'anag', email: 'ana@mail.com', phone: { number: '3511234567' } },
      order_items: [
        { item: { id: 'MLA100', variation_id: '', seller_sku: 'BIKE-1' }, quantity: 2 },
        { item: { id: 'MLA200', variation_id: '987654321.0', seller_sku: 'CASCO-L' }, quantity: 1 },
      ],
    };
    const ov = normalizarOrdenMl(orden);
    expect(ov.canal).toBe('ml');
    expect(ov.ml_order_id).toBe('ORD-1');
    expect(ov.wc_order_id).toBeNull();
    expect(ov.espejo_ml).toBe(false);
    expect(ov.comprador).toEqual({
      nombre: 'Ana', apellido: 'Gomez', nickname: 'anag', email: 'ana@mail.com', telefono: '3511234567',
    });
    expect(ov.items).toHaveLength(2);
    expect(ov.items[0]).toEqual({
      line_item_id: null, product_id: null, variation_id_wc: null,
      item_id_ml: 'MLA100', variation_id_ml: '', clave: 'MLA100|',
      sku: '', seller_sku: 'BIKE-1', nombre: '', cantidad: 2,
    });
    // El sufijo .0 se normaliza en la clave y en variation_id_ml.
    expect(ov.items[1].variation_id_ml).toBe('987654321');
    expect(ov.items[1].clave).toBe('MLA200|987654321');
  });

  it('buyer sin email/phone deja esos campos en ""', () => {
    const ov = normalizarOrdenMl({ id: 'ORD-2', buyer: { nickname: 'juanp' }, order_items: [] });
    expect(ov.comprador).toEqual({ nombre: '', apellido: '', nickname: 'juanp', email: '', telefono: '' });
  });
});

describe('normalizarPedidoWc', () => {
  it('pedido genuino (sin meta _ml_order_id) → espejo_ml false', () => {
    const order = {
      id: 900, number: '900', status: 'lpaandreani', date_created: '2026-07-01T00:00:00Z',
      billing: { first_name: 'Juan', last_name: 'Perez', email: 'juan@mail.com', phone: '3511111111' },
      meta_data: [{ key: '_billing_dni', value: '30000000' }],
      line_items: [{ id: 5, product_id: 100, variation_id: 0, sku: 'BIKE-1', name: 'Bici Rodado', quantity: 2 }],
    };
    const ov = normalizarPedidoWc(order);
    expect(ov.canal).toBe('web');
    expect(ov.ml_order_id).toBeNull();
    expect(ov.wc_order_id).toBe(900);
    expect(ov.numero).toBe('900');
    expect(ov.espejo_ml).toBe(false);
    expect(ov.comprador).toEqual({ nombre: 'Juan', apellido: 'Perez', nickname: '', email: 'juan@mail.com', telefono: '3511111111' });
    expect(ov.items).toEqual([{
      line_item_id: 5, product_id: 100, variation_id_wc: null,
      item_id_ml: '', variation_id_ml: '', clave: '',
      sku: 'BIKE-1', seller_sku: '', nombre: 'Bici Rodado', cantidad: 2,
    }]);
  });

  it('pedido espejo (meta _ml_order_id presente) → espejo_ml true', () => {
    const order = {
      id: 901, status: 'mercadolibre', meta_data: [{ key: '_ml_order_id', value: 'ORD-9' }], line_items: [],
    };
    expect(normalizarPedidoWc(order).espejo_ml).toBe(true);
  });

  it('numero cae a id cuando no hay number', () => {
    expect(normalizarPedidoWc({ id: 902, line_items: [] }).numero).toBe('902');
  });
});

describe('billingWcDesdeOrdenMl', () => {
  it('usa first_name/last_name reales cuando están disponibles', () => {
    const orden = { buyer: { first_name: 'Ana', last_name: 'Gomez', email: 'ana@mail.com', phone: { number: '3511234567' } } };
    expect(billingWcDesdeOrdenMl(orden)).toEqual({
      first_name: 'Ana', last_name: 'Gomez', email: 'ana@mail.com', phone: '3511234567',
    });
  });

  it('cae a nickname/"Comprador"/"MercadoLibre" y omite email/phone ausentes', () => {
    const orden = { buyer: { nickname: 'anag' } };
    expect(billingWcDesdeOrdenMl(orden)).toEqual({ first_name: 'anag', last_name: 'MercadoLibre' });
  });

  it('sin buyer en absoluto usa los defaults', () => {
    expect(billingWcDesdeOrdenMl({})).toEqual({ first_name: 'Comprador', last_name: 'MercadoLibre' });
  });
});
