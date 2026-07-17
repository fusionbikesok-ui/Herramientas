import { describe, it, expect } from 'vitest';
import { generarCSVStock, generarCSVNuevos, generarCSVNuevosCompleto, determinarEnvioYDimensiones, expandirCategoriasConPadre } from '../lib/csv.js';

describe('generarCSVStock', () => {
  it('sums current stock plus quantity and outputs ID,Inventario rows', () => {
    const csv = generarCSVStock([{ id: 42, stockActual: 3, cantidadSumar: 2 }]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('ID,Inventario');
    expect(lines[1]).toBe('42,5');
  });
});

describe('determinarEnvioYDimensiones', () => {
  it('detects bicicleta by name and returns bicicleta dimensions', () => {
    const r = determinarEnvioYDimensiones('Bicicleta Trek Marlin 7', 'BICICLETAS POR MARCA > BICICLETAS TREK');
    expect(r.clase).toBe('bicicleta');
    expect(r.peso).toBe(15);
  });

  it('defaults to casco dimensions for non-bike products', () => {
    const r = determinarEnvioYDimensiones('Casco Bell Falcon', 'INDUMENTARIA > CASCOS');
    expect(r.clase).toBe('casco');
    expect(r.peso).toBe(1);
  });
});

describe('expandirCategoriasConPadre', () => {
  it('adds the parent category as a separate entry, deduplicated', () => {
    const r = expandirCategoriasConPadre(['INDUMENTARIA > CASCOS', 'INDUMENTARIA > GUANTES']);
    expect(r).toEqual(['INDUMENTARIA > CASCOS', 'INDUMENTARIA', 'INDUMENTARIA > GUANTES']);
  });
});

describe('generarCSVNuevos', () => {
  it('generates a simple product row with correct headers and key columns', () => {
    const csv = generarCSVNuevos([{
      skuBase: 'FB-TEST-001',
      cantidad: 5,
      fichaGemini: { nombre: 'Casco Bell Falcon', tipo: 'simple', marca: 'Bell', categorias: ['INDUMENTARIA > CASCOS'], atributos: [], variaciones: [], descripcion: null }
    }]);
    const lines = csv.split('\n');
    const headers = lines[0].split(',');
    const row = lines[1].split(',');
    expect(headers[0]).toBe('ID');
    expect(row[headers.indexOf('SKU')]).toBe('FB-TEST-001');
    expect(row[headers.indexOf('Nombre')]).toBe('Casco Bell Falcon');
    expect(row[headers.indexOf('Tipo')]).toBe('simple');
    expect(row[headers.indexOf('Inventario')]).toBe('5');
  });

  it('generates a variable product with parent row plus one row per variation', () => {
    const csv = generarCSVNuevos([{
      skuBase: 'FB-TEST-002',
      cantidad: 4,
      fichaGemini: {
        nombre: 'Guante Venzo MTB', tipo: 'variable', marca: 'Venzo',
        categorias: ['INDUMENTARIA > GUANTES'], atributos: [],
        variaciones: [{ talle: 'M' }, { talle: 'L' }], descripcion: null
      }
    }]);
    const lines = csv.split('\n').filter(Boolean);
    // header + 1 parent row + 2 variation rows = 4 lines
    expect(lines.length).toBe(4);
    expect(lines[1].split(',')[lines[0].split(',').indexOf('Tipo')]).toBe('variable');
    expect(lines[2].split(',')[lines[0].split(',').indexOf('Tipo')]).toBe('variation');
  });
});

describe('generarCSVNuevosCompleto', () => {
  it('combines variaciones bajo padre existente with productos nuevos', () => {
    const csv = generarCSVNuevosCompleto({
      variacionesPadre: [{ idPadre: 99, variacion: 'Talle L', cantidad: 3, skuVar: 'FB-VAR-001' }],
      productosNuevos: [{
        skuBase: 'FB-TEST-003', cantidad: 2,
        fichaGemini: { nombre: 'Cubierta Continental', tipo: 'simple', marca: 'Continental', categorias: ['COMPONENTES Y PARTES > CUBIERTAS'], atributos: [], variaciones: [], descripcion: null }
      }]
    });
    const lines = csv.split('\n').filter(Boolean);
    // header + 1 variacion-bajo-padre row + 1 producto nuevo row = 3 lines
    expect(lines.length).toBe(3);
    const headers = lines[0].split(',');
    expect(lines[1].split(',')[headers.indexOf('Superior')]).toBe('id:99');
    expect(lines[2].split(',')[headers.indexOf('SKU')]).toBe('FB-TEST-003');
  });
});
