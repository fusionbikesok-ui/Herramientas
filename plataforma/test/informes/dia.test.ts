import { describe, it, expect } from 'vitest';
import { diasFaltantes, ventanaDiaAnterior } from '../../src/informes/dia.ts';

describe('ventanaDiaAnterior', () => {
  it('a las 07:00 ART reporta el día calendario anterior completo', () => {
    // 2026-09-17T10:00Z son las 07:00 ART: el día a reportar es el 16.
    const v = ventanaDiaAnterior(new Date('2026-09-17T10:00:00Z'));
    expect(v.fecha).toBe('2026-09-16');
    expect(v.desde.toISOString()).toBe('2026-09-16T03:00:00.000Z');
    expect(v.hasta.toISOString()).toBe('2026-09-17T03:00:00.000Z');
  });

  it('justo después de medianoche ART sigue siendo el día anterior', () => {
    expect(ventanaDiaAnterior(new Date('2026-09-17T03:30:00Z')).fecha).toBe('2026-09-16');
  });

  it('antes de medianoche ART el día anterior es el de ayer ART, no el UTC', () => {
    // 2026-09-17T02:00Z son las 23:00 ART del 16: el anterior es el 15.
    expect(ventanaDiaAnterior(new Date('2026-09-17T02:00:00Z')).fecha).toBe('2026-09-15');
  });
});

describe('diasFaltantes', () => {
  it('sin informes previos devuelve sólo el día anterior', () => {
    expect(diasFaltantes(null, new Date('2026-09-17T10:00:00Z'))).toEqual(['2026-09-16']);
  });

  it('devuelve los días caídos del más viejo al más nuevo', () => {
    expect(diasFaltantes('2026-09-13', new Date('2026-09-17T10:00:00Z')))
      .toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
  });

  it('al día no agrega nada y nunca devuelve más de 30', () => {
    expect(diasFaltantes('2026-09-16', new Date('2026-09-17T10:00:00Z'))).toEqual([]);
    expect(diasFaltantes('2025-01-01', new Date('2026-09-17T10:00:00Z'))).toHaveLength(30);
  });
});
