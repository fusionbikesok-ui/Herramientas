import { describe, expect, it } from 'vitest';
import {
  CONTRATO_VERSION, MINIMA_SOPORTADA, compararVersiones, estadoCompatibilidad, huellaContrato,
} from '../lib/contratoMovil.js';

describe('versión del contrato móvil', () => {
  it('publica la huella real del OpenAPI que sirve', () => {
    // La app compara esta huella con la suya: si difieren, alguno quedó viejo. Sacarla del
    // archivo y no de una constante evita que las dos fuentes divergan en silencio.
    const h = huellaContrato();
    expect(h.version).toBe(CONTRATO_VERSION);
    expect(h.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h.rutas).toBeGreaterThan(40);
  });

  it('ordena versiones sin depender de comparación de texto', () => {
    // '1.10.0' es mayor que '1.9.0' aunque como cadena sea al revés.
    expect(compararVersiones('1.10.0', '1.9.0')).toBe(1);
    expect(compararVersiones('1.0.0', '1.0.0')).toBe(0);
    expect(compararVersiones('0.9.9', '1.0.0')).toBe(-1);
    expect(compararVersiones('2', '1.9.9')).toBe(1);
  });

  it('exige actualizar sólo por debajo de la mínima soportada', () => {
    expect(estadoCompatibilidad('0.9.0')).toMatchObject({ actualizacion_obligatoria: true });
    expect(estadoCompatibilidad(MINIMA_SOPORTADA)).toMatchObject({ actualizacion_obligatoria: false });
    expect(estadoCompatibilidad('9.9.9')).toMatchObject({ actualizacion_obligatoria: false });
  });

  it('explica por qué exige actualizar', () => {
    // Un booleano solo obliga a adivinar; el motivo se puede mostrar en pantalla.
    const r = estadoCompatibilidad('0.1.0');
    expect(r.motivo).toContain('0.1.0');
    expect(r.motivo).toContain(MINIMA_SOPORTADA);
  });

  it('no bloquea a quien no declara versión', () => {
    // Puede ser una app de desarrollo o una herramienta interna: se informa, no se corta.
    expect(estadoCompatibilidad(undefined)).toMatchObject({ actualizacion_obligatoria: false, app_version: null });
    expect(estadoCompatibilidad('')).toMatchObject({ actualizacion_obligatoria: false });
  });
});
