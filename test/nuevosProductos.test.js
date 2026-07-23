import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import { armarTitulo, tituloCase, categoriasReales } from '../routes/nuevosProductos.js';
import { armarPromptBatch, CATEGORIAS_FB } from '../lib/categorias.js';
import { openDb } from '../db/index.js';

describe('armarTitulo', () => {
  it('joins tipo, marca, modelo and dato skipping empty parts', () => {
    expect(armarTitulo('Cubierta', 'Continental', 'DP25', 'R29')).toBe('Cubierta Continental DP25 R29');
    expect(armarTitulo('Caramañola', 'Venzo', '', '')).toBe('Caramañola Venzo');
  });

  it('tituloCase capitalizes first letter only', () => {
    expect(tituloCase('CONTINENTAL')).toBe('Continental');
  });
});

describe('categoriasReales', () => {
  const TEST_DB = './test/tmp-nuevos-productos.sqlite';

  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    vi.restoreAllMocks();
  });

  it('aplana categorias_json de todas las filas, deduplica y ordena alfabéticamente', () => {
    const db = openDb(TEST_DB);
    const now = new Date().toISOString();
    const ins = db.prepare(
      'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, categorias_json, actualizado_en) VALUES (?,?,?,?,?,?,?)'
    );
    ins.run(1, 'Bici Trek', 'FB-1', 'simple', 5, '["BICICLETAS POR MARCA","BICICLETAS TREK"]', now);
    ins.run(2, 'Bici Venzo', 'FB-2', 'simple', 5, '["BICICLETAS POR MARCA","BICICLETAS VENZO"]', now);
    ins.run(3, 'Cubierta', 'FB-3', 'simple', 5, '["  CUBIERTAS  "]', now);
    ins.run(4, 'Sin cat', 'FB-4', 'simple', 5, null, now);
    ins.run(5, 'Vacía', 'FB-5', 'simple', 5, '', now);

    const cats = categoriasReales(db);
    // Deduplicada ("BICICLETAS POR MARCA" aparece 2 veces → 1), trim aplicado, orden alfabético.
    expect(cats).toEqual([
      'BICICLETAS POR MARCA',
      'BICICLETAS TREK',
      'BICICLETAS VENZO',
      'CUBIERTAS'
    ]);
  });

  it('cae al fallback CATEGORIAS_FB (con console.warn) cuando el catálogo no tiene categorías', () => {
    const db = openDb(TEST_DB);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cats = categoriasReales(db);
    expect(cats).toEqual(CATEGORIAS_FB);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('armarPromptBatch', () => {
  it('interpola la lista dinámica de categorías reales (planas, sin jerarquía)', () => {
    const prompt = armarPromptBatch(['BICICLETAS TREK', 'CUBIERTAS']);
    expect(prompt).toContain('BICICLETAS TREK');
    expect(prompt).toContain('CUBIERTAS');
    expect(prompt).toContain('CATEGORÍAS DISPONIBLES:');
  });

  it('cae a CATEGORIAS_FB cuando no se pasa lista o viene vacía', () => {
    const prompt = armarPromptBatch([]);
    expect(prompt).toContain(CATEGORIAS_FB[0]);
    expect(armarPromptBatch()).toContain(CATEGORIAS_FB[0]);
  });

  it('caso límite documentado: en el fallback, la lista trae rutas jerárquicas ("A > B") pese a que la instrucción del prompt pide nombres planos sin jerarquía', () => {
    const prompt = armarPromptBatch();
    // Instrucción del prompt (aplica siempre, también en fallback).
    expect(prompt).toContain('son nombres planos, sin jerarquía');
    // CATEGORIAS_FB sigue usando el formato jerárquico "PADRE > HIJO".
    expect(CATEGORIAS_FB.every((c) => c.includes(' > '))).toBe(true);
    expect(prompt).toContain(CATEGORIAS_FB[0]); // ej: "BICICLETAS POR MARCA > BICICLETAS TREK"
    // Contradicción conocida y aceptada: si el catálogo real está vacío, Gemini
    // recibe categorías con formato "A > B" pero se le pide elegir nombres planos.
  });
});
