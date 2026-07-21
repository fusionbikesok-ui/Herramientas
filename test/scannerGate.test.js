import { describe, it, expect } from 'vitest';
import { createContinuousGate } from '../public/lib/scannerGate.js';

describe('createContinuousGate', () => {
  it('dispara la primera vez que ve un código', () => {
    const gate = createContinuousGate();
    expect(gate.frame('7791234567890')).toBe('7791234567890');
  });

  it('no vuelve a disparar mientras sigue viendo el mismo código', () => {
    const gate = createContinuousGate();
    gate.frame('7791234567890');
    expect(gate.frame('7791234567890')).toBeNull();
    expect(gate.frame('7791234567890')).toBeNull();
  });

  it('vuelve a disparar el mismo código después de perderlo de vista', () => {
    const gate = createContinuousGate();
    gate.frame('7791234567890');
    gate.frame(null); // se retiró el producto de cuadro
    expect(gate.frame('7791234567890')).toBe('7791234567890');
  });

  it('dispara inmediatamente al cambiar a un código distinto, sin necesitar un frame vacío', () => {
    const gate = createContinuousGate();
    gate.frame('AAA');
    expect(gate.frame('BBB')).toBe('BBB');
  });

  it('frames vacíos consecutivos no disparan nada', () => {
    const gate = createContinuousGate();
    expect(gate.frame(null)).toBeNull();
    expect(gate.frame(null)).toBeNull();
    expect(gate.frame('')).toBeNull();
  });

  describe('con dropoutMs (anti doble-conteo por parpadeo)', () => {
    it('un hueco más corto que dropoutMs NO resetea: el mismo código no re-dispara', () => {
      const gate = createContinuousGate({ dropoutMs: 500 });
      expect(gate.frame('AAA', 0)).toBe('AAA');
      expect(gate.frame(null, 300)).toBeNull();      // parpadeo de 300ms < 500ms
      expect(gate.frame('AAA', 350)).toBeNull();     // sigue siendo el mismo producto: no cuenta de nuevo
    });

    it('un hueco de al menos dropoutMs sí resetea: el mismo código vuelve a disparar', () => {
      const gate = createContinuousGate({ dropoutMs: 500 });
      expect(gate.frame('AAA', 0)).toBe('AAA');
      expect(gate.frame(null, 200)).toBeNull();
      expect(gate.frame(null, 700)).toBeNull();      // ausente 700ms ≥ 500ms → retirado
      expect(gate.frame('AAA', 800)).toBe('AAA');    // nueva unidad: cuenta
    });

    it('un código distinto dispara al instante aunque haya cooldown del anterior', () => {
      const gate = createContinuousGate({ dropoutMs: 500 });
      gate.frame('AAA', 0);
      expect(gate.frame('BBB', 100)).toBe('BBB');
    });
  });
});
