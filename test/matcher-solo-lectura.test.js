import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const vista = fs.readFileSync('./public/matcher/index.html', 'utf8');

describe('Matcher: pantalla de solo lectura', () => {
  // Fase D, paso 6: la pantalla vieja se retiró; public/matcher/index.html es sólo un stub de redirección
  // a Catálogo y vínculos. Los controles de solo lectura de abajo quedan como guarda: el stub no escribe.
  it('redirige a Catálogo y vínculos y ya no lleva a la Bandeja de identidad', () => {
    expect(vista).toContain("'catalogo-vinculos/'");
    expect(vista).not.toContain('bandeja-identidad');
    expect(vista).not.toContain('solo lectura');
  });

  it('no puede escribir: sin llamadas de vinculación ni POST', () => {
    expect(vista).not.toContain('/api/guardia-ml/vincular-clave');
    expect(vista).not.toMatch(/method:\s*['"]POST['"]/);
    expect(vista).not.toMatch(/\b(vincularSku|confirmWithSku|confirmItem|skipItem|selectManualSku|selectCandidate)\b/);
  });

  it('no deja confirmar ni omitir por teclado ni por botón', () => {
    expect(vista).not.toMatch(/case 'enter'/);
    expect(vista).not.toMatch(/case 's':/);
    expect(vista).not.toContain('manual-sku');
    expect(vista).not.toMatch(/Confirmar|Aprobar|Omitir/);
  });

  it('ya no hay lógica que mueva el índice a filteredItems[0] al renderizar la lista', () => {
    expect(vista).not.toContain('filteredItems[0]');
  });

  it('el script sigue siendo JavaScript válido', () => {
    const js = [...vista.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(() => new Function(js)).not.toThrow();
  });
});
