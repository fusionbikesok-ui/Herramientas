import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const vista = fs.readFileSync('./public/sync-ml/pausadas/index.html', 'utf8');
const sync = fs.readFileSync('./public/sync-ml/index.html', 'utf8');

describe('Pausadas con stock: vista propia (/sync-ml/pausadas)', () => {
  it('usa los tokens del sistema y no define colores propios', () => {
    expect(vista).toContain('../../lib/theme.css');
    expect(vista).toContain('../../lib/components.css');
    const css = vista.split('<style>')[1].split('</style>')[0];
    // sólo rgba de sombra, la máscara de chips (#000) y nada de hex de paleta
    expect(css.replace(/mask-image:[^;]+;/g, '').match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
  });
  it('lee y reactiva con los endpoints del contrato, un POST por lote de hasta 50', () => {
    expect(vista).toContain("fetch('/api/sync/pausadas-con-stock')");
    expect(vista).toContain("'/api/sync/pausadas-con-stock/reactivar'");
    expect(vista).toContain('MAX_LOTE=50');
    expect(vista).toContain('CONFIRMAR_DESDE=10');
    expect(vista).toContain('slice(0,MAX_LOTE)');
  });
  it('no usa modales nativos ni toasts', () => {
    expect(vista).not.toMatch(/\b(confirm|alert|prompt)\s*\(/);
    expect(vista).not.toMatch(/toast/i);
  });
  it('las bloqueadas no tienen checkbox y llevan un link a dónde resolverlas', () => {
    expect(vista).toMatch(/function row\(i\)\{[\s\S]*?if\(locked\(i\)\)\{[\s\S]*?row--locked[\s\S]*?\}/);
    expect(vista).toContain("go:'Ver aviso'");
    expect(vista).toContain("go:'Ir a Configuración ML'");
    expect(vista).toContain("go:'Ir a Catálogo'");
  });
  it('escapa los textos que vienen de ML', () => {
    expect(vista).toContain('function esc(');
    expect(vista).toMatch(/esc\(i\.titulo\|\|i\.item_id\)/);
  });
  it('tiene los atajos pedidos, estados y hoja móvil', () => {
    for (const k of ["'j'", "'k'", "'x'", "'Enter'", "'r'", "'R'", "'/'", "'?'", "'Escape'"]) expect(vista).toContain(k);
    expect(vista).toContain('Todo al día');
    expect(vista).toContain('class="sk"');
    expect(vista).toContain('Mostrando datos de');
    expect(vista).toContain("setAttribute('role','dialog')");
    expect(vista).not.toMatch(/Deshacer/);
  });
});

describe('Sincronización ML: la caja vieja se reemplaza por una línea', () => {
  it('queda sólo "N pausadas con stock · Revisar →" hacia la vista nueva', () => {
    expect(sync).toContain('pausadas con stock · <a href="/herramientas/sync-ml/pausadas/">Revisar →</a>');
    expect(sync).not.toContain('id="pausadas-box"');
    expect(sync).not.toContain('reactivarPausadas');
  });
  it('trata los avisos sin pausa como no-error y la oferta de reactivar apunta a la vista', () => {
    expect(sync).toContain('c.nota||c.pausa_error');
    expect(sync).toContain('d.oferta_reactivar');
  });
});
