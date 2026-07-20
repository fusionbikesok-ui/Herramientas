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
});
