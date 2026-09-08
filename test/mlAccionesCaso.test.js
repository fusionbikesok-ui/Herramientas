import { describe, it, expect } from 'vitest';
import {
  ROL_VENDEDOR, ACCIONES_ECONOMICAS, accionesDelVendedor, accionesRapidas,
  vencimientoDeMl, serializarAcciones, deserializarAcciones,
} from '../lib/mlAccionesCaso.js';

/**
 * §4.2/§4.3 de la especificación de ML: `available_actions` vive dentro de `players[]`, por
 * rol, y sus elementos son objetos, no strings. `null` (desconocido) y `[]` (ninguna) no son
 * lo mismo, y estos tests existen para que esa distinción no se pierda en un refactor.
 */
describe('lib/mlAccionesCaso', () => {
  describe('accionesDelVendedor', () => {
    it('devuelve null cuando el reclamo no tiene players', () => {
      expect(accionesDelVendedor({})).toBeNull();
      expect(accionesDelVendedor({ players: [] })).toBeNull();
      expect(accionesDelVendedor(null)).toBeNull();
    });

    it('devuelve null cuando ningún player tiene nuestro rol', () => {
      const reclamo = { players: [{ role: 'complainant', available_actions: [{ action: 'refund' }] }] };
      expect(accionesDelVendedor(reclamo)).toBeNull();
    });

    it('devuelve null cuando el player con nuestro rol declaró una lista vacía', () => {
      const reclamo = { players: [{ role: ROL_VENDEDOR, available_actions: [] }] };
      expect(accionesDelVendedor(reclamo)).toBeNull();
    });

    it('devuelve un array de objetos {action, mandatory, due_date} cuando ML sí declaró acciones', () => {
      const reclamo = {
        players: [
          { role: 'complainant', available_actions: [{ action: 'refund' }] },
          {
            role: ROL_VENDEDOR,
            available_actions: [
              { action: 'send_message_to_mediator', mandatory: true, due_date: '2026-09-10T00:00:00.000Z' },
              { action: 'allow_return', mandatory: false, due_date: null },
            ],
          },
        ],
      };
      const acciones = accionesDelVendedor(reclamo);
      expect(acciones).toEqual([
        { action: 'send_message_to_mediator', mandatory: true, due_date: '2026-09-10T00:00:00.000Z' },
        { action: 'allow_return', mandatory: false, due_date: null },
      ]);
    });

    it('acepta strings sueltos en available_actions y los normaliza a objeto', () => {
      const reclamo = { players: [{ role: ROL_VENDEDOR, available_actions: ['send_message'] }] };
      expect(accionesDelVendedor(reclamo)).toEqual([{ action: 'send_message', mandatory: false, due_date: null }]);
    });

    it('descarta elementos inválidos y devuelve null si no queda ninguno válido', () => {
      const reclamo = { players: [{ role: ROL_VENDEDOR, available_actions: [null, 42, { sinAction: true }] }] };
      expect(accionesDelVendedor(reclamo)).toBeNull();
    });

    it('respeta un rol distinto al default cuando se pasa explícito', () => {
      const reclamo = { players: [{ role: 'complainant', available_actions: [{ action: 'refund' }] }] };
      expect(accionesDelVendedor(reclamo, 'complainant')).toEqual([{ action: 'refund', mandatory: false, due_date: null }]);
    });
  });

  describe('accionesRapidas', () => {
    it('nunca ofrece una acción económica como atajo', () => {
      const acciones = [...ACCIONES_ECONOMICAS].map((action) => ({ action, mandatory: false, due_date: null }));
      expect(accionesRapidas(acciones)).toEqual([]);
    });

    it('ofrece solo las acciones de mensaje reconocidas', () => {
      const acciones = [
        { action: 'send_message_to_mediator', mandatory: false, due_date: null },
        { action: 'reply', mandatory: false, due_date: null },
        { action: 'accion_desconocida_de_ml', mandatory: false, due_date: null },
      ];
      const rapidas = accionesRapidas(acciones);
      expect(rapidas.map((a) => a.action).sort()).toEqual(['reply', 'send_message_to_mediator']);
    });

    it('devuelve lista vacía cuando la entrada no es un array (desconocido)', () => {
      expect(accionesRapidas(null)).toEqual([]);
      expect(accionesRapidas(undefined)).toEqual([]);
    });
  });

  describe('vencimientoDeMl', () => {
    it('devuelve el due_date más próximo entre las obligatorias', () => {
      const acciones = [
        { action: 'a', mandatory: true, due_date: '2026-09-15T00:00:00.000Z' },
        { action: 'b', mandatory: true, due_date: '2026-09-10T00:00:00.000Z' },
        { action: 'c', mandatory: false, due_date: '2026-09-01T00:00:00.000Z' },
      ];
      expect(vencimientoDeMl(acciones)).toBe('2026-09-10T00:00:00.000Z');
    });

    it('ignora las no obligatorias aunque venzan antes', () => {
      const acciones = [{ action: 'a', mandatory: false, due_date: '2026-01-01T00:00:00.000Z' }];
      expect(vencimientoDeMl(acciones)).toBeNull();
    });

    it('devuelve null si no hay ninguna obligatoria con due_date, o si la entrada no es array', () => {
      expect(vencimientoDeMl([{ action: 'a', mandatory: true, due_date: null }])).toBeNull();
      expect(vencimientoDeMl(null)).toBeNull();
    });
  });

  describe('serializarAcciones / deserializarAcciones', () => {
    it('hace un viaje de ida y vuelta sin perder datos', () => {
      const acciones = [{ action: 'reply', mandatory: true, due_date: '2026-09-10T00:00:00.000Z' }];
      const texto = serializarAcciones(acciones);
      expect(typeof texto).toBe('string');
      expect(deserializarAcciones(texto)).toEqual(acciones);
    });

    it('serializa null/[] como NULL', () => {
      expect(serializarAcciones(null)).toBeNull();
      expect(serializarAcciones([])).toBeNull();
    });

    it('trata un JSON corrupto como desconocido, no como "ninguna"', () => {
      expect(deserializarAcciones('{esto no es json')).toBeNull();
    });

    it('trata un texto vacío o ausente como desconocido', () => {
      expect(deserializarAcciones(null)).toBeNull();
      expect(deserializarAcciones('')).toBeNull();
    });

    it('un array vacío persistido se relee como desconocido (null), no como "ninguna"', () => {
      expect(deserializarAcciones('[]')).toBeNull();
    });
  });
});
