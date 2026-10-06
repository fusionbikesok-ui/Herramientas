/**
 * Tests para Fase 4 de Preparación: detección y confirmación de pedidos del
 * mismo comprador (preparacion_vinculos).
 *
 * NOTA DE DISEÑO: Los tests de detectarVinculoEntrePedidos y
 * normalizarTelefonoParaComparacion son tests unitarios puros (sin DB). La tabla
 * preparacion_vinculos se prueba en test/preparacion.test.js con fixtures más
 * completas (el router completo con todas sus dependencias).
 */

import { describe, it, expect } from 'vitest';
import {
  detectarVinculoEntrePedidos,
  normalizarTelefonoParaComparacion,
} from '../lib/preparacion.js';

describe('Fase 4: Detección de vínculos entre pedidos', () => {
  describe('normalizarTelefonoParaComparacion', () => {
    it('extrae solo el número sin característica', () => {
      expect(normalizarTelefonoParaComparacion('11 2345-6789')).toBe('23456789');
      expect(normalizarTelefonoParaComparacion('(11) 2345-6789')).toBe('23456789');
    });

    it('maneja prefijos de país y celular', () => {
      expect(normalizarTelefonoParaComparacion('+54 9 11 2345-6789')).toBe('23456789');
    });

    it('devuelve vacío si el input es nulo o vacío', () => {
      expect(normalizarTelefonoParaComparacion('')).toBe('');
      expect(normalizarTelefonoParaComparacion(null)).toBe('');
      expect(normalizarTelefonoParaComparacion(undefined)).toBe('');
    });
  });

  describe('detectarVinculoEntrePedidos', () => {
    it('detecta vínculo por DNI', () => {
      const order1 = {
        meta_data: [{ key: 'dni', value: '12345678' }],
        billing: { email: 'a@example.com', phone: '11 2345-6789' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1' },
      };

      const order2 = {
        meta_data: [{ key: 'dni', value: '12345678' }],
        billing: { email: 'b@example.com', phone: '11 9999-9999' },
        shipping: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra Calle' },
      };

      expect(detectarVinculoEntrePedidos(order1, order2)).toBe('dni');
    });

    it('detecta vínculo por email', () => {
      const order1 = {
        meta_data: [],
        billing: { email: 'juan@example.com', phone: '' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1' },
      };

      const order2 = {
        meta_data: [],
        billing: { email: 'juan@example.com', phone: '' },
        shipping: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra Calle' },
      };

      expect(detectarVinculoEntrePedidos(order1, order2)).toBe('email');
    });

    it('detecta vínculo por teléfono normalizado', () => {
      const order1 = {
        meta_data: [],
        billing: { email: '', phone: '11 2345-6789' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1' },
      };

      const order2 = {
        meta_data: [],
        billing: { email: '', phone: '(11) 2345 6789' },
        shipping: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra Calle' },
      };

      expect(detectarVinculoEntrePedidos(order1, order2)).toBe('telefono');
    });

    it('detecta vínculo por nombre + dirección de envío', () => {
      const order1 = {
        meta_data: [],
        billing: { email: '', phone: '' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1 123' },
      };

      const order2 = {
        meta_data: [],
        billing: { email: '', phone: '' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1 123' },
      };

      expect(detectarVinculoEntrePedidos(order1, order2)).toBe('nombre_direccion');
    });

    it('normaliza nombre + dirección: sin acentos, mayúsculas, espacios', () => {
      const order1 = {
        meta_data: [],
        billing: { email: '', phone: '' },
        shipping: { first_name: 'José', last_name: 'Pérez', address_1: 'Av.  Corrientes  1000' },
      };

      const order2 = {
        meta_data: [],
        billing: { email: '', phone: '' },
        shipping: { first_name: 'jose', last_name: 'perez', address_1: 'av corrientes 1000' },
      };

      expect(detectarVinculoEntrePedidos(order1, order2)).toBe('nombre_direccion');
    });

    it('devuelve null si no hay vínculo', () => {
      const order1 = {
        meta_data: [],
        billing: { email: 'juan@example.com', phone: '11 2345-6789' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1' },
      };

      const order2 = {
        meta_data: [],
        billing: { email: 'otro@example.com', phone: '11 9999-9999' },
        shipping: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra Calle' },
      };

      expect(detectarVinculoEntrePedidos(order1, order2)).toBeNull();
    });

    it('respeta la prioridad: DNI antes que email', () => {
      // DNI diferente pero email igual → devuelve email (porque DNI no matchea)
      const order1 = {
        meta_data: [{ key: 'dni', value: '11111111' }],
        billing: { email: 'juan@example.com', phone: '' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1' },
      };

      const order2 = {
        meta_data: [{ key: 'dni', value: '22222222' }],
        billing: { email: 'juan@example.com', phone: '' },
        shipping: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra Calle' },
      };

      expect(detectarVinculoEntrePedidos(order1, order2)).toBe('email');
    });

    it('devuelve DNI si ambos matchean (prioridad máxima)', () => {
      const order1 = {
        meta_data: [{ key: 'dni', value: '12345678' }],
        billing: { email: 'juan@example.com', phone: '11 2345-6789' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1' },
      };

      const order2 = {
        meta_data: [{ key: 'dni', value: '12345678' }],
        billing: { email: 'juan@example.com', phone: '11 2345-6789' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1' },
      };

      expect(detectarVinculoEntrePedidos(order1, order2)).toBe('dni');
    });

    it('ignora campos vacíos en comparación', () => {
      const order1 = {
        meta_data: [],
        billing: { email: '', phone: '' },
        shipping: { first_name: '', last_name: '', address_1: '' },
      };

      const order2 = {
        meta_data: [],
        billing: { email: '', phone: '' },
        shipping: { first_name: '', last_name: '', address_1: '' },
      };

      // Aunque todo es vacío, no hay match (por defecto devuelve null)
      expect(detectarVinculoEntrePedidos(order1, order2)).toBeNull();
    });

    it('CUIT se trata igual que DNI', () => {
      const order1 = {
        meta_data: [{ key: 'cuit', value: '20123456789' }],
        billing: { email: 'a@example.com', phone: '' },
        shipping: { first_name: 'Juan', last_name: 'Pérez', address_1: 'Calle 1' },
      };

      const order2 = {
        meta_data: [{ key: 'cuit', value: '20123456789' }],
        billing: { email: 'b@example.com', phone: '' },
        shipping: { first_name: 'Otro', last_name: 'Nombre', address_1: 'Otra Calle' },
      };

      expect(detectarVinculoEntrePedidos(order1, order2)).toBe('dni');
    });
  });
});
