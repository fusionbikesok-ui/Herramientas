// Fase D, paso 6: el inicio muestra "Catálogo y vínculos" con el permiso de la pantalla nueva (matcher)
// y ya no muestra las tarjetas ni los chips de las cuatro herramientas retiradas.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const home = fs.readFileSync('./public/home/index.html', 'utf8');
const grupos = home.slice(home.indexOf('var GRUPOS = ['), home.indexOf('var FLECHA'));
const VIEJAS = ['identidad-productos', 'guardia-ml', 'bandeja-identidad'];

describe('Fase D paso 6: tarjetas del inicio', () => {
  const lineaTarjeta = grupos.split('\n').find((l) => l.includes("href: 'catalogo-vinculos'"));

  it('hay exactamente una tarjeta "Catálogo y vínculos" con permiso matcher', () => {
    expect(lineaTarjeta).toBeDefined();
    expect(lineaTarjeta).toContain("tool: 'matcher'");
    expect(lineaTarjeta).toContain("t: 'Catálogo y vínculos'");
    expect(grupos.split("href: 'catalogo-vinculos'").length - 1).toBe(1);
  });

  it('la tarjeta está en el grupo "Precios y catálogo", que no es sólo admin', () => {
    const idxTarjeta = grupos.indexOf("href: 'catalogo-vinculos'");
    const idxGrupo = grupos.lastIndexOf("{ titulo: 'Precios y catálogo'", idxTarjeta);
    const cabecera = grupos.slice(idxGrupo, grupos.indexOf('\n', idxGrupo));
    expect(idxGrupo).toBeGreaterThan(-1);
    expect(cabecera).not.toContain('adminOnly');
    // No hay otro grupo entre la cabecera y la tarjeta
    expect(grupos.slice(idxGrupo + 1, idxTarjeta)).not.toContain('{ titulo:');
  });

  it('no quedan tarjetas de Identidad, Guardia, Matcher ni Bandeja en GRUPOS', () => {
    expect(grupos).not.toMatch(/tool: '(identidad-productos|guardia-ml)'/);
    expect(grupos).not.toMatch(/href: '(identidad-productos|guardia-ml|matcher|bandeja-identidad)'/);
  });

  it('el home no enlaza a las URLs viejas en ningún lado', () => {
    for (const v of VIEJAS) expect(home).not.toContain(v);
    expect(home).not.toMatch(/herramientas\/matcher\//);
  });
});

describe('Fase D paso 6: chips del inicio', () => {
  it('el estado de atención de Catálogo y vínculos sale de GET /api/catalogo-vinculos/estado', () => {
    expect(home).toContain("fetch('/api/catalogo-vinculos/estado')");
    expect(home).toContain('salud.operaciones_pendientes');
    expect(home).toContain("'/herramientas/catalogo-vinculos/', 'matcher'");
  });

  it('el chip de ventas retenidas apunta a la pantalla nueva, no a Guardia ML', () => {
    expect(home).toContain("'ventas retenidas · Catálogo y vínculos', 'crit', '/herramientas/catalogo-vinculos/', 'matcher'");
  });

  it('el home ya no consulta el contador de push de SKUs (lo ve sólo sync-detalle)', () => {
    expect(home).not.toContain('/api/matcher/push-skus-pendientes/count');
  });
});
