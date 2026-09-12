// public/lib/conteoLista.js es un <script> clásico (no ESM), igual que conteoCantidad.js:
// se evalúa en un sandbox de node:vm y se extraen las funciones de ahí.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ctx = {};
vm.runInNewContext(readFileSync(path.resolve(dir, '../public/lib/conteoLista.js'), 'utf8'), ctx);
const { unificar, varianteDeNombre } = ctx.ConteoLista;

const pendiente = (sku, nombre, extra = {}) => ({ sku, nombre, categoria_principal: 'TRANSMISIÓN', marca: 'Shimano', ...extra });
const contado = (id, sku, nombre, cantidad, extra = {}) => ({
  id, sku, nombre, cantidad, categoria_principal: 'TRANSMISIÓN', marca: 'Shimano', ...extra,
});

describe('ConteoLista.unificar — una lista, y contar no mueve la fila', () => {
  it('mezcla pendientes y contados sin duplicar el producto', () => {
    const r = unificar([contado(1, 'FB-2', 'Beta', 3)], [pendiente('FB-1', 'Alfa'), pendiente('FB-2', 'Beta')]);
    expect(r).toHaveLength(2);
    expect(r.map(x => x.sku)).toEqual(['FB-1', 'FB-2']);
    expect(r.find(x => x.sku === 'FB-2')).toMatchObject({ contado: true, cantidad: 3, itemId: 1 });
    expect(r.find(x => x.sku === 'FB-1')).toMatchObject({ contado: false, cantidad: null });
  });

  // Éste es el test que justifica el rediseño: la posición de un producto no puede depender
  // de si está contado. Antes cambiaba de lista y había que ir a buscarlo al fondo de la otra.
  it('contar un producto NO cambia su posición en la lista', () => {
    const pends = [pendiente('FB-A', 'Alfa'), pendiente('FB-B', 'Beta'), pendiente('FB-C', 'Charlie')];
    const antes = unificar([], pends).map(x => x.sku);

    // Se cuenta el del medio: sale de pendientes y entra en contados, como hace la API.
    const despues = unificar(
      [contado(9, 'FB-B', 'Beta', 5)],
      pends.filter(p => p.sku !== 'FB-B'),
    ).map(x => x.sku);

    expect(despues).toEqual(antes);
    expect(despues).toEqual(['FB-A', 'FB-B', 'FB-C']);
  });

  it('ordena por categoría, después marca, después nombre', () => {
    const r = unificar([], [
      pendiente('FB-3', 'Zeta', { categoria_principal: 'FRENOS', marca: 'Shimano' }),
      pendiente('FB-1', 'Alfa', { categoria_principal: 'TRANSMISIÓN', marca: 'Abus' }),
      pendiente('FB-2', 'Beta', { categoria_principal: 'TRANSMISIÓN', marca: 'Abus' }),
    ]);
    expect(r.map(x => x.sku)).toEqual(['FB-3', 'FB-1', 'FB-2']);
  });

  it('un código sin asociar va primero: es trabajo que bloquea el cierre', () => {
    const r = unificar(
      [contado(7, null, null, 1, { ean: '779123', sku: null })],
      [pendiente('FB-1', 'Alfa')],
    );
    expect(r[0].sin_asociar).toBe(true);
    expect(r[0].clave).toBe('ean:779123');
    expect(r[1].sku).toBe('FB-1');
  });

  it('no se rompe con listas vacías', () => {
    expect(unificar([], [])).toEqual([]);
    expect(unificar(null, null)).toEqual([]);
  });
});

describe('ConteoLista.varianteDeNombre', () => {
  it('separa el talle/color del nombre base', () => {
    expect(varianteDeNombre('Casco Giro Syntax — M / Azul')).toEqual({ base: 'Casco Giro Syntax', detalle: 'M / Azul' });
  });
  it('devuelve null cuando el producto no tiene variante', () => {
    expect(varianteDeNombre('Cadena Shimano Hg53')).toBeNull();
    expect(varianteDeNombre('')).toBeNull();
    expect(varianteDeNombre(null)).toBeNull();
  });
  it('un separador sin detalle no cuenta como variante', () => {
    expect(varianteDeNombre('Producto raro — ')).toBeNull();
  });
});

// El segundo sonido de cada escaneo. El primero dice "te escuché"; éste dice qué pasó, para
// no tener que mirar la pantalla con guantes.
describe('ConteoLista.tipoDeSonido — el sonido dice qué pasó', () => {
  const { tipoDeSonido } = ctx.ConteoLista;

  it('primera unidad de un producto suena distinto que una suma', () => {
    expect(tipoDeSonido({ sku: 'FB-1', cantidad: 1 })).toBe('nuevo');
    expect(tipoDeSonido({ sku: 'FB-1', cantidad: 2 })).toBe('suma');
    expect(tipoDeSonido({ sku: 'FB-1', cantidad: 9 })).toBe('suma');
  });

  // Es la señal que faltaba el 2026-09-08: escaneás creyendo que es la primera unidad y el
  // tono de suma te avisa que ese producto ya estaba contado.
  it('un producto ya contado nunca suena como primera unidad', () => {
    expect(tipoDeSonido({ sku: 'FB-67121', cantidad: 2 })).not.toBe('nuevo');
  });

  it('un código sin asociar o desconocido suena a error', () => {
    expect(tipoDeSonido({ sku: null, ean: '779', cantidad: 1 })).toBe('error');
    expect(tipoDeSonido({ sku: 'FB-1', cantidad: 1, codigo_desconocido: true })).toBe('error');
    expect(tipoDeSonido(null)).toBe('error');
  });

  it('fuera de alcance tiene su propio tono, venga del item o del cuerpo de la respuesta', () => {
    expect(tipoDeSonido({ sku: 'FB-1', cantidad: 1, fuera_de_alcance: true })).toBe('fuera');
    expect(tipoDeSonido({ sku: 'FB-1', cantidad: 1 }, true)).toBe('fuera');
  });

  it('el error manda sobre el fuera de alcance: sin SKU no hay nada que contar', () => {
    expect(tipoDeSonido({ sku: null, cantidad: 1, fuera_de_alcance: true })).toBe('error');
  });
});
