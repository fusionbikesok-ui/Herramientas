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

  it('POST /consulta-precios/importar requiere write', () => {
    const req = resolvePermiso('POST', '/consulta-precios/importar');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'write' });
  });

  it('GET /consulta-precios/buscar-sku requiere read', () => {
    const req = resolvePermiso('GET', '/consulta-precios/buscar-sku');
    expect(req).toEqual({ anyOf: ['consulta-precios'], nivel: 'read' });
  });
});

describe('permiso codigos (Códigos Universales)', () => {
  it('está en la lista de herramientas con niveles', () => {
    const h = HERRAMIENTAS.find(x => x.id === 'codigos');
    expect(h).toBeTruthy();
    expect(h.niveles).toBe(true);
  });

  it('GET /codigos/faltantes requiere read', () => {
    const req = resolvePermiso('GET', '/codigos/faltantes');
    expect(req).toEqual({ anyOf: ['codigos'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'codigos', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /codigos/asignar requiere write', () => {
    const req = resolvePermiso('POST', '/codigos/asignar');
    expect(req).toEqual({ anyOf: ['codigos'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'codigos', nivel: 'read' }], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'codigos', nivel: 'write' }], req)).toBe(true);
  });
});

describe('permiso inventario (Contador de Inventario)', () => {
  it('está en la lista de herramientas, sin niveles (checkbox de acceso, no read/write)', () => {
    const h = HERRAMIENTAS.find(x => x.id === 'inventario');
    expect(h).toBeTruthy();
    expect(h.niveles).toBe(false);
  });

  // `inventario` es niveles:false → la UI de Usuarios siempre otorga el permiso con
  // nivel:'read' (checkbox de "acceso", sin selector read/write). Por eso la regla pide
  // explícitamente nivel:'read' sin importar el método HTTP: un operario de depósito
  // no-admin con el permiso tildado tiene que poder escanear/confirmar, no solo mirar.
  it('GET /inventario/sesion-activa requiere el permiso inventario', () => {
    const req = resolvePermiso('GET', '/inventario/sesion-activa');
    expect(req).toEqual({ anyOf: ['inventario'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'inventario', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /inventario/sesiones/1/confirmar también alcanza con el permiso otorgado por la UI (nivel read) — no queda bloqueado el operario no-admin', () => {
    const req = resolvePermiso('POST', '/inventario/sesiones/1/confirmar');
    expect(req).toEqual({ anyOf: ['inventario'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'inventario', nivel: 'read' }], req)).toBe(true);
  });

  it('sin el permiso otorgado, cualquier acción queda bloqueada', () => {
    const req = resolvePermiso('POST', '/inventario/sesiones/1/confirmar');
    expect(permiteAcceso([], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'otra-herramienta', nivel: 'write' }], req)).toBe(false);
  });
});

describe('permiso config-ml masivo (reservas locales por lote)', () => {
  it('GET /sync/catalogo-config acepta config-ml o sync-ml, nivel read (misma regla que buscar-sku)', () => {
    const req = resolvePermiso('GET', '/sync/catalogo-config');
    expect(req).toEqual({ anyOf: ['config-ml', 'sync-ml'], nivel: 'read' });
    expect(permiteAcceso([{ herramienta: 'config-ml', nivel: 'read' }], req)).toBe(true);
    expect(permiteAcceso([{ herramienta: 'sync-ml', nivel: 'read' }], req)).toBe(true);
    expect(permiteAcceso([], req)).toBe(false);
  });

  it('un usuario con solo config-ml (sin sync-ml) puede acceder a catalogo-config para poder usar el lote', () => {
    const req = resolvePermiso('GET', '/sync/catalogo-config');
    expect(permiteAcceso([{ herramienta: 'config-ml', nivel: 'read' }], req)).toBe(true);
  });

  it('POST /sync/config-ml/lote exige config-ml con nivel write (igual que el alta unitaria)', () => {
    const req = resolvePermiso('POST', '/sync/config-ml/lote');
    expect(req).toEqual({ anyOf: ['config-ml'], nivel: 'write' });
    expect(permiteAcceso([{ herramienta: 'config-ml', nivel: 'read' }], req)).toBe(false);
    expect(permiteAcceso([{ herramienta: 'config-ml', nivel: 'write' }], req)).toBe(true);
    expect(permiteAcceso([{ herramienta: 'sync-ml', nivel: 'write' }], req)).toBe(false);
  });
});
