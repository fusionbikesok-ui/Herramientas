import { describe, it, expect, vi, afterEach } from 'vitest';
import { inicioHoyBuenosAiresISO } from '../lib/tiempo.js';

describe('inicioHoyBuenosAiresISO', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('corta a medianoche de Buenos Aires (03:00 UTC), no a medianoche UTC (hallazgo I6)', () => {
    // 2026-08-13T02:00:00Z = 2026-08-12T23:00 en Buenos Aires (UTC-3): todavía es "ayer" allá.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T02:00:00.000Z'));
    expect(inicioHoyBuenosAiresISO()).toBe('2026-08-12T03:00:00.000Z');
  });

  it('un minuto después de medianoche BA ya cuenta como el nuevo día', () => {
    // 2026-08-13T03:01:00Z = 2026-08-13T00:01 en Buenos Aires: ya es "hoy" 13.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T03:01:00.000Z'));
    expect(inicioHoyBuenosAiresISO()).toBe('2026-08-13T03:00:00.000Z');
  });
});
