import { describe, it, expect } from 'vitest';
import { HERRAMIENTAS, resolvePermiso, permiteAcceso } from '../lib/permisos.js';

describe('permiso consulta-precios', () => {
  it('está en la lista de herramientas con niveles', () => {
    const h = HERRAMIENTAS.find(x => x.id === 'consulta-precios');
    expect(h).toBeTruthy();
    expect(h.niveles).toBe(true);
  });

  it('GET /consulta-precios/buscar requiere read', () => {
    const req = resolvePermiso('GET', '/consulta-precios/buscar');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'consulta-precios', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /consulta-precios/ean requiere write', () => {
    const req = resolvePermiso('POST', '/consulta-precios/ean');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'consulta-precios', nivel: 'read' }], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'consulta-precios', nivel: 'write' }], req)).toBe(true);
  });
});
