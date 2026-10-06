import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';

// precio.js es un módulo UMD sin dependencias: se evalúa como CommonJS.
const src = fs.readFileSync('./public/sync-ml/pausadas/precio.js', 'utf8');
const mod = { exports: {} };
new Function('module', src)(mod);
const PP = mod.exports;
const pagina = fs.readFileSync('./public/sync-ml/pausadas/index.html', 'utf8');

const fila = (clave, precio, extra = {}) => ({ clave, precio, precio_actual: 100000, contado: 90000, neto: 90010, ...extra });

describe('Calcular precio y reactivar: lógica', () => {
  describe('clavesBloqueoNeto', () => {
    it('toma las variaciones frenadas por neto bajo', () => {
      const res = { item_id: 'MLA1', ok: false, bloqueado: true, error: PP.ERR_NETO, clave: 'MLA1|1',
        bloqueos: [{ error: PP.ERR_NETO, clave: 'MLA1|1' }, { error: PP.ERR_NETO, clave: 'MLA1|2' }] };
      expect(PP.clavesBloqueoNeto(res)).toEqual(['MLA1|1', 'MLA1|2']);
    });
    it('acepta el bloqueo suelto (sin lista) y rechaza otros bloqueos', () => {
      expect(PP.clavesBloqueoNeto({ bloqueado: true, error: PP.ERR_NETO, clave: 'MLA2|' })).toEqual(['MLA2|']);
      expect(PP.clavesBloqueoNeto({ bloqueado: true, motivo: 'contradiccion_titulo', bloqueos: [{ clave: 'MLA3|', motivos: [] }] })).toBeNull();
      expect(PP.clavesBloqueoNeto({ ok: false, error: 'ML no la dejó' })).toBeNull();
      expect(PP.clavesBloqueoNeto(null)).toBeNull();
    });
  });

  it('parte las claves en tandas de 100 (tope de /objetivo)', () => {
    const claves = Array.from({ length: 230 }, (_, i) => `MLA${i}|`);
    expect(PP.tandas(claves).map((t) => t.length)).toEqual([100, 100, 30]);
  });

  describe('planItem', () => {
    it('usa el precio más alto de las variaciones (ML exige uno solo) y marca el neto de esa', () => {
      const p = PP.planItem('MLA1', ['MLA1|1', 'MLA1|2'], {
        'MLA1|1': fila('MLA1|1', 112000, { neto: 90000, contado: 90000 }),
        'MLA1|2': fila('MLA1|2', 125000, { neto: 100500, contado: 100500 }),
      });
      expect(p).toMatchObject({ ok: true, nuevo: 125000, actual: 100000, cambia: true, baja: false, neto: 100500, precioWeb: 100500, variaciones: 2 });
    });
    it('si una variación no tiene precio, no se ofrece confirmar y se dice por qué', () => {
      const p = PP.planItem('MLA1', ['MLA1|1', 'MLA1|2'], {
        'MLA1|1': fila('MLA1|1', 112000),
        'MLA1|2': { clave: 'MLA1|2', precio: null, motivo: 'Falta el precio de contado: no hay objetivo contra el cual calcular.' },
      });
      expect(p.ok).toBe(false);
      expect(p.motivos).toEqual(['Falta el precio de contado: no hay objetivo contra el cual calcular.']);
    });
    it('una clave que /objetivo no devolvió cuenta como sin cálculo', () => {
      expect(PP.planItem('MLA9', ['MLA9|'], {}).ok).toBe(false);
    });
    it('marca la baja y el precio sin cambio', () => {
      expect(PP.planItem('A', ['A|'], { 'A|': fila('A|', 90000) })).toMatchObject({ baja: true, cambia: true });
      expect(PP.planItem('A', ['A|'], { 'A|': fila('A|', 100000) })).toMatchObject({ baja: false, cambia: false });
    });
  });

  it('resumen: cuenta confirmables, sin cambio, bajas, sin cálculo y diferencia total', () => {
    const planes = [
      PP.planItem('A', ['A|'], { 'A|': fila('A|', 110000) }),   // +10000
      PP.planItem('B', ['B|'], { 'B|': fila('B|', 95000) }),    // -5000 (baja)
      PP.planItem('C', ['C|'], { 'C|': fila('C|', 100000) }),   // sin cambio
      PP.planItem('D', ['D|'], {}),                              // sin cálculo
    ];
    expect(PP.resumen(planes)).toEqual({ total: 4, confirmables: 3, sinCalculo: 1, cambian: 2, sinCambio: 1, bajan: 1, diferencia: 5000 });
  });

  describe('ejecutar', () => {
    const plan = (id, precio, actual = 100000) => PP.planItem(id, [`${id}|`], { [`${id}|`]: fila(`${id}|`, precio, { precio_actual: actual }) });

    it('primero el precio y después una sola reactivación con las que quedaron bien', async () => {
      const orden = [];
      const deps = {
        putPrecio: vi.fn(async (id) => { orden.push(`put:${id}`); return { ok: true }; }),
        reactivar: vi.fn(async (ids) => { orden.push(`react:${ids.join(',')}`); return Object.fromEntries(ids.map((i) => [i, { ok: true }])); }),
      };
      const r = await PP.ejecutar([plan('A', 110000), plan('B', 120000)], deps);
      expect(orden).toEqual(['put:A', 'put:B', 'react:A,B']);
      expect(r.map((x) => x.estado)).toEqual(['ok', 'ok']);
      expect(r[0].precioAplicado).toBe(110000);
    });

    it('si falla el precio, esa publicación NO se reactiva y se informa el error', async () => {
      const deps = {
        putPrecio: vi.fn(async (id) => (id === 'A' ? { ok: false, error: 'ML rechazó el precio' } : { ok: true })),
        reactivar: vi.fn(async (ids) => Object.fromEntries(ids.map((i) => [i, { ok: true }]))),
      };
      const r = await PP.ejecutar([plan('A', 110000), plan('B', 120000)], deps);
      expect(deps.reactivar).toHaveBeenCalledWith(['B']);
      expect(r[0]).toMatchObject({ itemId: 'A', estado: 'fallo_precio', error: 'ML rechazó el precio' });
      expect(r[1].estado).toBe('ok');
    });

    it('si el precio no cambió no hace el PUT, solo reactiva', async () => {
      const deps = { putPrecio: vi.fn(), reactivar: vi.fn(async (ids) => Object.fromEntries(ids.map((i) => [i, { ok: true }]))) };
      const r = await PP.ejecutar([plan('A', 100000, 100000)], deps);
      expect(deps.putPrecio).not.toHaveBeenCalled();
      expect(r[0]).toMatchObject({ estado: 'ok', precioAplicado: null });
    });

    it('si falla la reactivación, queda el precio nuevo aplicado y el estado lo dice', async () => {
      const deps = {
        putPrecio: vi.fn(async () => ({ ok: true })),
        reactivar: vi.fn(async (ids) => Object.fromEntries(ids.map((i) => [i, { ok: false, error: 'ML no la dejó', bloqueado: true }]))),
      };
      const r = await PP.ejecutar([plan('A', 110000)], deps);
      expect(r[0]).toMatchObject({ estado: 'fallo_reactivacion', precioAplicado: 110000, error: 'ML no la dejó', bloqueado: true });
    });

    it('si la reactivación entera falla (red/permiso), todas quedan con fallo_reactivacion', async () => {
      const deps = { putPrecio: vi.fn(async () => ({ ok: true })), reactivar: vi.fn(async () => { throw new Error('HTTP 500'); }) };
      const r = await PP.ejecutar([plan('A', 110000), plan('B', 120000)], deps);
      expect(r.map((x) => x.estado)).toEqual(['fallo_reactivacion', 'fallo_reactivacion']);
      expect(r[0].error).toBe('HTTP 500');
    });

    it('una excepción en el PUT cuenta como fallo de precio, no rompe el lote', async () => {
      const deps = {
        putPrecio: vi.fn(async (id) => { if (id === 'A') throw new Error('timeout'); return { ok: true }; }),
        reactivar: vi.fn(async (ids) => Object.fromEntries(ids.map((i) => [i, { ok: true }]))),
      };
      const r = await PP.ejecutar([plan('A', 110000), plan('B', 120000)], deps);
      expect(r[0]).toMatchObject({ estado: 'fallo_precio', error: 'timeout' });
      expect(r[1].estado).toBe('ok');
    });

    it('las sin cálculo no se tocan; el tope de 50 deja el resto como omitida', async () => {
      const deps = { putPrecio: vi.fn(async () => ({ ok: true })), reactivar: vi.fn(async (ids) => Object.fromEntries(ids.map((i) => [i, { ok: true }]))) };
      const planes = [PP.planItem('X', ['X|'], {}), ...Array.from({ length: 52 }, (_, i) => plan(`I${i}`, 110000))];
      const r = await PP.ejecutar(planes, deps);
      expect(r[0]).toEqual({ itemId: 'X', estado: 'sin_calculo' });
      expect(deps.putPrecio).toHaveBeenCalledTimes(50);
      expect(deps.reactivar.mock.calls[0][0]).toHaveLength(50);
      expect(r.filter((x) => x.estado === 'omitida')).toHaveLength(2);
    });
  });

  describe('puedeEscribirPrecios', () => {
    it('admin sí; write en precios Y sync-ml sí; si falta uno o es solo lectura, no', () => {
      expect(PP.puedeEscribirPrecios({ is_admin: 1 })).toBe(true);
      expect(PP.puedeEscribirPrecios({ scopes: ['all'] })).toBe(true);
      expect(PP.puedeEscribirPrecios({ permisos: [{ herramienta: 'precios', nivel: 'write' }, { herramienta: 'sync-ml', nivel: 'write' }] })).toBe(true);
      expect(PP.puedeEscribirPrecios({ permisos: [{ herramienta: 'precios', nivel: 'write' }, { herramienta: 'sync-ml', nivel: 'read' }] })).toBe(false);
      expect(PP.puedeEscribirPrecios({ permisos: [{ herramienta: 'sync-ml', nivel: 'write' }] })).toBe(false);
      expect(PP.puedeEscribirPrecios(null)).toBe(false);
    });
  });
});

