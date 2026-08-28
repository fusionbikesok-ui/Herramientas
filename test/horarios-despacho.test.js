import { describe, expect, it } from 'vitest';
import { calcularFechaDespacho, horaValida, normalizarHorarios } from '../lib/horariosDespacho.js';

const laborables = normalizarHorarios([]);

describe('horarios de despacho', () => {
  it('valida cortes HH:MM', () => {
    expect(horaValida('16:00')).toBe(true);
    expect(horaValida('24:00')).toBe(false);
    expect(horaValida('4:00')).toBe(false);
  });

  it('propone el mismo día antes del corte y el siguiente después', () => {
    expect(calcularFechaDespacho(laborables, new Date('2026-08-28T17:00:00Z'))).toBe('2026-08-28');
    expect(calcularFechaDespacho(laborables, new Date('2026-08-28T20:30:00Z'))).toBe('2026-08-31');
  });

  it('salta fines de semana deshabilitados', () => {
    expect(calcularFechaDespacho(laborables, new Date('2026-08-29T14:00:00Z'))).toBe('2026-08-31');
  });
});
