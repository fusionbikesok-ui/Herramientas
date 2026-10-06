import { describe, it, expect } from 'vitest';
import { contrastarCuentas, type CuentaRegistrada } from '../../src/reconciliacion/registro.ts';

// El incidente del 2026-09-17: la cuenta de ML no estaba en SENALES_CUENTAS ni en el registro del worker, y la
// plataforma rechazó TODAS las señales de ML durante cinco horas sin que nadie lo notara.
const WOO = '01a0ad82-de15-7a79-b935-dc665538cd05';
const ML = '01a0b28d-18e4-733b-b53f-64d1be288253';
const cuenta = (channel: 'woocommerce' | 'mercadolibre', id: string): CuentaRegistrada => (channel === 'mercadolibre'
  ? { id, channel, external_account: '1', base_url: 'http://x', seller_id: '1', transporte: 'gateway' }
  : { id, channel, external_account: 'https://x', base_url: 'http://x', transporte: 'gateway' });

describe('contrastarCuentas', () => {
  it('no informa nada cuando las dos configuraciones coinciden', () => {
    expect(contrastarCuentas(new Map([['woocommerce', WOO], ['mercadolibre', ML]]),
      [cuenta('woocommerce', WOO), cuenta('mercadolibre', ML)])).toEqual([]);
  });

  it('detecta una cuenta sólo en el registro: es la mitad del incidente del 17/09', () => {
    const d = contrastarCuentas(new Map([['woocommerce', WOO]]), [cuenta('woocommerce', WOO), cuenta('mercadolibre', ML)]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatch(/mercadolibre.*no en SENALES_CUENTAS.*409/);
  });

  it('detecta una cuenta sólo en SENALES_CUENTAS: se aceptan señales que nadie consume', () => {
    const d = contrastarCuentas(new Map([['woocommerce', WOO], ['mercadolibre', ML]]), [cuenta('woocommerce', WOO)]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatch(/mercadolibre.*no en el registro.*nadie las consume/);
  });

  it('detecta el mismo canal con uuid distinto', () => {
    const d = contrastarCuentas(new Map([['woocommerce', ML]]), [cuenta('woocommerce', WOO)]);
    expect(d).toEqual([expect.stringMatching(/woocommerce tiene un uuid distinto/)]);
  });
});