describe('Calcular precio y reactivar: pantalla de Pausadas', () => {
  it('carga la lógica y usa los endpoints existentes (sin backend nuevo)', () => {
    expect(pagina).toContain('<script src="precio.js"></script>');
    expect(pagina).toContain('/api/precios/objetivo');
    expect(pagina).toContain('/api/precios/actualizar-precio-item');
    expect(pagina).toContain('/api/sync/pausadas-con-stock/reactivar');
  });
  it('el botón solo aparece en filas con bloqueo de neto y con permiso de escritura', () => {
    expect(pagina).toContain("e&&e.neto&&puedePrecio?'<button class=\"btn\" data-calc=");
    expect(pagina).toContain('bp.hidden=!(puedePrecio&&nNeto)');
    expect(pagina).toContain('PausadasPrecio.puedeEscribirPrecios(me)');
    expect(pagina).toContain('neto:PausadasPrecio.clavesBloqueoNeto(res)');
  });
  it('confirma siempre en un panel propio (nunca un solo clic) y sin diálogos nativos', () => {
    expect(pagina).toContain('Actualizar precio y reactivar');
    expect(pagina).toContain("'Confirmar '+R.confirmables");
    expect(pagina).toContain('No se cambia nada hasta que confirmes');
    expect(pagina).toContain('baja el precio');
    expect(pagina).not.toMatch(/\b(alert|confirm|prompt)\(/);
    expect(src).not.toMatch(/\b(alert|confirm|prompt)\(/);
  });
  it('el panel se cierra con Escape salvo mientras aplica, y frena los atajos de la lista', () => {
    expect(pagina).toContain("if(pp){if(pp.estado!=='aplicando')cerrarPrecio();return}");
    expect(pagina).toContain('if(sheetEl||pp)return;');
  });
  it('el script de la página y el módulo son JavaScript válido', () => {
    const js = [...pagina.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(() => new Function(`return async function(){${js}}`)).not.toThrow();
  });
});
