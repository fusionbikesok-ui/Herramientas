import { describe, it, expect } from 'vitest';
import {
  normalizarGtin, claveGtin, mismoGtin, esGtinCrudoValido, digitoControlOk,
} from '../lib/gtin.js';

describe('digitoControlOk', () => {
  it('acepta los cuatro largos GS1 con control correcto', () => {
    for (const c of ['96385074', '036000291452', '4006381333931', '10614141000415']) {
      expect(digitoControlOk(c), c).toBe(true);
    }
  });

  it('rechaza un código con el último dígito alterado', () => {
    expect(digitoControlOk('4006381333932')).toBe(false);
  });
});

describe('normalizarGtin', () => {
  it('lleva cada largo a 14 dígitos y deriva el tipo', () => {
    expect(normalizarGtin('96385074')).toMatchObject({ ok: true, canonico: '00000096385074', tipo: 'ean_8' });
    expect(normalizarGtin('036000291452')).toMatchObject({ ok: true, canonico: '00036000291452', tipo: 'upc_a' });
    expect(normalizarGtin('4006381333931')).toMatchObject({ ok: true, canonico: '04006381333931', tipo: 'ean_13' });
    expect(normalizarGtin('10614141000415')).toMatchObject({ ok: true, canonico: '10614141000415', tipo: 'gtin_14' });
  });

  it('no destruye el cero significativo de un UPC-A', () => {
    // En 036000291452 el cero inicial es el sistema numérico, no relleno:
    // quitarlo deja 11 dígitos y rompe un código perfectamente válido.
    expect(normalizarGtin('036000291452')).toMatchObject({ ok: true, tipo: 'upc_a', canonico: '00036000291452' });
  });

  it('une los canales por el canónico aunque declaren tipos distintos', () => {
    const conCero = normalizarGtin('0602883701731');
    const sinCero = normalizarGtin('602883701731');
    expect(conCero.canonico).toBe(sinCero.canonico);
    // El tipo describe la representación recibida, no un tipo "verdadero"
    // inferido: una vez rellenado el código, adivinarlo sería inventarlo.
    expect(conCero.tipo).toBe('ean_13');
    expect(sinCero.tipo).toBe('upc_a');
  });

  it('conserva el crudo para no perder la representación original', () => {
    expect(normalizarGtin('  0602883701731 ').crudo).toBe('0602883701731');
  });

  it('distingue el motivo del rechazo en vez de lanzar', () => {
    expect(normalizarGtin(null)).toMatchObject({ ok: false, motivo: 'vacio' });
    expect(normalizarGtin('')).toMatchObject({ ok: false, motivo: 'vacio' });
    expect(normalizarGtin('N/A')).toMatchObject({ ok: false, motivo: 'no_numerico' });
    expect(normalizarGtin('12345678901')).toMatchObject({ ok: false, motivo: 'largo_invalido' });
    expect(normalizarGtin('4006381333932')).toMatchObject({ ok: false, motivo: 'digito_control' });
  });

  it('no colapsa un código de puros ceros a la cadena vacía', () => {
    expect(normalizarGtin('0000')).toMatchObject({ ok: false, motivo: 'largo_invalido' });
  });
});

describe('mismoGtin sobre pares reales de producción', () => {
  // Los 13 pares que al 2026-09-06 se leían como códigos distintos por relleno.
  it.each([
    ['0602883701731', '602883701731'],
    ['04550170894092', '4550170894092'],
    ['06970817351531', '6970817351531'],
    ['00682670915497', '682670915497'],
  ])('une %s con %s', (ml, woo) => {
    expect(mismoGtin(ml, woo)).toBe(true);
  });

  it('no une dos GTIN legítimamente distintos del mismo producto', () => {
    // FB-1550: Shimano JP en ML, Shimano US en Woo. Son dos identificadores
    // válidos, no un error de relleno; el modelo 0..N los acomoda, la clave no.
    expect(mismoGtin('4524667220343', '689228220348')).toBe(false);
  });

  it('no une nada cuando alguno de los dos no es un GTIN', () => {
    expect(mismoGtin('N/A', 'N/A')).toBe(false);
    expect(mismoGtin('', '')).toBe(false);
    expect(claveGtin('N/A')).toBeNull();
  });
});

describe('esGtinCrudoValido', () => {
  it('acepta todo largo GS1 válido y rechaza el resto', () => {
    expect(esGtinCrudoValido('602883701731')).toBe(true);
    // Anteponer un cero da un EAN-13 cuyo dígito de control sigue cerrando:
    // el cero no aporta a la suma ponderada. Es un código válido, no un error.
    expect(esGtinCrudoValido('0602883701731')).toBe(true);
    expect(esGtinCrudoValido('12345678901')).toBe(false);
    expect(esGtinCrudoValido('N/A')).toBe(false);
  });
});
