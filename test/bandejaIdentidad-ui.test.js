import { describe, it, expect } from 'vitest';

// Prueba el código real de public/bandeja-identidad/logica.js (no una copia).
// logica.js es un script clásico (UMD): en vitest se exporta como CommonJS-interop o cuelga de globalThis, como en el navegador.
const mod = await import('../public/bandeja-identidad/logica.js');
const L = mod.default?.marca ? mod.default : mod.marca ? mod : (globalThis.BandejaLogica ?? globalThis.window?.BandejaLogica);
const ev = (o = {}) => ({ key: 'j', target: { tagName: 'DIV', closest: () => null }, ...o });

describe('bandeja: logica pura', () => {
  it('marcas: símbolo + texto para cada una y no se rompe con una desconocida', () => {
    expect(L.marca('coincide')).toMatchObject({ simbolo: '✓', texto: 'coincide' });
    expect(L.marca('difiere').simbolo).toBe('≠');
    expect(L.marca('falta').simbolo).toBe('—');
    expect(L.marca('equivalente').simbolo).toBe('≈');
    expect(L.marca('xyz').texto).toBe('xyz');
  });

  it('copy de errores: cada código de la API tiene su texto de la spec', () => {
    for (const c of ['version_conflict', 'caso_cerrado', 'revierte_no_vigente', 'solo_admin', 'variante_invalida',
      'caso_sin_publicacion', 'idempotency_mismatch', 'caso_inexistente', 'bandeja_apagada', 'plataforma_no_responde']) {
      expect(L.copyError(c)).not.toMatch(/No se pudo completar/);
    }
    expect(L.copyError('otro')).toMatch(/otro/);
  });

  it('atajos: apagados, con modificadores, escribiendo o dentro de un diálogo no disparan', () => {
    expect(L.puedeDispararAtajo(ev(), true)).toBe(true);
    expect(L.puedeDispararAtajo(ev(), false)).toBe(false);
    for (const m of ['ctrlKey', 'altKey', 'metaKey']) expect(L.puedeDispararAtajo(ev({ [m]: true }), true)).toBe(false);
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(L.puedeDispararAtajo(ev({ target: { tagName, closest: () => null } }), true)).toBe(false);
    expect(L.puedeDispararAtajo(ev({ target: { tagName: 'DIV', closest: (s) => (s === 'dialog' ? {} : null) } }), true)).toBe(false);
    expect(L.puedeDispararAtajo(ev({ target: { tagName: 'DIV', isContentEditable: true, closest: () => null } }), true)).toBe(false);
  });

  it('reintento: sólo red caída, 429 y 5xx; un 4xx es definitivo', () => {
    for (const s of [0, 429, 500, 502, 503]) expect(L.esReintentable(s)).toBe(true);
    for (const s of [200, 400, 403, 404, 409, 422]) expect(L.esReintentable(s)).toBe(false);
    expect(L.demora(0)).toBe(1000);
    expect(L.demora(99)).toBe(15000);
  });

  it('deshacer: vale 10 s, una sola vez, y sólo si hay una decisión', () => {
    const u = { ts: 1000, consumida: false };
    expect(L.puedeDeshacer(u, 1000 + 10000)).toBe(true);
    expect(L.puedeDeshacer(u, 1000 + 10001)).toBe(false);
    expect(L.puedeDeshacer({ ...u, consumida: true }, 1500)).toBe(false);
    expect(L.puedeDeshacer(null, 1500)).toBe(false);
  });

  it('total del filtro: suma de grupos (sin no_decidibles) o el del grupo elegido', () => {
    const c = { conflictos: 1, d5: 2, sku_exacto: 3, activas_con_stock: 4, resto: 5, no_decidibles: 99 };
    expect(L.totalFiltro(c, null)).toBe(15);
    expect(L.totalFiltro(c, 1)).toBe(2);
    expect(L.totalFiltro({}, 4)).toBe(0);
  });

  it('precio y stock sin dato no dicen «null»', () => {
    expect(L.formatoPrecio(null, null)).toBe('Sin precio');
    expect(L.formatoPrecio(1500, 'ARS')).toBe('1500 ARS');
    expect(L.formatoStock(null)).toBe('Stock sin dato');
    expect(L.formatoStock(0)).toBe('0 en stock');
  });

  it('opciones = candidatos + búsqueda sin repetir la misma variante', () => {
    const c = [{ variant_id: 'a' }, { variant_id: 'b' }];
    expect(L.opcionesDe(c, [{ variant_id: 'b' }, { variant_id: 'c' }]).map((o) => o.variant_id)).toEqual(['a', 'b', 'c']);
  });

  it('sólo diferencias oculta las filas donde todo coincide y deja las que difieren o faltan', () => {
    const ops = [{ explicacion: { atributos: [{ nombre: 'color', marca: 'coincide' }, { nombre: 'talle', marca: 'difiere' }], otros_atributos: [{ nombre: 'marca', marca: 'falta' }] } }];
    expect(L.nombresAtributos(ops)).toEqual(['color', 'talle', 'marca']);
    expect(L.filaVisible(ops, 'color', true)).toBe(false);
    expect(L.filaVisible(ops, 'talle', true)).toBe(true);
    expect(L.filaVisible(ops, 'marca', true)).toBe(true);
    expect(L.filaVisible(ops, 'color', false)).toBe(true);
  });
});

describe('bandeja: atajos sobre radios', () => {
  it('un radio enfocado no bloquea los atajos (sólo los campos de texto)', () => {
    expect(L.puedeDispararAtajo({ key: 'n', target: { tagName: 'INPUT', type: 'radio', closest: () => null } }, true)).toBe(true);
    expect(L.puedeDispararAtajo({ key: 'n', target: { tagName: 'INPUT', type: 'search', closest: () => null } }, true)).toBe(false);
    expect(L.puedeDispararAtajo({ key: 'n', target: { tagName: 'INPUT', type: 'text', closest: () => null } }, true)).toBe(false);
  });
});
